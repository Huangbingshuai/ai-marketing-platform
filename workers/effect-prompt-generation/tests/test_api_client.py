from __future__ import annotations

import json

import httpx
import pytest

from effect_prompt_generation.api_client import HttpInternalApi
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
