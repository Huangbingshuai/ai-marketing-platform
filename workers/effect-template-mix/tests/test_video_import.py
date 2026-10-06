import asyncio
import hashlib
import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from effect_template_mix.api import InternalApi
from effect_template_mix.models import VideoImportClaim, VideoImportDescription, VideoImportMessage
from effect_template_mix.provider import ArkProvider, ProviderError
from effect_template_mix.video_import import describe_import_video, handle_video_import


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
    for duration in (3.99, 30.01):
        with pytest.raises(ValidationError):
            VideoImportClaim(claimed=True, durationSeconds=duration)
    with pytest.raises(ValidationError):
        VideoImportMessage.model_validate({**payload, "taskType": "PACKAGING"})


@pytest.mark.asyncio
async def test_description_is_editable_text_and_paid_provider_is_not_retried() -> None:
    provider = AsyncMock(spec=ArkProvider)
    provider.structured.return_value = VideoImportDescription(promptText="  实际画面描述  ")
    assert await describe_import_video(provider, [(1, b"jpeg")]) == "实际画面描述"
    call = provider.structured.await_args
    assert call.kwargs["max_attempts"] == 1
    assert call.kwargs["max_transient_attempts"] == 1
    assert any(item["type"] == "input_image" for item in call.args[0])
    provider.structured.side_effect = ProviderError("timeout", retryable=True)
    with pytest.raises(ProviderError):
        await describe_import_video(provider, [(1, b"jpeg")])
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
async def test_success_and_corrupt_download_have_frozen_file_checks(monkeypatch: pytest.MonkeyPatch) -> None:
    video = b"video"
    api = AsyncMock(spec=InternalApi)
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=video)
    api.client = httpx.AsyncClient(base_url="http://test/", transport=httpx.MockTransport(handler))
    api.request.return_value = {"claimed": True, "attemptToken": "lease", "durationSeconds": 10,
        "mimeType": "video/mp4", "sizeBytes": 5, "contentHash": hashlib.sha256(video).hexdigest()}
    samples = AsyncMock(return_value=[(1, b"jpeg")])
    monkeypatch.setattr("effect_template_mix.video_import.sample_frames", samples)
    provider = AsyncMock(spec=ArkProvider)
    provider.structured.return_value = VideoImportDescription(promptText="真实画面")
    envelope = {"schemaVersion": 2, "taskType": "VIDEO_IMPORT_DESCRIPTION", "projectId": "p", "runId": "r", "requestId": "k"}
    message = AsyncMock()
    await handle_video_import(message, envelope, api, provider, asyncio.Semaphore(1))
    assert api.request.await_args.kwargs["json"]["promptText"] == "真实画面"
    assert samples.await_args.kwargs["count"] == 6
    provider.structured.reset_mock()
    api.request.return_value["contentHash"] = "f" * 64
    await handle_video_import(message, envelope, api, provider, asyncio.Semaphore(1))
    provider.structured.assert_not_awaited()
    assert api.request.await_args.kwargs["json"] == {"projectId": "p"}
    await api.client.aclose()
