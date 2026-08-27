from __future__ import annotations

import json

import httpx
import pytest

from effect_prompt_generation.api_client import HttpInternalApi, InternalApiError
from effect_prompt_generation.models import NodeId, ProgressPayload, RuntimeContext, StageOutput, StageStatus


@pytest.mark.asyncio
async def test_internal_api_uses_worker_and_attempt_tokens(runtime: RuntimeContext) -> None:
    context = runtime
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"success": True, "data": {}})

    api = HttpInternalApi(
        "http://api.local/api",
        "worker-token",
        transport=httpx.MockTransport(handler),
    )
    try:
        await api.put_stage(
            context,
            StageOutput(
                node_id=NodeId.QUALITY_GATE,
                status=StageStatus.RUNNING,
                summary="正在校验",
            ),
        )
        await api.heartbeat(context, ProgressPayload(progress=40, current_node=NodeId.QUALITY_GATE))
    finally:
        await api.aclose()

    assert requests[0].url.path.endswith("/internal/workers/effect-prompt-generation/runs/run-1/stages/QUALITY_GATE")
    assert requests[0].headers["x-worker-token"] == "worker-token"
    assert requests[0].headers["x-attempt-token"] == "attempt-1"
    assert json.loads(requests[1].content) == {"projectId": "project-1"}


@pytest.mark.asyncio
async def test_get_shards_accepts_backend_run_id_envelope(runtime: RuntimeContext) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "success": True,
                "data": {"runId": "run-1", "shards": []},
            },
        )

    api = HttpInternalApi(
        "http://api.local/api",
        "worker-token",
        transport=httpx.MockTransport(handler),
    )
    try:
        assert await api.get_shards(runtime) == []
    finally:
        await api.aclose()


@pytest.mark.asyncio
async def test_internal_api_error_includes_only_bounded_structured_message() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={"message": [" first validation error ", "second\nerror", "x" * 300, "ignored"]},
        )

    api = HttpInternalApi(
        "http://api.local/api",
        "worker-token",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(InternalApiError) as caught:
            await api._request("GET", "invalid")
    finally:
        await api.aclose()

    message = str(caught.value)
    assert message.startswith("internal API returned HTTP 400: first validation error; second error; ")
    assert "ignored" not in message
    assert len(message) <= 532


@pytest.mark.asyncio
async def test_internal_api_error_does_not_echo_non_json_body() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="upstream body must stay private")

    api = HttpInternalApi(
        "http://api.local/api",
        "worker-token",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(InternalApiError) as caught:
            await api._request("GET", "invalid")
    finally:
        await api.aclose()

    assert str(caught.value) == "internal API returned HTTP 502"
    assert caught.value.retryable is True
