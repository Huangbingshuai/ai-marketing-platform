from __future__ import annotations

import asyncio
import zlib
from dataclasses import dataclass
from collections.abc import Awaitable, Callable, Mapping
from typing import Any
import httpx

ProgressCallback = Callable[[int, str | None], Awaitable[None]]

class _EvenRateLimiter:
    def __init__(self, rate_per_second: float) -> None:
        self._interval_seconds = 1 / rate_per_second
        self._next_at = 0.0
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        loop = asyncio.get_running_loop()
        async with self._lock:
            now = loop.time()
            scheduled_at = max(now, self._next_at)
            self._next_at = scheduled_at + self._interval_seconds
        delay = scheduled_at - now
        if delay > 0:
            await asyncio.sleep(delay)


class ProviderError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool,
        reset_provider_task: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.reset_provider_task = reset_provider_task


@dataclass
class VideoOutput:
    provider_task_id: str
    content: bytes
    file_name: str
    mime_type: str = "video/mp4"
    duration: float | None = None
    ratio: str | None = None
    resolution: str | None = None


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


class SeedanceTransport:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        timeout_seconds: float,
        poll_interval_seconds: float,
        create_qps: float,
        download_concurrency: int,
        max_download_bytes: int,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._timeout_seconds = timeout_seconds
        self._poll_interval_seconds = poll_interval_seconds
        self._create_limiter = _EvenRateLimiter(create_qps)
        self._download_slots = asyncio.Semaphore(download_concurrency)
        self._max_download_bytes = max_download_bytes
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=httpx.Timeout(
                connect=30.0,
                read=min(60.0, timeout_seconds),
                write=min(300.0, timeout_seconds),
                pool=60.0,
            ),
            transport=transport,
            headers={
                "authorization": "Bearer " + api_key,
                "accept": "application/json",
            },
        )
        # Provider output URLs are normally temporary object-storage URLs.  Keep
        # the Ark bearer token away from that second host.
        self._download_client = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, read=min(60.0, timeout_seconds)),
            transport=transport,
            follow_redirects=True,
        )

    async def render_request(self, payload: dict[str, Any], file_name: str, progress: ProgressCallback, provider_task_id: str | None = None, *, deadline: float | None = None) -> VideoOutput:
        deadline = deadline or asyncio.get_running_loop().time() + self._timeout_seconds
        if provider_task_id is None:
            try:
                await self._create_limiter.acquire()
                created = await self._request(
                    "POST",
                    "contents/generations/tasks",
                    json=payload,
                )
            except ProviderError as exc:
                if exc.retryable and exc.code != "SEEDANCE_HTTP_429":
                    raise ProviderError(
                        "SEEDANCE_CREATE_RESULT_UNKNOWN",
                        "Seedance 创建任务结果未知，为避免重复计费已停止自动重试",
                        retryable=False,
                    ) from exc
                raise
            provider_task_id = _text(created.get("id"))
            if not provider_task_id:
                raise ProviderError(
                    "SEEDANCE_INVALID_RESPONSE",
                    "Seedance 创建任务响应缺少任务 ID",
                    retryable=False,
                )
        else:
            provider_task_id = provider_task_id.strip()
            if not provider_task_id:
                raise ProviderError(
                    "SEEDANCE_INVALID_TASK_ID",
                    "Seedance 任务 ID 无效",
                    retryable=False,
                )
        await progress(10, provider_task_id)
        current_progress = 15
        consecutive_poll_failures = 0
        while True:
            if asyncio.get_running_loop().time() >= deadline:
                raise ProviderError(
                    "SEEDANCE_TIMEOUT", "Seedance 视频生成超时", retryable=True
                )
            try:
                result = await self._request(
                    "GET", "contents/generations/tasks/" + provider_task_id
                )
            except ProviderError as exc:
                if not exc.retryable:
                    raise
                consecutive_poll_failures += 1
                # A successful create response means the provider task already
                # exists and may be billable.  Network/DNS/5xx failures while
                # reading its status must stay inside this polling loop so an
                # outer task retry cannot accidentally exhaust its retry budget.
                await progress(current_progress, provider_task_id)
                await self._sleep_before_read_retry(
                    provider_task_id, consecutive_poll_failures, deadline
                )
                continue
            consecutive_poll_failures = 0
            status = (_text(result.get("status")) or "").casefold()
            if status in {"succeeded", "completed", "success"}:
                output_url = self._output_url(result)
                if not output_url:
                    raise ProviderError(
                        "SEEDANCE_INVALID_RESPONSE",
                        "Seedance 完成响应缺少视频地址",
                        retryable=False,
                    )
                await progress(92, provider_task_id)
                content, mime_type = await self._download_limited(
                    output_url, progress, provider_task_id
                )
                content_data = _mapping(result.get("content"))
                return VideoOutput(
                    provider_task_id=provider_task_id,
                    content=content,
                    file_name=file_name,
                    mime_type=mime_type,
                    duration=self._optional_duration(
                        content_data.get("duration", result.get("duration"))
                    ),
                    ratio=_text(content_data.get("ratio", result.get("ratio"))),
                    resolution=_text(
                        content_data.get("resolution", result.get("resolution"))
                    ),
                )
            if status in {"failed", "cancelled", "canceled", "expired"}:
                error = _mapping(result.get("error"))
                code = _text(error.get("code")) or "SEEDANCE_FAILED"
                raise ProviderError(
                    code[:120],
                    "Seedance 视频生成失败",
                    retryable=code.casefold()
                    in {"rate_limit", "timeout", "service_unavailable"},
                    reset_provider_task=True,
                )
            current_progress = min(88, current_progress + 3)
            await progress(current_progress, provider_task_id)
            await asyncio.sleep(self._poll_delay(provider_task_id))

    async def _read_task_with_retry(
        self, provider_task_id: str, deadline: float
    ) -> Mapping[str, Any]:
        failure_count = 0
        while True:
            try:
                return await self._request(
                    "GET", "contents/generations/tasks/" + provider_task_id
                )
            except ProviderError as exc:
                if not exc.retryable:
                    raise
                failure_count += 1
                await self._sleep_before_read_retry(
                    provider_task_id, failure_count, deadline
                )

    async def _sleep_before_read_retry(
        self, provider_task_id: str, failure_count: int, deadline: float
    ) -> None:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise ProviderError(
                "SEEDANCE_TIMEOUT", "Seedance 视频生成超时", retryable=True
            )
        base_delay = self._poll_delay(provider_task_id)
        delay = min(30.0, base_delay * (2 ** min(failure_count - 1, 3)))
        await asyncio.sleep(min(delay, remaining))

    def _poll_delay(self, provider_task_id: str) -> float:
        bucket = zlib.crc32(provider_task_id.encode("utf-8")) % 401
        jitter_factor = 0.8 + bucket / 1000
        return self._poll_interval_seconds * jitter_factor

    async def _download_limited(
        self,
        url: str,
        progress: ProgressCallback,
        provider_task_id: str,
    ) -> tuple[bytes, str]:
        while True:
            try:
                await asyncio.wait_for(self._download_slots.acquire(), timeout=30)
                break
            except TimeoutError:
                await progress(92, provider_task_id)
        try:
            return await self._download(url, progress, provider_task_id)
        finally:
            self._download_slots.release()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Mapping[str, Any]:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise ProviderError(
                "SEEDANCE_NETWORK_TIMEOUT", "Seedance 网络请求超时", retryable=True
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                "SEEDANCE_NETWORK", "Seedance 网络请求失败", retryable=True
            ) from exc
        if response.status_code >= 400:
            retryable = response.status_code == 429 or response.status_code >= 500
            raise ProviderError(
                "SEEDANCE_HTTP_" + str(response.status_code),
                "Seedance 服务暂时不可用" if retryable else "Seedance 请求被拒绝",
                retryable=retryable,
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderError(
                "SEEDANCE_INVALID_RESPONSE",
                "Seedance 返回了无效响应",
                retryable=False,
            ) from exc
        if not isinstance(payload, Mapping):
            raise ProviderError(
                "SEEDANCE_INVALID_RESPONSE",
                "Seedance 返回了无效响应",
                retryable=False,
            )
        return payload

    def _output_url(self, result: Mapping[str, Any]) -> str | None:
        content = _mapping(result.get("content"))
        output = _mapping(result.get("output"))
        return (
            _text(content.get("video_url"))
            or _text(content.get("videoUrl"))
            or _text(output.get("video_url"))
            or _text(output.get("videoUrl"))
            or _text(result.get("video_url"))
        )

    async def _download(
        self,
        url: str,
        progress: ProgressCallback,
        provider_task_id: str,
    ) -> tuple[bytes, str]:
        try:
            async with self._download_client.stream("GET", url) as response:
                response.raise_for_status()
                declared = int(response.headers.get("content-length", "0") or 0)
                if declared > self._max_download_bytes:
                    raise ProviderError(
                        "SEEDANCE_OUTPUT_TOO_LARGE",
                        "Seedance 输出文件超过大小限制",
                        retryable=False,
                    )
                chunks: list[bytes] = []
                size = 0
                loop = asyncio.get_running_loop()
                last_heartbeat = loop.time()
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > self._max_download_bytes:
                        raise ProviderError(
                            "SEEDANCE_OUTPUT_TOO_LARGE",
                            "Seedance 输出文件超过大小限制",
                            retryable=False,
                        )
                    chunks.append(chunk)
                    if loop.time() - last_heartbeat >= 30:
                        await progress(94, provider_task_id)
                        last_heartbeat = loop.time()
                if size == 0:
                    raise ProviderError(
                        "SEEDANCE_EMPTY_OUTPUT",
                        "Seedance 输出文件为空",
                        retryable=True,
                    )
                mime_type = response.headers.get("content-type", "video/mp4")
                return b"".join(chunks), mime_type.split(";", 1)[0].strip()
        except ProviderError:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError(
                "SEEDANCE_DOWNLOAD_FAILED",
                "Seedance 输出文件下载失败",
                retryable=True,
            ) from exc

    @staticmethod
    def _optional_duration(value: Any) -> float | None:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
        return parsed if parsed > 0 and parsed < float("inf") else None

    async def aclose(self) -> None:
        await self._client.aclose()
        await self._download_client.aclose()
