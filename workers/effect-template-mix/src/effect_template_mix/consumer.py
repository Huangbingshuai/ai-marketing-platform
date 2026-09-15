import asyncio
import json
import logging
import tempfile
from collections.abc import Awaitable
from contextlib import suppress
from pathlib import Path
from typing import TypeVar

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection
from pydantic import ValidationError

from .api import ApiError, InternalApi
from .models import Classification, Material, QueueMessage, Runtime, Selection, TrimOutput
from .provider import ArkProvider, ProviderError
from .reliability import classification_chunks
from .video import sample_frames

LOGGER = logging.getLogger(__name__)
T = TypeVar("T")


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
        self.connection: AbstractRobustConnection | None = None

    async def run(self) -> None:
        self.connection = await aio_pika.connect_robust(self.rabbitmq_url)
        channel = await self.connection.channel()
        await channel.set_qos(prefetch_count=1)
        queue = await channel.declare_queue(self.queue, durable=True)
        await queue.consume(self.handle)
        await self.connection.ready()
        await asyncio.Future()

    async def close(self) -> None:
        if self.connection and not self.connection.is_closed:
            await self.connection.close()

    async def handle(self, message: AbstractIncomingMessage) -> None:
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
                    await self.api.progress(
                        runtime,
                        heartbeat_stage,
                        heartbeat_progress,
                    )

            heartbeat_task = asyncio.create_task(keep_lease())
            restored_rows = [
                Classification.model_validate(item)
                for item in checkpoint.get("classifications") or []
            ]
            rows: list[Classification]
            selections: list[Selection]
            if restored_rows and checkpoint.get("selections"):
                rows = restored_rows
                selections = [Selection.model_validate(item) for item in checkpoint["selections"]]
            else:
                await report("CLASSIFYING", 10)
                rows_by_id = {item.materialId: item for item in restored_rows}
                pending_materials = [
                    item for item in snapshot.materials if item.id not in rows_by_id
                ]
                batches = classification_chunks(
                    pending_materials,
                    configured_max_size=self.classification_batch_size,
                    max_output_tokens=self.classification_max_output_tokens,
                    max_input_tokens=self.classification_input_token_budget,
                )
                semaphore = asyncio.Semaphore(self.ai_max_concurrency)

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
                return f"{item.variantIndex}:{item.slotId}"
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
            with tempfile.TemporaryDirectory(prefix="effect-template-mix-") as directory:
                root = Path(directory)
                trim_semaphore = asyncio.Semaphore(self.ai_max_concurrency)

                async def trim_selection(index: int, selection: Selection) -> None:
                    nonlocal heartbeat_progress
                    async with trim_semaphore:
                        material = materials[selection.materialId]
                        slot = slots[selection.slotId]
                        data = await self.api.video(runtime, material.id, self.max_video_bytes)
                        path = root / f"{selection.variantIndex:02d}-{index:03d}.mp4"
                        path.write_bytes(data)
                        frames = await sample_frames(path, material.duration)
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
                try:
                    await self.api.fail(runtime, "AI_TASK_FAILED", "智能填充服务暂时不可用，请重试" if retryable else "智能填充结果无效，请检查素材后重试", retryable)
                except Exception:
                    LOGGER.exception("failed to persist template mix error")
                    await message.nack(requeue=not message.redelivered)
                    return
            await message.ack()
            return
        finally:
            if heartbeat_task:
                heartbeat_task.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat_task
        await message.ack()
