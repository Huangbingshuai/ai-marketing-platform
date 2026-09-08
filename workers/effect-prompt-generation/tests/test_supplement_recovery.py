from __future__ import annotations

import json
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
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import (
    ArkResponsesProvider,
    MockAiProvider,
    _safe_schema_errors,
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
async def test_repeated_structural_error_is_bounded_without_rule_fallback() -> None:
    provider = RepairProvider("always")
    pipeline, runtime = await ready_pipeline(provider)
    initial = pipeline._cache(runtime).creative_direction_plan
    assert (
        await pipeline._plan_diversity_supplement_directions(
            runtime, initial, requested_candidate_count=8
        )
        == []
    )
    assert [r["requested_direction_count"] for r in provider.requests] == [4, 1, 1]
    assert pipeline._cache(runtime).creative_direction_plan == initial


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
    assert props["executionRoutes"]["minItems"] == args["execution_route_count"]
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
