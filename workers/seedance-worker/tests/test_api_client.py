from __future__ import annotations

import asyncio
import hashlib

import httpx

from seedance_worker.api_client import HttpInternalApi
from seedance_worker.models import InputImage, RuntimeContext


async def test_reference_images_are_verified_and_reused_from_the_bounded_cache() -> None:
    content = b"image"
    calls: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        await asyncio.sleep(0.01)
        return httpx.Response(
            200,
            content=content,
            headers={"content-type": "image/png", "content-length": str(len(content))},
        )

    api = HttpInternalApi(
        "https://api.example.test/api",
        "worker-token",
        reference_cache_bytes=1024,
        transport=httpx.MockTransport(handler),
    )
    context = RuntimeContext(
        project_id="project-a",
        task_id="task-a",
        task_version=1,
        request_id="request-a",
        attempt_token="attempt-a",
    )
    image = InputImage.model_validate(
        {
            "fileObjectId": "image-a",
            "originalFileName": "main.png",
            "mimeType": "image/png",
            "sizeBytes": len(content),
            "contentHash": hashlib.sha256(content).hexdigest(),
            "sortOrder": 0,
        }
    )
    try:
        results = await asyncio.gather(
            *(api.reference_images(context, [image]) for _ in range(10))
        )
        second = await api.reference_images(context, [image])
    finally:
        await api.aclose()

    assert results == [["data:image/png;base64,aW1hZ2U="]] * 10
    assert second == results[0]
    assert len(calls) == 1
    assert calls[0].headers["x-attempt-token"] == "attempt-a"


async def test_reference_video_url_is_requested_with_the_active_lease() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "url": "https://api.example.test/provider-inputs/video?signature=signed",
                "expiresAt": "2026-09-08T12:00:00.000Z",
            },
        )

    api = HttpInternalApi(
        "https://api.example.test/api",
        "worker-token",
        transport=httpx.MockTransport(handler),
    )
    context = RuntimeContext(
        project_id="project-a",
        task_id="task-a",
        task_version=2,
        request_id="request-a",
        attempt_token="attempt-a",
    )
    try:
        url = await api.reference_video_url(context)
    finally:
        await api.aclose()

    assert url.endswith("signature=signed")
    assert calls[0].headers["x-attempt-token"] == "attempt-a"
    assert calls[0].method == "POST"
    assert calls[0].url.path.endswith("/tasks/task-a/reference-video-url")
    assert calls[0].read().decode() == '{"projectId":"project-a","taskVersion":2}'
