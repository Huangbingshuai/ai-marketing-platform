import asyncio
import httpx
import pytest
from customized_storyboard.api import Api
from ai_runtime.http import InternalApiError


@pytest.mark.asyncio
async def test_completed_checkpoint_survives_short_api_restart(monkeypatch):
    requests = []
    pauses = []

    def respond(request):
        requests.append(request)
        if len(requests) == 1:
            raise httpx.ConnectError("restart", request=request)
        if len(requests) == 2:
            return httpx.Response(503, json={"success": False})
        return httpx.Response(200, json={"success": True, "data": {"saved": True}})

    async def pause(seconds):
        pauses.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", pause)
    api = Api("http://api.test", "test-secret", "project", "task")
    await api.client.aclose()
    api.client = httpx.AsyncClient(
        transport=httpx.MockTransport(respond), base_url="http://api.test/"
    )
    api.token = "attempt"
    try:
        assert await api.call("PUT", "steps", {"output": {"story": "paid result"}}) == {
            "saved": True
        }
        assert pauses == [1, 2]
        assert len({r.content for r in requests}) == 1
        assert all(r.headers["x-attempt-token"] == "attempt" for r in requests)
    finally:
        await api.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 404, 409])
async def test_invalidated_attempt_is_not_retried(status):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(status, json={"success": False})

    api = Api("http://api.test", "test-secret", "project", "task")
    await api.client.aclose()
    api.client = httpx.AsyncClient(
        transport=httpx.MockTransport(respond), base_url="http://api.test/"
    )
    try:
        with pytest.raises(InternalApiError) as error:
            await api.call("PUT", "heartbeat")
        assert error.value.status_code == status
        assert len(calls) == 1
    finally:
        await api.close()


@pytest.mark.asyncio
async def test_retry_is_bounded(monkeypatch):
    calls = []

    async def pause(_):
        pass

    def respond(request):
        calls.append(request)
        return httpx.Response(503)

    monkeypatch.setattr(asyncio, "sleep", pause)
    api = Api("http://api.test", "test-secret", "project", "task")
    await api.client.aclose()
    api.client = httpx.AsyncClient(
        transport=httpx.MockTransport(respond), base_url="http://api.test/"
    )
    try:
        with pytest.raises(InternalApiError):
            await api.call("POST", "scripts", {"script": {"id": "unchanged"}})
        assert len(calls) == 6
    finally:
        await api.close()
