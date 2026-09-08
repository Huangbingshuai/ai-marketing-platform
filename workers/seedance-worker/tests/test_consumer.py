from __future__ import annotations

import asyncio
import json
from typing import Any

from seedance_worker.consumer import SegmentRenderConsumer
from seedance_worker.models import ClaimResponse, RenderOutput, RenderSnapshot
from seedance_worker.providers import ProviderError


def render_snapshot() -> RenderSnapshot:
    return RenderSnapshot.model_validate(
        {
            "promptId": "prompt-a",
            "promptCode": "P001",
            "promptText": "产品展示",
            "primaryPurpose": "PRODUCT_DISPLAY",
            "compatiblePurposes": ["PRODUCT_DISPLAY"],
            "promptContentHash": "a" * 64,
            "sharedPromptHash": "b" * 64,
            "renderSettingsHash": "c" * 64,
            "sourcePackage": {
                "artifactId": "source-a",
                "revision": 1,
                "contentHash": "d" * 64,
            },
            "inputImages": [
                {
                    "fileObjectId": "image-a",
                    "originalFileName": "main.png",
                    "mimeType": "image/png",
                    "sizeBytes": 5,
                    "contentHash": "e" * 64,
                    "sortOrder": 0,
                }
            ],
            "request": {
                "model": "seedance-model",
                "content": [{"type": "text", "text": "产品展示"}],
                "duration": 5,
                "ratio": "9:16",
                "resolution": "1080p",
            },
        }
    )


class Message:
    def __init__(self, payload: bytes) -> None:
        self.body = payload
        self.redelivered = False
        self.acked = False
        self.nacked = False
        self.rejected = False

    async def ack(self) -> None:
        self.acked = True

    async def nack(self, *, requeue: bool) -> None:
        self.nacked = requeue

    async def reject(self, *, requeue: bool) -> None:
        self.rejected = not requeue


class Api:
    def __init__(self) -> None:
        self.completed: RenderOutput | None = None
        self.failures: list[dict[str, Any]] = []
        self.heartbeats: list[int] = []

    async def claim(self, task_id: str, project_id: str) -> ClaimResponse:
        return ClaimResponse.model_validate(
            {
                "terminal": False,
                "taskId": task_id,
                "taskVersion": 1,
                "attemptToken": "attempt-a",
                "sourceFingerprint": "c" * 64,
                "providerTaskId": None,
                "input": render_snapshot().model_dump(by_alias=True),
            }
        )

    async def heartbeat(
        self, context: Any, progress: int, provider_task_id: str | None = None
    ) -> None:
        self.heartbeats.append(progress)

    async def reference_images(self, context: Any, images: Any) -> list[str]:
        assert len(images) == 1
        return ["data:image/png;base64,aW1hZ2U="]

    async def reference_video_url(self, context: Any) -> str:
        return "https://api.example.test/reference.mp4?signature=signed"

    async def complete(self, context: Any, output: RenderOutput) -> None:
        self.completed = output

    async def fail(self, context: Any, **failure: Any) -> None:
        self.failures.append(failure)


class Provider:
    def __init__(self, error: ProviderError | None = None) -> None:
        self.error = error

    async def render(
        self,
        snapshot: RenderSnapshot,
        reference_images: list[str],
        reference_video_url: str | None,
        progress: Any,
        provider_task_id: str | None = None,
    ) -> RenderOutput:
        assert reference_images == ["data:image/png;base64,aW1hZ2U="]
        assert reference_video_url is None
        assert provider_task_id is None
        if self.error:
            raise self.error
        await progress(50, "provider-a")
        return RenderOutput(
            provider_task_id="provider-a",
            content=b"video",
            file_name="P001.mp4",
            duration=5,
            ratio="9:16",
            resolution="1080p",
        )

    async def aclose(self) -> None:
        return None


def queue_body() -> bytes:
    return json.dumps(
        {
            "schemaVersion": 1,
            "projectId": "project-a",
            "runId": "task-a",
            "requestId": "request-a",
        }
    ).encode()


async def test_consumer_claims_renders_uploads_and_acknowledges() -> None:
    api = Api()
    message = Message(queue_body())
    consumer = SegmentRenderConsumer(
        rabbitmq_url="amqp://unused",
        queue_name="test.render",
        api=api,
        provider=Provider(),
    )

    await consumer.handle(message)  # type: ignore[arg-type]

    assert message.acked
    assert api.heartbeats == [2, 5, 50]
    assert api.completed is not None
    assert api.completed.provider_task_id == "provider-a"


async def test_consumer_persists_a_safe_provider_failure_before_acknowledging() -> None:
    api = Api()
    message = Message(queue_body())
    consumer = SegmentRenderConsumer(
        rabbitmq_url="amqp://unused",
        queue_name="test.render",
        api=api,
        provider=Provider(ProviderError("SEEDANCE_TIMEOUT", "生成超时", retryable=True)),
    )

    await consumer.handle(message)  # type: ignore[arg-type]

    assert message.acked
    assert api.failures == [
        {
            "error_code": "SEEDANCE_TIMEOUT",
            "error_message": "生成超时",
            "retryable": True,
            "provider_task_id": None,
            "reset_provider_task": False,
        }
    ]


async def test_consumer_rejects_a_malformed_queue_message() -> None:
    api = Api()
    message = Message(b"not-json")
    consumer = SegmentRenderConsumer(
        rabbitmq_url="amqp://unused",
        queue_name="test.render",
        api=api,
        provider=Provider(),
    )

    await consumer.handle(message)  # type: ignore[arg-type]

    assert message.rejected
    assert api.completed is None


async def test_consumer_limits_parallel_result_uploads_independently() -> None:
    class SlowApi(Api):
        def __init__(self) -> None:
            super().__init__()
            self.active_uploads = 0
            self.peak_uploads = 0

        async def complete(self, context: Any, output: RenderOutput) -> None:
            self.active_uploads += 1
            self.peak_uploads = max(self.peak_uploads, self.active_uploads)
            await asyncio.sleep(0.01)
            self.active_uploads -= 1
            await super().complete(context, output)

    api = SlowApi()
    messages = [Message(queue_body()) for _ in range(5)]
    consumer = SegmentRenderConsumer(
        rabbitmq_url="amqp://unused",
        queue_name="test.render",
        api=api,
        provider=Provider(),
        max_inflight=20,
        result_concurrency=2,
    )

    await asyncio.gather(*(consumer.handle(message) for message in messages))  # type: ignore[arg-type]

    assert api.peak_uploads == 2
    assert all(message.acked for message in messages)
