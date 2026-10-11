import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.api import ApiError, InternalApi


async def client(handler, **options):
    api = InternalApi("http://test.invalid", "test-token", 1,
                      recovery_max_attempts=20, **options)
    await api.client.aclose()
    api.client = httpx.AsyncClient(base_url="http://test.invalid/",
                                  transport=httpx.MockTransport(handler))
    return api


@pytest.mark.parametrize("operation", ["video", "checkpoint"])
async def test_patient_recovery_survives_more_than_four_failures(operation, monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        if len(requests) <= 7:
            raise httpx.ConnectError("temporarily unavailable")
        return httpx.Response(200, content=b"video" if operation == "video" else b'{"ok":true}')

    sleep = AsyncMock()
    monkeypatch.setattr("effect_template_mix.api.asyncio.sleep", sleep)
    api = await client(handler)
    try:
        if operation == "video":
            runtime = SimpleNamespace(run_id="run", project_id="project", attempt_token="lease")
            assert await api.video(runtime, "material", 100) == b"video"
            assert all(request.headers["x-attempt-token"] == "lease" for request in requests)
        else:
            assert await api.request("PUT", "checkpoint", json={"value": 1}) == {"ok": True}
            assert all(request.content == requests[0].content for request in requests)
        assert len(requests) == 8
        assert all(request.url == requests[0].url for request in requests)
        assert [call.args[0] for call in sleep.await_args_list] == [2, 4, 8, 16, 30, 30, 30]
    finally:
        await api.close()


async def test_total_recovery_budget_bounds_backoff(monkeypatch):
    clock = [0.0]
    waits = []
    requests = []

    async def sleep(seconds):
        waits.append(seconds)
        clock[0] += seconds

    def handler(request):
        requests.append(request)
        raise httpx.ConnectError("temporarily unavailable")

    monkeypatch.setattr("effect_template_mix.api.monotonic", lambda: clock[0])
    monkeypatch.setattr("effect_template_mix.api.asyncio.sleep", sleep)
    api = await client(handler, recovery_timeout_seconds=5)
    try:
        with pytest.raises(ApiError) as error:
            await api.request("PUT", "checkpoint")
        assert error.value.retryable
        assert len(requests) == 2
        assert waits == [2, 3]
    finally:
        await api.close()


async def test_hung_download_obeys_total_deadline():
    async def handler(request):
        await asyncio.Event().wait()

    api = await client(handler, recovery_timeout_seconds=0.01)
    try:
        with pytest.raises(ApiError) as error:
            await api.video(SimpleNamespace(run_id="run", project_id="project", attempt_token="lease"), "material", 100)
        assert error.value.retryable
    finally:
        await api.close()


async def test_cancellation_during_recovery_is_not_swallowed(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("temporarily unavailable")

    monkeypatch.setattr("effect_template_mix.api.asyncio.sleep", AsyncMock(side_effect=asyncio.CancelledError))
    api = await client(handler)
    try:
        with pytest.raises(asyncio.CancelledError):
            await api.request("PUT", "checkpoint")
    finally:
        await api.close()


async def test_patient_policy_never_replays_ambiguous_mutation():
    requests = []

    def handler(request):
        requests.append(request)
        raise httpx.ReadTimeout("response lost after mutation")

    api = await client(handler)
    try:
        with pytest.raises(ApiError):
            await api.request("POST", "claim")
        assert len(requests) == 1
    finally:
        await api.close()
