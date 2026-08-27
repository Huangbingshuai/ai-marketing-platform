from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

import httpx

from .models import (
    ClaimResponse,
    CompleteResponse,
    FailurePayload,
    ProgressPayload,
    PromptBatchResult,
    RuntimeContext,
    ShardRecord,
    ShardsResponse,
    StageOutput,
)


class InternalApiError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool, status_code: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code


class InternalApi(Protocol):
    async def claim(self, run_id: str, project_id: str) -> ClaimResponse: ...
    async def put_stage(self, context: RuntimeContext, output: StageOutput) -> None: ...
    async def put_shard(self, context: RuntimeContext, shard: ShardRecord) -> None: ...
    async def get_shards(self, context: RuntimeContext) -> list[ShardRecord]: ...
    async def heartbeat(self, context: RuntimeContext, payload: ProgressPayload) -> None: ...
    async def complete(self, context: RuntimeContext, result: PromptBatchResult) -> str: ...
    async def fail(self, context: RuntimeContext, payload: FailurePayload) -> None: ...


def _unwrap(payload: Any) -> Any:
    if isinstance(payload, Mapping) and "success" in payload:
        if payload.get("success") is not True:
            raise InternalApiError(str(payload.get("message") or "success=false"), retryable=False)
        return payload.get("data")
    return payload


def _safe_response_message(response: httpx.Response) -> str | None:
    """Keep internal API diagnostics useful without echoing arbitrary response bodies."""
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, Mapping):
        return None
    raw = payload.get("message")
    values = raw if isinstance(raw, list) else [raw]
    cleaned = [" ".join(str(value).split())[:200] for value in values if value]
    return "; ".join(cleaned[:3])[:500] or None


class HttpInternalApi:
    _ROOT = "internal/workers/effect-prompt-generation"

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=timeout,
            transport=transport,
            headers={"x-worker-token": token, "accept": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._client.request(method, path, **kwargs)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise InternalApiError("internal API is unavailable", retryable=True) from exc
        if response.is_error:
            retryable = response.status_code == 429 or response.status_code >= 500
            detail = _safe_response_message(response)
            raise InternalApiError(
                f"internal API returned HTTP {response.status_code}"
                + (f": {detail}" if detail else ""),
                retryable=retryable,
                status_code=response.status_code,
            )
        return response

    async def _json(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self._request(method, path, **kwargs)
        try:
            return _unwrap(response.json())
        except ValueError as exc:
            raise InternalApiError("internal API returned invalid JSON", retryable=False) from exc

    @staticmethod
    def _lease(context: RuntimeContext) -> dict[str, str]:
        return {"x-attempt-token": context.attempt_token}

    async def claim(self, run_id: str, project_id: str) -> ClaimResponse:
        data = await self._json(
            "POST", f"{self._ROOT}/runs/{run_id}/claim", json={"projectId": project_id}
        )
        return ClaimResponse.model_validate(data)

    async def put_stage(self, context: RuntimeContext, output: StageOutput) -> None:
        await self._json(
            "PUT",
            f"{self._ROOT}/runs/{context.run_id}/stages/{output.node_id.value}",
            headers=self._lease(context),
            json={
                "projectId": context.project_id,
                "status": output.status.value,
                "summary": output.summary,
                "warnings": [_safe_text(item, 500) for item in output.warnings],
                "metadata": output.metadata,
            },
        )

    async def put_shard(self, context: RuntimeContext, shard: ShardRecord) -> None:
        await self._json(
            "PUT",
            f"{self._ROOT}/runs/{context.run_id}/shards/{shard.phase.value}/{shard.round}/{shard.shard_index}",
            headers=self._lease(context),
            json={
                "projectId": context.project_id,
                "phase": shard.phase.value,
                "status": shard.status.value,
                "combinationPlan": [
                    item.model_dump(mode="json", by_alias=True) for item in shard.combination_plan
                ],
                "items": [item.model_dump(mode="json", by_alias=True) for item in shard.items],
                "blueprintPlan": [
                    item.model_dump(mode="json", by_alias=True) for item in shard.blueprint_plan
                ],
                "blueprints": [
                    item.model_dump(mode="json", by_alias=True) for item in shard.blueprints
                ],
                "warnings": [_safe_text(item, 500) for item in shard.warnings],
                "errorCode": shard.error_code,
                "errorMessage": shard.error_message,
            },
        )

    async def get_shards(self, context: RuntimeContext) -> list[ShardRecord]:
        data = await self._json(
            "GET",
            f"{self._ROOT}/runs/{context.run_id}/shards",
            params={"projectId": context.project_id},
            headers=self._lease(context),
        )
        if isinstance(data, list):
            return [ShardRecord.model_validate(item) for item in data]
        return ShardsResponse.model_validate(data).shards

    async def heartbeat(self, context: RuntimeContext, payload: ProgressPayload) -> None:
        del payload
        await self._json(
            "PUT",
            f"{self._ROOT}/runs/{context.run_id}/heartbeat",
            headers=self._lease(context),
            json={"projectId": context.project_id},
        )

    async def complete(self, context: RuntimeContext, result: PromptBatchResult) -> str:
        data = await self._json(
            "POST",
            f"{self._ROOT}/runs/{context.run_id}/complete",
            headers=self._lease(context),
            json={
                "projectId": context.project_id,
                "result": result.model_dump(mode="json", by_alias=True),
            },
        )
        return CompleteResponse.model_validate(data).prompt_result_id

    async def fail(self, context: RuntimeContext, payload: FailurePayload) -> None:
        await self._json(
            "POST",
            f"{self._ROOT}/runs/{context.run_id}/fail",
            headers=self._lease(context),
            json={
                "projectId": context.project_id,
                "errorCode": _safe_text(payload.error_code, 100),
                "errorMessage": _safe_text(payload.error_message, 500),
                "retryable": payload.retryable,
                "warnings": [_safe_text(item, 500) for item in payload.warnings],
                "currentNode": (
                    payload.current_node.value if payload.current_node else None
                ),
            },
        )


def _safe_text(value: str, limit: int) -> str:
    return " ".join(value.split())[:limit]
