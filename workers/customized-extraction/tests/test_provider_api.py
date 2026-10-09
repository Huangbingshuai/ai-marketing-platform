from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

import httpx
import pytest

from customized_extraction.api import Api
from customized_extraction.models import Review
from customized_extraction.provider import Provider
from extraction_runtime.http import InternalApiError
from extraction_runtime.responses import ProviderError, ProviderErrorType


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,expected",
    [
        (401, ProviderErrorType.REQUEST_REJECTED),
        (429, ProviderErrorType.RATE_LIMIT),
        (503, ProviderErrorType.SERVICE),
    ],
)
async def test_provider_reports_safe_errors(
    status: int, expected: ProviderErrorType
) -> None:
    provider = Provider(
        "https://provider.invalid/api/v3",
        "test-only-secret",
        "test-model",
        max_attempts=1,
    )
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url="https://provider.invalid/api/v3/",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(status, text="private-provider-body")
        ),
    )
    try:
        with pytest.raises(ProviderError) as caught:
            await provider.generate(
                "DOCUMENT_EXTRACT", "test-only", "private-input", Review
            )
        assert caught.value.error_type == expected
        assert "private" not in str(caught.value)
    finally:
        await provider.close()


@pytest.mark.asyncio
async def test_provider_uses_shared_structured_schema_and_retries_invalid_output() -> (
    None
):
    calls: list[dict[str, Any]] = []

    def respond(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        calls.append(payload)
        return httpx.Response(
            200,
            json={
                "output_text": "invalid-json" if len(calls) == 1 else '{"issues":[]}'
            },
        )

    provider = Provider(
        "https://provider.invalid/api/v3",
        "test-only-secret",
        "test-model",
        max_attempts=2,
    )
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url="https://provider.invalid/api/v3/",
        transport=httpx.MockTransport(respond),
    )
    try:
        result = await provider.generate(
            "SEMANTIC_REFINEMENT", "核对来源", '{"fields":{}}', Review
        )
        assert result.issues == [] and len(calls) == 2
        assert calls[0]["text"]["format"]["strict"] is True
        assert calls[0]["text"]["format"]["schema"]["additionalProperties"] is False
        assert "input_image" not in json.dumps(calls)
    finally:
        await provider.close()


@pytest.mark.asyncio
async def test_internal_api_scopes_raw_and_multipart_requests_and_rejects_expired_attempt() -> (
    None
):
    project_id, task_id, source_id = (str(uuid4()) for _ in range(3))
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["x-worker-token"] == "test-worker-token"
        if request.url.path.endswith("/claim"):
            assert json.loads(request.content) == {"projectId": project_id}
            return httpx.Response(
                200, json={"success": True, "data": {"attemptToken": "attempt-1"}}
            )
        assert request.headers["x-attempt-token"] == "attempt-1"
        if "/sources/" in request.url.path:
            assert request.url.params["projectId"] == project_id
            return httpx.Response(200, content=b"raw-test-document")
        if request.url.path.endswith("/artifacts"):
            assert (
                b'name="sourceId"' in request.content
                and source_id.encode() in request.content
            )
            assert b"parsed-test-document" in request.content
            return httpx.Response(201, json={"success": True, "data": {}})
        return httpx.Response(409, json={"success": False})

    api = Api("https://api.invalid/api", "test-worker-token", project_id, task_id)
    await api.client.aclose()
    api.client = httpx.AsyncClient(
        base_url="https://api.invalid/api/",
        headers={"x-worker-token": "test-worker-token"},
        transport=httpx.MockTransport(respond),
    )
    try:
        api.token = (await api.call("POST", "claim"))["attemptToken"]
        assert await api.content(source_id) == b"raw-test-document"
        await api.upload(source_id, "parsed-test-document")
        with pytest.raises(InternalApiError) as caught:
            await api.call(
                "PUT", "progress", {"progress": 10, "nodeId": "DOCUMENT_PARSE"}
            )
        assert caught.value.status_code == 409 and not caught.value.retryable
        assert all(task_id in str(request.url) for request in requests)
    finally:
        await api.close()
