from __future__ import annotations

import json

import httpx
import pytest

from effect_prompt_generation.models import CreativeDirectionResponse
from effect_prompt_generation.providers import (
    ArkResponsesProvider, MockAiProvider, _fact_alias_maps, _remap_fact_references,
)
from test_supplement_recovery import ready_pipeline


@pytest.mark.asyncio
async def test_direction_coverage_instruction_uses_same_aliases_as_fact_table() -> None:
    pipeline, runtime = await ready_pipeline(MockAiProvider())
    application = pipeline._require_application(runtime)
    plan = pipeline._cache(runtime).creative_direction_plan
    assert plan is not None and plan.landscape is not None
    aliases, _ = _fact_alias_maps(application)
    expected = CreativeDirectionResponse(directions=plan.directions)
    response = _remap_fact_references(expected.model_dump(mode="json", by_alias=True), aliases)
    requests: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={
            "status": "completed", "output_text": json.dumps(response),
        })

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3", api_key="test", strategy_model="test",
        candidate_model="test", transport=httpx.MockTransport(handler),
    )
    try:
        call = await provider.plan_creative_directions(
            application,
            fact_visual_strategy=pipeline._required_fact_visual_strategy(runtime),
            shared_prompt=pipeline._required_shared_prompt(runtime),
            landscape=plan.landscape, target_count=50, style_instruction="",
            delivery_channel="京东", revision_context={
                "requiredDirectionSlots": [{
                    "directionId": d.direction_id, "territoryId": d.territory_id,
                    "primaryActionId": d.primary_action_id,
                } for d in plan.directions],
                "requiredBusinessFactIds": list(aliases),
            },
        )
    finally:
        await provider.aclose()
    prompt = requests[0]["input"][0]["content"][0]["text"]
    for fact_id, alias in aliases.items():
        assert fact_id not in prompt
        assert alias in prompt
    assert call.value == expected
