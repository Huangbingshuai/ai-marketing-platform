from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from effect_prompt_generation.consumer import PromptGenerationConsumer
from effect_prompt_generation.models import (
    ClaimResponse,
    FailurePayload,
    ProgressPayload,
    PromptBatchResult,
    PromptGenerationSnapshot,
    RuntimeContext,
    ShardRecord,
    StageOutput,
)
from effect_prompt_generation.pipeline import PipelineError, PromptGenerationPipeline
from effect_prompt_generation.providers import MockAiProvider


class ConsumerApi:
    def __init__(self, snapshot: PromptGenerationSnapshot) -> None:
        self.snapshot = snapshot
        self.failures: list[FailurePayload] = []
        self.claim_count = 0

    async def claim(self, run_id: str, project_id: str) -> ClaimResponse:
        self.claim_count += 1
        return ClaimResponse(
            terminal=False,
            run_id=run_id,
            source_fingerprint="fingerprint",
            attempt_token="attempt-token",
            input=self.snapshot,
        )

    async def put_stage(self, context: RuntimeContext, output: StageOutput) -> None:
        return None

    async def put_shard(self, context: RuntimeContext, shard: ShardRecord) -> None:
        return None

    async def get_shards(self, context: RuntimeContext) -> list[ShardRecord]:
        return []

    async def heartbeat(self, context: RuntimeContext, payload: ProgressPayload) -> None:
        return None

    async def complete(self, context: RuntimeContext, result: PromptBatchResult) -> str:
        return "result-id"

    async def fail(self, context: RuntimeContext, payload: FailurePayload) -> None:
        self.failures.append(payload)


class TrackingPipeline(PromptGenerationPipeline):
    def __init__(self, *, api: ConsumerApi) -> None:
        super().__init__(api=api, provider=MockAiProvider())
        self.unregistered = False

    def unregister(self, context: RuntimeContext) -> None:
        super().unregister(context)
        self.unregistered = True


class RuntimeValidationGraph:
    async def ainvoke(self, *args: object, **kwargs: object) -> dict[str, str]:
        raise ValidationError.from_exception_data(
            "RuntimeResult", [{"type": "missing", "loc": ("content",), "input": {}}]
        )


class FakeMessage:
    def __init__(self, payload: bytes) -> None:
        self.body = payload
        self.redelivered = False
        self.acked = False
        self.rejected = False
        self.nacked = False

    async def ack(self) -> None:
        self.acked = True

    async def reject(self, *, requeue: bool) -> None:
        assert requeue is False
        self.rejected = True

    async def nack(self, *, requeue: bool) -> None:
        self.nacked = True


@pytest.mark.asyncio
async def test_runtime_validation_error_is_persisted_as_safe_failure_and_cache_is_cleared(
    snapshot: PromptGenerationSnapshot,
) -> None:
    api = ConsumerApi(snapshot)
    pipeline = TrackingPipeline(api=api)
    consumer = PromptGenerationConsumer(
        rabbitmq_url="amqp://unused",
        queue_name="unused",
        api=api,
        pipeline=pipeline,
        graph=RuntimeValidationGraph(),  # type: ignore[arg-type]
    )
    message = FakeMessage(
        json.dumps(
            {
                "schemaVersion": 2,
                "runId": "run-1",
                "projectId": snapshot.project_id,
                "requestId": "request-1",
            }
        ).encode()
    )

    await consumer.handle(message)  # type: ignore[arg-type]

    assert message.rejected is True
    assert message.acked is False
    assert api.failures[0].error_code == "VALIDATION_ERROR"
    assert api.failures[0].error_message == "Prompt 子工作流数据结构校验失败"
    assert pipeline.unregistered is True
    context = RuntimeContext(
        run_id="run-1",
        project_id=snapshot.project_id,
        workflow_run_id=snapshot.workflow_run_id,
        product_id=snapshot.product_id,
        request_id="request-1",
        attempt_token="attempt-token",
        source_fingerprint="fingerprint",
    )
    with pytest.raises(PipelineError, match="not registered"):
        pipeline.snapshot(context)


@pytest.mark.asyncio
async def test_message_validation_error_is_rejected_without_claim_or_failure(
    snapshot: PromptGenerationSnapshot,
) -> None:
    api = ConsumerApi(snapshot)
    pipeline = TrackingPipeline(api=api)
    consumer = PromptGenerationConsumer(
        rabbitmq_url="amqp://unused",
        queue_name="unused",
        api=api,
        pipeline=pipeline,
        graph=RuntimeValidationGraph(),  # type: ignore[arg-type]
    )
    message = FakeMessage(b"{}")

    await consumer.handle(message)  # type: ignore[arg-type]

    assert message.rejected is True
    assert api.claim_count == 0
    assert api.failures == []
