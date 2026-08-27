from __future__ import annotations

from collections import Counter
from typing import Any

import pytest

from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    BlueprintBundleQuota,
    BlueprintShardPlan,
    BlueprintTask,
    DimensionCoordinate,
    FragmentDimensionCoordinatePlan,
    FragmentFactAllocation,
    FragmentConfig,
    FragmentRelationshipBundle,
    FragmentRelationshipModelResponse,
    FragmentRelationshipPlan,
    FragmentType,
    GeneratedBlueprint,
    InsightApplicationMap,
    PromptGenerationSnapshot,
    RuntimeContext,
    ShardPhase,
    SharedPrompt,
)
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import (
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
    _normalize_relationship_model_response,
)
from effect_prompt_generation.strategy_planning import allocate_fragment_facts
from effect_prompt_generation.v10_blueprints import (
    allocate_blueprint_quotas,
    coordinate_variant_targets,
    make_blueprint_shards,
    make_blueprint_tasks,
    normalize_coordinate_plan,
    normalize_generated_blueprints,
    relationship_hash,
    select_orthogonal_blueprints,
    validate_coordinate_plan,
)

from test_graph import FakeApi


def test_relationship_transport_freezes_metadata_and_selects_exact_bundle_count() -> None:
    application = map_insight(
        {
            "productName": "便携杯",
            "coreSellingPoints": ["单手开合"],
            "corePainPoints": ["双手被占用"],
            "targetAudience": "通勤人群",
            "marketingGoal": "引导了解",
        }
    )
    candidate_ids = [fact.fact_id for fact in application.required]
    allocation = FragmentFactAllocation(
        fragment_type=FragmentType.PAIN,
        target_count=8,
        bundle_target=3,
        mandatory_fact_ids=candidate_ids[:2],
        candidate_fact_ids=candidate_ids,
        allocation_hash="a" * 64,
    )
    response = FragmentRelationshipModelResponse(
        fragment_type=FragmentType.HOOK,
        bundles=[
            FragmentRelationshipBundle(
                bundle_id=f"model-{index}",
                fragment_type=FragmentType.HOOK,
                primary_fact_id=fact_id,
                fact_ids=[fact_id],
                creative_intent="只呈现一个未解决的受阻状态",
            )
            for index, fact_id in enumerate(candidate_ids[:5], 1)
        ],
        allocation_hash="model-owned-value",
        prompt_version="effect-prompt-v10-relationship-base-v1",
    )

    plan = _normalize_relationship_model_response(response, allocation, application)

    assert len(plan.bundles) == 3
    assert plan.fragment_type == FragmentType.PAIN
    assert plan.allocation_hash == allocation.allocation_hash
    assert plan.prompt_version == "effect-prompt-v10-relationship-v2"
    assert [bundle.bundle_id for bundle in plan.bundles] == [
        "PAIN-R1",
        "PAIN-R2",
        "PAIN-R3",
    ]
    assert set(allocation.mandatory_fact_ids) <= {
        fact_id for bundle in plan.bundles for fact_id in bundle.fact_ids
    }
    assert all(bundle.fragment_type == FragmentType.PAIN for bundle in plan.bundles)


class CountingV10Provider(MockAiProvider):
    def __init__(self) -> None:
        self.relationship_calls = 0
        self.coordinate_calls = 0
        self.blueprint_calls = 0
        self.prompt_calls = 0
        self.blueprint_avoid_signatures: list[list[list[str]]] = []
        self.call_sequence: list[str] = []

    async def plan_fragment_relationships(
        self,
        allocation: FragmentFactAllocation,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
    ):  # type: ignore[no-untyped-def]
        self.relationship_calls += 1
        return await super().plan_fragment_relationships(
            allocation, application=application, shared_prompt=shared_prompt
        )

    async def plan_dimension_coordinates(
        self,
        relationships: FragmentRelationshipPlan,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        target_count: int,
    ):  # type: ignore[no-untyped-def]
        self.coordinate_calls += 1
        return await super().plan_dimension_coordinates(
            relationships,
            application=application,
            shared_prompt=shared_prompt,
            target_count=target_count,
        )

    async def generate_blueprints(
        self,
        shard: BlueprintShardPlan,
        *,
        relationships: FragmentRelationshipPlan,
        coordinate_plan: FragmentDimensionCoordinatePlan,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        avoid_signatures: list[list[str]] | None = None,
    ):  # type: ignore[no-untyped-def]
        self.blueprint_calls += 1
        self.call_sequence.append(f"BLUEPRINT:{shard.round}")
        self.blueprint_avoid_signatures.append(avoid_signatures or [])
        return await super().generate_blueprints(
            shard,
            relationships=relationships,
            coordinate_plan=coordinate_plan,
            application=application,
            shared_prompt=shared_prompt,
            avoid_signatures=avoid_signatures,
        )

    async def generate_candidates(self, *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        self.prompt_calls += 1
        combinations = args[0]
        round_number = combinations[0].slot_id.split("-", 1)[0].removeprefix("r")
        self.call_sequence.append(f"PROMPT:{round_number}")
        return await super().generate_candidates(*args, **kwargs)


class OneInvalidBlueprintProvider(CountingV10Provider):
    def __init__(self) -> None:
        super().__init__()
        self.invalid_blueprint_returned = False

    async def generate_blueprints(
        self,
        shard: BlueprintShardPlan,
        *,
        relationships: FragmentRelationshipPlan,
        coordinate_plan: FragmentDimensionCoordinatePlan,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        avoid_signatures: list[list[str]] | None = None,
    ):  # type: ignore[no-untyped-def]
        if not self.invalid_blueprint_returned:
            self.invalid_blueprint_returned = True
            self.blueprint_calls += 1
            self.call_sequence.append(f"BLUEPRINT:{shard.round}")
            raise ProviderError(
                "invalid blueprint candidate",
                retryable=True,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        return await super().generate_blueprints(
            shard,
            relationships=relationships,
            coordinate_plan=coordinate_plan,
            application=application,
            shared_prompt=shared_prompt,
            avoid_signatures=avoid_signatures,
        )


def _relationships(snapshot: PromptGenerationSnapshot) -> list[FragmentRelationshipPlan]:
    application = map_insight(snapshot.insight_artifact.result)
    counts = {
        fragment_type: snapshot.settings.fragment_configs[fragment_type].count
        for fragment_type in FragmentType
    }
    allocations = allocate_fragment_facts(application, counts)
    plans: list[FragmentRelationshipPlan] = []
    for fragment_type, allocation in allocations.items():
        facts = allocation.candidate_fact_ids
        bundles = []
        for index in range(allocation.bundle_target):
            primary = facts[index % len(facts)]
            bundles.append(
                FragmentRelationshipBundle(
                    bundle_id=f"{fragment_type.value}-R{index + 1}",
                    fragment_type=fragment_type,
                    primary_fact_id=primary,
                    fact_ids=[primary],
                    creative_intent="按当前片段职责表达已确认事实",
                )
            )
        plans.append(
            FragmentRelationshipPlan(
                fragment_type=fragment_type,
                bundles=bundles,
                allocation_hash=allocation.allocation_hash,
                prompt_version="effect-prompt-v10-relationship-v2",
            )
        )
    return plans


def test_default_v10_quota_and_shards_are_exact(
    snapshot: PromptGenerationSnapshot,
) -> None:
    snapshot = snapshot.model_copy(
        update={
            "settings": snapshot.settings.model_copy(
                update={
                    "fragment_configs": {
                        FragmentType.HOOK: FragmentConfig(count=10, duration_seconds=5),
                        FragmentType.PAIN: FragmentConfig(count=8, duration_seconds=5),
                        FragmentType.PRODUCT_DISPLAY: FragmentConfig(count=12, duration_seconds=5),
                        FragmentType.SELLING_POINT_EXPLANATION: FragmentConfig(count=10, duration_seconds=5),
                        FragmentType.CTA: FragmentConfig(count=6, duration_seconds=5),
                        FragmentType.OUTRO: FragmentConfig(count=4, duration_seconds=5),
                    }
                }
            )
        }
    )
    relationships = _relationships(snapshot)
    targets = {
        fragment_type: snapshot.settings.fragment_configs[fragment_type].count
        for fragment_type in FragmentType
    }
    quotas = allocate_blueprint_quotas(relationships, targets)
    tasks = make_blueprint_tasks(
        relationships,
        quotas,
        {fragment_type: 5 for fragment_type in FragmentType},
        round_number=0,
        ordinal_start=1,
    )
    shards = make_blueprint_shards(tasks, round_number=0, shard_size=8)

    assert len(tasks) == 50
    assert len(shards) == 9
    assert all(len(shard.tasks) <= 8 for shard in shards)
    assert Counter(task.fragment_type for task in tasks) == Counter(targets)
    expected_quotas = {
        FragmentType.HOOK: [3, 3, 2, 2],
        FragmentType.PAIN: [3, 3, 2],
        FragmentType.PRODUCT_DISPLAY: [3, 3, 3, 3],
        FragmentType.SELLING_POINT_EXPLANATION: [3, 3, 2, 2],
        FragmentType.CTA: [3, 3],
        FragmentType.OUTRO: [2, 2],
    }
    for fragment_type, expected in expected_quotas.items():
        assert [
            quota.target_count
            for quota in quotas
            if quota.fragment_type == fragment_type
        ] == expected


def test_quota_remainder_prefers_bundle_with_required_fact(
    snapshot: PromptGenerationSnapshot,
) -> None:
    original = _relationships(snapshot)[0]
    template = original.bundles[0]
    plan = original.model_copy(
        update={
            "bundles": [
                template.model_copy(
                    update={
                        "bundle_id": f"HOOK-R{index + 1}",
                        "fact_ids": [
                            *template.fact_ids,
                            *(["required-fact"] if index == 3 else []),
                        ],
                    }
                )
                for index in range(4)
            ]
        }
    )
    priority_fact = "required-fact"
    quotas = allocate_blueprint_quotas(
        [plan],
        {FragmentType.HOOK: 10},
        priority_fact_ids={priority_fact},
    )
    by_bundle = {item.bundle_id: item.target_count for item in quotas}
    assert by_bundle[plan.bundles[-1].bundle_id] == 3
    assert sorted(by_bundle.values()) == [2, 2, 3, 3]


def test_coordinate_signatures_are_recomputed_by_worker(
    snapshot: PromptGenerationSnapshot,
) -> None:
    plan = _relationships(snapshot)[0]
    coordinate = DimensionCoordinate(
        coordinate_id="HOOK-N01",
        value="  Local, Hook! ",
        compatible_bundle_ids=[item.bundle_id for item in plan.bundles],
        source_fact_ids=[],
        normalized_signature="MODEL-PROVIDED-VALUE",
    )
    second = coordinate.model_copy(
        update={
            "coordinate_id": "HOOK-N02",
            "value": "Second value",
            "normalized_signature": "ALSO-UNTRUSTED",
        }
    )
    raw = FragmentDimensionCoordinatePlan(
        fragment_type=FragmentType.HOOK,
        relationship_allocation_hash="a" * 64,
        narratives=[coordinate, second],
        scenes=[
            coordinate.model_copy(update={"coordinate_id": "HOOK-S01"}),
            second.model_copy(update={"coordinate_id": "HOOK-S02"}),
        ],
        personas=[
            coordinate.model_copy(update={"coordinate_id": "HOOK-P01"}),
            second.model_copy(update={"coordinate_id": "HOOK-P02"}),
        ],
        selling_points=[coordinate.model_copy(update={"coordinate_id": "HOOK-SP01"})],
        cameras=[
            coordinate.model_copy(update={"coordinate_id": "HOOK-C01"}),
            second.model_copy(update={"coordinate_id": "HOOK-C02"}),
        ],
        emotions=[
            coordinate.model_copy(update={"coordinate_id": "HOOK-E01"}),
            second.model_copy(update={"coordinate_id": "HOOK-E02"}),
        ],
        prompt_version="test",
    )
    normalized = normalize_coordinate_plan(raw)
    assert normalized.narratives[0].normalized_signature == "localhook"


def test_coordinate_plan_accepts_limited_variation_when_every_dimension_covers_bundle(
    snapshot: PromptGenerationSnapshot,
) -> None:
    relationships = _relationships(snapshot)[0]
    application = map_insight(snapshot.insight_artifact.result)
    bundle_ids = [bundle.bundle_id for bundle in relationships.bundles]
    fact_id = relationships.bundles[0].primary_fact_id

    def rows(prefix: str, size: int) -> list[DimensionCoordinate]:
        return [
            DimensionCoordinate(
                coordinate_id=f"{prefix}{index}",
                value=f"{prefix}真实候选{index}",
                compatible_bundle_ids=bundle_ids,
                source_fact_ids=[fact_id],
                normalized_signature=f"{prefix.lower()}真实候选{index}",
            )
            for index in range(1, size + 1)
        ]

    plan = FragmentDimensionCoordinatePlan(
        fragment_type=FragmentType.HOOK,
        relationship_allocation_hash=relationship_hash(relationships),
        narratives=rows("N", 2),
        scenes=rows("S", 2),
        personas=rows("P", 2),
        selling_points=rows("SP", 1),
        cameras=rows("C", 2),
        emotions=rows("E", 2),
        prompt_version="test",
    )
    plan = normalize_coordinate_plan(plan, relationships)
    targets = coordinate_variant_targets(relationships, 3)

    assert targets
    validate_coordinate_plan(plan, relationships, application)


def test_coordinate_normalization_completes_only_fact_compatible_bundle_labels(
    snapshot: PromptGenerationSnapshot,
) -> None:
    relationships = _relationships(snapshot)[-1]
    first_bundle = relationships.bundles[0]
    second_bundle = first_bundle.model_copy(update={"bundle_id": "OUTRO-R2"})
    shared_fact = first_bundle.primary_fact_id
    relationships = relationships.model_copy(
        update={
            "bundles": [
                first_bundle,
                second_bundle.model_copy(
                    update={
                        "primary_fact_id": shared_fact,
                        "fact_ids": [shared_fact],
                    }
                ),
            ]
        }
    )
    first_id = relationships.bundles[0].bundle_id
    second_id = relationships.bundles[1].bundle_id
    coordinate = DimensionCoordinate(
        coordinate_id="OUTRO-SP01",
        value="保留真实产品细节的稳定收束",
        compatible_bundle_ids=[first_id],
        source_fact_ids=[shared_fact],
        normalized_signature="model-value",
    )
    visual = coordinate.model_copy(
        update={"coordinate_id": "OUTRO-V01", "source_fact_ids": []}
    )
    visual_second = visual.model_copy(
        update={"coordinate_id": "OUTRO-V02", "value": "另一个视觉候选"}
    )
    raw = FragmentDimensionCoordinatePlan(
        fragment_type=FragmentType.OUTRO,
        relationship_allocation_hash="b" * 64,
        narratives=[visual, visual_second],
        scenes=[visual, visual_second],
        personas=[visual, visual_second],
        selling_points=[coordinate],
        cameras=[visual, visual_second],
        emotions=[visual, visual_second],
        prompt_version="model-version",
    )

    normalized = normalize_coordinate_plan(raw, relationships)

    assert set(normalized.selling_points[0].compatible_bundle_ids) == {
        first_id,
        second_id,
    }


def test_blueprint_normalization_freezes_task_identity_and_fact_subset() -> None:
    task = BlueprintTask(
        slot_id="HOOK-R1-001",
        ordinal=1,
        round=0,
        fragment_type=FragmentType.HOOK,
        bundle_id="HOOK-R1",
        primary_fact_id="fact-primary",
        fact_ids=["fact-primary", "fact-helper"],
        target_duration_seconds=5,
        material_tags=["钩子"],
    )
    item = GeneratedBlueprint(
        slot_id="model-changed-slot",
        fragment_type=FragmentType.OUTRO,
        bundle_id="model-bundle",
        primary_fact_id="model-fact",
        used_fact_ids=["unknown-fact", "fact-helper"],
        narrative_coordinate_id="N1",
        scene_coordinate_id="S1",
        persona_coordinate_id="P1",
        selling_point_coordinate_id="SP1",
        camera_coordinate_id="C1",
        emotion_coordinate_id="E1",
        opening_state="首帧建立悬念",
        action_arc="主体缓慢靠近后停住",
        ending_state="关键信息仍未揭晓",
    )

    normalized = normalize_generated_blueprints([item], [task])[0]

    assert normalized.slot_id == task.slot_id
    assert normalized.fragment_type == task.fragment_type
    assert normalized.bundle_id == task.bundle_id
    assert normalized.primary_fact_id == task.primary_fact_id
    assert normalized.used_fact_ids == ["fact-primary", "fact-helper"]


def test_blueprint_distance_is_preference_but_exact_tuple_is_hard_duplicate() -> None:
    bundle_id = "HOOK-R1"

    def coordinate(identifier: str, value: str) -> DimensionCoordinate:
        return DimensionCoordinate(
            coordinate_id=identifier,
            value=value,
            compatible_bundle_ids=[bundle_id],
            source_fact_ids=[],
            normalized_signature=value.casefold(),
        )

    first = coordinate("N1", "narrative one")
    second = coordinate("N2", "narrative two")
    plan = FragmentDimensionCoordinatePlan(
        fragment_type=FragmentType.HOOK,
        relationship_allocation_hash="a" * 64,
        narratives=[first, second],
        scenes=[coordinate("S1", "scene one"), coordinate("S2", "scene two")],
        personas=[coordinate("P1", "persona one"), coordinate("P2", "persona two")],
        selling_points=[coordinate("SP1", "selling one")],
        cameras=[coordinate("C1", "camera one"), coordinate("C2", "camera two")],
        emotions=[coordinate("E1", "emotion one"), coordinate("E2", "emotion two")],
        prompt_version="test",
    )

    def blueprint(slot_id: str, narrative_id: str) -> GeneratedBlueprint:
        return GeneratedBlueprint(
            slot_id=slot_id,
            fragment_type=FragmentType.HOOK,
            bundle_id=bundle_id,
            primary_fact_id="fact-1",
            used_fact_ids=["fact-1"],
            narrative_coordinate_id=narrative_id,
            scene_coordinate_id="S1",
            persona_coordinate_id="P1",
            selling_point_coordinate_id="SP1",
            camera_coordinate_id="C1",
            emotion_coordinate_id="E1",
            opening_state="首帧悬念",
            action_arc="成年人伸手后停住",
            ending_state="信息仍未揭晓",
        )

    selected, deficits, rejected = select_orthogonal_blueprints(
        [blueprint("slot-a", "N1"), blueprint("slot-b", "N2"), blueprint("slot-c", "N1")],
        [
            BlueprintBundleQuota(
                fragment_type=FragmentType.HOOK,
                bundle_id=bundle_id,
                primary_fact_id="fact-1",
                target_count=2,
                candidate_count=3,
            )
        ],
        [plan],
    )

    assert len(selected) == 2
    assert {item.narrative_coordinate_id for item in selected} == {"N1", "N2"}
    assert deficits == {}
    assert rejected == 1

    changed_action = blueprint("slot-d", "N1").model_copy(
        update={"action_arc": "成年人轻触主体边缘后停住"}
    )
    same_coordinates, deficits, rejected = select_orthogonal_blueprints(
        [blueprint("slot-a", "N1"), changed_action],
        [
            BlueprintBundleQuota(
                fragment_type=FragmentType.HOOK,
                bundle_id=bundle_id,
                primary_fact_id="fact-1",
                target_count=2,
                candidate_count=2,
            )
        ],
        [plan],
    )
    assert len(same_coordinates) == 2
    assert deficits == {}
    assert rejected == 0


def test_replenishment_only_overgenerates_actual_bundle_gap(
    snapshot: PromptGenerationSnapshot,
) -> None:
    relationships = _relationships(snapshot)
    quotas = allocate_blueprint_quotas(
        relationships,
        {fragment_type: snapshot.settings.fragment_configs[fragment_type].count for fragment_type in FragmentType},
        round_number=1,
        deficits={relationships[0].bundles[0].bundle_id: 2},
    )
    assert len(quotas) == 1
    assert quotas[0].target_count == 2
    assert quotas[0].candidate_count == 3


@pytest.mark.asyncio
async def test_v10_graph_persists_blueprint_and_prompt_phases(
    snapshot: PromptGenerationSnapshot,
    runtime: RuntimeContext,
) -> None:
    snapshot = snapshot.model_copy(
        update={"graph_version": "V10_RELATION_COORDINATE_BLUEPRINT"}
    )
    api = FakeApi()
    pipeline = PromptGenerationPipeline(api=api, provider=MockAiProvider(), shard_size=8)
    pipeline.register_snapshot(runtime, snapshot)

    result: dict[str, Any] = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
        config={"max_concurrency": 6},
    )

    assert result["prompt_result_id"] == "prompt-result-1"
    assert any(shard.phase == ShardPhase.BLUEPRINT for shard in api.shards.values())
    assert any(shard.phase == ShardPhase.PROMPT for shard in api.shards.values())
    assert all(
        item.planning_version == "v10-coordinate-blueprint"
        for shard in api.shards.values()
        if shard.phase == ShardPhase.PROMPT
        for item in shard.combination_plan
    )


@pytest.mark.asyncio
async def test_invalid_blueprint_shard_becomes_a_replenishment_gap(
    snapshot: PromptGenerationSnapshot,
    runtime: RuntimeContext,
) -> None:
    snapshot = snapshot.model_copy(
        update={"graph_version": "V10_RELATION_COORDINATE_BLUEPRINT"}
    )
    api = FakeApi()
    provider = OneInvalidBlueprintProvider()
    pipeline = PromptGenerationPipeline(api=api, provider=provider, shard_size=8)
    pipeline.register_snapshot(runtime, snapshot)

    result: dict[str, Any] = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
        config={"max_concurrency": 6},
    )

    assert result["prompt_result_id"] == "prompt-result-1"
    assert any(
        shard.phase == ShardPhase.BLUEPRINT and shard.status.value == "FAILED"
        for shard in api.shards.values()
    )
    first_prompt = provider.call_sequence.index("PROMPT:0")
    first_replenishment_blueprint = provider.call_sequence.index("BLUEPRINT:1")
    assert first_prompt < first_replenishment_blueprint
    assert any(
        shard.phase == ShardPhase.BLUEPRINT
        and shard.round > 0
        and shard.status.value == "SUCCEEDED"
        for shard in api.shards.values()
    )


@pytest.mark.asyncio
async def test_default_50_v10_uses_six_coordinate_calls_and_nine_blueprint_shards(
    snapshot: PromptGenerationSnapshot,
    runtime: RuntimeContext,
) -> None:
    snapshot = snapshot.model_copy(
        update={
            "graph_version": "V10_RELATION_COORDINATE_BLUEPRINT",
            "settings": snapshot.settings.model_copy(
                update={
                    "fragment_configs": {
                        FragmentType.HOOK: FragmentConfig(count=10, duration_seconds=5),
                        FragmentType.PAIN: FragmentConfig(count=8, duration_seconds=5),
                        FragmentType.PRODUCT_DISPLAY: FragmentConfig(count=12, duration_seconds=5),
                        FragmentType.SELLING_POINT_EXPLANATION: FragmentConfig(count=10, duration_seconds=5),
                        FragmentType.CTA: FragmentConfig(count=6, duration_seconds=5),
                        FragmentType.OUTRO: FragmentConfig(count=4, duration_seconds=5),
                    }
                }
            ),
        }
    )
    provider = CountingV10Provider()
    api = FakeApi()
    pipeline = PromptGenerationPipeline(api=api, provider=provider, shard_size=8)
    pipeline.register_snapshot(runtime, snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
        config={"max_concurrency": 6},
    )

    assert provider.relationship_calls == 6
    assert provider.coordinate_calls == 6
    prompt_keys = sorted(
        shard.key
        for shard in api.shards.values()
        if shard.phase == ShardPhase.PROMPT and shard.status.value == "SUCCEEDED"
    )
    missing_key = prompt_keys[len(prompt_keys) // 2]
    pending, deficits = await pipeline.gate_blueprints_and_plan_prompts(
        runtime,
        round_number=0,
        completed_prompt_keys=[key for key in prompt_keys if key != missing_key],
    )
    assert deficits == {}
    assert [shard.key for shard in pending] == [missing_key]
    assert provider.blueprint_calls == 9
    assert provider.prompt_calls == 9
    assert any(provider.blueprint_avoid_signatures)
    assert api.result is not None
    assert len(api.result.items) == 50
    assert api.result.quality_status == "PASS"
    assert api.result.metrics.insight_coverage.missing == []
    assert api.result.metrics.fallback_count == 0
    assert api.result.metrics.execution_invalid_reasons == []
    assert Counter(item.fragment_type for item in api.result.items) == Counter(
        {
            FragmentType.HOOK: 10,
            FragmentType.PAIN: 8,
            FragmentType.PRODUCT_DISPLAY: 12,
            FragmentType.SELLING_POINT_EXPLANATION: 10,
            FragmentType.CTA: 6,
            FragmentType.OUTRO: 4,
        }
    )
