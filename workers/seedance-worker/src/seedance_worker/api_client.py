from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

import httpx

from .models import ClaimResponse, RenderOutput, RuntimeContext


class InternalApiError(RuntimeError):
    def __init__(
        self, message: str, *, retryable: bool, status_code: int | None = None
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code


class InternalApi(Protocol):
    async def claim(self, task_id: str, project_id: str) -> ClaimResponse: ...
    async def heartbeat(
        self,
        context: RuntimeContext,
        progress: int,
        provider_task_id: str | None = None,
    ) -> None: ...
    async def complete(
        self, context: RuntimeContext, output: RenderOutput
    ) -> None: ...
    async def fail(
        self,
        context: RuntimeContext,
        *,
        error_code: str,
        error_message: str,
        retryable: bool,
    ) -> None: ...


def _unwrap(payload: Any) -> Any:
    if isinstance(payload, Mapping) and "success" in payload:
        if payload.get("success") is not True:
            raise InternalApiError(
                str(payload.get("message") or "success=false"), retryable=False
            )
        return payload.get("data")
    return payload


def _safe_response_message(response: httpx.Response) -> str | None:
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
    _ROOT = "internal/workers/effect-segment-render"

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

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise InternalApiError(
                "internal API request timed out", retryable=True
            ) from exc
        except httpx.HTTPError as exc:
            raise InternalApiError(
                "internal API request failed", retryable=True
            ) from exc
        if response.status_code >= 400:
            detail = _safe_response_message(response)
            message = "internal API returned HTTP " + str(response.status_code)
            if detail:
                message += ": " + detail
            raise InternalApiError(
                message,
                retryable=response.status_code >= 500,
                status_code=response.status_code,
            )
        if not response.content:
            return None
        try:
            return _unwrap(response.json())
        except ValueError as exc:
            raise InternalApiError(
                "internal API returned invalid JSON", retryable=True
            ) from exc

    @staticmethod
    def _lease(context: RuntimeContext) -> dict[str, str]:
        return {"x-attempt-token": context.attempt_token}

    async def claim(self, task_id: str, project_id: str) -> ClaimResponse:
        data = await self._request(
            "POST",
            self._ROOT + "/tasks/" + task_id + "/claim",
            json={"projectId": project_id},
        )
        return ClaimResponse.model_validate(data)

    async def heartbeat(
        self,
        context: RuntimeContext,
        progress: int,
        provider_task_id: str | None = None,
    ) -> None:
        await self._request(
            "PUT",
            self._ROOT + "/tasks/" + context.task_id + "/heartbeat",
            headers=self._lease(context),
            json={
                "projectId": context.project_id,
                "taskVersion": context.task_version,
                "progress": progress,
                **(
                    {"providerTaskId": provider_task_id}
                    if provider_task_id is not None
                    else {}
                ),
            },
        )

    async def complete(
        self, context: RuntimeContext, output: RenderOutput
    ) -> None:
        data: dict[str, str] = {
            "projectId": context.project_id,
            "taskVersion": str(context.task_version),
            "providerTaskId": output.provider_task_id,
        }
        if output.duration is not None:
            data["duration"] = str(output.duration)
        if output.ratio is not None:
            data["ratio"] = output.ratio
        if output.resolution is not None:
            data["resolution"] = output.resolution
        await self._request(
            "POST",
            self._ROOT + "/tasks/" + context.task_id + "/complete",
            headers=self._lease(context),
            data=data,
            files={
                "file": (
                    output.file_name,
                    output.content,
                    output.mime_type,
                )
            },
        )

    async def fail(
        self,
        context: RuntimeContext,
        *,
        error_code: str,
        error_message: str,
        retryable: bool,
    ) -> None:
        await self._request(
            "POST",
            self._ROOT + "/tasks/" + context.task_id + "/fail",
            headers=self._lease(context),
            json={
                "projectId": context.project_id,
                "taskVersion": context.task_version,
                "errorCode": " ".join(error_code.split())[:120],
                "errorMessage": " ".join(error_message.split())[:500],
                "retryable": retryable,
            },
        )
