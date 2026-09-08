from __future__ import annotations

import asyncio
import base64
import hashlib
from collections import OrderedDict
from collections.abc import Mapping
from typing import Any, Protocol

import httpx

from .models import ClaimResponse, InputImage, RenderOutput, RuntimeContext


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
    async def reference_images(
        self, context: RuntimeContext, images: list[InputImage]
    ) -> list[str]: ...
    async def reference_video_url(self, context: RuntimeContext) -> str: ...
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
        provider_task_id: str | None = None,
        reset_provider_task: bool = False,
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
        reference_cache_bytes: int = 128 * 1024 * 1024,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=timeout,
            transport=transport,
            headers={"x-worker-token": token, "accept": "application/json"},
        )
        self._reference_cache_bytes = reference_cache_bytes
        self._reference_cache_size = 0
        self._reference_cache: OrderedDict[str, tuple[str, int]] = OrderedDict()
        self._reference_cache_lock = asyncio.Lock()
        self._reference_load_locks: dict[str, asyncio.Lock] = {}

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

    async def _request_bytes(
        self, method: str, path: str, *, max_bytes: int, **kwargs: Any
    ) -> bytes:
        try:
            async with self._client.stream(method, path, **kwargs) as response:
                if response.status_code >= 400:
                    await response.aread()
                    detail = _safe_response_message(response)
                    message = "internal API returned HTTP " + str(response.status_code)
                    if detail:
                        message += ": " + detail
                    raise InternalApiError(
                        message,
                        retryable=response.status_code >= 500,
                        status_code=response.status_code,
                    )
                declared = int(response.headers.get("content-length", "0") or 0)
                if declared > max_bytes:
                    raise InternalApiError(
                        "reference image exceeds the frozen size limit",
                        retryable=False,
                    )
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise InternalApiError(
                            "reference image exceeds the frozen size limit",
                            retryable=False,
                        )
                    chunks.append(chunk)
                if size == 0:
                    raise InternalApiError("reference image is empty", retryable=False)
                return b"".join(chunks)
        except InternalApiError:
            raise
        except httpx.TimeoutException as exc:
            raise InternalApiError(
                "reference image request timed out", retryable=True
            ) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise InternalApiError(
                "reference image request failed", retryable=True
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

    async def reference_images(
        self, context: RuntimeContext, images: list[InputImage]
    ) -> list[str]:
        return list(
            await asyncio.gather(
                *(self._reference_image(context, image) for image in images)
            )
        )

    async def reference_video_url(self, context: RuntimeContext) -> str:
        data = await self._request(
            "POST",
            self._ROOT + "/tasks/" + context.task_id + "/reference-video-url",
            headers=self._lease(context),
            json={
                "projectId": context.project_id,
                "taskVersion": context.task_version,
            },
        )
        url = data.get("url")
        if not isinstance(url, str) or not url.startswith(("https://", "http://")):
            raise InternalApiError(
                "internal API returned an invalid reference video URL",
                retryable=False,
            )
        return url

    async def _reference_image(
        self, context: RuntimeContext, image: InputImage
    ) -> str:
        cache_key = image.content_hash + ":" + image.mime_type
        async with self._reference_cache_lock:
            cached = self._reference_cache.get(cache_key)
            if cached is not None:
                self._reference_cache.move_to_end(cache_key)
                return cached[0]
            load_lock = self._reference_load_locks.setdefault(cache_key, asyncio.Lock())
        async with load_lock:
            async with self._reference_cache_lock:
                cached = self._reference_cache.get(cache_key)
                if cached is not None:
                    self._reference_cache.move_to_end(cache_key)
                    return cached[0]
            return await self._load_reference_image(context, image, cache_key)

    async def _load_reference_image(
        self, context: RuntimeContext, image: InputImage, cache_key: str
    ) -> str:
        content = await self._request_bytes(
            "GET",
            self._ROOT
            + "/tasks/"
            + context.task_id
            + "/reference-images/"
            + image.file_object_id,
            headers=self._lease(context),
            params={
                "projectId": context.project_id,
                "taskVersion": context.task_version,
            },
            max_bytes=image.size_bytes,
        )
        if len(content) != image.size_bytes:
            raise InternalApiError(
                "reference image size no longer matches the task snapshot",
                retryable=False,
            )
        if hashlib.sha256(content).hexdigest() != image.content_hash:
            raise InternalApiError(
                "reference image hash no longer matches the task snapshot",
                retryable=False,
            )
        data_uri = (
            "data:"
            + image.mime_type
            + ";base64,"
            + base64.b64encode(content).decode("ascii")
        )
        cache_size = len(data_uri)
        if cache_size <= self._reference_cache_bytes:
            async with self._reference_cache_lock:
                existing = self._reference_cache.pop(cache_key, None)
                if existing is not None:
                    self._reference_cache_size -= existing[1]
                while (
                    self._reference_cache
                    and self._reference_cache_size + cache_size
                    > self._reference_cache_bytes
                ):
                    _, (_, removed_size) = self._reference_cache.popitem(last=False)
                    self._reference_cache_size -= removed_size
                self._reference_cache[cache_key] = (data_uri, cache_size)
                self._reference_cache_size += cache_size
        return data_uri

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
        provider_task_id: str | None = None,
        reset_provider_task: bool = False,
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
                **(
                    {"providerTaskId": provider_task_id}
                    if provider_task_id is not None
                    else {}
                ),
                "resetProviderTask": reset_provider_task,
            },
        )
