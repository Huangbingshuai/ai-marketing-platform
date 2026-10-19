from __future__ import annotations

import asyncio
from dataclasses import asdict
from collections.abc import Awaitable, Callable
from typing import Protocol, Any
import httpx
from ai_runtime.seedance import SeedanceTransport, ProviderError as ProviderError, ProgressCallback as ProgressCallback, _EvenRateLimiter as _EvenRateLimiter, _mapping, _text
from .models import RenderOutput, RenderSnapshot

class VideoProvider(Protocol):
    async def render(
        self,
        snapshot: RenderSnapshot,
        reference_images: list[str],
        reference_video_url: str | None,
        progress: ProgressCallback,
        provider_task_id: str | None = None,
    ) -> RenderOutput: ...

    async def aclose(self) -> None: ...


class ArkSeedanceProvider(SeedanceTransport):
    async def render(
        self,
        snapshot: RenderSnapshot,
        reference_images: list[str],
        reference_video_url: str | None,
        progress: ProgressCallback,
        provider_task_id: str | None = None,
    ) -> RenderOutput:
        deadline = asyncio.get_running_loop().time() + self._timeout_seconds
        payload: dict[str, Any] = {}
        if provider_task_id is None:
            if snapshot.operation == "REPAIR":
                reference_video_url = await self._repair_reference_video_url(
                    snapshot, reference_video_url, deadline
                )
            payload = snapshot.request.model_dump(mode="json")
            if snapshot.operation == "REPAIR" and snapshot.repair is not None and snapshot.repair.provider_mode == "VIDEO_EDIT":
                # Seedance 2.5 exact video editing requires adaptive ratio and lets
                # the provider preserve the input duration.
                payload.update(
                    {
                        "omni_reference_task_type": "edit",
                        "duration": -1,
                        "ratio": "adaptive",
                    }
                )
            else:
                payload["duration"] = int(snapshot.request.duration)
            payload["content"] = [
                *payload["content"],
                *[
                    {
                        "type": "image_url",
                        "image_url": {"url": image},
                        "role": "reference_image",
                    }
                    for image in reference_images
                ],
                *(
                    [
                        {
                            "type": "video_url",
                            "video_url": {"url": reference_video_url},
                            "role": "reference_video",
                        }
                    ]
                    if reference_video_url is not None
                    else []
                ),
            ]
        result = await self.render_request(payload, snapshot.prompt_code + ".mp4", progress, provider_task_id, deadline=deadline)
        return RenderOutput(**asdict(result))

    async def _repair_reference_video_url(
        self,
        snapshot: RenderSnapshot,
        fallback_url: str | None,
        deadline: float,
    ) -> str:
        # A signed URL for the frozen local file is an explicit recovery source.
        # Looking up an old Ark task again does NOT renew its output URL.
        if fallback_url is not None:
            if await self._reference_video_readable(fallback_url):
                return fallback_url
            raise ProviderError(
                "SEEDANCE_REFERENCE_VIDEO_UNAVAILABLE",
                "系统保存的参考视频地址无法访问，请检查公网素材访问配置",
                retryable=False,
            )
        source_task_id = (
            snapshot.input_video.provider_task_id
            if snapshot.input_video is not None
            else None
        )
        if source_task_id is not None:
            try:
                source = await self._read_task_with_retry(source_task_id, deadline)
            except ProviderError as exc:
                if exc.code != "SEEDANCE_HTTP_404":
                    raise
                raise ProviderError(
                    "SEEDANCE_SOURCE_VIDEO_UNAVAILABLE",
                    "Seedance 原视频任务已过期或删除，请改用系统保存的素材",
                    retryable=False,
                ) from exc
            status = (_text(source.get("status")) or "").casefold()
            source_url = self._output_url(source)
            if status not in {"succeeded", "completed", "success"} or not source_url:
                raise ProviderError(
                    "SEEDANCE_SOURCE_VIDEO_UNAVAILABLE",
                    "Seedance 原视频任务已不可复用",
                    retryable=False,
                )
            if not await self._reference_video_readable(source_url):
                raise ProviderError(
                    "SEEDANCE_SOURCE_VIDEO_EXPIRED",
                    "Seedance 原视频临时地址已失效，请改用系统保存的素材",
                    retryable=False,
                )
            return source_url
        raise ProviderError(
            "REFERENCE_VIDEO_REQUIRED",
            "视频返修任务缺少参考视频",
            retryable=False,
        )

    async def _reference_video_readable(self, url: str) -> bool:
        # HEAD is not consistently supported by provider object storage. Stream
        # a one-byte range instead, close immediately, and never send Ark auth.
        try:
            async with self._download_client.stream(
                "GET", url, headers={"Range": "bytes=0-0"}
            ) as response:
                if response.status_code in {400, 401, 403, 404, 410}:
                    return False
                if response.status_code >= 400:
                    raise ProviderError(
                        "SEEDANCE_REFERENCE_VIDEO_NETWORK",
                        "参考视频读取暂时失败，请稍后重试",
                        retryable=response.status_code == 429
                        or response.status_code >= 500,
                    )
                content_type = (
                    response.headers.get("content-type", "").split(";", 1)[0].strip()
                )
                if content_type and content_type not in {
                    "video/mp4",
                    "video/quicktime",
                    "application/octet-stream",
                }:
                    return False
                async for chunk in response.aiter_bytes(chunk_size=1):
                    return bool(chunk)
                return False
        except httpx.HTTPError as exc:
            raise ProviderError(
                "SEEDANCE_REFERENCE_VIDEO_NETWORK",
                "参考视频读取暂时失败，请稍后重试",
                retryable=True,
            ) from exc



class MockVideoProvider:
    async def render(
        self,
        snapshot: RenderSnapshot,
        reference_images: list[str],
        reference_video_url: str | None,
        progress: ProgressCallback,
        provider_task_id: str | None = None,
    ) -> RenderOutput:
        del reference_images, reference_video_url
        provider_task_id = provider_task_id or "mock-" + snapshot.prompt_id
        await progress(50, provider_task_id)
        return RenderOutput(
            provider_task_id=provider_task_id,
            content=b"\x00\x00\x00\x18ftypmp42mock-video",
            file_name=snapshot.prompt_code + ".mp4",
            duration=snapshot.request.duration,
            ratio=snapshot.request.ratio,
            resolution=snapshot.request.resolution,
        )

    async def aclose(self) -> None:
        return None
