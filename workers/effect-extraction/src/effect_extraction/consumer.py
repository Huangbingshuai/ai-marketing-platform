from __future__ import annotations

import json
import logging
import asyncio
from typing import Any

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection
from langgraph.graph.state import CompiledStateGraph
from pydantic import ValidationError

from .api_client import InternalApi, InternalApiError
from .models import ExtractionRequest, GraphState, InputState, OutputState, RuntimeContext
from .pipeline import ExtractionPipeline, PipelineError
from .providers import ProviderError

logger = logging.getLogger(__name__)


class ExtractionConsumer:
    def __init__(
        self,
        *,
        rabbitmq_url: str,
        queue_name: str,
        api: InternalApi,
        pipeline: ExtractionPipeline,
        graph: CompiledStateGraph[GraphState, RuntimeContext, InputState, OutputState],
    ) -> None:
        self._rabbitmq_url = rabbitmq_url
        self._queue_name = queue_name
        self._api = api
        self._pipeline = pipeline
        self._graph = graph
        self._connection: AbstractRobustConnection | None = None

    async def run(self) -> None:
        self._connection = await aio_pika.connect_robust(self._rabbitmq_url)
        channel = await self._connection.channel()
        await channel.set_qos(prefetch_count=1)
        queue = await channel.declare_queue(self._queue_name, durable=True)
        logger.info("effect extraction worker is consuming queue=%s", self._queue_name)
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
        request: ExtractionRequest | None = None
        context: RuntimeContext | None = None
        try:
            payload = json.loads(message.body)
            request = ExtractionRequest.model_validate(payload)
            claim = await self._api.claim(request.run_id, request.project_id)
            if claim.terminal:
                await message.ack()
                logger.info("ignoring terminal extraction run_id=%s", request.run_id)
                return
            if claim.input is None or claim.attempt_token is None or claim.source_fingerprint is None:
                raise PipelineError("claim response is missing input, attemptToken, or sourceFingerprint")
            snapshot = claim.input
            context = RuntimeContext(
                run_id=request.run_id,
                project_id=request.project_id,
                draft_id=snapshot.draft_id,
                product_id=snapshot.product.id,
                request_id=request.request_id,
                attempt_token=claim.attempt_token,
                source_fingerprint=claim.source_fingerprint,
            )
            self._pipeline.register_snapshot(context, snapshot)
            stop_heartbeat = asyncio.Event()
            heartbeat = asyncio.create_task(self._heartbeat(context, stop_heartbeat))
            try:
                result = await self._graph.ainvoke(
                    {"project_id": request.project_id},
                    context=context,
                    config={"max_concurrency": 4},
                )
            finally:
                stop_heartbeat.set()
                await heartbeat
            if not isinstance(result, dict) or not result.get("extract_result_id"):
                raise PipelineError("graph completed without extract_result_id")
        except (json.JSONDecodeError, ValidationError) as exc:
            logger.warning("rejecting malformed extraction message: %s", type(exc).__name__)
            await message.reject(requeue=False)
            return
        except Exception as exc:
            logger.exception(
                "effect extraction failed run_id=%s error=%s",
                request.run_id if request else "unknown",
                type(exc).__name__,
            )
            retryable = _retryable(exc)
            if context is not None:
                try:
                    await self._pipeline.mark_failed(context, exc)
                except Exception:
                    logger.exception("failed to persist terminal extraction failure")
            if retryable and not message.redelivered:
                await message.nack(requeue=True)
                return
            await message.reject(requeue=False)
            return
        await message.ack()
        logger.info("effect extraction completed run_id=%s", request.run_id)

    async def _heartbeat(self, context: RuntimeContext, stop: asyncio.Event) -> None:
        while True:
            try:
                await asyncio.wait_for(stop.wait(), timeout=30.0)
                return
            except TimeoutError:
                await self._pipeline.heartbeat(context)


def _retryable(exc: Exception) -> bool:
    if isinstance(exc, (InternalApiError, ProviderError)):
        return exc.retryable
    return False
