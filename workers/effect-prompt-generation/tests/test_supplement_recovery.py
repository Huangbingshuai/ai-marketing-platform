from __future__ import annotations

import json
import asyncio
from dataclasses import replace
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from effect_prompt_generation.models import (
    CreativeEvaluationDraft,
    CreativeDirectionResponse,
    FragmentType,
)
from historical_planning import HistoricalPlanningPipeline as PromptGenerationPipeline
from effect_prompt_generation.providers import (
    ArkResponsesProvider,
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
    _safe_schema_errors,
    _creative_task_brief,
)
from effect_prompt_generation.supplement_recovery import (
    direction_summary,
    retain_valid_supplements,
)
from test_creatives import PromptApi, _runtime, _snapshot


def evaluation_data() -> dict[str, Any]:
    return {
        "slotId": "slot-test",
        "primaryPurpose": "PRODUCT_DISPLAY",
        "compatiblePurposes": ["HOOK", "PRODUCT_DISPLAY", "EFFECT", "CTA"],
        "scores": dict.fromkeys(
            [
                "productRelevance",
                "creativeCoherence",
                "visualExecutability",
                "commercialUsefulness",
                "visualClarity",
            ],
            80,
        ),
    }


def test_primary_inclusive_four_purposes_normalize_without_changing_ai_decision() -> (
    None
):
    data = evaluation_data()
    data["warnings"] = ["CAMERA_ACTION_MISMATCH"]
    item = CreativeEvaluationDraft.model_validate(data)
    assert item.compatible_purposes == [
        FragmentType.HOOK,
        FragmentType.EFFECT,
        FragmentType.CTA,
    ]
    assert item.warnings == ["CAMERA_ACTION_MISMATCH"]
    assert item.hard_issues == []
    assert item.scores.visual_executability == 80
    data["compatiblePurposes"] = ["UNKNOWN"]
    with pytest.raises(ValidationError):
        CreativeEvaluationDraft.model_validate(data)


def test_schema_diagnostics_never_include_private_values_or_unknown_keys() -> None:
    data = evaluation_data()
    data["scores"]["visualExecutability"] = "PRIVATE_PROMPT_CONTENT"
    data["PRIVATE_FIELD_NAME"] = "PRIVATE_SECRET"
    with pytest.raises(ValidationError) as caught:
        CreativeEvaluationDraft.model_validate(data)
    diagnostics = _safe_schema_errors(caught.value, CreativeEvaluationDraft)
    encoded = json.dumps(diagnostics)
    assert "PRIVATE" not in encoded
    assert {
        "path": "scores.visualExecutability",
        "code": "float_parsing",
    } in diagnostics
    assert any(row["path"] == "?" for row in diagnostics)


class RepairProvider(MockAiProvider):
    def __init__(self, failure: str) -> None:
        self.failure = failure
        self.requests: list[dict[str, Any]] = []
        self.retained: dict[str, Any] = {}
        self.audited_ids: list[list[str]] = []

    async def plan_diversity_supplement_directions(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        self.requests.append(kwargs)
        call = await super().plan_diversity_supplement_directions(*args, **kwargs)
        rows = list(call.value.directions)
        if len(self.requests) == 1 or self.failure == "always":
            self.retained = {row.direction_id: row for row in rows[:-1]}
            if self.failure == "missing":
                rows = rows[:-1]
            else:
                rows[-1] = rows[-1].model_copy(
                    update={"territory_id": "UNKNOWN_TERRITORY"}
                )
        return replace(call, value=call.value.model_copy(update={"directions": rows}))

    async def audit_creative_direction_diversity(self, **kwargs: Any) -> Any:
        if kwargs.get("proposed_direction_ids"):
            self.audited_ids.append(
                [d.direction_id for d in kwargs["directions"].directions]
            )
        return await super().audit_creative_direction_diversity(**kwargs)


async def ready_pipeline(provider: MockAiProvider) -> tuple[Any, Any]:
    pipeline = PromptGenerationPipeline(api=PromptApi(), provider=provider)  # type: ignore[arg-type]
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    await pipeline.plan_creatives(runtime, round_number=0)
    return pipeline, runtime


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["missing", "source"])
async def test_supplement_repairs_only_pending_slot_and_audits_whole_plan(
    failure: str,
) -> None:
    provider = RepairProvider(failure)
    pipeline, runtime = await ready_pipeline(provider)
    initial = list(pipeline._cache(runtime).creative_direction_plan.directions)
    result = await pipeline._plan_diversity_supplement_directions(
        runtime,
        pipeline._cache(runtime).creative_direction_plan,
        requested_candidate_count=8,
    )
    assert len(result) == 4
    assert [r["requested_direction_count"] for r in provider.requests] == [4, 1]
    assert provider.requests[1]["revision_context"]["requiredDirectionIds"] == [
        "DIVERSITY_SUPPLEMENT_4"
    ]
    assert all(d == provider.retained[d.direction_id] for d in result[:3])
    assert provider.audited_ids[-1] == [d.direction_id for d in [*initial, *result]]


@pytest.mark.asyncio
async def test_repeated_structural_error_reviews_retained_partial_without_rule_fallback() -> None:
    provider = RepairProvider("always")
    pipeline, runtime = await ready_pipeline(provider)
    initial = pipeline._cache(runtime).creative_direction_plan
    result = await pipeline._plan_diversity_supplement_directions(
        runtime, initial, requested_candidate_count=8
    )
    assert len(result) == 3
    assert [d.direction_id for d in result] == [f"DIVERSITY_SUPPLEMENT_{i}" for i in range(1, 4)]
    assert [r["requested_direction_count"] for r in provider.requests] == [4, 1, 1]
    assert provider.audited_ids[-1] == [d.direction_id for d in [*initial.directions, *result]]
    assert pipeline._cache(runtime).diversity_supplement_direction_count == 3
    assert pipeline._cache(runtime).creative_direction_plan.directions[:len(initial.directions)] == initial.directions


class PartialReviewProvider(RepairProvider):
    def __init__(self, outcome: str) -> None:
        super().__init__("always")
        self.outcome = outcome

    async def audit_creative_direction_diversity(self, **kwargs: Any) -> Any:
        call = await super().audit_creative_direction_diversity(**kwargs)
        if not kwargs.get("proposed_direction_ids"):
            return call
        if self.outcome == "cancel":
            raise asyncio.CancelledError()
        if self.outcome == "invalid":
            raise ValueError("invalid review structure")
        return replace(call, value=call.value.model_copy(update={
            "requires_revision": True,
            "revision_direction_ids": list(kwargs["proposed_direction_ids"]),
        }))


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["reject", "invalid", "cancel"])
async def test_retained_partial_cannot_bypass_ai_review(outcome: str) -> None:
    provider = PartialReviewProvider(outcome)
    pipeline, runtime = await ready_pipeline(provider)
    initial = pipeline._cache(runtime).creative_direction_plan
    if outcome == "cancel":
        with pytest.raises(asyncio.CancelledError):
            await pipeline._plan_diversity_supplement_directions(runtime, initial, requested_candidate_count=8)
    else:
        assert await pipeline._plan_diversity_supplement_directions(runtime, initial, requested_candidate_count=8) == []
    assert pipeline._cache(runtime).creative_direction_plan == initial
    assert pipeline._cache(runtime).diversity_supplement_direction_count == 0
    assert len(provider.requests) <= 4


class UnavailableSupplementProvider(RepairProvider):
    async def plan_diversity_supplement_directions(self, *args: Any, **kwargs: Any) -> Any:
        if self.failure == "whole_response" and self.requests:
            self.requests.append(kwargs)
            raise ProviderError("response invalid", error_type=ProviderErrorType.RESPONSE_INVALID, retryable=False)
        call = await super().plan_diversity_supplement_directions(*args, **kwargs)
        if self.failure == "all_invalid":
            return replace(call, value=call.value.model_copy(update={"directions": [
                d.model_copy(update={"territory_id": "UNKNOWN_TERRITORY"}) for d in call.value.directions
            ]}))
        return call


@pytest.mark.asyncio
@pytest.mark.parametrize("failure,expected", [("whole_response", 3), ("all_invalid", 0)])
async def test_provider_failure_keeps_only_reviewed_valid_slots(failure: str, expected: int) -> None:
    provider = UnavailableSupplementProvider(failure)
    pipeline, runtime = await ready_pipeline(provider)
    initial = pipeline._cache(runtime).creative_direction_plan
    result = await pipeline._plan_diversity_supplement_directions(runtime, initial, requested_candidate_count=8)
    assert len(result) == expected
    assert len(provider.requests) == 3
    if expected:
        assert provider.audited_ids[-1] == [d.direction_id for d in [*initial.directions, *result]]
    else:
        assert provider.audited_ids == []
        assert pipeline._cache(runtime).creative_direction_plan == initial


@pytest.mark.asyncio
async def test_partial_diversity_generation_does_not_cycle_routes_to_fill_optional_pool() -> None:
    provider = RepairProvider("always")
    pipeline, runtime = await ready_pipeline(provider)
    shards = await pipeline.plan_creatives(runtime, round_number=1, requested_count=8, supplement_kind="DIVERSITY")
    tasks = [task for shard in shards for task in shard.tasks]
    assert len(tasks) == 6  # Three reviewed directions, two real routes each.
    keys = [(task.creative_direction.direction_id, task.execution_route.route_id) for task in tasks]
    assert len(set(keys)) == 6
    assert all(key[0].startswith("DIVERSITY_SUPPLEMENT_") for key in keys)


class SharedFamilyProvider(RepairProvider):
    async def plan_diversity_supplement_directions(self, *args: Any, **kwargs: Any) -> Any:
        call = await super().plan_diversity_supplement_directions(*args, **kwargs)
        return replace(call, value=call.value.model_copy(update={"directions": [
            d.model_copy(update={"semantic_profile": d.semantic_profile.model_copy(update={
                "scene_family": "SHARED_FAMILY" if index < 2 else "ALTERNATIVE_FAMILY",
            })}) for index, d in enumerate(call.value.directions)
        ]}))


@pytest.mark.asyncio
async def test_reviewed_new_events_are_not_filtered_again_by_family_id() -> None:
    provider = SharedFamilyProvider("always")
    pipeline, runtime = await ready_pipeline(provider)
    pipeline._cache(runtime).diversity_avoid_scene_families = {"SHARED_FAMILY"}
    shards = await pipeline.plan_creatives(runtime, round_number=1, requested_count=8, supplement_kind="DIVERSITY")
    tasks = [task for shard in shards for task in shard.tasks]
    keys = [(task.creative_direction.direction_id, task.execution_route.route_id) for task in tasks]
    assert len(keys) == len(set(keys)) == 6
    assert len({direction for direction, _ in keys}) == 3


@pytest.mark.asyncio
async def test_supplement_receives_actual_generated_events_not_only_dimension_labels() -> None:
    provider = RepairProvider("missing")
    pipeline, runtime = await ready_pipeline(provider)
    shards = await pipeline.plan_creatives(runtime, round_number=0)
    candidates = await pipeline.generate_creative_shard(runtime, shards[0])
    candidate = candidates[0]
    assert candidate.shot_plan is not None
    cache = pipeline._cache(runtime)
    cache.diversity_avoid_slot_ids = {candidate.slot_id}
    await pipeline._plan_diversity_supplement_directions(runtime, cache.creative_direction_plan, requested_candidate_count=8)
    example = provider.requests[0]["revision_context"]["vectorCrowdedExamples"][0]
    assert example["visibleEvent"] == {
        "initialState": candidate.shot_plan.scene.initial_state,
        "actions": [{"action": beat.action, "visibleResult": beat.visible_result} for beat in candidate.shot_plan.beats],
        "finalFrame": candidate.shot_plan.final_frame,
    }
    assert "content" not in example and "sound" not in json.dumps(example)


@pytest.mark.asyncio
async def test_single_candidate_brief_preserves_sibling_events_without_other_directions() -> None:
    pipeline, runtime = await ready_pipeline(MockAiProvider())
    tasks = list(pipeline._cache(runtime).creative_tasks.values())
    task = next(task for task in tasks if task.creative_direction is not None)
    direction = task.creative_direction
    assert direction is not None and len(direction.execution_routes) >= 2
    assert task.fact_assignment is not None
    brief = _creative_task_brief(
        task, assignment=task.fact_assignment,
        application=pipeline._require_application(runtime),
        fact_visual_strategy=pipeline._required_fact_visual_strategy(runtime),
    )
    comparisons = brief["siblingVariation"]["routeComparisons"]
    assert len(comparisons) == len(direction.execution_routes)
    for route, row in zip(direction.execution_routes, comparisons, strict=True):
        assert row == {
            "routeId": route.route_id, "eventOutline": route.event_outline,
            "visualEvent": route.visual_event, "sceneRelation": route.scene_relation,
            "productAction": route.product_action, "endingState": route.ending_state,
        }
    assert brief["executionRoute"] == task.execution_route.model_dump(mode="json", by_alias=True)
    assert brief["slotId"] == task.slot_id
    assert all("factApplications" not in row and "content" not in row for row in comparisons)
    old_task = task.model_copy(update={"creative_direction": None, "execution_route": None})
    old_brief = _creative_task_brief(
        old_task, assignment=task.fact_assignment,
        application=pipeline._require_application(runtime), fact_visual_strategy=None,
    )
    assert old_brief["siblingVariation"]["routeComparisons"] == []


class MixedFailureProvider(MockAiProvider):
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.audit_count = 0

    async def plan_diversity_supplement_directions(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        self.requests.append(kwargs)
        call = await super().plan_diversity_supplement_directions(*args, **kwargs)
        rows = list(call.value.directions)
        if len(self.requests) == 1:
            rows = rows[:-1]
        elif len(self.requests) == 3:
            rows[0] = rows[0].model_copy(update={"primary_action_id": "UNKNOWN_ACTION"})
        return replace(call, value=call.value.model_copy(update={"directions": rows}))

    async def audit_creative_direction_diversity(self, **kwargs: Any) -> Any:
        call = await super().audit_creative_direction_diversity(**kwargs)
        if kwargs.get("proposed_direction_ids"):
            self.audit_count += 1
            if self.audit_count == 1:
                return replace(
                    call,
                    value=call.value.model_copy(
                        update={
                            "requires_revision": True,
                            "revision_direction_ids": ["DIVERSITY_SUPPLEMENT_1"],
                        }
                    ),
                )
        return call


class FinalRepairFailureProvider(MixedFailureProvider):
    async def plan_diversity_supplement_directions(self, *args: Any, **kwargs: Any) -> Any:
        if len(self.requests) >= 2:
            self.requests.append(kwargs)
            raise ProviderError(
                "response invalid", error_type=ProviderErrorType.RESPONSE_INVALID,
                retryable=False,
            )
        return await super().plan_diversity_supplement_directions(*args, **kwargs)


class FinalSalvageReviewFailureProvider(FinalRepairFailureProvider):
    def __init__(self, outcome: str) -> None:
        super().__init__()
        self.outcome = outcome

    async def audit_creative_direction_diversity(self, **kwargs: Any) -> Any:
        call = await super().audit_creative_direction_diversity(**kwargs)
        if kwargs.get("proposed_direction_ids") and self.audit_count == 2:
            if self.outcome == "cancel":
                raise asyncio.CancelledError
            if self.outcome == "invalid":
                raise ProviderError(
                    "invalid review", error_type=ProviderErrorType.RESPONSE_INVALID,
                    retryable=False,
                )
            return replace(call, value=call.value.model_copy(update={
                "requires_revision": True,
                "revision_direction_ids": list(kwargs["proposed_direction_ids"]),
            }))
        return call


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["reject", "invalid", "cancel"])
async def test_final_salvage_still_cannot_bypass_ai_or_cancellation(outcome: str) -> None:
    provider = FinalSalvageReviewFailureProvider(outcome)
    pipeline, runtime = await ready_pipeline(provider)
    cache = pipeline._cache(runtime)
    original = cache.creative_direction_plan
    if outcome == "cancel":
        with pytest.raises(asyncio.CancelledError):
            await pipeline._plan_diversity_supplement_directions(
                runtime, original, requested_candidate_count=8,
            )
    else:
        assert await pipeline._plan_diversity_supplement_directions(
            runtime, original, requested_candidate_count=8,
        ) == []
    assert len(provider.requests) == 4
    assert cache.creative_direction_plan == original
    assert cache.diversity_supplement_direction_count == 0


@pytest.mark.asyncio
async def test_last_failed_replacement_still_reviews_retained_directions() -> None:
    provider = FinalRepairFailureProvider()
    pipeline, runtime = await ready_pipeline(provider)
    result = await pipeline._plan_diversity_supplement_directions(
        runtime, pipeline._cache(runtime).creative_direction_plan,
        requested_candidate_count=8,
    )
    assert [row.direction_id for row in result] == [
        "DIVERSITY_SUPPLEMENT_2", "DIVERSITY_SUPPLEMENT_3", "DIVERSITY_SUPPLEMENT_4",
    ]
    assert len(provider.requests) == 4  # Fifth pass reviews only, never generates.
    assert provider.audit_count == 2  # Kept subset has independent AI approval.
    assert pipeline._cache(runtime).diversity_supplement_direction_count == 3


@pytest.mark.asyncio
async def test_structure_recovery_does_not_consume_ai_semantic_revision() -> None:
    provider = MixedFailureProvider()
    pipeline, runtime = await ready_pipeline(provider)
    result = await pipeline._plan_diversity_supplement_directions(
        runtime,
        pipeline._cache(runtime).creative_direction_plan,
        requested_candidate_count=8,
    )
    assert len(result) == 4
    assert [r["requested_direction_count"] for r in provider.requests] == [4, 1, 1, 1]
    assert [
        r["revision_context"]["requiredDirectionIds"] for r in provider.requests[1:]
    ] == [
        ["DIVERSITY_SUPPLEMENT_4"],
        ["DIVERSITY_SUPPLEMENT_1"],
        ["DIVERSITY_SUPPLEMENT_1"],
    ]
    assert provider.audit_count == 2
    retained_before_revision = {
        d.direction_id: d
        for d in provider.requests[2]["existing_directions"].directions
    }
    assert all(row == retained_before_revision[row.direction_id] for row in result[1:])


@pytest.mark.asyncio
async def test_retention_rejects_duplicate_and_unknown_fact_without_overwriting_slots() -> (
    None
):
    mock = RepairProvider("missing")
    pipeline, runtime = await ready_pipeline(mock)
    await pipeline._plan_diversity_supplement_directions(
        runtime,
        pipeline._cache(runtime).creative_direction_plan,
        requested_candidate_count=8,
    )
    args = mock.requests[0]
    application = pipeline._require_application(runtime)
    call = await MockAiProvider().plan_diversity_supplement_directions(
        application, **args
    )
    rows = call.value.directions
    unknown = rows[2].model_copy(
        update={
            "fact_applications": [
                rows[2]
                .fact_applications[0]
                .model_copy(update={"fact_id": "UNKNOWN_FACT"})
            ]
        }
    )
    retained = {rows[3].direction_id: rows[3]}
    response = CreativeDirectionResponse.model_construct(
        directions=[
            rows[0],
            rows[0],
            rows[1],
            unknown,
            rows[3].model_copy(update={"creative_direction": "不得覆盖已保存创意方向"}),
        ]
    )
    errors = retain_valid_supplements(
        response,
        pending_ids=[d.direction_id for d in rows[:3]],
        retained=retained,
        application=application,
        strategy=args["fact_visual_strategy"],
        landscape=args["landscape"],
        existing=args["existing_directions"].directions,
        route_count=args["execution_route_count"],
    )
    assert errors[rows[0].direction_id] == "DUPLICATE_DIRECTION_ID"
    assert "unavailable fact" in errors[rows[2].direction_id]
    assert retained == {rows[1].direction_id: rows[1], rows[3].direction_id: rows[3]}


@pytest.mark.asyncio
async def test_supplement_protocol_is_scoped_and_old_direction_input_is_compact() -> (
    None
):
    mock = RepairProvider("missing")
    pipeline, runtime = await ready_pipeline(mock)
    await pipeline._plan_diversity_supplement_directions(
        runtime,
        pipeline._cache(runtime).creative_direction_plan,
        requested_candidate_count=8,
    )
    args = mock.requests[1]
    application = pipeline._require_application(runtime)
    expected = await MockAiProvider().plan_diversity_supplement_directions(
        application, **args
    )
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": expected.value.model_dump_json(by_alias=True),
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test",
        strategy_model="test",
        candidate_model="test",
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.plan_diversity_supplement_directions(
            application, **args
        )
    finally:
        await provider.aclose()
    assert len(result.value.directions) == 1
    schema = seen["text"]["format"]["schema"]
    assert (
        schema["properties"]["directions"]["minItems"]
        == schema["properties"]["directions"]["maxItems"]
        == 1
    )
    props = schema["$defs"]["CreativeDirection"]["properties"]
    assert props["directionId"]["enum"] == ["DIVERSITY_SUPPLEMENT_4"]
    assert props["executionRoutes"]["minItems"] == 1
    assert props["executionRoutes"]["maxItems"] == 5
    assert "eventOutline" in schema["$defs"]["CreativeExecutionRoute"]["required"]
    prompt = seen["input"][0]["content"][0]["text"]
    old_section = prompt.split("现有方向摘要", 1)[1].split("当前拥挤场景", 1)[0]
    assert "factApplications" not in old_section
    assert "visualEvents" in old_section
    original = args["existing_directions"].directions
    compact = [direction_summary(d) for d in original]
    assert len(json.dumps(compact)) < len(
        json.dumps([d.model_dump(mode="json") for d in original])
    )
    for original_direction, projected in zip(original, compact, strict=True):
        assert projected["creativeDirection"] == original_direction.creative_direction
        assert [row["event"] for row in projected["visualEvents"]] == [
            r.visual_event for r in original_direction.execution_routes
        ]
        assert [row["productAction"] for row in projected["visualEvents"]] == [
            r.product_action for r in original_direction.execution_routes
        ]
        assert [row["sceneRelation"] for row in projected["visualEvents"]] == [
            r.scene_relation for r in original_direction.execution_routes
        ]
