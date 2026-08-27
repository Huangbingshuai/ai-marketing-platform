from __future__ import annotations

from collections import Counter
from typing import Any

import pytest

from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    BlueprintShardPlan,
    DimensionCoordinate,
    FragmentDimensionCoordinatePlan,
    FragmentFactAllocation,
    FragmentConfig,
    FragmentRelationshipBundle,
    FragmentRelationshipPlan,
    FragmentType,
    InsightApplicationMap,
    PromptGenerationSnapshot,
    RuntimeContext,
    ShardPhase,
    SharedPrompt,
)
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import MockAiProvider
from effect_prompt_generation.strategy_planning import allocate_fragment_facts
from effect_prompt_generation.v10_blueprints import (
    allocate_blueprint_quotas,
    make_blueprint_shards,
    make_blueprint_tasks,
    normalize_coordinate_plan,
)

from test_graph import FakeApi


class CountingV10Provider(MockAiProvider):
    def __init__(self) -> None:
        self.relationship_calls = 0
        self.coordinate_calls = 0
        self.blueprint_calls = 0
        self.prompt_calls = 0
        self.blueprint_avoid_signatures: list[list[list[str]]] = []

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
        return await super().generate_candidates(*args, **kwargs)


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
                prompt_version="effect-prompt-v10-relationship-v1",
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
    assert provider.blueprint_calls == 9
    assert provider.prompt_calls == 9
    assert any(provider.blueprint_avoid_signatures)
    assert api.result is not None
    assert len(api.result.items) == 50
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
