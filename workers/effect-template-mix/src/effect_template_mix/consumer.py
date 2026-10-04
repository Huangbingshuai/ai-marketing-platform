import asyncio
import json
import logging
import tempfile
from collections.abc import Awaitable
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, TypeVar

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection
from pydantic import ValidationError

from .api import ApiError, InternalApi
from .models import Classification, Material, QueueMessage, Runtime, SampledMaterial, Selection, TrimOutput
from .provider import ArkProvider, ProviderError
from .reliability import classification_chunks
from .video import sample_frames
from .packaging import PackagingHandler
from .final_output import FinalOutputHandler
from .caption_voice import CaptionVoiceHandler
from .voice_preview import VoicePreviewHandler

LOGGER = logging.getLogger(__name__)
T = TypeVar("T")


@contextmanager
def temporary_video_directory() -> Iterator[Path]:
    temporary = tempfile.TemporaryDirectory(prefix="effect-template-mix-")
    try:
        yield Path(temporary.name)
    except BaseException:
        try:
            temporary.cleanup()
        except OSError as cleanup_error:
            LOGGER.warning("temporary video cleanup failed errno=%s", cleanup_error.errno)
        raise
    else:
        temporary.cleanup()


async def gather_cancel_on_error(calls: list[Awaitable[T]]) -> list[T]:
    tasks = [asyncio.ensure_future(call) for call in calls]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


class Consumer:
    def __init__(
        self,
        rabbitmq_url: str,
        queue: str,
        api: InternalApi,
        provider: ArkProvider,
        max_video_bytes: int,
        classification_batch_size: int,
        classification_input_token_budget: int,
        classification_max_output_tokens: int,
        ai_max_concurrency: int,
        packaging: PackagingHandler | None = None,
        final_output: FinalOutputHandler | None = None,
        voice_preview: VoicePreviewHandler | None = None,
        caption_voice: CaptionVoiceHandler | None = None,
    ) -> None:
        self.rabbitmq_url = rabbitmq_url
        self.queue = queue
        self.api = api
        self.provider = provider
        self.max_video_bytes = max_video_bytes
        self.classification_batch_size = classification_batch_size
        self.classification_input_token_budget = classification_input_token_budget
        self.classification_max_output_tokens = classification_max_output_tokens
        self.ai_max_concurrency = ai_max_concurrency
        self.packaging = packaging
        self.final_output = final_output
        self.voice_preview = voice_preview
        self.caption_voice = caption_voice
        self.long_task = asyncio.Semaphore(1)
        self.request_slots = packaging.requests if packaging else asyncio.Semaphore(ai_max_concurrency)
        self.connection: AbstractRobustConnection | None = None

    async def run(self) -> None:
        self.connection = await aio_pika.connect_robust(self.rabbitmq_url)
        channel = await self.connection.channel()
        # At most one long job plus one interactive task (a voice preview or a caption narration);
        # long-job execution remains serialized.
        await channel.set_qos(prefetch_count=2)
        queue = await channel.declare_queue(self.queue, durable=True)
        await queue.consume(self.handle)
        await self.connection.ready()
        await asyncio.Future()

    async def close(self) -> None:
        if self.connection and not self.connection.is_closed:
            await self.connection.close()

    async def handle(self, message: AbstractIncomingMessage) -> None:
        try:
            envelope = json.loads(message.body)
        except (ValueError, UnicodeDecodeError):
            await message.ack()
            return
        if isinstance(envelope, dict) and envelope.get('schemaVersion') == 2 and envelope.get('taskType') == 'VOICE_PREVIEW':
            if self.voice_preview is None:
                await message.nack(requeue=False)
            else:
                await self.voice_preview.handle(message, envelope)
            return
        # A caption narration is a one-off paid call the editor is waiting on, so it must not queue
        # behind a packaging run; it is serialized against itself, not against the long task.
        if isinstance(envelope, dict) and envelope.get('schemaVersion') == 2 and envelope.get('taskType') == 'CAPTION_VOICE':
            if self.caption_voice is None:
                await message.nack(requeue=False)
            else:
                await self.caption_voice.handle(message, envelope)
            return
        async with self.long_task:
            await self.handle_work(message)

    async def handle_work(self, message: AbstractIncomingMessage) -> None:
        try:
            envelope = json.loads(message.body)
        except (ValueError, UnicodeDecodeError):
            await message.ack()
            return
        if isinstance(envelope, dict) and envelope.get('schemaVersion') == 2 and envelope.get('taskType') == 'PACKAGING':
            if self.packaging is None:
                await message.nack(requeue=False)
                return
            await self.packaging.handle(message, envelope)
            return
        if isinstance(envelope, dict) and envelope.get('schemaVersion') == 2 and envelope.get('taskType') == 'FINAL_OUTPUT':
            if self.final_output is None:
                await message.nack(requeue=False)
                return
            await self.final_output.handle(message, envelope)
            return
        runtime: Runtime | None = None
        heartbeat_task: asyncio.Task[None] | None = None
        heartbeat_stage = "CLASSIFYING"
        heartbeat_progress = 2
        try:
            request = QueueMessage.model_validate(json.loads(message.body))
            claim = await self.api.claim(request.projectId, request.runId)
            if claim.terminal:
                await message.ack()
                return
            if not claim.attemptToken or not claim.snapshot:
                raise RuntimeError("claim response missing lease")
            runtime = Runtime(project_id=request.projectId, run_id=request.runId, attempt_token=claim.attemptToken)
            snapshot = claim.snapshot
            checkpoint = claim.checkpoint or {}

            async def report(stage: str, progress: int) -> None:
                nonlocal heartbeat_stage, heartbeat_progress
                heartbeat_stage = stage
                heartbeat_progress = progress
                await self.api.progress(runtime, stage, progress)

            async def keep_lease() -> None:
                while True:
                    await asyncio.sleep(30)
                    try:
                        await self.api.progress(runtime, heartbeat_stage, heartbeat_progress)
                    except ApiError as exc:
                        if not exc.retryable:
                            raise
                        # A temporary API outage must not permanently kill the heartbeat.
                        LOGGER.warning("template mix heartbeat temporarily unavailable")

            heartbeat_task = asyncio.create_task(keep_lease())
            restored_rows = [
                Classification.model_validate(item)
                for item in checkpoint.get("classifications") or []
            ]
            rows: list[Classification]
            selections: list[Selection]
            if snapshot.trimOnly:
                if not checkpoint.get("selections"):
                    raise RuntimeError("trim-only run is missing fixed slot selections")
                rows = restored_rows
                selections = [Selection.model_validate(item) for item in checkpoint["selections"]]
            elif restored_rows and checkpoint.get("selections"):
                rows = restored_rows
                selections = [Selection.model_validate(item) for item in checkpoint["selections"]]
            else:
                await report("CLASSIFYING", 10)
                rows_by_id = {item.materialId: item for item in restored_rows}
                manual_rows = [
                    Classification.model_validate({
                        "materialId": material_id,
                        "source": "MANUAL",
                        "scores": {role: int(role == assigned_role) for role in
                                   ("HOOK", "PAIN_POINT", "PRODUCT", "SELLING_POINT", "TRANSFORMATION", "END")},
                        "reasons": {assigned_role: "用户手动归槽"},
                    })
                    for material_id, assigned_role in snapshot.manualMaterialRoles.items()
                    if material_id in {item.id for item in snapshot.materials}
                ]
                rows_by_id.update({item.materialId: item for item in manual_rows})
                restored_ids = {item.materialId for item in restored_rows}
                new_manual_rows = [item for item in manual_rows if item.materialId not in restored_ids]
                if new_manual_rows:
                    await self.api.checkpoint_classifications(runtime, new_manual_rows)
                pending_materials = [
                    item for item in snapshot.materials if item.id not in rows_by_id
                ]
                batches = classification_chunks(
                    pending_materials,
                    configured_max_size=self.classification_batch_size,
                    max_output_tokens=self.classification_max_output_tokens,
                    max_input_tokens=self.classification_input_token_budget,
                )
                semaphore = self.request_slots

                async def classify_batch(batch: list[Material]) -> list[Classification]:
                    nonlocal heartbeat_progress
                    expected_ids = {item.id for item in batch}
                    try:
                        async with semaphore:
                            candidate = await self.provider.classify(snapshot.slots, batch)
                        actual_ids = [item.materialId for item in candidate.classifications]
                        if len(actual_ids) != len(expected_ids) or set(actual_ids) != expected_ids:
                            raise ProviderError(
                                "AI 归槽结果缺少素材或存在重复素材",
                                retryable=False,
                                split_recommended=True,
                            )
                    except ProviderError as exc:
                        if exc.split_recommended and len(batch) > 1:
                            midpoint = (len(batch) + 1) // 2
                            recovered: list[Classification] = []
                            recovered.extend(await classify_batch(batch[:midpoint]))
                            recovered.extend(await classify_batch(batch[midpoint:]))
                            return recovered
                        raise
                    rows_by_id.update(
                        {item.materialId: item for item in candidate.classifications}
                    )
                    estimated_progress = 10 + round(
                        len(rows_by_id) / max(1, len(snapshot.materials)) * 20
                    )
                    heartbeat_progress = max(heartbeat_progress, estimated_progress)
                    saved = await self.api.checkpoint_classifications(
                        runtime,
                        candidate.classifications,
                    )
                    heartbeat_progress = max(heartbeat_progress, saved.progress)
                    return candidate.classifications

                await gather_cancel_on_error(
                    [classify_batch(batch) for batch in batches]
                )
                rows = [rows_by_id[item.id] for item in snapshot.materials]
                await report("MATCHING", 35)
                selections = await self.api.classify(runtime, rows)
            materials = {item.id: item for item in snapshot.materials}
            slots = {item.id: item for item in snapshot.slots}
            restored_trims = [
                TrimOutput.model_validate(item) for item in checkpoint.get("trims") or []
            ]
            def trim_key(item: Selection | TrimOutput) -> str:
                return item.materialId
            trims_by_key = {trim_key(item): item for item in restored_trims}
            pending_selections = [
                (index, selection)
                for index, selection in enumerate(selections)
                if trim_key(selection) not in trims_by_key
            ]
            if pending_selections:
                await report("SAMPLING", max(50, heartbeat_progress))
                await report(
                    "TRIMMING",
                    max(
                        55,
                        55 + round(len(restored_trims) / max(1, len(selections)) * 35),
                    ),
                )
            with temporary_video_directory() as root:
                trim_semaphore = self.request_slots

                async def trim_selection(index: int, selection: Selection) -> None:
                    nonlocal heartbeat_progress
                    async with trim_semaphore:
                        material = materials[selection.materialId]
                        slot = slots[selection.slotId]
                        data = await self.api.video(runtime, material.id, self.max_video_bytes)
                        path = root / f"{selection.variantIndex:02d}-{index:03d}.mp4"
                        path.write_bytes(data)
                        frames = await sample_frames(path, material.duration)
                        await self.api.checkpoint_sampling(
                            runtime,
                            [SampledMaterial(
                                materialId=material.id,
                                frameTimestampsSeconds=[timestamp for timestamp, _ in frames],
                            )],
                        )
                        choice = None
                        max_start = max(0.0, material.duration - slot.duration)
                        for attempt in range(2):
                            correction = (
                                None
                                if attempt == 0
                                else f"上次起点越界；请重新选择 0 到 {max_start:.3f} 秒之间的起点。"
                            )
                            trim_candidate = await self.provider.trim(
                                slot, material, frames, correction
                            )
                            if trim_candidate.trimStartSeconds <= max_start + 0.001:
                                choice = trim_candidate
                                break
                            if attempt == 1:
                                raise ProviderError("AI 截取区间超出源视频", retryable=False)
                        assert choice is not None
                        result = TrimOutput(
                            variantIndex=selection.variantIndex,
                            slotId=slot.id,
                            materialId=material.id,
                            trimStartSeconds=round(choice.trimStartSeconds, 3),
                            trimReason=choice.trimReason,
                        )
                    trims_by_key[trim_key(result)] = result
                    heartbeat_progress = max(
                        heartbeat_progress,
                        55 + round(len(trims_by_key) / max(1, len(selections)) * 35),
                    )
                    saved = await self.api.checkpoint_trims(runtime, [result])
                    heartbeat_progress = max(heartbeat_progress, saved.progress)

                await gather_cancel_on_error(
                    [trim_selection(index, selection) for index, selection in pending_selections]
                )
            trims = [trims_by_key[trim_key(selection)] for selection in selections]
            await self.api.complete(runtime, trims)
        except Exception as exc:
            LOGGER.exception("template mix task failed error=%s", type(exc).__name__)
            if runtime:
                retryable = isinstance(exc, (ApiError, ProviderError)) and exc.retryable
                error_message = "智能填充服务暂时不可用，请重试" if retryable else "智能填充结果无效，请检查素材后重试"
                if not retryable and isinstance(exc, (ApiError, ProviderError)):
                    detail = str(exc)
                    if detail and detail not in ("internal API rejected request", "internal API unavailable"):
                        error_message = detail
                try:
                    await self.api.fail(runtime, "AI_TASK_FAILED", error_message, retryable)
                except Exception:
                    LOGGER.exception("failed to persist template mix error")
                    await message.nack(requeue=not message.redelivered)
                    return
            await message.ack()
            return
        finally:
            if heartbeat_task:
                heartbeat_task.cancel()
                try:
                    await heartbeat_task
                except asyncio.CancelledError:
                    pass
                except Exception as heartbeat_error:
                    # The main task has already completed or recorded its failure. A late
                    # lease heartbeat must not keep the RabbitMQ delivery unacknowledged.
                    LOGGER.warning("template mix heartbeat stopped error=%s", type(heartbeat_error).__name__)
        await message.ack()
