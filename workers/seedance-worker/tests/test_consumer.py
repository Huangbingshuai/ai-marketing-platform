from __future__ import annotations

import asyncio
import json
from typing import Any
import pytest

from seedance_worker.consumer import SegmentRenderConsumer
from seedance_worker.api_client import InternalApiError
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


def test_frozen_refresh_metadata_never_replaces_the_compiled_generation_input() -> None:
    original = render_snapshot().model_dump(by_alias=True)
    snapshot = RenderSnapshot.model_validate({
        **original,
        "refreshContext": {"schemaVersion": 1, "confirmationSignature": "confirmed",
                           "sourcePrompt": {"artifactId": "old-source", "revision": 3}},
        "adoptedInput": {"promptText": "旧视频正文", "request": {"duration": 10}},
        "adoptedPrompt": {"sourcePrompt": {"revision": 1}},
    })
    assert snapshot.prompt_text == original["promptText"]
    assert snapshot.request.duration == original["request"]["duration"]
    assert snapshot.request.content == render_snapshot().request.content
    assert snapshot.input_images == render_snapshot().input_images


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


class RepairApi(Api):
    def __init__(self, unavailable: bool = False, resumed: bool = False) -> None:
        super().__init__()
        self.unavailable = unavailable
        self.resumed = resumed
        self.references = 0

    async def claim(self, task_id: str, project_id: str) -> ClaimResponse:
        claim = await super().claim(task_id, project_id)
        data = render_snapshot().model_dump(by_alias=True)
        data.update({"operation": "REPAIR", "inputImages": [], "inputVideo": {
            "fileObjectId": "saved-video", "providerTaskId": "source-task", "originalFileName": "saved.mp4",
            "mimeType": "video/mp4", "sizeBytes": 1024, "contentHash": "f" * 64, "durationSeconds": 5,
        }, "repair": {"sourceVersion": 1, "startMs": 0, "endMs": 2000,
            "instruction": "修复画面", "region": None}})
        return claim.model_copy(update={"input": RenderSnapshot.model_validate(data),
            "provider_task_id": "existing-repair" if self.resumed else None})

    async def reference_video_url(self, context: Any) -> str:
        self.references += 1
        if self.unavailable:
            raise InternalApiError("Seedance 参考视频访问地址尚未配置", retryable=False, status_code=409)
        return await super().reference_video_url(context)


class RepairProvider(Provider):
    def __init__(self, error_code: str) -> None:
        super().__init__()
        self.code = error_code
        self.calls = 0

    async def render(self, snapshot: RenderSnapshot, reference_images: list[str],
        reference_video_url: str | None, progress: Any, provider_task_id: str | None = None,
    ) -> RenderOutput:
        self.calls += 1
        assert not reference_images
        if self.calls == 1:
            raise ProviderError(self.code, "参考视频失败", retryable=False)
        assert reference_video_url is not None
        assert provider_task_id is None
        await progress(50, "new-repair")
        return RenderOutput(provider_task_id="new-repair", content=b"video", file_name="P001.mp4")


@pytest.mark.parametrize("error_code", ["SEEDANCE_SOURCE_VIDEO_EXPIRED", "SEEDANCE_SOURCE_VIDEO_UNAVAILABLE"])
async def test_repair_recovers_owned_video_before_creating(error_code: str) -> None:
    api = RepairApi()
    provider = RepairProvider(error_code)
    message = Message(queue_body())
    consumer = SegmentRenderConsumer(rabbitmq_url="amqp://unused", queue_name="test.render", api=api, provider=provider)
    await consumer.handle(message)  # type: ignore[arg-type]
    assert message.acked
    assert api.references == 1 and provider.calls == 2
    assert api.completed is not None and not api.failures


async def test_repair_missing_public_access_is_explicit_and_preserves_output() -> None:
    api = RepairApi(unavailable=True)
    provider = RepairProvider("SEEDANCE_SOURCE_VIDEO_EXPIRED")
    message = Message(queue_body())
    consumer = SegmentRenderConsumer(rabbitmq_url="amqp://unused", queue_name="test.render", api=api, provider=provider)
    await consumer.handle(message)  # type: ignore[arg-type]
    assert message.acked and api.completed is None
    assert provider.calls == 1 and api.references == 1
    assert api.failures[0]["error_code"] == "REFERENCE_VIDEO_RECOVERY_NOT_CONFIGURED"
    assert "原素材已保留" in api.failures[0]["error_message"]
    assert not api.failures[0]["retryable"]


@pytest.mark.parametrize("resumed,error_code", [(True, "SEEDANCE_SOURCE_VIDEO_EXPIRED"), (False, "SEEDANCE_HTTP_400")])
async def test_repair_does_not_recreate_existing_or_rejected_tasks(resumed: bool, error_code: str) -> None:
    api = RepairApi(resumed=resumed)
    provider = RepairProvider(error_code)
    message = Message(queue_body())
    consumer = SegmentRenderConsumer(rabbitmq_url="amqp://unused", queue_name="test.render", api=api, provider=provider)
    await consumer.handle(message)  # type: ignore[arg-type]
    assert message.acked
    assert provider.calls == 1 and api.references == 0
    assert api.completed is None and api.failures
