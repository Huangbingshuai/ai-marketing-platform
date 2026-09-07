from __future__ import annotations

import hashlib
from collections import Counter
from dataclasses import replace
from typing import Any

import pytest

from effect_prompt_generation.embeddings import MockEmbeddingProvider
from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.insight_mapping import (
    mandatory_business_facts,
    map_insight,
)
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDimensions,
    CreativeDirectionFactApplication,
    CreativeDirectionAuditItem,
    CreativeDirectionAuditResponse,
    CreativeDirectionDiversityAuditResponse,
    CreativeDirectionOverlapGroup,
    CreativeDirectionResponse,
    CreativeDiversityLandscapeResponse,
    CreativeLandscapeAuditResponse,
    CreativeLandscapeFactIssue,
    CreativeTerritoryAuditResponse,
    CreativeEvaluation,
    CreativeFactTerritoryAssignment,
    CreativeFactTerritoryAssignmentResponse,
    CreativeFactAssignment,
    CreativeScores,
    CreativeSemanticProfile,
    CreativeTask,
    CreativeTerritoryFactCompatibility,
    FragmentType,
    PromptGenerationSnapshot,
    PromptBatchSettings,
    StrategyCheckpoint,
)
from effect_prompt_generation.pipeline import (
    PromptGenerationPipeline,
    _creative_task_chunks,
    _creative_direction_planning_batches,
    _silent_material_planning_inputs,
    _visually_required_business_fact_ids,
)
from effect_prompt_generation.providers import (
    CREATIVE_DIRECTION_TEMPLATE_HASH,
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)
from effect_prompt_generation.creative_directions import (
    apply_creative_landscape_audit,
    allocate_creative_directions,
    complete_semantic_profile,
    compile_creative_landscape_assignments,
    creative_direction_fact_density_instruction,
    creative_direction_target_count,
    creative_territory_target_range,
    creative_direction_source_hash,
    direction_allocation_bucket,
    dominant_families,
    max_cluster_share,
    merge_creative_landscape_territory_revision,
    merge_creative_direction_revision,
    creative_direction_audit_revision_context,
    creative_direction_revision_context,
    semantic_cluster_novelty,
    validate_semantic_profile,
    validate_creative_direction_audit_batch,
    validate_creative_direction_diversity_audit,
    validate_creative_diversity_landscape,
    validate_creative_direction_audit,
    validate_creative_landscape_audit,
    validate_creative_direction_plan,
)

from test_creatives import PromptApi, _runtime, _snapshot


def test_creative_direction_count_scales_with_batch_size() -> None:
    assert creative_direction_target_count(10) == 8


@pytest.mark.parametrize(
    ("direction_count", "expected_batch_sizes"),
    [(13, [8, 5]), (20, [8, 8, 4]), (32, [8, 8, 8, 8])],
)
def test_direction_planning_packs_multiple_territories_into_safe_batches(
    direction_count: int,
    expected_batch_sizes: list[int],
) -> None:
    from effect_prompt_generation.providers import _mock_creative_landscape_response

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(
            application,
            direction_count=direction_count,
        ),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=direction_count,
    )

    batches = _creative_direction_planning_batches(landscape, batch_size=8)

    assert [len(batch.slots) for batch in batches] == expected_batch_sizes
    assert len(batches[0].territories) > 1
    slots = [slot for batch in batches for slot in batch.slots]
    assert (
        len(slots)
        == len({slot["directionId"] for slot in slots})
        == direction_count
    )
    assert all(slot["territoryId"] for slot in slots)
    assert all(slot["primaryActionId"] for slot in slots)
    required_fact_ids = [
        fact_id for batch in batches for fact_id in batch.required_fact_ids
    ]
    assert len(required_fact_ids) == len(set(required_fact_ids))


class CountingPlanningProvider(MockAiProvider):
    def __init__(self) -> None:
        self.calls: Counter[str] = Counter()

    async def plan_creative_landscape(self, *args: Any, **kwargs: Any) -> Any:
        self.calls["space"] += 1
        return await super().plan_creative_landscape(*args, **kwargs)

    async def assign_creative_landscape_facts(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        self.calls["assignment"] += 1
        return await super().assign_creative_landscape_facts(*args, **kwargs)

    async def audit_creative_landscape(self, *args: Any, **kwargs: Any) -> Any:
        self.calls["space_review"] += 1
        return await super().audit_creative_landscape(*args, **kwargs)

    async def plan_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        self.calls["direction"] += 1
        return await super().plan_creative_directions(*args, **kwargs)

    async def audit_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        self.calls["direction_review"] += 1
        return await super().audit_creative_directions(*args, **kwargs)

    async def audit_creative_direction_diversity(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        self.calls["diversity_review"] += 1
        return await super().audit_creative_direction_diversity(*args, **kwargs)


@pytest.mark.asyncio
async def test_ten_item_normal_path_uses_six_front_planning_calls() -> None:
    api = PromptApi()
    provider = CountingPlanningProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    shards = await pipeline.plan_creatives(runtime, round_number=0)

    assert shards
    assert provider.calls == Counter(
        {
            "space": 1,
            "assignment": 1,
            "space_review": 1,
            "direction": 1,
            "direction_review": 1,
            "diversity_review": 1,
        }
    )
    stage = next(
        item
        for item in reversed(api.stages)
        if item.node_id.value == "COHERENT_CREATIVE_GENERATION"
        and "planningAiCallCount" in item.metadata
    )
    assert stage.metadata["planningAiCallCount"] == 6
    assert stage.metadata["directionPlanningBatchCount"] == 1
    assert stage.metadata["directionAuditBatchCount"] == 1


def test_audit_transport_accepts_empty_explanatory_summaries() -> None:
    direction_audit = CreativeDirectionAuditResponse(
        items=[
            CreativeDirectionAuditItem(
                direction_id="direction-01",
                realized_territory_id="BATHROOM_ROUTINE",
                realized_action_id="PRESS_PUMP",
                aligned=True,
                fact_reviews=[],
            )
        ],
        requires_revision=False,
        summary="",
    )
    diversity_audit = CreativeDirectionDiversityAuditResponse(
        groups=[],
        requires_revision=False,
        summary="",
    )
    territory_audit = CreativeTerritoryAuditResponse(
        territory_id="BATHROOM_ROUTINE",
        fact_issues=[],
        summary="",
    )

    assert direction_audit.summary == "创意方向复核完成"
    assert diversity_audit.summary == "全批方向重复复核完成"
    assert territory_audit.summary == "创意空间复核完成"


def test_creative_task_chunks_keep_direction_siblings_together() -> None:
    plan = _direction_plan_for_semantic_tests()
    directions = plan.directions[:6]
    tasks = [
        CreativeTask(
            slot_id=f"slot-{index}",
            ordinal=index + 1,
            round=0,
            target_duration_seconds=15,
            fact_assignment=CreativeFactAssignment(
                fact_ids=direction.fact_ids,
                assignment_hash=f"{index + 1:064x}",
            ),
            creative_direction=direction,
        )
        for index, direction in enumerate([*directions, *directions])
    ]

    chunks = _creative_task_chunks(tasks, max_size=4)

    assert [len(chunk) for chunk in chunks] == [4, 4, 4]
    assert {task.slot_id for chunk in chunks for task in chunk} == {
        task.slot_id for task in tasks
    }
    direction_chunk_indexes: dict[str, set[int]] = {}
    for chunk_index, chunk in enumerate(chunks):
        for task in chunk:
            assert task.creative_direction is not None
            direction_chunk_indexes.setdefault(
                task.creative_direction.direction_id, set()
            ).add(chunk_index)
    assert all(len(indexes) == 1 for indexes in direction_chunk_indexes.values())


def test_fact_compatibility_keeps_multiple_independent_unsupported_conditions() -> None:
    compatibility = CreativeTerritoryFactCompatibility(
        fact_id="fact-1",
        natural_usage="作为产品成分背景",
        unsupported_conditions=[
            "不得用瓶身外观证明成分体系",
            "不得用泡沫形态证明成分体系",
        ],
    )

    assert compatibility.unsupported_conditions == [
        "不得用瓶身外观证明成分体系",
        "不得用泡沫形态证明成分体系",
    ]
    assignment = CreativeFactTerritoryAssignment(
        fact_id="fact-1",
        territory_id="PRODUCT_USAGE",
        natural_usage="作为产品成分背景",
        unsupported_conditions=compatibility.unsupported_conditions,
    )
    assert len(assignment.unsupported_conditions) == 2


def test_direction_diversity_audit_validation_is_idempotent() -> None:
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
    )

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )
    directions = _mock_creative_direction_response(
        application,
        landscape=landscape,
        direction_count=13,
    ).directions
    validated = validate_creative_direction_diversity_audit(
        CreativeDirectionDiversityAuditResponse(
            groups=[],
            requires_revision=False,
            revision_direction_ids=[],
            summary="未发现实质重复",
        ),
        directions,
    )

    restored = validate_creative_direction_diversity_audit(validated, directions)

    assert restored == validated
    assert creative_direction_target_count(50) == 20
    assert creative_direction_target_count(75) == 30
    assert creative_direction_target_count(100) == 32
    assert creative_direction_target_count(500) == 32


def test_direction_audit_normalizes_action_to_its_structural_territory() -> None:
    from effect_prompt_generation.providers import (
        _mock_creative_direction_audit,
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
    )

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )
    directions = _mock_creative_direction_response(
        application,
        landscape=landscape,
        direction_count=13,
    )
    response = _mock_creative_direction_audit(landscape, directions)
    first = response.items[0]
    wrong_territory = next(
        territory.territory_id
        for territory in landscape.territories
        if territory.territory_id != first.realized_territory_id
    )
    mismatched = response.model_copy(
        update={
            "items": [
                first.model_copy(update={"realized_territory_id": wrong_territory}),
                *response.items[1:],
            ]
        }
    )

    normalized = validate_creative_direction_audit_batch(
        mismatched,
        directions.directions,
        landscape,
    )

    assert normalized.items[0].realized_territory_id == first.realized_territory_id


def test_large_batches_require_enough_creative_territory_capacity() -> None:
    assert creative_territory_target_range(20) == (6, 10)
    assert creative_territory_target_range(25) == (6, 10)
    assert creative_territory_target_range(38) == (7, 10)
    assert creative_territory_target_range(50) == (8, 10)


def test_landscape_requires_one_structural_action_slot_per_direction() -> None:
    from effect_prompt_generation.providers import _mock_creative_landscape_response

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    draft = _mock_creative_landscape_response(application, direction_count=13)
    territories = [item.model_copy(deep=True) for item in draft.territories]
    territories[0] = territories[0].model_copy(
        update={"actions": territories[0].actions[:1]}
    )
    for index in range(1, len(territories)):
        territories[index] = territories[index].model_copy(
            update={"actions": territories[index].actions[:1]}
        )

    with pytest.raises(ValueError, match="action capacity"):
        validate_creative_diversity_landscape(
            CreativeDiversityLandscapeResponse(territories=territories),
            application,
            source_hash="a" * 64,
            template_hash="b" * 64,
            expected_direction_count=13,
        )


def test_direction_plan_rejects_reusing_one_action_inside_a_territory() -> None:
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_fact_visual_strategy,
        _mock_creative_landscape_response,
    )
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )
    response = _mock_creative_direction_response(
        application,
        landscape=landscape,
        direction_count=13,
    )
    first = response.directions[0]
    same_territory_index = next(
        index
        for index, direction in enumerate(response.directions[1:], start=1)
        if direction.territory_id == first.territory_id
    )
    repeated = response.directions[same_territory_index].model_copy(
        update={"primary_action_id": first.primary_action_id}
    )
    invalid = response.model_copy(
        update={
            "directions": [
                repeated if index == same_territory_index else direction
                for index, direction in enumerate(response.directions)
            ]
        }
    )
    visual_strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="e" * 64,
        template_hash="f" * 64,
    )

    with pytest.raises(ValueError, match="repeat a territory primary action"):
        validate_creative_direction_plan(
            invalid,
            application,
            visual_strategy,
            landscape=landscape,
            source_hash="c" * 64,
            template_hash="d" * 64,
        )


def test_creative_direction_count_scales_with_fact_density() -> None:
    assert creative_direction_target_count(50, 37) == 20
    assert creative_direction_target_count(50, 41) == 20
    assert creative_direction_target_count(10, 40) == 10
    assert "每个方向必须自然使用 2～4 条业务事实" in (
        creative_direction_fact_density_instruction(37, 13)
    )
    assert "至少让 3 个不同方向" in (creative_direction_fact_density_instruction(3, 8))


def test_creative_direction_capacity_fails_before_ai_calls() -> None:
    with pytest.raises(ValueError, match="至少调整为 11 条"):
        creative_direction_target_count(10, 41)
    with pytest.raises(ValueError, match="最多承载 200 条业务事实"):
        creative_direction_target_count(50, 321)
    with pytest.raises(ValueError, match="没有可分配"):
        creative_direction_target_count(50, 0)


class CrossBatchDirectionOverlapProvider(MockAiProvider):
    def __init__(self) -> None:
        self.diversity_audit_calls = 0
        self.direction_plan_calls = 0
        self.initial_slot_batch_sizes: list[int] = []
        self.initial_required_fact_batches: list[list[str]] = []

    async def plan_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        self.direction_plan_calls += 1
        context = kwargs.get("revision_context")
        if context and not context.get("revisionDirectionIds"):
            slots = context.get("requiredDirectionSlots", [])
            if slots:
                self.initial_slot_batch_sizes.append(len(slots))
                self.initial_required_fact_batches.append(
                    list(context.get("requiredBusinessFactIds", []))
                )
        return await super().plan_creative_directions(*args, **kwargs)

    async def audit_creative_direction_diversity(
        self,
        *,
        landscape: Any,
        directions: CreativeDirectionResponse,
        proposed_direction_ids: Any = (),
    ) -> Any:
        self.diversity_audit_calls += 1
        result = await super().audit_creative_direction_diversity(
            landscape=landscape,
            directions=directions,
            proposed_direction_ids=proposed_direction_ids,
        )
        if self.diversity_audit_calls == 1:
            left = directions.directions[0].direction_id
            right = directions.directions[8].direction_id
            return result.__class__(
                value=CreativeDirectionDiversityAuditResponse(
                    groups=[
                        CreativeDirectionOverlapGroup(
                            group_id="OVERLAP_01",
                            direction_ids=[left, right],
                            repeated_visual_core="两个方向会形成相同主体、主动作和构图",
                            revision_direction_ids=[right],
                            diversification_goal="改变产品主动作与画面结构",
                        )
                    ],
                    requires_revision=True,
                    revision_direction_ids=[right],
                    summary="发现一个跨分片视觉重叠组",
                ),
                metadata=result.metadata,
            )
        return result


@pytest.mark.asyncio
async def test_global_direction_audit_can_revise_cross_batch_overlap() -> None:
    api = PromptApi()
    provider = CrossBatchDirectionOverlapProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _snapshot().model_copy(
        update={
            "settings": PromptBatchSettings(
                target_count=50,
                default_duration_seconds=15,
            )
        }
    )
    pipeline.register_snapshot(runtime, snapshot)
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    shards = await pipeline.plan_creatives(runtime, round_number=0)

    assert sum(len(item.tasks) for item in shards) == 70
    assert sum(provider.initial_slot_batch_sizes) == 20
    assert max(provider.initial_slot_batch_sizes) <= 8
    planned_required_fact_ids = [
        fact_id
        for batch in provider.initial_required_fact_batches
        for fact_id in batch
    ]
    assert len(planned_required_fact_ids) == len(set(planned_required_fact_ids))
    assert set(planned_required_fact_ids) == set(
        _visually_required_business_fact_ids(
            pipeline._require_application(runtime),
            pipeline._required_fact_visual_strategy(runtime),
        )
    )
    # Initial planning safely packs several territories per call; the overlap
    # repair remains the only subsequent targeted direction call.
    assert provider.direction_plan_calls == 4
    assert provider.diversity_audit_calls == 2
    plan = pipeline._cache(runtime).creative_direction_plan
    assert plan is not None
    assert plan.diversity_audit is not None
    assert plan.diversity_audit.requires_revision is False


def test_one_natural_territory_can_carry_more_than_eight_business_facts() -> None:
    from effect_prompt_generation.providers import _mock_creative_landscape_response

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    template = mandatory_business_facts(application)[0]
    business_ids = {fact.fact_id for fact in mandatory_business_facts(application)}
    cloned_facts = [
        template.model_copy(
            update={
                "fact_id": f"dense-business-{index:02d}",
                "value": f"已确认业务事实 {index}",
                "value_hash": hashlib.sha256(
                    f"已确认业务事实 {index}".encode("utf-8")
                ).hexdigest(),
            }
        )
        for index in range(9)
    ]
    dense_application = application.model_copy(
        update={
            "required": [
                fact
                for fact in application.required
                if fact.fact_id not in business_ids
            ]
            + cloned_facts,
            "adaptive": [
                fact
                for fact in application.adaptive
                if fact.fact_id not in business_ids
            ],
        }
    )
    landscape = _mock_creative_landscape_response(
        dense_application,
        direction_count=13,
    )
    territory_id = landscape.territories[0].territory_id
    compiled = compile_creative_landscape_assignments(
        landscape,
        CreativeFactTerritoryAssignmentResponse(
            assignments=[
                CreativeFactTerritoryAssignment(
                    fact_id=fact.fact_id,
                    territory_id=territory_id,
                    natural_usage="同一真实业务主题下的自然产品表达",
                    unsupported_conditions=[],
                )
                for fact in cloned_facts
            ]
        ),
        dense_application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )

    assert len(compiled.by_id[territory_id].required_fact_ids) == 9
    assert compiled.by_id[territory_id].target_slots >= 3
    assert sum(item.target_slots for item in compiled.territories) == 13


def test_ai_flagged_optional_landscape_binding_is_removed_mechanically() -> None:
    from effect_prompt_generation.providers import _mock_creative_landscape_response

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )
    compatibility_counts = Counter(
        fact_id
        for territory in landscape.territories
        for fact_id in territory.compatible_fact_ids
    )
    territory, fact_id = next(
        (territory, fact_id)
        for territory in landscape.territories
        for fact_id in territory.compatible_fact_ids
        if fact_id not in territory.required_fact_ids
        and compatibility_counts[fact_id] > 1
    )
    audit = validate_creative_landscape_audit(
        CreativeLandscapeAuditResponse(
            reviewed_territory_ids=[
                item.territory_id for item in landscape.territories
            ],
            fact_issues=[
                CreativeLandscapeFactIssue(
                    territory_id=territory.territory_id,
                    fact_id=fact_id,
                    verdict="WEAK",
                    reason="该辅助事实与空间主动作只有远距离关系",
                )
            ],
            requires_revision=True,
            revision_territory_ids=[territory.territory_id],
            summary="发现一项不自然辅助关系",
        ),
        landscape,
    )

    repaired = apply_creative_landscape_audit(landscape, audit, application)

    assert repaired is not None
    assert fact_id not in repaired.by_id[territory.territory_id].compatible_fact_ids
    assert repaired.semantic_audit is not None
    assert repaired.semantic_audit.requires_revision is False


def test_direction_revision_context_names_territory_fact_boundary() -> None:
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
    )

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )
    response = _mock_creative_direction_response(
        application,
        landscape=landscape,
        direction_count=13,
    )
    first = response.directions[0]
    outside_fact_id = next(
        fact_id
        for territory in landscape.territories[1:]
        for fact_id in territory.compatible_fact_ids
        if fact_id not in landscape.by_id[first.territory_id].compatible_fact_ids
    )
    invalid_first = first.model_copy(
        update={
            "fact_applications": [
                first.fact_applications[0].model_copy(
                    update={"fact_id": outside_fact_id}
                ),
                *first.fact_applications[1:],
            ]
        }
    )
    invalid_response = response.model_copy(
        update={"directions": [invalid_first, *response.directions[1:]]}
    )

    context = creative_direction_revision_context(
        invalid_response,
        application,
        validation_error="creative direction used a fact outside its territory",
        landscape=landscape,
    )

    assert context["allowedFactIdsByTerritory"][first.territory_id] == list(
        landscape.by_id[first.territory_id].compatible_fact_ids
    )
    assert context["invalidDirectionFactReferences"] == [
        {
            "directionId": first.direction_id,
            "territoryId": first.territory_id,
            "invalidFactIds": [outside_fact_id],
        }
    ]
    assert first.direction_id in context["revisionDirectionIds"]
    assert len(context["revisionDirectionIds"]) <= 4
    assert context["revisionRequiredBusinessFactIds"] == []
    assert context["revisionFactApplicationCapacity"] == (
        len(context["revisionDirectionIds"]) * 4
    )
    assert context["revisionFactOptions"] == []


def test_direction_revision_context_opens_a_valid_destination_for_business_fact() -> (
    None
):
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
    )

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )
    response = _mock_creative_direction_response(
        application,
        landscape=landscape,
        direction_count=13,
    )
    business_ids = {fact.fact_id for fact in mandatory_business_facts(application)}
    invalid_direction = next(
        direction
        for direction in response.directions
        if any(
            fact_id in business_ids
            and fact_id
            not in landscape.by_id[direction.territory_id].compatible_fact_ids
            and any(
                fact_id in landscape.by_id[candidate.territory_id].compatible_fact_ids
                for candidate in response.directions
                if candidate.direction_id != direction.direction_id
            )
            for territory in landscape.territories
            for fact_id in territory.compatible_fact_ids
        )
    )
    outside_business_fact_id = next(
        fact_id
        for territory in landscape.territories
        for fact_id in territory.compatible_fact_ids
        if fact_id in business_ids
        and fact_id
        not in landscape.by_id[invalid_direction.territory_id].compatible_fact_ids
        and any(
            fact_id in landscape.by_id[candidate.territory_id].compatible_fact_ids
            for candidate in response.directions
            if candidate.direction_id != invalid_direction.direction_id
        )
    )
    invalid_response = response.model_copy(
        update={
            "directions": [
                direction.model_copy(
                    update={
                        "fact_applications": [
                            direction.fact_applications[0].model_copy(
                                update={"fact_id": outside_business_fact_id}
                            ),
                            *[
                                item
                                for item in direction.fact_applications[1:]
                                if item.fact_id != outside_business_fact_id
                            ],
                        ]
                    }
                )
                if direction.direction_id == invalid_direction.direction_id
                else direction.model_copy(
                    update={
                        "fact_applications": [
                            item
                            for item in direction.fact_applications
                            if item.fact_id != outside_business_fact_id
                        ]
                    }
                )
                for direction in response.directions
            ]
        }
    )

    context = creative_direction_revision_context(
        invalid_response,
        application,
        validation_error="creative direction used a fact outside its territory",
        landscape=landscape,
    )

    eligible_destination_ids = {
        direction.direction_id
        for direction in invalid_response.directions
        if direction.direction_id != invalid_direction.direction_id
        and outside_business_fact_id
        in landscape.by_id[direction.territory_id].compatible_fact_ids
    }
    opened_destination_ids = eligible_destination_ids.intersection(
        context["revisionDirectionIds"]
    )
    option = next(
        item
        for item in context["revisionFactOptions"]
        if item["factId"] == outside_business_fact_id
    )
    assert invalid_direction.direction_id in context["revisionDirectionIds"]
    assert opened_destination_ids
    assert opened_destination_ids.intersection(option["eligibleDirectionIds"])
    assert all(
        outside_business_fact_id in context["allowedFactIdsByDirection"][direction_id]
        for direction_id in opened_destination_ids
    )


def test_direction_revision_context_identifies_structural_slot_correction() -> None:
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
    )

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )
    response = _mock_creative_direction_response(
        application,
        landscape=landscape,
        direction_count=13,
    )
    source = landscape.territories[0]
    target = landscape.territories[1]
    moved = next(
        direction
        for direction in response.directions
        if direction.territory_id == target.territory_id
    )
    source_action = source.actions[0].action_id
    invalid_response = response.model_copy(
        update={
            "directions": [
                direction.model_copy(
                    update={
                        "territory_id": source.territory_id,
                        "primary_action_id": source_action,
                        "fact_applications": [
                            application
                            for application in direction.fact_applications
                            if application.fact_id in source.compatible_fact_ids
                        ]
                        or [response.directions[0].fact_applications[0]],
                    }
                )
                if direction.direction_id == moved.direction_id
                else direction
                for direction in response.directions
            ]
        }
    )

    context = creative_direction_revision_context(
        invalid_response,
        application,
        validation_error="creative directions do not follow landscape target slots",
        landscape=landscape,
    )

    correction = context["territorySlotCorrection"]
    assert correction["overflowSlotsByTerritory"] == {source.territory_id: 1}
    assert correction["deficitSlotsByTerritory"] == {target.territory_id: 1}
    assert correction["movableDirectionIds"] == [moved.direction_id]
    assert moved.direction_id in context["revisionDirectionIds"]
    assert len(context["revisionDirectionIds"]) <= 4
    assert (
        correction["targetTerritoryOptions"][target.territory_id]["remainingSlots"] == 1
    )


def test_direction_revision_context_keeps_missing_fact_replan_local() -> None:
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
    )

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )
    response = _mock_creative_direction_response(
        application,
        landscape=landscape,
        direction_count=13,
    )
    missing_fact_id = mandatory_business_facts(application)[-1].fact_id
    omitted = response.model_copy(
        update={
            "directions": [
                direction.model_copy(
                    update={
                        "fact_applications": [
                            item
                            for item in direction.fact_applications
                            if item.fact_id != missing_fact_id
                        ]
                    }
                )
                for direction in response.directions
            ]
        }
    )

    context = creative_direction_revision_context(
        omitted,
        application,
        validation_error="creative directions did not cover all usable business facts",
        landscape=landscape,
    )

    assert context["missingBusinessFactIds"] == [missing_fact_id]
    assert 1 <= len(context["revisionDirectionIds"]) <= 3
    assert len(context["revisionDirectionIds"]) < len(response.directions)
    missing_option = next(
        item
        for item in context["revisionFactOptions"]
        if item["factId"] == missing_fact_id
    )
    assert missing_option["eligibleDirectionIds"]
    assert set(missing_option["eligibleDirectionIds"]).issubset(
        context["revisionDirectionIds"]
    )


def test_direction_revision_context_repairs_missing_territory_fact_locally() -> None:
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
    )

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )
    response = _mock_creative_direction_response(
        application,
        landscape=landscape,
        direction_count=13,
    )
    territory = next(item for item in landscape.territories if item.required_fact_ids)
    missing_fact_id = territory.required_fact_ids[0]
    omitted = response.model_copy(
        update={
            "directions": [
                direction.model_copy(
                    update={
                        "fact_applications": [
                            item
                            for item in direction.fact_applications
                            if item.fact_id != missing_fact_id
                        ]
                    }
                )
                if direction.territory_id == territory.territory_id
                else direction
                for direction in response.directions
            ]
        }
    )

    context = creative_direction_revision_context(
        omitted,
        application,
        validation_error="creative directions did not cover territory required facts",
        landscape=landscape,
    )

    assert context["missingRequiredFactIdsByTerritory"] == {
        territory.territory_id: [missing_fact_id]
    }
    option = next(
        item
        for item in context["territoryRequiredFactOptions"]
        if item["factId"] == missing_fact_id
        and item["territoryId"] == territory.territory_id
    )
    assert option["eligibleDirectionIds"]
    assert set(option["eligibleDirectionIds"]).issubset(
        context["revisionDirectionIds"]
    )
    assert all(
        next(
            direction
            for direction in omitted.directions
            if direction.direction_id == direction_id
        ).territory_id
        == territory.territory_id
        for direction_id in option["eligibleDirectionIds"]
    )


def test_direction_revision_context_repairs_only_underfilled_directions() -> None:
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
    )

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    seed_fact = mandatory_business_facts(application)[0]
    application = application.model_copy(
        update={
            "adaptive": [
                *application.adaptive,
                *[
                    seed_fact.model_copy(update={"fact_id": f"extra-fact-{index}"})
                    for index in range(20)
                ],
            ]
        }
    )
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="a" * 64,
        template_hash="b" * 64,
        expected_direction_count=13,
    )
    response = _mock_creative_direction_response(application, landscape=landscape)
    target = next(
        direction
        for direction in response.directions
        if len(
            set(
                landscape.by_id[direction.territory_id].compatible_fact_ids
            ).intersection(
                fact.fact_id for fact in mandatory_business_facts(application)
            )
        )
        >= 2
    )
    underfilled = target.model_copy(
        update={"fact_applications": [target.fact_applications[0]]}
    )
    invalid_response = response.model_copy(
        update={
            "directions": [
                underfilled if item.direction_id == target.direction_id else item
                for item in response.directions
            ]
        }
    )

    context = creative_direction_revision_context(
        invalid_response,
        application,
        validation_error=(
            "fact-rich batches require at least two business facts per direction"
        ),
        landscape=landscape,
    )

    assert context["underfilledDirectionIds"] == [target.direction_id]
    assert target.direction_id in context["revisionDirectionIds"]
    assert context["minimumBusinessFactsByDirection"][target.direction_id] == 2
    assert context["businessFactCountsByDirection"][target.direction_id] == 1
    assert context["additionalBusinessFactOptionsByDirection"][target.direction_id]
    assert context["preservedBusinessFactIdsByDirection"][target.direction_id] == [
        fact_id
        for fact_id in underfilled.fact_ids
        if fact_id in {
            fact.fact_id for fact in mandatory_business_facts(application)
        }
    ]
    assert not set(context["revisionRequiredBusinessFactIds"]).intersection(
        context["preservedBusinessFactIdsByDirection"][target.direction_id]
    )


def _cluster_snapshot() -> PromptGenerationSnapshot:
    return _snapshot()


class ConcentratedClusterProvider(MockAiProvider):
    def __init__(self) -> None:
        self.supplement_revision_contexts: list[dict[str, Any] | None] = []

    async def plan_diversity_supplement_directions(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        self.supplement_revision_contexts.append(kwargs.get("revision_context"))
        return await super().plan_diversity_supplement_directions(*args, **kwargs)

    async def evaluate_creatives(
        self,
        candidates: list[Any],
        *,
        target_durations: Any,
        application: Any,
        assigned_context_fact_ids: Any = None,
        fact_visual_strategy: Any = None,
        direction_plan: Any = None,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            target_durations=target_durations,
            application=application,
            assigned_context_fact_ids=assigned_context_fact_ids,
            fact_visual_strategy=fact_visual_strategy,
            direction_plan=direction_plan,
        )
        assert direction_plan is not None
        crowded = direction_plan.directions[0].semantic_profile
        items = [
            item.model_copy(update={"semantic_profile": crowded})
            for item in call.value.items
        ]
        return replace(call, value=call.value.model_copy(update={"items": items}))


class MissingSemanticProfileProvider(MockAiProvider):
    async def evaluate_creatives(
        self,
        candidates: list[Any],
        *,
        target_durations: Any,
        application: Any,
        assigned_context_fact_ids: Any = None,
        fact_visual_strategy: Any = None,
        direction_plan: Any = None,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            target_durations=target_durations,
            application=application,
            assigned_context_fact_ids=assigned_context_fact_ids,
            fact_visual_strategy=fact_visual_strategy,
            direction_plan=direction_plan,
        )
        items = [
            item.model_copy(update={"semantic_profile": None})
            if index % 2 == 0
            else item
            for index, item in enumerate(call.value.items)
        ]
        return replace(call, value=call.value.model_copy(update={"items": items}))


class MissingFactThenReplanningProvider(MockAiProvider):
    def __init__(self) -> None:
        self.revision_contexts: list[dict[str, Any] | None] = []
        self.omission_count = 0

    async def plan_creative_directions(
        self,
        application: Any,
        *,
        fact_visual_strategy: Any,
        target_count: int,
        shared_prompt: Any,
        landscape: Any,
        style_instruction: str,
        delivery_channel: str,
        revision_context: dict[str, Any] | None = None,
    ) -> Any:
        self.revision_contexts.append(revision_context)
        call = await super().plan_creative_directions(
            application,
            fact_visual_strategy=fact_visual_strategy,
            target_count=target_count,
            shared_prompt=shared_prompt,
            landscape=landscape,
            style_instruction=style_instruction,
            delivery_channel=delivery_channel,
            revision_context=revision_context,
        )
        if self.omission_count > 0:
            return call
        required_fact_ids = (
            revision_context.get("requiredBusinessFactIds", [])
            if revision_context is not None
            else []
        )
        missing_fact_id = (
            required_fact_ids[0]
            if required_fact_ids
            else mandatory_business_facts(application)[-1].fact_id
        )
        self.omission_count += 1
        business_facts = mandatory_business_facts(application)
        directions = []
        for direction in call.value.directions:
            applications = [
                item
                for item in direction.fact_applications
                if item.fact_id != missing_fact_id
            ]
            for fallback_fact in business_facts:
                if len(applications) >= 2:
                    break
                if (
                    fallback_fact.fact_id not in {item.fact_id for item in applications}
                    and fallback_fact.fact_id != missing_fact_id
                ):
                    applications.append(
                        CreativeDirectionFactApplication(
                            fact_id=fallback_fact.fact_id,
                            creative_usage="让该事实自然决定人物需求",
                        )
                    )
            directions.append(
                direction.model_copy(update={"fact_applications": applications})
            )
        return replace(
            call, value=call.value.model_copy(update={"directions": directions})
        )


class SemanticAuditThenReplanningProvider(MockAiProvider):
    def __init__(self) -> None:
        self.audit_calls = 0
        self.direction_calls = 0
        self.direction_revision_contexts: list[dict[str, Any] | None] = []

    async def plan_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        self.direction_calls += 1
        self.direction_revision_contexts.append(kwargs.get("revision_context"))
        return await super().plan_creative_directions(*args, **kwargs)

    async def audit_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        self.audit_calls += 1
        call = await super().audit_creative_directions(*args, **kwargs)
        if self.audit_calls > 1:
            return call
        first = call.value.items[0]
        return replace(
            call,
            value=CreativeDirectionAuditResponse(
                items=[
                    first.model_copy(
                        update={
                            "aligned": False,
                            "issues": ["实际主动作与声明版图不一致"],
                        }
                    ),
                    *call.value.items[1:],
                ],
                requires_revision=True,
                revision_direction_ids=[first.direction_id],
                summary="独立语义复核要求重新规划一个方向",
            ),
        )


class SemanticAuditAlwaysAdvisoryProvider(SemanticAuditThenReplanningProvider):
    async def audit_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        self.audit_calls += 1
        call = await MockAiProvider.audit_creative_directions(self, *args, **kwargs)
        first = call.value.items[0]
        return replace(
            call,
            value=CreativeDirectionAuditResponse(
                items=[
                    first.model_copy(
                        update={
                            "aligned": False,
                            "issues": ["实际主动作仍需继续优化"],
                        }
                    ),
                    *call.value.items[1:],
                ],
                requires_revision=True,
                revision_direction_ids=[first.direction_id],
                summary="独立语义复核保留一项非阻断优化建议",
            ),
        )


class ManyDirectionAuditThenReplanningProvider(MockAiProvider):
    def __init__(self) -> None:
        self.revision_batches: list[list[str]] = []
        self.revision_started = False

    async def plan_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        context = kwargs.get("revision_context")
        revision_ids = context.get("revisionDirectionIds", []) if context else []
        if revision_ids:
            self.revision_started = True
            self.revision_batches.append(list(revision_ids))
        return await super().plan_creative_directions(*args, **kwargs)

    async def audit_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        call = await super().audit_creative_directions(*args, **kwargs)
        if self.revision_started:
            return call
        items = [
            item.model_copy(
                update={
                    "aligned": False,
                    "issues": ["与其他方向的实质画面关系重叠"],
                }
            )
            for item in call.value.items
        ]
        return replace(
            call,
            value=CreativeDirectionAuditResponse(
                items=items,
                requires_revision=True,
                revision_direction_ids=[item.direction_id for item in items],
                summary="要求局部修订多个方向",
            ),
        )


class UnknownAuditActionOnceProvider(MockAiProvider):
    def __init__(self) -> None:
        self.invalid_audit_batches = 0
        self.repaired_audit_batches = 0

    async def audit_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        call = await super().audit_creative_directions(*args, **kwargs)
        if kwargs.get("revision_context") is not None:
            self.repaired_audit_batches += 1
            return call
        self.invalid_audit_batches += 1
        first = call.value.items[0]
        return replace(
            call,
            value=call.value.model_copy(
                update={
                    "items": [
                        first.model_copy(
                            update={"realized_action_id": "ACTION_UNKNOWN"}
                        ),
                        *call.value.items[1:],
                    ]
                }
            ),
        )


@pytest.mark.asyncio
async def test_unknown_audit_action_is_retried_inside_the_failed_batch() -> None:
    provider = UnknownAuditActionOnceProvider()
    pipeline = PromptGenerationPipeline(
        api=PromptApi(),  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    result = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert result["prompt_result_id"] == "prompt-result-current"
    assert provider.invalid_audit_batches > 0
    assert provider.repaired_audit_batches == provider.invalid_audit_batches


@pytest.mark.asyncio
async def test_cluster_policy_plans_directions_and_generates_140_percent() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    result = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert result["prompt_result_id"] == "prompt-result-current"
    assert api.result is not None
    assert api.result.metrics.candidate_target_count == 14
    assert api.result.metrics.generated_candidate_count == 16
    assert len(api.result.items) == 10
    creative_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE" and shard.round == 0
        for task in shard.creative_plan
    ]
    assert len(creative_tasks) == 14
    assert all(task.creative_direction is not None for task in creative_tasks)
    assert all(
        task.fact_assignment.fact_ids == task.creative_direction.fact_ids
        for task in creative_tasks
        if task.fact_assignment is not None and task.creative_direction is not None
    )
    counts = Counter(
        task.creative_direction.direction_id
        for task in creative_tasks
        if task.creative_direction is not None
    )
    assert max(counts.values()) - min(counts.values()) <= 1
    creative_stage = next(
        stage
        for stage in api.stages
        if stage.node_id.value == "COHERENT_CREATIVE_GENERATION"
        and "checkpoint" in stage.metadata
    )
    assert creative_stage.metadata["directionCount"] == 8
    assert creative_stage.metadata["checkpoint"]["templateHash"] == (
        CREATIVE_DIRECTION_TEMPLATE_HASH
    )
    selection_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert selection_stage.metadata["clusterAwareNoveltyWeight"] == 0.30
    assert selection_stage.metadata["contentNoveltyWeight"] == 0.70


@pytest.mark.asyncio
async def test_fifty_target_plans_exactly_seventy_initial_candidates() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _cluster_snapshot().model_copy(
        update={
            "settings": PromptBatchSettings(
                target_count=50,
                default_duration_seconds=15,
            )
        }
    )
    pipeline.register_snapshot(runtime, snapshot)
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    shards = await pipeline.plan_creatives(runtime, round_number=0)

    tasks = [task for shard in shards for task in shard.tasks]
    assert len(tasks) == 70
    assert sum(len(shard.tasks) for shard in shards) == 70
    assert all(task.creative_direction is not None for task in tasks)
    direction_counts = Counter(
        task.creative_direction.direction_id
        for task in tasks
        if task.creative_direction is not None
    )
    assert len(direction_counts) == 20
    assert max(direction_counts.values()) <= 4
    assert all(
        task.sibling_variant_total
        == direction_counts[task.creative_direction.direction_id]
        for task in tasks
        if task.creative_direction is not None
    )
    for direction_id, sibling_total in direction_counts.items():
        sibling_indexes = sorted(
            task.sibling_variant_index
            for task in tasks
            if task.creative_direction is not None
            and task.creative_direction.direction_id == direction_id
        )
        assert sibling_indexes == list(range(1, sibling_total + 1))
    assert len(shards) == 20
    assert all(len(shard.tasks) <= 4 for shard in shards)
    shard_indexes_by_direction: dict[str, set[int]] = {}
    for shard_index, shard in enumerate(shards):
        for task in shard.tasks:
            if task.creative_direction is not None:
                shard_indexes_by_direction.setdefault(
                    task.creative_direction.direction_id, set()
                ).add(shard_index)
    assert all(
        len(indexes) == 1
        for direction_id, indexes in shard_indexes_by_direction.items()
    )


@pytest.mark.asyncio
async def test_missing_business_fact_retries_only_its_territory_batch_with_ai() -> (
    None
):
    api = PromptApi()
    provider = MissingFactThenReplanningProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    shards = await pipeline.plan_creatives(runtime, round_number=0)

    assert shards
    assert len(provider.revision_contexts) >= 2
    assert (
        sum(
            bool(item and item.get("requiredDirectionSlots"))
            for item in provider.revision_contexts
        )
        >= 1
    )
    retry_context = next(
        item
        for item in provider.revision_contexts
        if item and item.get("validationError")
    )
    assert retry_context["requiredDirectionSlots"]
    assert retry_context["requiredBusinessFactIds"]
    assert retry_context["revisionDirectionIds"]
    assert retry_context["revisionRequiredBusinessFactIds"] == (
        retry_context["requiredBusinessFactIds"]
    )
    assert retry_context["preservedBusinessFactIdsByDirection"]
    assert retry_context["revisionFactOptions"]
    assert all(
        option["eligibleDirectionIds"]
        for option in retry_context["revisionFactOptions"]
    )
    assert provider.omission_count == 1
    assert all(
        task.fact_assignment is not None
        and task.creative_direction is not None
        and task.fact_assignment.fact_ids == task.creative_direction.fact_ids
        for shard in shards
        for task in shard.tasks
    )


@pytest.mark.asyncio
async def test_independent_ai_semantic_audit_requests_direction_replanning() -> None:
    api = PromptApi()
    provider = SemanticAuditThenReplanningProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    shards = await pipeline.plan_creatives(runtime, round_number=0)

    assert shards
    assert provider.audit_calls == 2
    assert provider.direction_calls == 2
    targeted_context = next(
        context
        for context in provider.direction_revision_contexts
        if context and context.get("revisionDirectionIds")
    )
    assert targeted_context["requiredDirectionSlots"]
    assert all(
        slot["directionId"] in targeted_context["revisionDirectionIds"]
        and slot["territoryId"]
        and slot["primaryActionId"]
        for slot in targeted_context["requiredDirectionSlots"]
    )
    required_fact_ids = set(targeted_context["revisionRequiredBusinessFactIds"])
    assert {
        option["factId"] for option in targeted_context["revisionFactOptions"]
    } == required_fact_ids
    assert all(
        option["eligibleDirectionIds"]
        and set(option["eligibleDirectionIds"]).issubset(
            targeted_context["revisionDirectionIds"]
        )
        for option in targeted_context["revisionFactOptions"]
    )
    plan = pipeline._cache(runtime).creative_direction_plan
    assert plan is not None
    assert plan.semantic_audit is not None
    assert plan.semantic_audit.requires_revision is False
    projected_application, _ = _silent_material_planning_inputs(
        pipeline._require_application(runtime),
        pipeline._required_fact_visual_strategy(runtime),
    )
    all_revision_ids = [direction.direction_id for direction in plan.directions]
    full_revision_context = creative_direction_audit_revision_context(
        plan,
        plan.semantic_audit.model_copy(
            update={
                "requires_revision": True,
                "revision_direction_ids": all_revision_ids,
            }
        ),
        projected_application,
    )
    assert set(full_revision_context["revisionRequiredBusinessFactIds"]) == {
        fact.fact_id
        for fact in mandatory_business_facts(projected_application)
    }
    assert all(
        option["eligibleDirectionIds"]
        for option in full_revision_context["revisionFactOptions"]
    )


@pytest.mark.asyncio
async def test_many_audited_directions_are_revised_in_bounded_batches() -> None:
    api = PromptApi()
    provider = ManyDirectionAuditThenReplanningProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _cluster_snapshot().model_copy(
        update={
            "settings": PromptBatchSettings(
                target_count=50,
                default_duration_seconds=15,
            )
        }
    )
    pipeline.register_snapshot(runtime, snapshot)
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    shards = await pipeline.plan_creatives(runtime, round_number=0)

    assert shards
    assert len(provider.revision_batches) > 1
    assert max(len(batch) for batch in provider.revision_batches) <= 4
    revised_ids = [item for batch in provider.revision_batches for item in batch]
    assert len(revised_ids) == len(set(revised_ids))
    assert len(revised_ids) > 7
    plan = pipeline._cache(runtime).creative_direction_plan
    assert plan is not None
    assert plan.semantic_audit is not None
    assert plan.semantic_audit.requires_revision is False


@pytest.mark.asyncio
async def test_repeated_semantic_audit_disagreement_becomes_advisory() -> None:
    api = PromptApi()
    provider = SemanticAuditAlwaysAdvisoryProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    shards = await pipeline.plan_creatives(runtime, round_number=0)

    assert shards
    assert provider.audit_calls == 2
    assert provider.direction_calls == 2
    plan = pipeline._cache(runtime).creative_direction_plan
    assert plan is not None
    assert plan.semantic_audit is not None
    assert plan.semantic_audit.requires_revision is True
    assert plan.semantic_audit.revision_direction_ids


def test_landscape_validation_is_structural_not_keyword_based() -> None:
    from effect_prompt_generation.providers import _mock_creative_landscape_response

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    raw = _mock_creative_landscape_response(application, direction_count=13)
    landscape = validate_creative_diversity_landscape(
        raw,
        application,
        source_hash="1" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        expected_direction_count=13,
    )
    assert sum(item.target_slots for item in landscape.territories) == 13
    required_ids = [
        fact_id
        for territory in landscape.territories
        for fact_id in territory.required_fact_ids
    ]
    assert len(required_ids) == len(set(required_ids))
    business_ids = {fact.fact_id for fact in mandatory_business_facts(application)}
    assert set(required_ids) == business_ids
    compatible_ids = {
        fact_id
        for territory in landscape.territories
        for fact_id in territory.compatible_fact_ids
    }
    assert business_ids.issubset(compatible_ids)

    compatible_only = CreativeDiversityLandscapeResponse(
        territories=[
            raw.territories[0].model_copy(
                update={"required_fact_ids": raw.territories[0].required_fact_ids[1:]}
            ),
            *raw.territories[1:],
        ]
    )
    with pytest.raises(ValueError, match="assign every business fact once"):
        validate_creative_diversity_landscape(
            compatible_only,
            application,
            source_hash="1" * 64,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
            expected_direction_count=13,
        )


def test_ai_fact_assignments_are_merged_and_checked_mechanically() -> None:
    from effect_prompt_generation.providers import _mock_creative_landscape_response

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    planned = _mock_creative_landscape_response(application, direction_count=13)
    base = CreativeDiversityLandscapeResponse(
        territories=[
            territory.model_copy(update={"required_fact_ids": []})
            for territory in planned.territories
        ]
    )
    assignments = CreativeFactTerritoryAssignmentResponse(
        assignments=[
            CreativeFactTerritoryAssignment(
                fact_id=fact_id,
                territory_id=territory.territory_id,
                natural_usage="由该事实直接决定本空间的商业表达",
            )
            for territory in planned.territories
            for fact_id in territory.required_fact_ids
            if fact_id
            in {fact.fact_id for fact in mandatory_business_facts(application)}
        ]
    )

    compiled = compile_creative_landscape_assignments(
        base,
        assignments,
        application,
        source_hash="1" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        expected_direction_count=13,
    )

    assert sum(item.target_slots for item in compiled.territories) == 13
    assert {
        fact_id
        for territory in compiled.territories
        for fact_id in territory.required_fact_ids
    } == {fact.fact_id for fact in mandatory_business_facts(application)}

    invalid = assignments.model_copy(
        update={
            "assignments": [
                assignments.assignments[0].model_copy(
                    update={"territory_id": "UNKNOWN_TERRITORY"}
                ),
                *assignments.assignments[1:],
            ]
        }
    )
    with pytest.raises(ValueError, match="unknown territory"):
        compile_creative_landscape_assignments(
            base,
            invalid,
            application,
            source_hash="1" * 64,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
            expected_direction_count=13,
        )

    raw = planned
    assert all(
        "targetSlots" not in territory.model_dump(mode="json", by_alias=True)
        for territory in raw.territories
    )

    duplicated_required = raw.territories[0].required_fact_ids[0]
    duplicate_assignment = CreativeDiversityLandscapeResponse(
        territories=[
            raw.territories[0],
            raw.territories[1].model_copy(
                update={
                    "required_fact_ids": [
                        *raw.territories[1].required_fact_ids,
                        duplicated_required,
                    ],
                    "compatible_fact_ids": [
                        *raw.territories[1].compatible_fact_ids,
                        duplicated_required,
                    ],
                    "fact_compatibilities": [
                        *(raw.territories[1].fact_compatibilities or []),
                        next(
                            item
                            for item in raw.territories[0].fact_compatibilities or []
                            if item.fact_id == duplicated_required
                        ),
                    ],
                }
            ),
            *raw.territories[2:],
        ]
    )
    with pytest.raises(ValueError, match="repeats a required fact"):
        validate_creative_diversity_landscape(
            duplicate_assignment,
            application,
            source_hash="1" * 64,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
            expected_direction_count=13,
        )


class LandscapeAuditThenReplanningProvider(MockAiProvider):
    def __init__(self) -> None:
        self.audit_calls = 0
        self.landscape_calls = 0
        self.revision_contexts: list[dict[str, Any] | None] = []
        self.assignment_calls = 0
        self.assignment_revision_contexts: list[dict[str, Any] | None] = []

    async def plan_creative_landscape(self, *args: Any, **kwargs: Any) -> Any:
        self.landscape_calls += 1
        self.revision_contexts.append(kwargs.get("revision_context"))
        return await super().plan_creative_landscape(*args, **kwargs)

    async def assign_creative_landscape_facts(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        self.assignment_calls += 1
        self.assignment_revision_contexts.append(kwargs.get("revision_context"))
        return await super().assign_creative_landscape_facts(*args, **kwargs)

    async def audit_creative_landscape(self, *args: Any, **kwargs: Any) -> Any:
        self.audit_calls += 1
        call = await super().audit_creative_landscape(*args, **kwargs)
        if self.audit_calls > 1:
            return call
        landscape = kwargs["landscape"]
        territory = landscape.territories[0]
        fact_id = territory.compatible_fact_ids[0]
        return replace(
            call,
            value=CreativeLandscapeAuditResponse(
                reviewed_territory_ids=[
                    item.territory_id for item in landscape.territories
                ],
                fact_issues=[
                    CreativeLandscapeFactIssue(
                        territory_id=territory.territory_id,
                        fact_id=fact_id,
                        verdict="UNSUPPORTED",
                        reason="该事实依赖资料未确认的画面条件",
                    )
                ],
                requires_revision=True,
                revision_territory_ids=[territory.territory_id],
                summary="批量复核要求修订一个创意空间",
            ),
        )


class WeakTerritoryAuditProvider(LandscapeAuditThenReplanningProvider):
    async def audit_creative_landscape(self, *args: Any, **kwargs: Any) -> Any:
        self.audit_calls += 1
        call = await MockAiProvider.audit_creative_landscape(
            self, *args, **kwargs
        )
        if self.audit_calls > 1:
            return call
        landscape = kwargs["landscape"]
        territory = landscape.territories[0]
        fact_id = territory.compatible_fact_ids[0]
        return replace(
            call,
            value=CreativeLandscapeAuditResponse(
                reviewed_territory_ids=[
                    item.territory_id for item in landscape.territories
                ],
                fact_issues=[
                    CreativeLandscapeFactIssue(
                        territory_id=territory.territory_id,
                        fact_id=fact_id,
                        verdict="WEAK",
                        reason="关系可以使用，但创意承载仍可更自然",
                    )
                ],
                requires_revision=False,
                revision_territory_ids=[],
                summary="存在一项偏弱但不依赖未确认条件的关系",
            ),
        )


class TransientTerritoryAuditProvider(MockAiProvider):
    def __init__(self) -> None:
        self.audit_calls = 0

    async def audit_creative_landscape(self, *args: Any, **kwargs: Any) -> Any:
        self.audit_calls += 1
        if self.audit_calls == 1:
            raise ProviderError(
                "temporary landscape audit timeout",
                retryable=True,
                error_type=ProviderErrorType.TIMEOUT,
            )
        return await super().audit_creative_landscape(*args, **kwargs)


class StructuralThenSemanticLandscapeProvider(LandscapeAuditThenReplanningProvider):
    async def assign_creative_landscape_facts(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        call = await super().assign_creative_landscape_facts(*args, **kwargs)
        if self.assignment_calls != 1:
            return call
        assignments = call.value.assignments
        return replace(
            call,
            value=CreativeFactTerritoryAssignmentResponse(
                assignments=[assignments[0], assignments[0], *assignments[2:]]
            ),
        )


class InvalidJsonDuringSemanticReplanProvider(LandscapeAuditThenReplanningProvider):
    async def assign_creative_landscape_facts(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        if self.assignment_calls == 1:
            self.assignment_calls += 1
            self.assignment_revision_contexts.append(kwargs.get("revision_context"))
            raise ProviderError(
                "truncated fact assignment json",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        return await super().assign_creative_landscape_facts(*args, **kwargs)


class StructuralThenInvalidAssignmentProvider(LandscapeAuditThenReplanningProvider):
    async def assign_creative_landscape_facts(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        if self.assignment_calls == 0:
            call = await super().assign_creative_landscape_facts(*args, **kwargs)
            assignments = call.value.assignments
            return replace(
                call,
                value=CreativeFactTerritoryAssignmentResponse(
                    assignments=[assignments[0], assignments[0], *assignments[2:]]
                ),
            )
        if self.assignment_calls == 1:
            self.assignment_calls += 1
            self.assignment_revision_contexts.append(kwargs.get("revision_context"))
            raise ProviderError(
                "malformed fact assignment json",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        return await super().assign_creative_landscape_facts(*args, **kwargs)


class TwiceTransientTerritoryAuditProvider(MockAiProvider):
    def __init__(self) -> None:
        self.audit_calls = 0

    async def audit_creative_landscape(self, *args: Any, **kwargs: Any) -> Any:
        self.audit_calls += 1
        if self.audit_calls == 1:
            raise ProviderError(
                "temporary landscape audit network error",
                retryable=True,
                error_type=ProviderErrorType.NETWORK,
            )
        return await super().audit_creative_landscape(*args, **kwargs)


@pytest.mark.asyncio
async def test_landscape_semantic_audit_replans_before_direction_generation() -> None:
    api = PromptApi()
    provider = LandscapeAuditThenReplanningProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    await pipeline.plan_creatives(runtime, round_number=0)

    assert provider.landscape_calls == 1
    assert provider.assignment_calls == 2
    assert provider.audit_calls >= 2
    assert provider.revision_contexts[0] is None
    assert provider.assignment_revision_contexts[0] is None
    assert provider.assignment_revision_contexts[1]
    assert "semanticAudit" in provider.assignment_revision_contexts[1]
    assert "previousAssignments" in provider.assignment_revision_contexts[1]


@pytest.mark.asyncio
async def test_weak_landscape_finding_is_advisory_and_does_not_replan() -> None:
    api = PromptApi()
    provider = WeakTerritoryAuditProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    await pipeline.plan_creatives(runtime, round_number=0)

    assert provider.landscape_calls == 1
    assert provider.assignment_calls == 1
    assert provider.audit_calls >= 1
    assert provider.assignment_revision_contexts == [None]


@pytest.mark.asyncio
async def test_transient_landscape_audit_retries_the_compact_batch_once() -> None:
    api = PromptApi()
    provider = TransientTerritoryAuditProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    await pipeline.plan_creatives(runtime, round_number=0)

    assert provider.audit_calls == 2


@pytest.mark.asyncio
async def test_structure_repair_does_not_consume_semantic_replan_budget() -> None:
    api = PromptApi()
    provider = StructuralThenSemanticLandscapeProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    await pipeline.plan_creatives(runtime, round_number=0)

    assert provider.landscape_calls == 1
    assert provider.assignment_calls == 3
    assert provider.assignment_revision_contexts[1]
    assert "validationError" in provider.assignment_revision_contexts[1]
    assert provider.assignment_revision_contexts[2]
    assert "semanticAudit" in provider.assignment_revision_contexts[2]


@pytest.mark.asyncio
async def test_invalid_landscape_json_retries_without_consuming_semantic_replan() -> (
    None
):
    api = PromptApi()
    provider = InvalidJsonDuringSemanticReplanProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    await pipeline.plan_creatives(runtime, round_number=0)

    assert provider.landscape_calls == 1
    assert provider.assignment_calls == 3
    assert provider.assignment_revision_contexts[1]
    assert provider.assignment_revision_contexts[2]
    assert "semanticAudit" in provider.assignment_revision_contexts[2]


@pytest.mark.asyncio
async def test_fact_assignment_invalid_json_retries_without_replanning_landscape() -> None:
    api = PromptApi()
    provider = StructuralThenInvalidAssignmentProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    await pipeline.plan_creatives(runtime, round_number=0)

    assert provider.landscape_calls == 1
    assert provider.assignment_calls == 4
    assert provider.assignment_revision_contexts[1]
    assert provider.assignment_revision_contexts[2]


@pytest.mark.asyncio
async def test_landscape_audit_has_one_local_retry_before_task_failure() -> None:
    api = PromptApi()
    provider = TwiceTransientTerritoryAuditProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    await pipeline.plan_creatives(runtime, round_number=0)

    assert provider.audit_calls == 2


def test_landscape_requires_ai_fact_compatibility_guidance() -> None:
    from effect_prompt_generation.providers import _mock_creative_landscape_response

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    raw = _mock_creative_landscape_response(application, direction_count=13)
    missing_guidance = CreativeDiversityLandscapeResponse(
        territories=[
            raw.territories[0].model_copy(update={"fact_compatibilities": []}),
            *raw.territories[1:],
        ]
    )

    with pytest.raises(ValueError, match="omitted fact compatibility guidance"):
        validate_creative_diversity_landscape(
            missing_guidance,
            application,
            source_hash="1" * 64,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
            expected_direction_count=13,
        )

    first = raw.territories[0]
    mismatched_guidance = CreativeDiversityLandscapeResponse(
        territories=[
            first.model_copy(
                update={
                    "fact_compatibilities": first.fact_compatibilities[:-1]
                    if first.fact_compatibilities
                    else [],
                }
            ),
            *raw.territories[1:],
        ]
    )
    with pytest.raises(ValueError, match="guidance must match compatible facts"):
        validate_creative_diversity_landscape(
            mismatched_guidance,
            application,
            source_hash="1" * 64,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
            expected_direction_count=13,
        )


def test_landscape_audit_cannot_hide_a_reported_fact_issue() -> None:
    from effect_prompt_generation.providers import (
        _mock_creative_landscape_audit,
        _mock_creative_landscape_response,
    )

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    raw = _mock_creative_landscape_response(application, direction_count=13)
    landscape = validate_creative_diversity_landscape(
        raw,
        application,
        source_hash="1" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        expected_direction_count=13,
    )
    audit = _mock_creative_landscape_audit(landscape)
    first_territory_id = landscape.territories[0].territory_id
    fact_id = landscape.territories[0].compatible_fact_ids[0]
    inconsistent = audit.model_copy(
        update={
            "fact_issues": [
                CreativeLandscapeFactIssue(
                    territory_id=first_territory_id,
                    fact_id=fact_id,
                    verdict="WEAK",
                    reason="该事实只能被口头硬解释",
                )
            ]
        }
    )

    with pytest.raises(ValueError, match="ignored a semantic issue"):
        validate_creative_landscape_audit(inconsistent, landscape)

    revised = inconsistent.model_copy(
        update={
            "requires_revision": True,
            "revision_territory_ids": [first_territory_id],
        }
    )
    assert validate_creative_landscape_audit(revised, landscape).requires_revision


def test_ai_audit_must_review_every_fact_and_request_revision_for_weak_fit() -> None:
    from effect_prompt_generation.providers import (
        _mock_creative_direction_audit,
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
        _mock_fact_visual_strategy,
    )
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    raw_landscape = _mock_creative_landscape_response(application, direction_count=13)
    landscape = validate_creative_diversity_landscape(
        raw_landscape,
        application,
        source_hash="1" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        expected_direction_count=13,
    )
    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="2" * 64,
        template_hash="3" * 64,
    )
    raw_directions = _mock_creative_direction_response(
        application,
        landscape=landscape,
    )
    plan = validate_creative_direction_plan(
        raw_directions,
        application,
        strategy,
        source_hash="1" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        expected_direction_count=13,
        landscape=landscape,
    )
    raw_audit = _mock_creative_direction_audit(landscape, raw_directions)
    first_item = raw_audit.items[0]
    assert first_item.fact_reviews
    weak_review = first_item.fact_reviews[0].model_copy(
        update={
            "verdict": "WEAK",
            "reason": "当前场景只能口头解释该事实，无法自然承载",
        }
    )
    inconsistent = raw_audit.model_copy(
        update={
            "items": [
                first_item.model_copy(
                    update={
                        "fact_reviews": [weak_review, *first_item.fact_reviews[1:]],
                    }
                ),
                *raw_audit.items[1:],
            ]
        }
    )
    normalized = validate_creative_direction_audit(inconsistent, plan, landscape)
    assert normalized.requires_revision is True
    assert normalized.revision_direction_ids == [first_item.direction_id]

    revised = inconsistent.model_copy(
        update={
            "items": [
                inconsistent.items[0].model_copy(
                    update={"aligned": False, "issues": ["事实关系牵强"]}
                ),
                *inconsistent.items[1:],
            ],
            "requires_revision": True,
            "revision_direction_ids": [first_item.direction_id],
        }
    )
    validated = validate_creative_direction_audit(revised, plan, landscape)
    assert validated.requires_revision is True
    assert validated.revision_direction_ids == [first_item.direction_id]

    batch_distribution_revision = raw_audit.model_copy(
        update={
            "requires_revision": True,
            "revision_direction_ids": [first_item.direction_id],
            "summary": "整批创意分布需要调整",
        }
    )
    batch_validated = validate_creative_direction_audit(
        batch_distribution_revision,
        plan,
        landscape,
    )
    assert batch_validated.requires_revision is True
    assert batch_validated.revision_direction_ids == [first_item.direction_id]


def test_direction_revision_mechanically_preserves_unflagged_directions() -> None:
    from effect_prompt_generation.providers import _mock_creative_direction_response

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    previous = _mock_creative_direction_response(application, direction_count=8)
    revised = previous.model_copy(
        update={
            "directions": [
                direction.model_copy(
                    update={
                        "creative_direction": (
                            f"模型修订后的方向 {direction.direction_id}"
                        )
                    }
                )
                for direction in previous.directions
            ]
        }
    )
    flagged_id = previous.directions[0].direction_id
    merged = merge_creative_direction_revision(previous, revised, [flagged_id])

    assert merged.directions[0].creative_direction.startswith("模型修订后的方向")
    assert merged.directions[1:] == previous.directions[1:]

    partial_revision = revised.model_copy(
        update={"directions": [revised.directions[0]]}
    )
    partial_merged = merge_creative_direction_revision(
        previous,
        partial_revision,
        [flagged_id],
    )
    assert partial_merged == merged


def test_landscape_revision_mechanically_preserves_unflagged_territories() -> None:
    from effect_prompt_generation.providers import _mock_creative_landscape_response

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    previous = _mock_creative_landscape_response(application, direction_count=13)
    flagged_id = previous.territories[0].territory_id
    revised_territory = previous.territories[0].model_copy(
        update={"label": "模型局部修订后的创意空间"}
    )
    partial = CreativeDiversityLandscapeResponse(territories=[revised_territory])

    merged = merge_creative_landscape_territory_revision(
        previous,
        partial,
        [flagged_id],
    )

    assert merged.territories[0].label == "模型局部修订后的创意空间"
    assert merged.territories[1:] == previous.territories[1:]
    assert len(merged.territories) == len(previous.territories)

    with pytest.raises(ValueError, match="every requested territory once"):
        merge_creative_landscape_territory_revision(
            previous,
            CreativeDiversityLandscapeResponse(
                territories=[previous.territories[1]]
            ),
            [flagged_id],
        )


def test_direction_audit_accepts_structured_direction_issue_as_revision_reason() -> (
    None
):
    from effect_prompt_generation.providers import (
        _mock_creative_direction_audit,
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
        _mock_fact_visual_strategy,
    )
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy

    application = map_insight(_cluster_snapshot().insight_artifact.result)
    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="2" * 64,
        template_hash="3" * 64,
    )
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=13),
        application,
        source_hash="1" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        expected_direction_count=13,
    )
    raw_directions = _mock_creative_direction_response(
        application,
        direction_count=13,
        landscape=landscape,
    )
    plan = validate_creative_direction_plan(
        raw_directions,
        application,
        strategy,
        source_hash="1" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        expected_direction_count=13,
        landscape=landscape,
    )
    raw_audit = _mock_creative_direction_audit(landscape, raw_directions)
    first_item = raw_audit.items[0]
    response = raw_audit.model_copy(
        update={
            "items": [
                first_item.model_copy(update={"issues": ["主动作关系需要调整"]}),
                *raw_audit.items[1:],
            ],
            "requires_revision": True,
            "revision_direction_ids": [first_item.direction_id],
        }
    )

    validated = validate_creative_direction_audit(response, plan, landscape)

    assert validated.requires_revision is True
    assert validated.revision_direction_ids == [first_item.direction_id]


@pytest.mark.asyncio
async def test_quantity_supplement_respects_total_candidate_ceiling() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    initial = await pipeline.plan_creatives(runtime, round_number=0)
    initial_tasks = [task for shard in initial for task in shard.tasks]
    cache = pipeline._cache(runtime)
    cache.creatives = {
        task.slot_id: CreativeCandidate(
            slot_id=task.slot_id,
            ordinal=task.ordinal,
            round=0,
            creative_core=f"创意 {task.ordinal}：产品关联",
            declared_fact_ids=task.fact_assignment.fact_ids,
            fact_evidence=[
                {
                    "factId": fact_id,
                    "evidenceText": "产品关联",
                    "evidenceSource": "PRODUCT_RELATION",
                }
                for fact_id in task.fact_assignment.fact_ids
            ],
            dimensions=CreativeDimensions(
                narrative="连续叙事",
                scene="真实场景",
                persona="成年人",
                product_relation="产品动作",
                camera="稳定跟拍",
                emotion="自然",
            ),
            content=f"真实产品在一个连续场景中完成清晰可执行的展示动作，候选编号 {task.ordinal}",
        )
        for task in initial_tasks
        if task.fact_assignment is not None
    }

    supplement = await pipeline.plan_creatives(
        runtime,
        round_number=1,
        missing_count=10,
    )

    # A 10-item target starts with 14 candidates. Every supplement shares the
    # 18-item batch ceiling, so quantity recovery may request only four more.
    assert sum(len(shard.tasks) for shard in supplement) == 4


@pytest.mark.asyncio
async def test_coverage_supplement_targets_the_missing_business_fact() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _cluster_snapshot()
    pipeline.register_snapshot(runtime, snapshot)
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    application = map_insight(snapshot.insight_artifact.result)
    missing_fact = next(
        fact for fact in application.required if fact.field.value == "CORE_PAIN_POINT"
    )

    supplement = await pipeline.plan_creatives(
        runtime,
        round_number=1,
        requested_count=2,
        supplement_kind="COVERAGE",
        coverage_fact_ids=[missing_fact.fact_id],
    )
    tasks = [task for shard in supplement for task in shard.tasks]

    assert len(tasks) == 2
    assert all(
        task.fact_assignment is not None
        and missing_fact.fact_id in task.fact_assignment.fact_ids
        and task.coverage_focus_fact_ids == [missing_fact.fact_id]
        and task.supplement_kind == "COVERAGE"
        for task in tasks
    )


@pytest.mark.asyncio
async def test_cluster_concentration_triggers_one_soft_diversity_supplement() -> None:
    api = PromptApi()
    provider = ConcentratedClusterProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert api.result.metrics.generated_candidate_count == 16
    diversity_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
        if task.supplement_kind == "DIVERSITY"
    ]
    assert len(diversity_tasks) == 2
    assert {task.round for task in diversity_tasks} == {1}
    final_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert final_stage.metadata["diversitySupplementTriggered"] is True
    assert final_stage.metadata["diversitySupplementCount"] == 2
    assert "SEMANTIC_DIVERSITY_CAN_BE_IMPROVED" in final_stage.warnings
    assert provider.supplement_revision_contexts
    first_context = provider.supplement_revision_contexts[0]
    if first_context is not None:
        assert first_context["vectorCrowdedExamples"]


@pytest.mark.asyncio
async def test_missing_semantic_profiles_do_not_fail_the_batch() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MissingSemanticProfileProvider(),
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    result = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert result["prompt_result_id"] == "prompt-result-current"
    assert api.result is not None
    assert len(api.result.items) == 10
    evaluations = [
        evaluation for shard in api.shards.values() for evaluation in shard.evaluations
    ]
    assert evaluations
    assert all(evaluation.semantic_profile is not None for evaluation in evaluations)


def test_direction_plan_rejects_unknown_facts_and_balances_allocations() -> None:
    application = map_insight(_cluster_snapshot().insight_artifact.result)
    provider = MockAiProvider()
    response = provider  # keep construction below explicit and synchronous
    del response
    from effect_prompt_generation.providers import _mock_creative_direction_response
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy
    from effect_prompt_generation.providers import _mock_fact_visual_strategy

    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="source",
        template_hash="0" * 64,
    )
    raw = _mock_creative_direction_response(application)
    source_hash = creative_direction_source_hash(
        insight_content_hash="insight",
        visual_strategy_hash=strategy.strategy_hash,
        shared_prompt_hash="shared",
        target_count=50,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    plan = validate_creative_direction_plan(
        raw,
        application,
        strategy,
        source_hash=source_hash,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    with pytest.raises(ValueError, match="count does not match"):
        validate_creative_direction_plan(
            raw,
            application,
            strategy,
            source_hash=source_hash,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
            expected_direction_count=13,
        )
    planned_fact_ids = {
        fact_id for direction in plan.directions for fact_id in direction.fact_ids
    }
    business_fact_ids = {fact.fact_id for fact in mandatory_business_facts(application)}
    assert business_fact_ids.issubset(planned_fact_ids)
    business_counts = [
        len(business_fact_ids.intersection(direction.fact_ids))
        for direction in plan.directions
    ]
    if len(business_fact_ids) >= len(plan.directions) * 2:
        assert all(2 <= count <= 4 for count in business_counts)
    elif len(business_fact_ids) >= len(plan.directions):
        assert all(1 <= count <= 4 for count in business_counts)
    else:
        assert sum(count > 0 for count in business_counts) >= len(business_fact_ids)
    assert all(
        application.by_id[item.fact_id].value not in {"", item.creative_usage}
        for direction in plan.directions
        for item in direction.fact_applications
    )
    allocated = allocate_creative_directions(
        plan,
        count=70,
        ordinal_start=1,
    )
    counts = Counter(item.direction_id for item in allocated)
    assert max(counts.values()) - min(counts.values()) <= 1
    assert max(counts.values()) <= 9
    invalid = raw.model_copy(
        update={
            "directions": [
                raw.directions[0].model_copy(
                    update={
                        "fact_applications": [
                            CreativeDirectionFactApplication(
                                fact_id="unknown-fact",
                                creative_usage="让未知事实决定当前方向的场景",
                            ),
                            *raw.directions[0].fact_applications[1:],
                        ]
                    }
                ),
                *raw.directions[1:],
            ]
        }
    )
    with pytest.raises(ValueError, match="unavailable fact"):
        validate_creative_direction_plan(
            CreativeDirectionResponse.model_validate(invalid),
            application,
            strategy,
            source_hash=source_hash,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        )

    omitted_fact_id = mandatory_business_facts(application)[-1].fact_id
    replacement_facts = [
        fact
        for fact in mandatory_business_facts(application)
        if fact.fact_id != omitted_fact_id
    ]
    omitted_directions = []
    for direction in raw.directions:
        applications = [
            item
            for item in direction.fact_applications
            if item.fact_id != omitted_fact_id
        ]
        for replacement in replacement_facts:
            if len(applications) >= 2:
                break
            if replacement.fact_id not in {item.fact_id for item in applications}:
                applications.append(
                    CreativeDirectionFactApplication(
                        fact_id=replacement.fact_id,
                        creative_usage="让替代事实自然决定人物或场景",
                    )
                )
        omitted_directions.append(
            direction.model_copy(update={"fact_applications": applications})
        )
    omitted = raw.model_copy(update={"directions": omitted_directions})
    with pytest.raises(ValueError, match="did not cover all usable business facts"):
        validate_creative_direction_plan(
            CreativeDirectionResponse.model_validate(omitted),
            application,
            strategy,
            source_hash=source_hash,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        )

    repeated_directions = [
        direction.model_copy(
            update={
                "creative_direction": f"在家庭餐桌完成端上产品的变化{index + 1}",
                "semantic_profile": direction.semantic_profile.model_copy(
                    update={
                        "scene_family": "家庭餐桌",
                        "product_action_family": "端上产品",
                    }
                ),
            }
        )
        if index < 3
        else direction
        for index, direction in enumerate(raw.directions)
    ]
    repeated = raw.model_copy(update={"directions": repeated_directions})
    # Worker no longer interprets free-text scene/action labels. An independent
    # AI audit owns the semantic decision and asks the planner for revision.
    repeated_plan = validate_creative_direction_plan(
        CreativeDirectionResponse.model_validate(repeated),
        application,
        strategy,
        source_hash=source_hash,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    assert len(repeated_plan.directions) == len(raw.directions)


def test_direction_bucket_uses_ai_owned_stable_ids_not_free_text() -> None:
    plan = _direction_plan_for_semantic_tests()
    direction = plan.directions[0].model_copy(
        update={
            "semantic_profile": plan.directions[0].semantic_profile.model_copy(
                update={
                    "scene_family": "任意同义场景文字",
                    "product_action_family": "任意同义动作文字",
                }
            )
        }
    )

    assert direction_allocation_bucket(direction) == (
        direction.territory_id,
        direction.primary_action_id,
    )


def test_semantic_novelty_uses_product_independent_scene_and_action_families() -> None:
    left = CreativeSemanticProfile(
        narrative_family="问题发现",
        scene_family="浴室洗护区",
        persona_family="长发用户",
        product_action_family="按压泵头取用",
        camera_family="手部近景",
        emotion_family="清爽轻快",
    )
    right = CreativeSemanticProfile(
        narrative_family="效果体验",
        scene_family="浴室洗护区",
        persona_family="短发用户",
        product_action_family="按压泵头取用",
        camera_family="肩后跟拍",
        emotion_family="从容治愈",
    )

    # Scene and product action carry half of the cluster weight for every
    # product domain; no shampoo-specific verb dictionary is involved.
    assert semantic_cluster_novelty(left, right) == 50.0
    assert semantic_cluster_novelty(left, left) == 0.0


def test_unknown_semantic_family_does_not_fake_a_crowded_business_cluster() -> None:
    unknown = CreativeSemanticProfile(
        narrative_family="OTHER",
        scene_family="OTHER",
        persona_family="OTHER",
        product_action_family="OTHER",
        camera_family="OTHER",
        emotion_family="OTHER",
    )
    evaluations = [
        _evaluation_for_semantic_tests(semantic_profile=unknown).model_copy(
            update={"slot_id": f"unknown-{index}"}
        )
        for index in range(5)
    ]

    assert max_cluster_share(evaluations, "scene_family") == 0.0
    assert dominant_families(evaluations, "scene_family") == []


def test_direction_allocation_caps_each_dynamic_direction() -> None:
    plan = _direction_plan_for_semantic_tests()
    scene_labels = [
        "家庭厨房灶台",
        "岭南厨房",
        "砂锅台面备餐",
        "家庭砧板",
        "家宴餐桌",
        "团圆饭围桌",
        "超市货架",
        "门店选购",
    ]
    directions = [
        direction.model_copy(
            update={
                "semantic_profile": direction.semantic_profile.model_copy(
                    update={"scene_family": scene_labels[index]}
                )
            }
        )
        for index, direction in enumerate(plan.directions)
    ]
    plan = plan.model_copy(update={"directions": directions})

    allocated = allocate_creative_directions(
        plan,
        count=12,
        ordinal_start=1,
    )
    direction_counts = Counter(item.direction_id for item in allocated)

    assert max(direction_counts.values()) - min(direction_counts.values()) <= 1
    assert max(direction_counts.values()) <= 2


def test_direction_allocation_prevents_single_dining_direction_from_taking_23_of_70() -> (
    None
):
    plan = _direction_plan_for_semantic_tests()
    scene_action_rows = [
        ("家庭厨房灶台", "整根放入煲仔饭烹制"),
        ("家庭厨房蒸制区", "整根上屉蒸制观察"),
        ("新春家庭玄关", "袋装整袋递赠送礼"),
        ("家庭厨房炒锅旁", "切段下锅翻炒"),
        ("家庭餐桌", "煲仔饭开盖展示"),
        ("家庭备餐台面", "少量切片展示切面"),
        ("家庭备餐区", "整根摆入家宴备菜盘"),
        ("居家客厅会客区", "袋装双手递赠"),
    ]
    directions = [
        direction.model_copy(
            update={
                "semantic_profile": direction.semantic_profile.model_copy(
                    update={
                        "scene_family": scene,
                        "product_action_family": action,
                    }
                ),
                "creative_direction": f"在{scene}完成{action}",
            }
        )
        for direction, (scene, action) in zip(
            plan.directions,
            scene_action_rows,
            strict=True,
        )
    ]
    plan = plan.model_copy(update={"directions": directions})

    allocated = allocate_creative_directions(plan, count=70, ordinal_start=1)
    direction_counts = Counter(item.direction_id for item in allocated)
    bucket_counts = Counter(direction_allocation_bucket(item) for item in allocated)

    assert len(direction_counts) == 8
    assert min(direction_counts.values()) == 8
    assert max(direction_counts.values()) == 9
    assert direction_counts[directions[4].direction_id] <= 9
    assert max(bucket_counts.values()) < 23


def test_direction_checkpoint_round_trip_parses_worker_plan() -> None:
    application = map_insight(_cluster_snapshot().insight_artifact.result)
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_fact_visual_strategy,
    )
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy

    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="source",
        template_hash="0" * 64,
    )
    source_hash = "a" * 64
    plan = validate_creative_direction_plan(
        _mock_creative_direction_response(application),
        application,
        strategy,
        source_hash=source_hash,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    checkpoint = StrategyCheckpoint.model_validate(
        {
            "nodeId": "COHERENT_CREATIVE_GENERATION",
            "sourceFingerprint": source_hash,
            "allocationHash": plan.plan_hash,
            "templateHash": plan.template_hash,
            "plan": plan.model_dump(mode="json", by_alias=True),
        }
    )
    assert checkpoint.plan == plan


def test_semantic_profile_only_accepts_dynamic_vocabulary_or_other() -> None:
    application = map_insight(_cluster_snapshot().insight_artifact.result)
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_fact_visual_strategy,
    )
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy

    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="source",
        template_hash="0" * 64,
    )
    plan = validate_creative_direction_plan(
        _mock_creative_direction_response(application),
        application,
        strategy,
        source_hash="b" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    base = plan.directions[0].semantic_profile
    evaluation = CreativeEvaluation(
        slot_id="candidate-1",
        primary_purpose=FragmentType.HOOK,
        compatible_purposes=[FragmentType.HOOK],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=90,
            visual_clarity=90,
        ),
        semantic_signature="semantic",
        visual_signature="visual",
        semantic_profile=base,
    )
    validate_semantic_profile(evaluation, plan)

    unknown = evaluation.model_copy(
        update={
            "semantic_profile": CreativeSemanticProfile(
                narrative_family=base.narrative_family,
                scene_family="不在本批动态词表内",
                persona_family=base.persona_family,
                product_action_family=base.product_action_family,
                camera_family=base.camera_family,
                emotion_family=base.emotion_family,
            )
        }
    )
    with pytest.raises(ValueError, match="unknown scene_family"):
        validate_semantic_profile(unknown, plan)

    other = unknown.model_copy(
        update={
            "semantic_profile": unknown.semantic_profile.model_copy(
                update={"scene_family": "OTHER"}
            )
        }
    )
    validate_semantic_profile(other, plan)


def test_missing_semantic_profile_becomes_other_without_character_guessing() -> None:
    plan = _direction_plan_for_semantic_tests()
    profile = plan.directions[0].semantic_profile
    candidate = _candidate_for_semantic_tests(profile)
    evaluation = _evaluation_for_semantic_tests(semantic_profile=None)

    completed = complete_semantic_profile(evaluation, candidate, plan)

    assert completed.semantic_profile == CreativeSemanticProfile(
        narrative_family="OTHER",
        scene_family="OTHER",
        persona_family="OTHER",
        product_action_family="OTHER",
        camera_family="OTHER",
        emotion_family="OTHER",
    )
    validate_semantic_profile(completed, plan)


def test_partial_semantic_profile_preserves_valid_labels_and_marks_unknown_other() -> (
    None
):
    plan = _direction_plan_for_semantic_tests()
    profile = plan.directions[0].semantic_profile
    candidate = _candidate_for_semantic_tests(profile)
    evaluation = CreativeEvaluation.model_validate(
        {
            **_evaluation_for_semantic_tests(semantic_profile=None).model_dump(
                mode="json", by_alias=True, exclude={"semantic_profile"}
            ),
            "semanticProfile": {
                "narrativeFamily": profile.narrative_family,
                "sceneFamily": "",
                "personaFamily": "模型返回的未知人物族",
                # productActionFamily intentionally omitted.
                "cameraFamily": profile.camera_family,
                "emotionFamily": profile.emotion_family,
            },
        }
    )

    completed = complete_semantic_profile(evaluation, candidate, plan)

    assert completed.semantic_profile is not None
    assert completed.semantic_profile.narrative_family == profile.narrative_family
    assert completed.semantic_profile.scene_family == "OTHER"
    assert completed.semantic_profile.persona_family == "OTHER"
    assert completed.semantic_profile.product_action_family == "OTHER"
    assert completed.semantic_profile.camera_family == profile.camera_family
    assert completed.semantic_profile.emotion_family == profile.emotion_family
    validate_semantic_profile(completed, plan)

    unrelated = candidate.model_copy(
        update={
            "dimensions": candidate.dimensions.model_copy(
                update={"scene": "完全无法归入动态词表的抽象空间"}
            ),
            "creative_core": "抽象构成",
            "content": "抽象色块保持静止，画面没有可识别地点，仅展示产品包装。",
        }
    )
    unknown_scene = evaluation.model_copy(
        update={
            "semantic_profile": evaluation.semantic_profile.model_copy(
                update={"scene_family": "仍然未知"}
            )
        }
    )
    fallback = complete_semantic_profile(unknown_scene, unrelated, plan)
    assert fallback.semantic_profile is not None
    assert fallback.semantic_profile.scene_family == "OTHER"
    validate_semantic_profile(fallback, plan)


def _direction_plan_for_semantic_tests() -> Any:
    application = map_insight(_cluster_snapshot().insight_artifact.result)
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_fact_visual_strategy,
    )
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy

    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="source",
        template_hash="0" * 64,
    )
    return validate_creative_direction_plan(
        _mock_creative_direction_response(application),
        application,
        strategy,
        source_hash="c" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )


def _candidate_for_semantic_tests(
    profile: CreativeSemanticProfile,
) -> CreativeCandidate:
    return CreativeCandidate(
        slot_id="candidate-semantic-repair",
        ordinal=1,
        round=0,
        creative_core=f"{profile.narrative_family}的连贯创意",
        declared_fact_ids=["fact-1"],
        dimensions=CreativeDimensions(
            narrative=profile.narrative_family,
            scene=profile.scene_family,
            persona=profile.persona_family,
            product_relation=profile.product_action_family,
            camera=profile.camera_family,
            emotion=profile.emotion_family,
        ),
        content=(
            f"在{profile.scene_family}中，{profile.persona_family}完成"
            f"{profile.product_action_family}，采用{profile.camera_family}，"
            f"呈现{profile.emotion_family}。"
        ),
    )


def _evaluation_for_semantic_tests(
    *, semantic_profile: CreativeSemanticProfile | None
) -> CreativeEvaluation:
    return CreativeEvaluation(
        slot_id="candidate-semantic-repair",
        primary_purpose=FragmentType.HOOK,
        compatible_purposes=[FragmentType.HOOK],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=90,
            visual_clarity=90,
        ),
        semantic_signature="semantic",
        visual_signature="visual",
        semantic_profile=semantic_profile,
    )


def test_direction_source_hash_invalidates_every_authoritative_input() -> None:
    baseline = creative_direction_source_hash(
        insight_content_hash="insight-a",
        visual_strategy_hash="visual-a",
        shared_prompt_hash="shared-a",
        target_count=50,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    variants = {
        creative_direction_source_hash(
            insight_content_hash="insight-b",
            visual_strategy_hash="visual-a",
            shared_prompt_hash="shared-a",
            target_count=50,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        ),
        creative_direction_source_hash(
            insight_content_hash="insight-a",
            visual_strategy_hash="visual-b",
            shared_prompt_hash="shared-a",
            target_count=50,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        ),
        creative_direction_source_hash(
            insight_content_hash="insight-a",
            visual_strategy_hash="visual-a",
            shared_prompt_hash="shared-b",
            target_count=50,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        ),
        creative_direction_source_hash(
            insight_content_hash="insight-a",
            visual_strategy_hash="visual-a",
            shared_prompt_hash="shared-a",
            target_count=51,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        ),
    }
    assert baseline not in variants
    assert len(variants) == 4
