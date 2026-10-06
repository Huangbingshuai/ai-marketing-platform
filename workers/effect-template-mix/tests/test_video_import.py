import asyncio
import hashlib
import json
import re
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from effect_template_mix.api import ApiError, InternalApi
from effect_template_mix.models import VideoImportClaim, VideoImportDescription, VideoImportFailure, VideoImportMessage
from effect_template_mix.provider import ArkProvider, ProviderError, ProviderIncompleteError, ProviderOutputError
from effect_template_mix.config import Settings
from effect_template_mix.video_import import IMPORT_OUTPUT_TOKENS, _failure_code, _normalize_description_times, describe_import_video, handle_video_import
from effect_template_mix.video_import_template import DescriptionTemplateError, VideoImportObservation

CREATIVE_DIMENSIONS = {"narrative": "取用后展示", "scene": "餐桌", "persona": "只有手部", "productRelation": "产品置于食物表面", "camera": "固定近景", "emotion": "日常用餐"}
CREATIVE = {"creativeCore": "取用产品的可见过程", "dimensions": CREATIVE_DIMENSIONS}


def formatted_prompt(duration: float = 10) -> str:
    return ("【视频概览】\n目标：展示饭团上的酱料。 质感：写实。 场景：餐桌。 光线：侧面柔光。 首帧状态：饭团已在碟中。\n"
            f"【逐秒镜头】\n0–{duration}秒\n近景，酱料已在饭团上。 镜头：固定侧前方机位。 结果：食物与酱料同框可见。\n"
            "【结束画面】\n饭团与酱料保持同框。")


def observation_from_prompt(text: str, **metadata: object) -> VideoImportObservation:
    """Test fixture only: production receives structured observations, never this parser."""
    overview, shots = text.strip().split("【逐秒镜头】")
    shots, final = shots.split("【结束画面】")
    labels = ("目标：", "质感：", "场景：", "光线：", "首帧状态：")
    values = []
    for index, label in enumerate(labels):
        value = overview.split(label, 1)[1]
        values.append(value.split(labels[index + 1], 1)[0].strip() if index + 1 < len(labels) else value.strip())
    ranges = list(re.finditer(r"(\d+(?:\.\d+)?)–\d+(?:\.\d+)?秒", shots))
    stages = []
    for index, match in enumerate(ranges):
        detail = shots[match.end():ranges[index + 1].start() if index + 1 < len(ranges) else len(shots)].strip()
        description, camera = detail.split("镜头：")
        camera, result = camera.split("结果：")
        stages.append({"startSeconds": float(match[1]), "description": description.strip(), "camera": camera.strip(),
                       "focus": "", "motionSource": "", "visibleResult": result.strip()})
    return VideoImportObservation.model_validate({"overview": dict(zip(("visualIntent", "visualStyle", "environment", "lighting", "initialState"), values)),
        "stages": stages, "finalFrame": final.strip(), **metadata})


def test_import_uses_dedicated_volcano_multimodal_model() -> None:
    settings = Settings.model_validate({"INTERNAL_API_BASE_URL": "http://localhost/api", "EFFECT_TEMPLATE_MIX_WORKER_TOKEN": "test-token", "RABBITMQ_URL": "amqp://localhost", "ARK_API_KEY": "test-key", "ARK_MODEL": "mix-model"})
    assert settings.model == "mix-model"
    assert settings.video_import_model == "doubao-seed-2-1-pro-260628"


def test_import_shared_message_and_duration_bounds() -> None:
    payload = {"schemaVersion": 2, "taskType": "VIDEO_IMPORT_DESCRIPTION",
        "projectId": "project", "runId": "draft", "requestId": "key"}
    assert VideoImportMessage.model_validate(payload).taskType == "VIDEO_IMPORT_DESCRIPTION"
    schema = json.loads((Path(__file__).resolve().parents[3] / "packages/contracts/schemas/effect-video-import-message.schema.json").read_text(encoding="utf-8"))
    model = VideoImportMessage.model_json_schema()
    assert schema["required"] == model["required"]
    for name in schema["properties"]:
        assert schema["properties"][name].get("const") == model["properties"][name].get("const")
    for duration in (4, 30):
        assert VideoImportClaim(claimed=True, durationSeconds=duration).durationSeconds == duration
    for invalid_duration in (3.99, 30.01):
        with pytest.raises(ValidationError):
            VideoImportClaim(claimed=True, durationSeconds=invalid_duration)
    with pytest.raises(ValidationError):
        VideoImportMessage.model_validate({**payload, "taskType": "PACKAGING"})


@pytest.mark.asyncio
async def test_description_is_editable_text_and_paid_provider_is_not_retried() -> None:
    provider = AsyncMock(spec=ArkProvider)
    provider.structured.return_value = observation_from_prompt(formatted_prompt(), primaryPurpose="EFFECT", compatiblePurposes=["EFFECT", "PRODUCT_DISPLAY"], **CREATIVE)
    assert (await describe_import_video(provider, [(1, b"jpeg")], duration_seconds=10)).model_dump() == {"promptText": formatted_prompt(), "primaryPurpose": "EFFECT", "compatiblePurposes": ["EFFECT", "PRODUCT_DISPLAY"], **CREATIVE}
    call = provider.structured.await_args
    assert call.kwargs["max_attempts"] == 1
    assert call.kwargs["max_transient_attempts"] == 1
    assert call.kwargs["max_output_tokens"] == IMPORT_OUTPUT_TOKENS
    assert any(item["type"] == "input_image" for item in call.args[0])
    instruction = call.args[0][0]["text"]
    for field in ("creativeCore", "narrative", "scene", "persona", "productRelation", "camera", "emotion"):
        assert field in instruction
    assert "不能另起创意" in instruction
    assert "不推测味道、配方或功效" in instruction
    for field in ("overview", "stages", "finalFrame", "startSeconds", "visualIntent", "visualStyle", "environment", "lighting", "initialState"):
        assert field in instruction
    assert call.args[1] is VideoImportObservation
    assert "promptText" not in call.args[1].model_json_schema()["properties"]
    compiler = (Path(__file__).resolve().parents[2] / "effect-prompt-generation/src/effect_prompt_generation/shot_plan.py").read_text(encoding="utf-8")
    assert all(header in compiler for header in ("【视频概览】", "【逐秒镜头】", "【结束画面】"))
    assert "不输出同步声" in instruction
    assert "严格区分主体运动、相机运动与剪辑切换" in instruction
    assert "相邻帧只能约束变化发生的区间" in instruction
    assert "不要补上帧间没有证据的动作" in instruction
    provider.structured.side_effect = ProviderError("timeout", retryable=True)
    with pytest.raises(ProviderError):
        await describe_import_video(provider, [(1, b"jpeg")], duration_seconds=10)
    assert provider.structured.await_count == 2  # One invocation per explicit request, no loop.


@pytest.mark.asyncio
async def test_duplicate_delivery_never_calls_provider() -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {"claimed": False}
    provider = AsyncMock(spec=ArkProvider)
    message = AsyncMock()
    await handle_video_import(message, {"schemaVersion": 2, "taskType": "VIDEO_IMPORT_DESCRIPTION",
        "projectId": "p", "runId": "r", "requestId": "k"}, api, provider, asyncio.Semaphore(1))
    provider.structured.assert_not_awaited()
    message.ack.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("duration,readable", [(10, 10), (15.041667, 15)])
async def test_success_and_corrupt_download_have_frozen_file_checks(monkeypatch: pytest.MonkeyPatch, duration: float, readable: int) -> None:
    video = b"video"
    api = AsyncMock(spec=InternalApi)
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=video)
    api.client = httpx.AsyncClient(base_url="http://test/", transport=httpx.MockTransport(handler))
    api.request.return_value = {"claimed": True, "attemptToken": "lease", "durationSeconds": duration,
        "mimeType": "video/mp4", "sizeBytes": 5, "contentHash": hashlib.sha256(video).hexdigest()}
    samples = AsyncMock(return_value=[(1, b"jpeg")])
    monkeypatch.setattr("effect_template_mix.video_import.sample_import_frames", samples)
    provider = AsyncMock(spec=ArkProvider)
    provider.structured.return_value = observation_from_prompt(formatted_prompt(duration), primaryPurpose="HOOK", compatiblePurposes=["HOOK"], **CREATIVE)
    envelope = {"schemaVersion": 2, "taskType": "VIDEO_IMPORT_DESCRIPTION", "projectId": "p", "runId": "r", "requestId": "k"}
    message = AsyncMock()
    await handle_video_import(message, envelope, api, provider, asyncio.Semaphore(1))
    assert api.request.await_args is not None
    assert api.request.await_args.kwargs["json"]["promptText"] == formatted_prompt(readable)
    assert api.request.await_args.kwargs["json"]["primaryPurpose"] == "HOOK"
    assert api.request.await_args.kwargs["json"]["compatiblePurposes"] == ["HOOK"]
    assert api.request.await_args.kwargs["json"]["dimensions"] == CREATIVE["dimensions"]
    assert api.request.await_args.kwargs["json"]["creativeCore"] == CREATIVE["creativeCore"]
    assert samples.await_args is not None
    assert samples.await_args.kwargs == {}
    assert samples.await_args.args[1] == duration  # Frozen precise duration is still used for actual extraction.
    assert f"视频描述总时长为 {readable} 秒" in provider.structured.await_args.args[0][0]["text"]
    provider.structured.return_value.overview.visualStyle = " "
    provider.structured.reset_mock()
    await handle_video_import(message, envelope, api, provider, asyncio.Semaphore(1))
    provider.structured.assert_awaited_once()
    assert api.request.await_args.kwargs["json"] == {"projectId": "p", "failureCode": "TEMPLATE_INVALID"}
    provider.structured.reset_mock()
    api.request.return_value["contentHash"] = "f" * 64
    await handle_video_import(message, envelope, api, provider, asyncio.Semaphore(1))
    provider.structured.assert_not_awaited()
    assert api.request.await_args.kwargs["json"] == {"projectId": "p", "failureCode": "VIDEO_INTEGRITY_FAILED"}
    await api.client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("duration,readable", [(4, "4"), (6.04, "6"), (15.041667, "15"), (6.25, "6.3"), (15, "15"), (29.96, "30"), (30, "30")])
async def test_template_uses_readable_times_without_long_encoded_decimals(duration: float, readable: str) -> None:
    provider = AsyncMock(spec=ArkProvider)
    text = formatted_prompt(duration)
    provider.structured.return_value = observation_from_prompt(text, primaryPurpose="HOOK", compatiblePurposes=["HOOK"], **CREATIVE)
    assert (await describe_import_video(provider, [(0, b"jpeg")], duration_seconds=duration)).promptText == text.replace(f"0–{duration}秒", f"0–{readable}秒")
    assert f"视频描述总时长为 {readable} 秒" in provider.structured.await_args.args[0][0]["text"]
    provider.structured.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("text", [
    "只返回一句画面简介",
    formatted_prompt().replace("【结束画面】", "【视频概览】"),
    formatted_prompt().replace("质感：写实。", ""),
    formatted_prompt().replace("光线：侧面柔光。", "光线："),
    formatted_prompt().replace("0–10秒", "1–10秒"),
    formatted_prompt().replace("0–10秒", "0–11秒"),
    formatted_prompt().replace("0–10秒", "0–9秒"),
    formatted_prompt().replace("镜头：固定侧前方机位。", ""),
    formatted_prompt().replace("结果：食物与酱料同框可见。", ""),
    formatted_prompt().split("【结束画面】")[0] + "【结束画面】\n",
    formatted_prompt().replace("0–10秒", "0–5秒\n镜头：固定。结果：饭团可见。\n6–10秒"),
    formatted_prompt().replace("0–10秒", "0–6秒\n镜头：固定。结果：饭团可见。\n5–10秒"),
])
async def test_legacy_normalizer_still_rejects_genuinely_malformed_text(text: str) -> None:
    with pytest.raises(ValueError):
        _normalize_description_times(text, 10)


@pytest.mark.asyncio
async def test_valid_multi_stage_description_keeps_actual_stages() -> None:
    text = formatted_prompt(6.04).replace("0–6.04秒", "0–2.5秒\n镜头：固定。结果：饭团已在碟中。\n2.5–6.04秒")
    assert _normalize_description_times(text, 6.04) == text.replace("2.5–6.04秒", "2.5–6秒")


@pytest.mark.asyncio
async def test_user_reported_four_stage_times_are_readable_and_continuous() -> None:
    stages = ("0–1.88秒\n镜头：固定。结果：放入酱料。\n"
              "1.88–8.148秒\n镜头：固定。结果：翻拌意面。\n"
              "8.148–13.161秒\n镜头：推近。结果：展示挂酱。\n"
              "13.161–15.041667秒")
    text = formatted_prompt(15.041667).replace("0–15.041667秒", stages)
    expected = text.replace("1.88", "1.9").replace("8.148", "8.1").replace("13.161", "13.2").replace("15.041667", "15")
    assert _normalize_description_times(text, 15.041667) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("ranges", [
    "0–0.04秒\n镜头：固定。结果：极短开场。\n0.04–15.041667秒",
    "0–1.01秒\n镜头：固定。结果：开场。\n1.01–1.04秒\n镜头：固定。结果：极短过渡。\n1.04–15.041667秒",
    "0–15.02秒\n镜头：固定。结果：展示。\n15.02–15.041667秒",
])
async def test_rounded_zero_length_shots_keep_all_details_without_zero_intervals(ranges: str) -> None:
    import re
    text = formatted_prompt(15.041667).replace("0–15.041667秒", ranges)
    result = _normalize_description_times(text, 15.041667)
    def strip_times(value: str) -> str:
        return re.sub(r"^\d+(?:\.\d+)?–\d+(?:\.\d+)?秒\n", "", value, flags=re.MULTILINE)
    assert strip_times(result) == strip_times(text)
    assert result.split("【结束画面】")[0].rstrip().endswith("食物与酱料同框可见。")
    assert "–15秒" in result


@pytest.mark.asyncio
async def test_model_can_use_readable_total_with_exact_frozen_media_duration() -> None:
    provider = AsyncMock(spec=ArkProvider)
    text = formatted_prompt(15)
    provider.structured.return_value = observation_from_prompt(text, primaryPurpose="EFFECT", compatiblePurposes=["EFFECT"], **CREATIVE)
    assert (await describe_import_video(provider, [(0, b"jpeg")], duration_seconds=15.041667)).promptText == text


@pytest.mark.asyncio
@pytest.mark.parametrize("duration,frames", [(3.99, [(0, b"jpeg")]), (30.01, [(0, b"jpeg")]), (float("nan"), [(0, b"jpeg")]), (6, [])])
async def test_invalid_inputs_never_call_paid_provider(duration: float, frames: list[tuple[float, bytes]]) -> None:
    provider = AsyncMock(spec=ArkProvider)
    with pytest.raises(ValueError):
        await describe_import_video(provider, frames, duration_seconds=duration)
    provider.structured.assert_not_awaited()


def test_shared_description_schema_matches_worker() -> None:
    schema = json.loads((Path(__file__).resolve().parents[3] / "packages/contracts/schemas/effect-video-import-description.schema.json").read_text(encoding="utf-8"))
    model = VideoImportDescription.model_json_schema()
    assert schema["required"] == model["required"]
    assert schema["additionalProperties"] == model["additionalProperties"]
    for name in schema["properties"]:
        assert schema["properties"][name] == {key: value for key, value in model["properties"][name].items() if key != "title"}
    assert schema["$defs"]["VideoImportDimensions"]["required"] == model["$defs"]["VideoImportDimensions"]["required"]
    for name, definition in schema["$defs"]["VideoImportDimensions"]["properties"].items():
        assert definition == {key: value for key, value in model["$defs"]["VideoImportDimensions"]["properties"][name].items() if key != "title"}


@pytest.mark.parametrize("changes", [
    {"primaryPurpose": "PAIN"},
    {"primaryPurpose": None},
    {"compatiblePurposes": []},
    {"compatiblePurposes": ["HOOK"]},
    {"compatiblePurposes": ["EFFECT", "EFFECT"]},
    {"promptText": " "},
    {"creativeCore": " "},
    {"dimensions": {**CREATIVE_DIMENSIONS, "camera": " "}},
])
def test_description_rejects_incomplete_or_invalid_purposes(changes: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        VideoImportDescription.model_validate({"promptText": "真实画面", "primaryPurpose": "EFFECT", "compatiblePurposes": ["EFFECT"], **CREATIVE, **changes})


@pytest.mark.asyncio
@pytest.mark.parametrize("interval", ["0秒–15秒", "0 ~ 15秒", "0至15秒", "0–15.0417秒"])
async def test_equivalent_generated_format_does_not_discard_valid_description(interval: str) -> None:
    prompt = formatted_prompt(15).replace("0–15秒", interval).replace("：", ": ")
    result = _normalize_description_times(prompt, 15.041667)
    assert "0–15秒" in result
    assert "结果：" in result
    assert "饭团与酱料保持同框。" in result


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_first", [False, True])
async def test_two_simultaneous_imports_keep_results_and_failures_isolated(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, fail_first: bool) -> None:
    videos = {"first": b"first-video", "second": b"second-video"}
    api = AsyncMock(spec=InternalApi)
    results: dict[str, dict[str, object]] = {}

    async def content(request: httpx.Request) -> httpx.Response:
        draft_id = request.url.path.split("/")[-2]
        assert request.headers["x-attempt-token"] == f"lease-{draft_id}"
        return httpx.Response(200, content=videos[draft_id])

    async def request(method: str, path: str, **kwargs: object) -> object:
        draft_id = path.split("/")[-2]
        if path.endswith("/claim"):
            video = videos[draft_id]
            return {"claimed": True, "attemptToken": f"lease-{draft_id}", "durationSeconds": 6,
                    "mimeType": "video/mp4", "sizeBytes": len(video), "contentHash": hashlib.sha256(video).hexdigest()}
        if path.endswith("/complete"):
            assert kwargs["headers"] == {"x-attempt-token": f"lease-{draft_id}"}
            results[draft_id] = kwargs["json"]  # type: ignore[assignment]
        return None

    api.request.side_effect = request
    api.client = httpx.AsyncClient(base_url="http://test/", transport=httpx.MockTransport(content))

    async def frames(path: Path, duration: float, **kwargs: object) -> list[tuple[float, bytes]]:
        return [(0, path.read_bytes())]

    monkeypatch.setattr("effect_template_mix.video_import.sample_import_frames", frames)
    provider = AsyncMock(spec=ArkProvider)
    arrived = 0
    both_started = asyncio.Event()

    async def recognize(parts: list[dict[str, str]], *args: object, **kwargs: object) -> VideoImportObservation:
        nonlocal arrived
        arrived += 1
        if arrived == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), timeout=2)
        import base64
        image = next(part["image_url"] for part in parts if part["type"] == "input_image")
        own_video = base64.b64decode(image.split(",")[1])
        draft_id = "first" if own_video == videos["first"] else "second"
        if fail_first and draft_id == "first":
            raise ProviderError("do-not-log-private-response", retryable=True)
        return observation_from_prompt(formatted_prompt(6).replace("饭团", draft_id),
            primaryPurpose="HOOK" if draft_id == "first" else "EFFECT",
            compatiblePurposes=["HOOK" if draft_id == "first" else "EFFECT"],
            creativeCore=draft_id, dimensions={**CREATIVE_DIMENSIONS, "narrative": draft_id})

    provider.structured.side_effect = recognize
    messages = [AsyncMock(), AsyncMock()]
    slots = asyncio.Semaphore(2)
    await asyncio.gather(*(handle_video_import(message, {"schemaVersion": 2, "taskType": "VIDEO_IMPORT_DESCRIPTION",
        "projectId": "project", "runId": draft_id, "requestId": f"request-{draft_id}"}, api, provider, slots)
        for message, draft_id in zip(messages, videos)))
    assert provider.structured.await_count == 2
    for message in messages:
        message.ack.assert_awaited_once()
    assert "second" in str(results["second"]["promptText"])
    assert results["second"]["creativeCore"] == "second"
    assert results["second"]["dimensions"] == {**CREATIVE_DIMENSIONS, "narrative": "second"}
    assert results["second"]["primaryPurpose"] == "EFFECT"
    if fail_first:
        assert results["first"] == {"projectId": "project", "failureCode": "AI_SERVICE_FAILED"}
        assert "stage=recognition reason=ProviderError" in caplog.text
        assert "do-not-log-private-response" not in caplog.text
        assert "lease-first" not in caplog.text
    else:
        assert "first" in str(results["first"]["promptText"])
        assert results["first"]["creativeCore"] == "first"
        assert results["first"]["primaryPurpose"] == "HOOK"
        assert results["first"]["dimensions"] == {**CREATIVE_DIMENSIONS, "narrative": "first"}
    await api.client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("failures", [1, 3])
async def test_callback_retries_keep_generated_result_and_never_repeat_paid_call(monkeypatch: pytest.MonkeyPatch, failures: int) -> None:
    video = b"video"
    api = AsyncMock(spec=InternalApi)
    attempts: list[dict[str, object]] = []

    async def content(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=video)

    async def request(method: str, path: str, **kwargs: object) -> object:
        if path.endswith("/claim"):
            return {"claimed": True, "attemptToken": "lease", "durationSeconds": 6,
                    "mimeType": "video/mp4", "sizeBytes": len(video), "contentHash": hashlib.sha256(video).hexdigest()}
        if path.endswith("/complete"):
            attempts.append(kwargs["json"])  # type: ignore[arg-type]
            if len(attempts) <= failures:
                raise ApiError("transient write failure", retryable=True, status_code=503)
        return None

    api.request.side_effect = request
    api.client = httpx.AsyncClient(base_url="http://test/", transport=httpx.MockTransport(content))
    monkeypatch.setattr("effect_template_mix.video_import.sample_import_frames", AsyncMock(return_value=[(0, b"jpeg")]))
    provider = AsyncMock(spec=ArkProvider)
    provider.structured.return_value = observation_from_prompt(formatted_prompt(6),
        primaryPurpose="EFFECT", compatiblePurposes=["EFFECT"], **CREATIVE)
    message = AsyncMock()
    await handle_video_import(message, {"schemaVersion": 2, "taskType": "VIDEO_IMPORT_DESCRIPTION",
        "projectId": "p", "runId": "r", "requestId": "k"}, api, provider, asyncio.Semaphore(2))
    provider.structured.assert_awaited_once()
    assert len(attempts) == min(failures + 1, 3)
    assert all(payload == attempts[0] and payload["promptText"] == formatted_prompt(6) for payload in attempts)
    message.ack.assert_awaited_once()
    await api.client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["incomplete", "invalid"])
async def test_provider_diagnostics_are_safe_and_never_repeat_paid_recognition(caplog: pytest.LogCaptureFixture, failure: str) -> None:
    requests: list[httpx.Request] = []
    private = "do-not-log-private-field-or-response"
    payload = {"promptText": formatted_prompt(6), "primaryPurpose": "EFFECT", "compatiblePurposes": ["EFFECT"], **CREATIVE, private: private}

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = {"status": "incomplete", "private": private} if failure == "incomplete" else {"output_text": json.dumps(payload)}
        return httpx.Response(200, json=body, headers={"x-request-id": "safe-request-id"})

    provider = ArkProvider("https://test.invalid", "private-key", "model", 1, IMPORT_OUTPUT_TOKENS, "medium")
    await provider.client.aclose()
    provider.client = httpx.AsyncClient(base_url="https://test.invalid/", transport=httpx.MockTransport(handler))
    with pytest.raises(ProviderOutputError if failure == "invalid" else ProviderError):
        await describe_import_video(provider, [(0, b"jpeg")], duration_seconds=6)
    assert len(requests) == 1
    assert json.loads(requests[0].content)["max_output_tokens"] == IMPORT_OUTPUT_TOKENS
    assert f"video import model {failure}" in caplog.text
    assert private not in caplog.text
    assert "private-key" not in caplog.text
    await provider.close()


def test_failure_schema_is_identical_and_rejects_raw_error_payloads() -> None:
    schema = json.loads((Path(__file__).resolve().parents[3] / "packages/contracts/schemas/effect-video-import-failure.schema.json").read_text(encoding="utf-8"))
    model = VideoImportFailure.model_json_schema()
    assert schema["required"] == model["required"]
    assert schema["additionalProperties"] == model["additionalProperties"]
    assert schema["properties"]["failureCode"]["enum"] == model["properties"]["failureCode"]["enum"]
    with pytest.raises(ValidationError):
        VideoImportFailure.model_validate({"projectId": "p", "failureCode": "raw-response-secret"})
    with pytest.raises(ValidationError):
        VideoImportFailure.model_validate({"projectId": "p", "failureCode": "AI_TIMEOUT", "errorMessage": "raw-response-secret"})


@pytest.mark.parametrize("stage,error,code", [
    ("download", ValueError("private-hash"), "VIDEO_INTEGRITY_FAILED"),
    ("download", ApiError("private-url", retryable=False), "VIDEO_READ_FAILED"),
    ("sample_frames", RuntimeError("private-file"), "FRAME_EXTRACTION_FAILED"),
    ("recognition", ProviderError("private-response", retryable=True, status_code=429), "AI_RATE_LIMITED"),
    ("recognition", ProviderError("private-response", retryable=True, status_code=408), "AI_TIMEOUT"),
    ("recognition", ProviderError("private-response", retryable=True, status_code=503), "AI_SERVICE_FAILED"),
    ("recognition", ProviderIncompleteError("private-response", retryable=False), "AI_OUTPUT_TRUNCATED"),
    ("recognition", ProviderOutputError("private-response", retryable=False), "AI_OUTPUT_INVALID"),
    ("recognition", DescriptionTemplateError("overview_fields_missing"), "TEMPLATE_INVALID"),
    ("model_queue", TimeoutError("private-info"), "TASK_TIMEOUT"),
    ("recognition", ApiError("private-token", retryable=False), "TASK_INTERRUPTED"),
    ("recognition", RuntimeError("private-info"), "UNKNOWN"),
])
def test_failure_codes_do_not_expose_exception_text(stage: str, error: Exception, code: str) -> None:
    assert _failure_code(stage, error) == code


@pytest.mark.parametrize("cause,code", [(httpx.ReadTimeout("private-url"), "AI_TIMEOUT"), (httpx.ConnectError("private-url"), "AI_CONNECTION_FAILED")])
def test_provider_cause_is_classified_without_exposing_transport_info(cause: Exception, code: str) -> None:
    error = ProviderError("private-provider-message", retryable=True)
    error.__cause__ = cause
    assert _failure_code("recognition", error) == code
