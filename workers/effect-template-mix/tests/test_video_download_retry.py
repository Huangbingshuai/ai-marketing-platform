from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.api import ApiError, InternalApi


class InterruptedVideo(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b"partial-prefix"
        raise httpx.RemoteProtocolError("connection closed mid-video")


async def make_api(handler, monkeypatch):
    api = InternalApi("http://test.invalid", "test-token", 1)
    await api.client.aclose()
    api.client = httpx.AsyncClient(
        base_url="http://test.invalid/", transport=httpx.MockTransport(handler)
    )
    monkeypatch.setattr("effect_template_mix.api.asyncio.sleep", AsyncMock())
    return api


def runtime():
    return SimpleNamespace(run_id="run", project_id="project", attempt_token="lease")


async def test_midstream_disconnect_retries_same_frozen_source_without_joining_partial_bytes(monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(200, stream=InterruptedVideo())
        return httpx.Response(200, content=b"complete-video")

    api = await make_api(handler, monkeypatch)
    try:
        assert await api.video(runtime(), "material", 100) == b"complete-video"
        assert len(requests) == 2
        assert all(request.url == requests[0].url for request in requests)
        assert all(request.headers["x-attempt-token"] == "lease" for request in requests)
        assert requests[0].url.params["projectId"] == "project"
    finally:
        await api.close()


@pytest.mark.parametrize("mode", ["connect", "disconnect", "timeout", "server"])
async def test_download_retry_exhaustion_is_retryable_not_invalid_content(mode, monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        if mode == "connect":
            raise httpx.ConnectError("connection unavailable")
        if mode == "timeout":
            raise httpx.ReadTimeout("read interrupted")
        if mode == "server":
            return httpx.Response(503)
        return httpx.Response(200, stream=InterruptedVideo())

    api = await make_api(handler, monkeypatch)
    try:
        with pytest.raises(ApiError) as error:
            await api.video(runtime(), "material", 100)
        assert error.value.retryable
        assert len(requests) == api.max_attempts == 4
    finally:
        await api.close()


async def test_connect_error_recovers_without_starting_a_new_task(monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        if len(requests) < 3:
            raise httpx.ConnectError("connection unavailable")
        return httpx.Response(200, content=b"complete-video")

    api = await make_api(handler, monkeypatch)
    try:
        assert await api.video(runtime(), "material", 100) == b"complete-video"
        assert len(requests) == 3
        assert all(request.method == "GET" for request in requests)
        assert all(request.url == requests[0].url for request in requests)
        assert all(request.headers["x-attempt-token"] == "lease" for request in requests)
    finally:
        await api.close()


@pytest.mark.parametrize("status", [401, 403, 404, 409])
async def test_expired_lease_or_missing_file_never_retries(status, monkeypatch):
    requests = []
    api = await make_api(lambda request: requests.append(request) or httpx.Response(status), monkeypatch)
    try:
        with pytest.raises(ApiError) as error:
            await api.video(runtime(), "material", 100)
        assert not error.value.retryable and error.value.status_code == status
        assert len(requests) == 1
    finally:
        await api.close()


@pytest.mark.parametrize("declared", [True, False])
async def test_size_limit_is_never_retried(declared, monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        if declared:
            return httpx.Response(200, headers={"content-length": "101"}, content=b"video")
        return httpx.Response(200, content=b"oversized")

    api = await make_api(handler, monkeypatch)
    try:
        with pytest.raises(ApiError) as error:
            await api.video(runtime(), "material", 5)
        assert not error.value.retryable
        assert len(requests) == 1
    finally:
        await api.close()
