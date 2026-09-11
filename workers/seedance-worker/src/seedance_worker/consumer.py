from __future__ import annotations

import asyncio
import json
import logging

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection
from pydantic import ValidationError

from .api_client import InternalApi, InternalApiError
from .models import QueueMessage, RenderOutput, RuntimeContext
from .providers import ProviderError, VideoProvider


LOGGER = logging.getLogger(__name__)


class SegmentRenderConsumer:
    def __init__(
        self,
        *,
        rabbitmq_url: str,
        queue_name: str,
        api: InternalApi,
        provider: VideoProvider,
        max_inflight: int = 20,
        result_concurrency: int = 3,
    ) -> None:
        self._rabbitmq_url = rabbitmq_url
        self._queue_name = queue_name
        self._api = api
        self._provider = provider
        self._max_inflight = max_inflight
        self._result_slots = asyncio.Semaphore(result_concurrency)
        self._connection: AbstractRobustConnection | None = None

    async def run(self) -> None:
        self._connection = await aio_pika.connect_robust(self._rabbitmq_url)
        channel = await self._connection.channel()
        await channel.set_qos(prefetch_count=self._max_inflight)
        queue = await channel.declare_queue(self._queue_name, durable=True)
        LOGGER.info("seedance worker is consuming queue=%s", self._queue_name)
        await queue.consume(self.handle)
        await self._connection.ready()
        try:
            await asyncio.Future[None]()
        finally:
            await channel.close()

    async def close(self) -> None:
        if self._connection is not None and not self._connection.is_closed:
            await self._connection.close()

    async def handle(self, message: AbstractIncomingMessage) -> None:
        request: QueueMessage | None = None
        context: RuntimeContext | None = None
        provider_task_id: str | None = None
        try:
            try:
                request = QueueMessage.model_validate(json.loads(message.body))
            except (json.JSONDecodeError, ValidationError) as exc:
                LOGGER.warning(
                    "rejecting malformed segment-render message error=%s",
                    type(exc).__name__,
                )
                await message.reject(requeue=False)
                return
            claim = await self._api.claim(request.task_id, request.project_id)
            if claim.terminal:
                await message.ack()
                return
            if (
                claim.input is None
                or claim.task_version is None
                or claim.attempt_token is None
            ):
                raise RuntimeError("claim response is missing task input or lease")
            context = RuntimeContext(
                project_id=request.project_id,
                task_id=request.task_id,
                task_version=claim.task_version,
                request_id=request.request_id,
                attempt_token=claim.attempt_token,
            )
            provider_task_id = claim.provider_task_id

            async def progress(value: int, reported_provider_task_id: str | None) -> None:
                nonlocal provider_task_id
                if reported_provider_task_id is not None:
                    provider_task_id = reported_provider_task_id
                await self._api.heartbeat(context, value, reported_provider_task_id)

            reference_images: list[str] = []
            reference_video_url: str | None = None
            if claim.provider_task_id is None:
                await self._api.heartbeat(context, 2)
                if claim.input.operation == "REPAIR":
                    if (
                        claim.input.input_video is None
                        or claim.input.input_video.provider_task_id is None
                    ):
                        reference_video_url = await self._api.reference_video_url(context)
                else:
                    reference_images = await self._api.reference_images(
                        context, claim.input.input_images
                    )
                await self._api.heartbeat(context, 5)
            output = await self._provider.render(
                claim.input,
                reference_images,
                reference_video_url,
                progress,
                claim.provider_task_id,
            )
            provider_task_id = output.provider_task_id
            await self._complete_limited(context, output)
        except Exception as exc:
            LOGGER.exception(
                "segment render failed task_id=%s error=%s",
                request.task_id if request else "unknown",
                type(exc).__name__,
            )
            retryable, code, message_text, reset_provider_task = _safe_failure(exc)
            persisted = False
            if context is not None:
                try:
                    await self._api.fail(
                        context,
                        error_code=code,
                        error_message=message_text,
                        retryable=retryable,
                        provider_task_id=provider_task_id,
                        reset_provider_task=reset_provider_task,
                    )
                    persisted = True
                except Exception:
                    LOGGER.exception("failed to persist segment-render failure")
            if persisted:
                await message.ack()
            elif retryable and not message.redelivered:
                await message.nack(requeue=True)
            else:
                await message.reject(requeue=False)
            return
        await message.ack()
        LOGGER.info("segment render completed task_id=%s", request.task_id)

    async def _complete_limited(
        self, context: RuntimeContext, output: RenderOutput
    ) -> None:
        while True:
            try:
                await asyncio.wait_for(self._result_slots.acquire(), timeout=30)
                break
            except TimeoutError:
                await self._api.heartbeat(context, 94, output.provider_task_id)
        try:
            await self._api.complete(context, output)
        finally:
            self._result_slots.release()


def _safe_failure(exc: Exception) -> tuple[bool, str, str, bool]:
    if isinstance(exc, ProviderError):
        return exc.retryable, exc.code, str(exc), exc.reset_provider_task
    if isinstance(exc, InternalApiError):
        return exc.retryable, "INTERNAL_API_ERROR", "视频渲染内部回写失败", False
    if isinstance(exc, ValidationError):
        return False, "VALIDATION_ERROR", "视频渲染数据结构校验失败", False
    return False, "WORKER_ERROR", "视频渲染 Worker 执行失败", False
