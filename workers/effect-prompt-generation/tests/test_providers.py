from __future__ import annotations

import json

import httpx
import pytest

from effect_prompt_generation.models import PlannedCombination, PromptDimensions
from effect_prompt_generation.providers import ArkResponsesProvider, ProviderError, ProviderErrorType


@pytest.mark.asyncio
async def test_ark_strategy_uses_strict_schema_and_restores_allowed_selling_points() -> None:
    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        output = {
            "narratives": ["痛点前置型"],
            "scenes": ["家庭"],
            "personas": ["年轻用户"],
            "sellingPoints": ["模型擅自改写的卖点"],
            "cameras": ["产品特写"],
            "emotions": ["温馨"],
            "fragmentTypes": ["完整片段"],
        }
        return httpx.Response(200, json={"output_text": json.dumps(output, ensure_ascii=False)})

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        model="test-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.plan_strategy(
            {"coreSellingPoints": ["已确认卖点"], "secondarySellingPoints": ["次要卖点"]},
            target_count=50,
        )
    finally:
        await provider.aclose()

    text_format = seen["text"]
    assert isinstance(text_format, dict)
    assert text_format["format"]["strict"] is True
    assert result.value.selling_points == ["已确认卖点", "次要卖点"]


@pytest.mark.asyncio
async def test_ark_candidate_rejects_missing_slot() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"output_text": '{"items":[]}'})

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        model="test-model",
        max_attempts=1,
        transport=httpx.MockTransport(handler),
    )
    combination = PlannedCombination(
        slot_id="slot-1",
        ordinal=1,
        fragment_type="完整片段",
        dimensions=PromptDimensions(
            narrative="痛点前置型",
            scene="家庭",
            persona="年轻女性",
            selling_point="已确认卖点",
            camera="特写",
            emotion="温馨",
        ),
    )
    try:
        with pytest.raises(ProviderError) as exc_info:
            await provider.generate_candidates(
                [combination], insight={"coreSellingPoints": ["已确认卖点"]}, duration_seconds=15
            )
    finally:
        await provider.aclose()

    assert exc_info.value.error_type == ProviderErrorType.RESPONSE_INVALID
