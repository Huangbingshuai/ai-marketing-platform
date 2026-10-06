import json
import re
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from effect_template_mix.provider import ArkProvider
from effect_template_mix.video_import import describe_import_video
from effect_template_mix.video_import_template import (
    DescriptionTemplateError, VideoImportObservation, compile_import_observation,
)


def observation(starts: list[float]) -> VideoImportObservation:
    return VideoImportObservation.model_validate({
        "overview": {"visualIntent": "展示酱料拌面。", "visualStyle": "写实。", "environment": "厨房台面。",
                     "lighting": "自然光。", "initialState": "勺子悬于意面上方。"},
        "stages": [{"startSeconds": start, "description": f"阶段{index}：可见拌面动作。",
                    "camera": "固定俯拍。", "focus": "碗内意面。", "motionSource": "右手持夹子。",
                    "visibleResult": f"结果{index}：面条挂酱。"} for index, start in enumerate(starts)],
        "finalFrame": "意面与酱料保持同框。", "primaryPurpose": "EFFECT", "compatiblePurposes": ["EFFECT"],
        "creativeCore": "拌面后展示挂酱。", "dimensions": {"narrative": "取酱拌面。", "scene": "厨房。",
            "persona": "只有手部。", "productRelation": "酱料附着在意面上。", "camera": "固定俯拍。", "emotion": "日常。"},
    })


@pytest.mark.parametrize("starts,expected", [
    ([0], ["0–15秒"]),
    ([0, 1.88, 8.148, 13.161], ["0–1.9秒", "1.9–8.1秒", "8.1–13.2秒", "13.2–15秒"]),
    ([0, 0, 0.04, 1.01, 1.04, 15, 15.02, 15.041667], ["0–1秒", "1–15秒"]),
])
def test_observed_starts_compile_continuous_ranges_and_keep_every_detail(starts: list[float], expected: list[str]) -> None:
    result = compile_import_observation(observation(starts), 15.041667)
    assert re.findall(r"^\d+(?:\.\d+)?–\d+(?:\.\d+)?秒$", result.promptText, re.MULTILINE) == expected
    for index in range(len(starts)):
        assert f"阶段{index}：" in result.promptText
        assert f"结果{index}：" in result.promptText
    assert "15.041667" not in result.promptText
    assert result.primaryPurpose == "EFFECT"
    assert result.creativeCore == "拌面后展示挂酱。"


@pytest.mark.parametrize("starts", [[0.1], [0, 4, 3], [0, 15.05], [0, 20]])
def test_compiler_rejects_missing_start_disordered_or_out_of_media_stages(starts: list[float]) -> None:
    with pytest.raises(DescriptionTemplateError):
        compile_import_observation(observation(starts), 15.041667)


@pytest.mark.parametrize("path", ["overview", "description", "camera", "visibleResult", "finalFrame"])
def test_missing_content_is_not_replaced_by_invented_text(path: str) -> None:
    result = observation([0])
    if path == "overview":
        result.overview.visualIntent = " "
    elif path == "finalFrame":
        result.finalFrame = " "
    else:
        setattr(result.stages[0], path, " ")
    with pytest.raises(DescriptionTemplateError):
        compile_import_observation(result, 15.041667)


@pytest.mark.parametrize("start", [-1, float("nan"), float("inf"), 31])
def test_model_schema_rejects_invalid_times(start: float) -> None:
    with pytest.raises(ValidationError):
        observation([start])


def test_rounded_up_media_endpoint_is_merged_not_false_rejected() -> None:
    result = compile_import_observation(observation([0, 29.98, 30]), 29.96)
    assert "0–30秒" in result.promptText
    assert "阶段2：" in result.promptText
    assert "30–30秒" not in result.promptText


@pytest.mark.asyncio
async def test_real_provider_wire_schema_has_no_free_text_time_ranges_and_calls_once() -> None:
    calls: list[httpx.Request] = []
    generated = observation([0, 1.88, 8.148, 13.161, 15.041667])

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"output_text": generated.model_dump_json()})

    provider = ArkProvider("https://test.invalid", "test-key", "test-model", 1, 8192, "minimal")
    await provider.client.aclose()
    provider.client = httpx.AsyncClient(base_url="https://test.invalid/", transport=httpx.MockTransport(handler))
    result = await describe_import_video(provider, [(0, b"jpeg"), (8.148, b"jpeg")], duration_seconds=15.041667)
    assert len(calls) == 1
    payload = json.loads(calls[0].content)
    schema = payload["text"]["format"]["schema"]
    assert "promptText" not in schema["properties"]
    assert "endSeconds" not in schema["$defs"]["ImportStage"]["properties"]
    assert set(schema["$defs"]["ImportOverview"]["required"]) == set(schema["$defs"]["ImportOverview"]["properties"])
    assert result.promptText.count("【视频概览】") == 1
    assert result.promptText.count("【逐秒镜头】") == 1
    assert result.promptText.count("【结束画面】") == 1
    assert "13.2–15秒" in result.promptText
    assert "证据帧 2/2；视频实际采样时间 8.148 秒" in str(payload["input"])
    await provider.close()


@pytest.mark.asyncio
async def test_invalid_structure_does_not_trigger_an_extra_paid_request() -> None:
    provider = AsyncMock(spec=ArkProvider)
    provider.structured.return_value = observation([0, 4, 3])
    with pytest.raises(DescriptionTemplateError):
        await describe_import_video(provider, [(0, b"jpeg")], duration_seconds=15.041667)
    provider.structured.assert_awaited_once()
