from __future__ import annotations

import json

import httpx

from seedance_worker.models import RenderSnapshot
from seedance_worker.providers import ArkSeedanceProvider


def snapshot() -> RenderSnapshot:
    return RenderSnapshot.model_validate(
        {
            "promptId": "prompt-a",
            "promptCode": "P001",
            "promptText": "产品展示",
            "primaryPurpose": "PRODUCT_DISPLAY",
            "compatiblePurposes": ["PRODUCT_DISPLAY"],
            "promptContentHash": "a" * 64,
            "sharedPromptHash": "b" * 64,
            "request": {
                "model": "seedance-model",
                "content": [{"type": "text", "text": "产品展示。保持外观一致。"}],
                "duration": 5,
                "ratio": "9:16",
                "resolution": "1080p",
            },
        }
    )


async def test_provider_creates_polls_and_downloads_without_leaking_bearer_token() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.method == "POST":
            return httpx.Response(200, json={"id": "provider-task-a"})
        if request.url.host == "files.example.test":
            return httpx.Response(200, content=b"video", headers={"content-type": "video/mp4"})
        return httpx.Response(
            200,
            json={
                "status": "succeeded",
                "content": {
                    "video_url": "https://files.example.test/output.mp4",
                    "duration": 5,
                    "ratio": "9:16",
                    "resolution": "1080p",
                },
            },
        )

    provider = ArkSeedanceProvider(
        base_url="https://ark.example.test/api/v3",
        api_key="secret",
        timeout_seconds=10,
        poll_interval_seconds=0.001,
        max_download_bytes=1024,
        transport=httpx.MockTransport(handler),
    )
    progress: list[tuple[int, str | None]] = []
    try:
        output = await provider.render(snapshot(), lambda value, task_id: _record(progress, value, task_id))
    finally:
        await provider.aclose()

    assert output.content == b"video"
    assert output.duration == 5
    create_body = json.loads(calls[0].content)
    assert create_body["content"][0]["text"].count("保持外观一致") == 1
    assert calls[-1].url.host == "files.example.test"
    assert "authorization" not in calls[-1].headers
    assert progress[-1] == (92, "provider-task-a")


async def _record(
    values: list[tuple[int, str | None]], value: int, task_id: str | None
) -> None:
    values.append((value, task_id))
