from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import httpx
import pytest

from effect_prompt_generation.creative_directions import (
    validate_diversity_supplement_directions,
)
from effect_prompt_generation.models import (
    CreativeDirectionResponse,
    CreativeTerritoryAction,
)
from effect_prompt_generation.providers import (
    ArkResponsesProvider,
    MockAiProvider,
    _creative_shot_response_schema,
)
from effect_prompt_generation.supplement_actions import supplement_review_landscape
from test_execution_repair import LocatedProvider, prepared
from test_supplement_recovery import ready_pipeline


class ProposedActionProvider(MockAiProvider):
    def __init__(self, reject: bool = False) -> None:
        self.reject = reject
        self.proposals = 0
        self.new_action_reviews: list[list[Any]] = []

    async def plan_diversity_supplement_directions(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        self.proposals += 1
        call = await super().plan_diversity_supplement_directions(*args, **kwargs)
        rows = [
            row.model_copy(
                update={
                    "primary_action_id": f"NEW_ACTION_{index}",
                    "proposed_action": CreativeTerritoryAction(
                        action_id=f"NEW_ACTION_{index}",
                        label=f"新的可信使用事件{index}",
                        boundary="只能使用同空间已确认事实，不新增功能或包装属性",
                    ),
                }
            )
            for index, row in enumerate(call.value.directions)
        ]
        return replace(call, value=call.value.model_copy(update={"directions": rows}))

    async def audit_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        call = await super().audit_creative_directions(*args, **kwargs)
        if any(row.proposed_action for row in kwargs["directions"].directions):
            self.new_action_reviews.append(kwargs["directions"].directions)
            if self.reject:
                call = replace(
                    call,
                    value=call.value.model_copy(
                        update={
                            "items": [
                                row.model_copy(
                                    update={
                                        "aligned": False,
                                        "issues": ["AI 判断新增动作与事实不相容"],
                                    }
                                )
                                for row in call.value.items
                            ]
                        }
                    ),
                )
        return call


@pytest.mark.asyncio
@pytest.mark.parametrize("reject", [False, True])
async def test_proposed_actions_require_ai_review_without_mutating_base_landscape(
    reject: bool,
) -> None:
    provider = ProposedActionProvider(reject)
    pipeline, runtime = await ready_pipeline(provider)
    plan = pipeline._cache(runtime).creative_direction_plan
    before = plan.landscape.model_dump_json()
    result = await pipeline._plan_diversity_supplement_directions(
        runtime, plan, requested_candidate_count=8
    )
    assert len(result) == (0 if reject else 4)
    assert provider.proposals == (2 if reject else 1)
    assert len(provider.new_action_reviews) == (4 if reject else 2)
    assert all(len(group) <= 2 for group in provider.new_action_reviews)
    assert plan.landscape.model_dump_json() == before
    if result:
        assert all(row.proposed_action is not None for row in result)
        assert all(
            row.proposed_action
            == type(row).model_validate(row.model_dump()).proposed_action
            for row in result
        )
        for invalid in [
            {"territory_id": "UNKNOWN_TERRITORY"},
            {"primary_action_id": "UNKNOWN_ACTION"},
            {
                "fact_applications": [
                    result[0]
                    .fact_applications[0]
                    .model_copy(update={"fact_id": "unknown-fact"})
                ]
            },
        ]:
            with pytest.raises(ValueError):
                validate_diversity_supplement_directions(
                    CreativeDirectionResponse(
                        directions=[result[0].model_copy(update=invalid)]
                    ),
                    pipeline._cache(runtime).insight_application,
                    pipeline._cache(runtime).fact_visual_strategy,
                    landscape=plan.landscape,
                    existing_directions=plan.directions,
                    expected_direction_count=1,
                )
        existing = plan.landscape.territories[-1].actions[0]
        overwritten = result[0].model_copy(
            update={
                "primary_action_id": existing.action_id,
                "proposed_action": existing,
            }
        )
        with pytest.raises(ValueError, match="overwrite"):
            supplement_review_landscape(plan.landscape, [overwritten])


@pytest.mark.asyncio
async def test_global_ai_reviewer_receives_every_event_outline_not_just_titles() -> (
    None
):
    pipeline, runtime = await ready_pipeline(MockAiProvider())
    plan = pipeline._cache(runtime).creative_direction_plan
    directions = CreativeDirectionResponse(
        directions=[
            row.model_copy(
                update={
                    "execution_routes": [
                        route.model_copy(
                            update={
                                "event_outline": f"事件摘要 {row.direction_id} {route.route_id}"
                            }
                        )
                        for route in row.execution_routes
                    ]
                }
            )
            for row in plan.directions
        ]
    )
    args = {"landscape": plan.landscape, "directions": directions}
    expected = await MockAiProvider().audit_creative_direction_diversity(**args)
    seen = {}

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
        await provider.audit_creative_direction_diversity(**args)
    finally:
        await provider.aclose()
    prompt = seen["input"][0]["content"][0]["text"]
    for row in directions.directions:
        for route in row.execution_routes:
            assert route.event_outline in prompt
            assert route.scene_relation in prompt
            assert route.product_action in prompt
            assert route.ending_state in prompt
            assert route.visual_event in prompt
    assert '"eventOutline"' in prompt
    assert '"sceneRelation"' in prompt
    # The review receives event relationships, not full fact explanations or
    # generated shot scripts; output schema and AI call count remain unchanged.
    assert '"factApplications"' not in prompt
    assert '"shotPlan"' not in prompt


@pytest.mark.asyncio
async def test_ark_local_repair_uses_bounded_structured_call_and_original_constraints() -> (
    None
):
    mock = LocatedProvider()
    pipeline, runtime, candidate, _ = await prepared(mock)
    cache = pipeline._cache(runtime)
    audit = await mock.audit_creative_execution(
        [candidate],
        target_durations={candidate.slot_id: 5},
    )
    args = dict(
        task=cache.creative_tasks[candidate.slot_id],
        findings=audit.value.items[0].findings,
        application=cache.insight_application,
        shared_prompt=cache.shared_prompt,
        fact_visual_strategy=cache.fact_visual_strategy,
    )
    response = await mock.repair_creative_execution(candidate, **args)
    seen = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": response.value.model_dump_json(by_alias=True),
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test",
        strategy_model="strategy-test",
        candidate_model="candidate-test",
        transport=httpx.MockTransport(handler),
    )
    try:
        await provider.repair_creative_execution(candidate, **args)
    finally:
        await provider.aclose()
    assert seen["model"] == "candidate-test"
    assert seen["max_output_tokens"] == 6144
    assert "shotPlan" in seen["text"]["format"]["schema"]["properties"]
    payload = json.loads(seen["input"][0]["content"][0]["text"])
    assert payload["original"]["slotId"] == candidate.slot_id
    assert "content" not in payload["original"]
    assert payload["sharedPrompt"] == cache.shared_prompt.compiled_content
    assert payload["findings"][0]["field"] == "CAMERA"


def test_new_generation_schema_requests_separate_execution_fields() -> None:
    required = _creative_shot_response_schema()["$defs"]["MaterialShotBeat"]["required"]
    assert {
        "framing",
        "camera",
        "focus",
        "motionSource",
        "action",
        "visibleResult",
    }.issubset(required)
