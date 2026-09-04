from __future__ import annotations

import asyncio
import json
import logging

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection
from langgraph.graph.state import CompiledStateGraph
from pydantic import ValidationError

from .api_client import InternalApi, InternalApiError
from .models import (
    GraphState,
    InputState,
    OutputState,
    PromptGenerationRequest,
    RuntimeContext,
)
from .pipeline import PipelineError, PromptGenerationPipeline
from .providers import ProviderError


LOGGER = logging.getLogger(__name__)
HEARTBEAT_INTERVAL_SECONDS = 30.0
HEARTBEAT_RETRY_SECONDS = 5.0


class PromptGenerationConsumer:
    def __init__(
        self,
        *,
        rabbitmq_url: str,
        queue_name: str,
        api: InternalApi,
        pipeline: PromptGenerationPipeline,
        graph: CompiledStateGraph[GraphState, RuntimeContext, InputState, OutputState],
        max_concurrency: int = 3,
        heartbeat_interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
        heartbeat_retry_seconds: float = HEARTBEAT_RETRY_SECONDS,
    ) -> None:
        self._rabbitmq_url = rabbitmq_url
        self._queue_name = queue_name
        self._api = api
        self._pipeline = pipeline
        self._graph = graph
        self._max_concurrency = max_concurrency
        self._heartbeat_interval_seconds = heartbeat_interval_seconds
        self._heartbeat_retry_seconds = heartbeat_retry_seconds
        self._connection: AbstractRobustConnection | None = None

    async def run(self) -> None:
        self._connection = await aio_pika.connect_robust(self._rabbitmq_url)
        channel = await self._connection.channel()
        await channel.set_qos(prefetch_count=1)
        queue = await channel.declare_queue(self._queue_name, durable=True)
        LOGGER.info("effect prompt worker is consuming queue=%s", self._queue_name)
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
        request: PromptGenerationRequest | None = None
        context: RuntimeContext | None = None
        try:
            try:
                request = PromptGenerationRequest.model_validate(
                    json.loads(message.body)
                )
            except (json.JSONDecodeError, ValidationError) as exc:
                LOGGER.warning(
                    "rejecting malformed prompt message error=%s", type(exc).__name__
                )
                await message.reject(requeue=False)
                return
            claim = await self._api.claim(request.run_id, request.project_id)
            if claim.terminal:
                await message.ack()
                LOGGER.info("ignoring terminal prompt run_id=%s", request.run_id)
                return
            if (
                claim.input is None
                or claim.attempt_token is None
                or claim.source_fingerprint is None
            ):
                raise PipelineError(
                    "claim response is missing input, attemptToken, or sourceFingerprint"
                )
            snapshot = claim.input
            context = RuntimeContext(
                run_id=request.run_id,
                project_id=request.project_id,
                workflow_run_id=snapshot.workflow_run_id,
                product_id=snapshot.product_id,
                request_id=request.request_id,
                attempt_token=claim.attempt_token,
                source_fingerprint=claim.source_fingerprint,
            )
            self._pipeline.register_snapshot(
                context,
                snapshot,
                [*claim.strategy_checkpoints, *claim.stage_checkpoints],
            )
            try:
                stop = asyncio.Event()
                heartbeat = asyncio.create_task(self._heartbeat(context, stop))
                try:
                    result = await self._graph.ainvoke(
                        {"project_id": request.project_id},
                        context=context,
                        config={"max_concurrency": self._max_concurrency},
                    )
                finally:
                    stop.set()
                    await heartbeat
                if not isinstance(result, dict) or not result.get("prompt_result_id"):
                    raise PipelineError("graph completed without prompt_result_id")
            finally:
                self._pipeline.unregister(context)
        except Exception as exc:
            LOGGER.exception(
                "effect prompt generation failed run_id=%s error=%s",
                request.run_id if request else "unknown",
                type(exc).__name__,
            )
            retryable = _retryable(exc)
            failure_persisted = False
            if context is not None:
                try:
                    await self._pipeline.mark_failed(context, exc)
                    failure_persisted = True
                except Exception:
                    LOGGER.exception("failed to persist prompt-generation failure")
            if failure_persisted:
                await message.ack()
                return
            if retryable and not message.redelivered:
                await message.nack(requeue=True)
                return
            await message.reject(requeue=False)
            return
        await message.ack()
        LOGGER.info("effect prompt generation completed run_id=%s", request.run_id)

    async def _heartbeat(self, context: RuntimeContext, stop: asyncio.Event) -> None:
        while True:
            if await self._wait_for_stop(
                stop, timeout=self._heartbeat_interval_seconds
            ):
                return
            while True:
                try:
                    await self._pipeline.heartbeat(context)
                    break
                except InternalApiError as exc:
                    if not exc.retryable:
                        raise
                    LOGGER.warning(
                        "Prompt heartbeat temporarily unavailable run_id=%s; retrying",
                        context.run_id,
                    )
                    if await self._wait_for_stop(
                        stop, timeout=self._heartbeat_retry_seconds
                    ):
                        return

    @staticmethod
    async def _wait_for_stop(stop: asyncio.Event, *, timeout: float) -> bool:
        try:
            await asyncio.wait_for(stop.wait(), timeout=timeout)
        except TimeoutError:
            return False
        else:
            return True


def _retryable(exc: Exception) -> bool:
    return isinstance(exc, (InternalApiError, ProviderError)) and exc.retryable
