from __future__ import annotations

import asyncio
import json
import logging

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection
from pydantic import ValidationError

from .api_client import InternalApi, InternalApiError
from .models import QueueMessage, RuntimeContext
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
        max_concurrency: int = 3,
    ) -> None:
        self._rabbitmq_url = rabbitmq_url
        self._queue_name = queue_name
        self._api = api
        self._provider = provider
        self._max_concurrency = max_concurrency
        self._connection: AbstractRobustConnection | None = None

    async def run(self) -> None:
        self._connection = await aio_pika.connect_robust(self._rabbitmq_url)
        channel = await self._connection.channel()
        await channel.set_qos(prefetch_count=self._max_concurrency)
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

            async def progress(value: int, provider_task_id: str | None) -> None:
                await self._api.heartbeat(context, value, provider_task_id)

            output = await self._provider.render(claim.input, progress)
            await self._api.complete(context, output)
        except Exception as exc:
            LOGGER.exception(
                "segment render failed task_id=%s error=%s",
                request.task_id if request else "unknown",
                type(exc).__name__,
            )
            retryable, code, message_text = _safe_failure(exc)
            persisted = False
            if context is not None:
                try:
                    await self._api.fail(
                        context,
                        error_code=code,
                        error_message=message_text,
                        retryable=retryable,
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


def _safe_failure(exc: Exception) -> tuple[bool, str, str]:
    if isinstance(exc, ProviderError):
        return exc.retryable, exc.code, str(exc)
    if isinstance(exc, InternalApiError):
        return exc.retryable, "INTERNAL_API_ERROR", "视频渲染内部回写失败"
    if isinstance(exc, ValidationError):
        return False, "VALIDATION_ERROR", "视频渲染数据结构校验失败"
    return False, "WORKER_ERROR", "视频渲染 Worker 执行失败"
