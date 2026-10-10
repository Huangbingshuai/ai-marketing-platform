from typing import Any
import httpx
import pytest
from customized_extraction.api import Api
from extraction_runtime.http import InternalApiError


@pytest.mark.asyncio
@pytest.mark.parametrize("status,expected_calls", [(503, 4), (409, 1), (404, 1)])
async def test_internal_api_retries_only_transient_errors_with_finite_budget(
    monkeypatch: Any, status: int, expected_calls: int
) -> None:
    calls = 0
    delays = []

    async def sleep(delay: float) -> None:
        delays.append(delay)

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(status, json={"success": False})

    monkeypatch.setattr("customized_extraction.api.asyncio.sleep", sleep)
    api = Api("http://test/api", "test-token", "project", "task")
    await api.client.aclose()
    api.client = httpx.AsyncClient(
        base_url="http://test/api/", transport=httpx.MockTransport(respond)
    )
    try:
        with pytest.raises(InternalApiError):
            await api.call("PUT", "progress", {"progress": 16})
    finally:
        await api.close()
    assert calls == expected_calls
    assert delays == ([1, 2, 4] if status == 503 else [])


@pytest.mark.asyncio
async def test_transient_progress_failure_recovers_without_repeating_pipeline(
    monkeypatch: Any,
) -> None:
    calls = 0

    async def sleep(delay: float) -> None:
        pass

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("test outage", request=request)
        return httpx.Response(200, json={"success": True, "data": {"accepted": True}})

    monkeypatch.setattr("customized_extraction.api.asyncio.sleep", sleep)
    api = Api("http://test/api", "test-token", "project", "task")
    await api.client.aclose()
    api.client = httpx.AsyncClient(
        base_url="http://test/api/", transport=httpx.MockTransport(respond)
    )
    try:
        assert await api.call("PUT", "progress", {"progress": 32}) == {"accepted": True}
    finally:
        await api.close()
    assert calls == 2
