from __future__ import annotations

import asyncio
import json

import httpx

from seedance_worker.models import RenderSnapshot
from seedance_worker.providers import ArkSeedanceProvider, _EvenRateLimiter


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
            "renderSettingsHash": "c" * 64,
            "sourcePackage": {
                "artifactId": "source-a",
                "revision": 1,
                "contentHash": "d" * 64,
            },
            "inputImages": [
                {
                    "fileObjectId": "image-a",
                    "originalFileName": "main.png",
                    "mimeType": "image/png",
                    "sizeBytes": 5,
                    "contentHash": "e" * 64,
                    "sortOrder": 0,
                }
            ],
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
        create_qps=1000,
        download_concurrency=2,
        max_download_bytes=1024,
        transport=httpx.MockTransport(handler),
    )
    progress: list[tuple[int, str | None]] = []
    try:
        output = await provider.render(
            snapshot(),
            ["data:image/png;base64,aW1hZ2U="],
            None,
            lambda value, task_id: _record(progress, value, task_id),
        )
    finally:
        await provider.aclose()

    assert output.content == b"video"
    assert output.duration == 5
    create_body = json.loads(calls[0].content)
    assert create_body["content"][0]["text"].count("保持外观一致") == 1
    assert create_body["content"][1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,aW1hZ2U="},
        "role": "reference_image",
    }
    assert calls[-1].url.host == "files.example.test"
    assert "authorization" not in calls[-1].headers
    assert progress[-1] == (92, "provider-task-a")


async def test_provider_resumes_existing_task_without_creating_a_duplicate() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.host == "files.example.test":
            return httpx.Response(200, content=b"video", headers={"content-type": "video/mp4"})
        return httpx.Response(
            200,
            json={
                "status": "succeeded",
                "content": {"video_url": "https://files.example.test/output.mp4"},
            },
        )

    provider = ArkSeedanceProvider(
        base_url="https://ark.example.test/api/v3",
        api_key="secret",
        timeout_seconds=10,
        poll_interval_seconds=0.001,
        create_qps=1000,
        download_concurrency=2,
        max_download_bytes=1024,
        transport=httpx.MockTransport(handler),
    )
    try:
        output = await provider.render(
            snapshot(),
            [],
            None,
            lambda value, task_id: _record([], value, task_id),
            "provider-existing",
        )
    finally:
        await provider.aclose()

    assert output.provider_task_id == "provider-existing"
    assert not any(request.method == "POST" for request in calls)
    assert any(request.url.path.endswith("/provider-existing") for request in calls)


async def test_provider_keeps_polling_an_existing_task_after_transient_network_errors() -> None:
    calls: list[httpx.Request] = []
    poll_attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal poll_attempts
        calls.append(request)
        if request.url.host == "files.example.test":
            return httpx.Response(
                200, content=b"video", headers={"content-type": "video/mp4"}
            )
        poll_attempts += 1
        if poll_attempts <= 2:
            raise httpx.ConnectError("temporary dns failure", request=request)
        return httpx.Response(
            200,
            json={
                "status": "succeeded",
                "content": {"video_url": "https://files.example.test/output.mp4"},
            },
        )

    provider = ArkSeedanceProvider(
        base_url="https://ark.example.test/api/v3",
        api_key="secret",
        timeout_seconds=10,
        poll_interval_seconds=0.001,
        create_qps=1000,
        download_concurrency=2,
        max_download_bytes=1024,
        transport=httpx.MockTransport(handler),
    )
    try:
        output = await provider.render(
            snapshot(),
            [],
            None,
            lambda value, task_id: _record([], value, task_id),
            "provider-existing",
        )
    finally:
        await provider.aclose()

    assert output.content == b"video"
    assert poll_attempts == 3
    assert not any(request.method == "POST" for request in calls)


async def test_provider_sends_a_reference_video_for_repair() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.method == "POST":
            return httpx.Response(200, json={"id": "provider-repair"})
        if request.url.host == "files.example.test":
            return httpx.Response(200, content=b"video", headers={"content-type": "video/mp4"})
        return httpx.Response(
            200,
            json={
                "status": "succeeded",
                "content": {"video_url": "https://files.example.test/repaired.mp4"},
            },
        )

    repair_data = snapshot().model_dump(by_alias=True)
    repair_data.update(
        {
            "operation": "REPAIR",
            "inputImages": [],
            "inputVideo": {
                "fileObjectId": "video-a",
                "originalFileName": "source.mp4",
                "mimeType": "video/mp4",
                "sizeBytes": 1024,
                "contentHash": "f" * 64,
                "durationSeconds": 5,
            },
            "repair": {
                "sourceVersion": 1,
                "startMs": 1000,
                "endMs": 2000,
                "instruction": "移除画面瑕疵",
                "region": None,
            },
        }
    )
    repair = RenderSnapshot.model_validate(repair_data)
    provider = ArkSeedanceProvider(
        base_url="https://ark.example.test/api/v3",
        api_key="secret",
        timeout_seconds=10,
        poll_interval_seconds=0.001,
        create_qps=1000,
        download_concurrency=2,
        max_download_bytes=1024,
        transport=httpx.MockTransport(handler),
    )
    try:
        await provider.render(
            repair,
            [],
            "https://api.example.test/reference.mp4?signature=secret",
            lambda value, task_id: _record([], value, task_id),
        )
    finally:
        await provider.aclose()

    create_body = json.loads(calls[0].content)
    assert create_body["content"][1] == {
        "type": "video_url",
        "video_url": {"url": "https://api.example.test/reference.mp4?signature=secret"},
        "role": "reference_video",
    }
    assert not any(item["type"] == "image_url" for item in create_body["content"])


async def test_provider_reuses_the_source_ark_task_for_exact_editing() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.method == "POST":
            return httpx.Response(200, json={"id": "provider-repair"})
        if request.url.host == "files.example.test":
            return httpx.Response(
                200, content=b"video", headers={"content-type": "video/mp4"}
            )
        if request.url.path.endswith("/provider-source"):
            return httpx.Response(
                200,
                json={
                    "status": "succeeded",
                    "content": {
                        "video_url": "https://source.example.test/original.mp4"
                    },
                },
            )
        return httpx.Response(
            200,
            json={
                "status": "succeeded",
                "content": {"video_url": "https://files.example.test/repaired.mp4"},
            },
        )

    repair_data = snapshot().model_dump(by_alias=True)
    repair_data.update(
        {
            "operation": "REPAIR",
            "inputImages": [],
            "inputVideo": {
                "fileObjectId": "video-a",
                "providerTaskId": "provider-source",
                "originalFileName": "source.mp4",
                "mimeType": "video/mp4",
                "sizeBytes": 1024,
                "contentHash": "f" * 64,
                "durationSeconds": 5,
            },
            "repair": {
                "sourceVersion": 1,
                "startMs": 1000,
                "endMs": 2000,
                "instruction": "移除画面瑕疵",
                "region": None,
            },
            "request": {
                "model": "doubao-seedance-2-5-260628",
                "content": [{"type": "text", "text": "仅修复指定范围"}],
                "duration": 5,
                "ratio": "9:16",
                "resolution": "720p",
            },
        }
    )
    repair = RenderSnapshot.model_validate(repair_data)
    provider = ArkSeedanceProvider(
        base_url="https://ark.example.test/api/v3",
        api_key="secret",
        timeout_seconds=10,
        poll_interval_seconds=0.001,
        create_qps=1000,
        download_concurrency=2,
        max_download_bytes=1024,
        transport=httpx.MockTransport(handler),
    )
    try:
        await provider.render(
            repair,
            [],
            None,
            lambda value, task_id: _record([], value, task_id),
        )
    finally:
        await provider.aclose()

    assert calls[0].method == "GET"
    assert calls[0].url.path.endswith("/provider-source")
    create_request = next(request for request in calls if request.method == "POST")
    create_body = json.loads(create_request.content)
    assert create_body["model"] == "doubao-seedance-2-5-260628"
    assert create_body["omni_reference_task_type"] == "edit"
    assert create_body["duration"] == -1
    assert create_body["ratio"] == "adaptive"
    assert create_body["content"][1] == {
        "type": "video_url",
        "video_url": {"url": "https://source.example.test/original.mp4"},
        "role": "reference_video",
    }


async def test_provider_retries_source_lookup_before_creating_one_repair_task() -> None:
    calls: list[httpx.Request] = []
    source_attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal source_attempts
        calls.append(request)
        if request.url.host == "files.example.test":
            return httpx.Response(
                200, content=b"video", headers={"content-type": "video/mp4"}
            )
        if request.url.path.endswith("/provider-source"):
            source_attempts += 1
            if source_attempts == 1:
                raise httpx.ConnectError("temporary dns failure", request=request)
            return httpx.Response(
                200,
                json={
                    "status": "succeeded",
                    "content": {
                        "video_url": "https://source.example.test/original.mp4"
                    },
                },
            )
        if request.method == "POST":
            return httpx.Response(200, json={"id": "provider-repair"})
        return httpx.Response(
            200,
            json={
                "status": "succeeded",
                "content": {"video_url": "https://files.example.test/repaired.mp4"},
            },
        )

    repair_data = snapshot().model_dump(by_alias=True)
    repair_data.update(
        {
            "operation": "REPAIR",
            "inputImages": [],
            "inputVideo": {
                "fileObjectId": "video-a",
                "providerTaskId": "provider-source",
                "originalFileName": "source.mp4",
                "mimeType": "video/mp4",
                "sizeBytes": 1024,
                "contentHash": "f" * 64,
                "durationSeconds": 5,
            },
            "repair": {
                "sourceVersion": 1,
                "startMs": 1000,
                "endMs": 2000,
                "instruction": "移除画面瑕疵",
                "region": None,
            },
        }
    )
    provider = ArkSeedanceProvider(
        base_url="https://ark.example.test/api/v3",
        api_key="secret",
        timeout_seconds=10,
        poll_interval_seconds=0.001,
        create_qps=1000,
        download_concurrency=2,
        max_download_bytes=1024,
        transport=httpx.MockTransport(handler),
    )
    try:
        output = await provider.render(
            RenderSnapshot.model_validate(repair_data),
            [],
            None,
            lambda value, task_id: _record([], value, task_id),
        )
    finally:
        await provider.aclose()

    assert output.content == b"video"
    assert source_attempts == 2
    assert sum(request.method == "POST" for request in calls) == 1


async def test_create_rate_limiter_spaces_concurrent_submissions() -> None:
    limiter = _EvenRateLimiter(20)
    started: list[float] = []

    async def acquire() -> None:
        await limiter.acquire()
        started.append(asyncio.get_running_loop().time())

    await asyncio.gather(*(acquire() for _ in range(3)))

    assert started[-1] - started[0] >= 0.09


async def test_downloads_use_their_own_concurrency_limit() -> None:
    provider = ArkSeedanceProvider(
        base_url="https://ark.example.test/api/v3",
        api_key="secret",
        timeout_seconds=10,
        poll_interval_seconds=1,
        create_qps=1000,
        download_concurrency=2,
        max_download_bytes=1024,
        transport=httpx.MockTransport(lambda request: httpx.Response(500)),
    )
    active = 0
    peak = 0

    async def download(url: str, progress: object, provider_task_id: str) -> tuple[bytes, str]:
        nonlocal active, peak
        del url, progress, provider_task_id
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return b"video", "video/mp4"

    provider._download = download  # type: ignore[method-assign]
    try:
        await asyncio.gather(
            *(
                provider._download_limited(
                    "https://files.example.test/output.mp4",
                    lambda value, task_id: _record([], value, task_id),
                    f"provider-{index}",
                )
                for index in range(5)
            )
        )
    finally:
        await provider.aclose()

    assert peak == 2


async def _record(
    values: list[tuple[int, str | None]], value: int, task_id: str | None
) -> None:
    values.append((value, task_id))
