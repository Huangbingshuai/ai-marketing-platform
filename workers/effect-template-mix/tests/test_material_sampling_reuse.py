import asyncio
from unittest.mock import AsyncMock

import pytest

from effect_template_mix.api import ApiError, InternalApi
from effect_template_mix.consumer import Consumer
from effect_template_mix.models import Claim, SamplingCheckpoint, TrimCheckpoint
from effect_template_mix.provider import ArkProvider, ProviderError, TrimChoice
from test_consumer import material


def claim(*, restored: bool = False, revision: int = 1) -> Claim:
    selections = [
        {"variantIndex": index, "slotId": slot, "role": "HOOK", "materialId": source,
         "matchScore": 1, "matchLevel": "NORMAL", "classificationReason": "动作", "duration": duration}
        for index, slot, source, duration in (
            (0, "short", "m1", 4), (1, "short", "m1", 4),
            (2, "long", "m1", 6), (3, "short", "m2", 4),
        )
    ]
    sources = [material(index).model_copy(update={
        "artifactRevision": revision, "fileObjectId": f"file-{revision}-{index}",
    }).model_dump() for index in (1, 2)]
    return Claim.model_validate({
        "terminal": False, "attemptToken": f"lease-{revision}", "snapshot": {
            "schemaVersion": 1, "trimOnly": True,
            "template": {"id": "t", "slots": [
                {"id": "short", "role": "HOOK", "label": "短槽", "duration": 4},
                {"id": "long", "role": "HOOK", "label": "长槽", "duration": 6},
            ]},
            "draftRevision": 1, "targetVariantId": None, "lockedBindings": [],
            "promptArtifacts": [], "materials": sources,
            "incremental": {"materialIds": ["m1", "m2"], "oldVariantIds": ["old"],
                            "packageNewVariants": False},
        }, "checkpoint": {"selections": selections, "trims": [{
            "variantIndex": 0, "slotId": "short", "materialId": "m1",
            "trimStartSeconds": 8, "trimReason": "已成功选区，不改写",
        }] if restored else []},
    })


def harness(monkeypatch, *, concurrency: int = 3):
    api = AsyncMock(spec=InternalApi)
    api.claim.return_value = claim()
    api.video.return_value = b"frozen-source"
    api.checkpoint_sampling.return_value = SamplingCheckpoint(materialIds=[])
    api.checkpoint_trims.return_value = TrimCheckpoint(trims=[], progress=90)
    provider = AsyncMock(spec=ArkProvider)
    frames = AsyncMock(return_value=[(1.0, b"frame"), (2.0, b"frame-2")])
    monkeypatch.setattr("effect_template_mix.consumer.sample_frames", frames)
    consumer = Consumer("amqp://test", "effect.template-mix.requested", api, provider,
                        1000, 10, 16000, 8192, concurrency)
    message = AsyncMock()
    message.body = b'{"schemaVersion":1,"projectId":"project","runId":"run","requestId":"request"}'
    return api, provider, frames, consumer, message


@pytest.mark.asyncio
@pytest.mark.parametrize("concurrency", [1, 3])
@pytest.mark.parametrize("restored", [False, True])
async def test_download_and_sampling_once_but_each_pending_variant_chooses_its_own_trim(
    monkeypatch, concurrency, restored,
) -> None:
    api, provider, frames, consumer, message = harness(monkeypatch, concurrency=concurrency)
    api.claim.return_value = claim(restored=restored)
    active_downloads = 0
    peak_downloads = 0

    async def download(*_args):
        nonlocal active_downloads, peak_downloads
        active_downloads += 1
        peak_downloads = max(peak_downloads, active_downloads)
        await asyncio.sleep(0)
        active_downloads -= 1
        return b"frozen-source"

    api.video.side_effect = download
    choice_index = 0

    async def choose(*_args):
        nonlocal choice_index
        choice_index += 1
        return TrimChoice(trimStartSeconds=choice_index / 10, trimReason="独立选区")

    provider.trim.side_effect = choose
    await asyncio.wait_for(consumer.handle(message), timeout=5)

    assert sorted(call.args[1] for call in api.video.await_args_list) == ["m1", "m2"]
    assert frames.await_count == api.checkpoint_sampling.await_count == 2
    assert peak_downloads <= concurrency
    assert provider.trim.await_count == api.checkpoint_trims.await_count == 4 - int(restored)
    results = api.complete.await_args.args[1]
    assert len(results) == 4
    assert len({result.trimStartSeconds for result in results}) == 4
    assert results[0].trimStartSeconds == (8 if restored else 0.1)
    long_call = next(call for call in provider.trim.await_args_list if call.args[0].id == "long")
    assert long_call.args[0].duration == 6
    api.fail.assert_not_awaited()


@pytest.mark.asyncio
async def test_material_frames_never_cross_task_or_source_revision(monkeypatch) -> None:
    api, provider, frames, consumer, message = harness(monkeypatch)
    api.claim.side_effect = [claim(revision=1), claim(revision=2)]
    provider.trim.return_value = TrimChoice(trimStartSeconds=1, trimReason="当前快照")
    await consumer.handle(message)
    await consumer.handle(message)
    assert api.video.await_count == frames.await_count == 4
    assert provider.trim.await_count == 8
    assert {call.args[0].attempt_token for call in api.video.await_args_list} == {"lease-1", "lease-2"}
    assert {call.args[1].fileObjectId for call in provider.trim.await_args_list} == {
        "file-1-1", "file-1-2", "file-2-1", "file-2-2",
    }
    assert api.complete.await_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("failure, expected", [
    ("素材下载暂时中断，请稍后重试", "素材下载连接中断，已完成的检查点已保留"),
    ("internal API unavailable", "混剪后台连接暂时不可用，已完成的检查点已保留"),
])
async def test_failed_download_does_not_sample_or_consume_failed_material(monkeypatch, failure, expected) -> None:
    api, provider, frames, consumer, message = harness(monkeypatch, concurrency=1)
    api.video.side_effect = ApiError(failure, retryable=True)
    await consumer.handle(message)
    frames.assert_not_awaited()
    provider.trim.assert_not_awaited()
    api.checkpoint_sampling.assert_not_awaited()
    api.complete.assert_not_awaited()
    assert api.fail.await_args.args[-1] is True
    assert api.fail.await_args.args[-2] == expected
    message.ack.assert_awaited_once()


@pytest.mark.asyncio
async def test_failure_drains_sibling_trims_before_cleaning_shared_files(monkeypatch) -> None:
    api, provider, frames, consumer, message = harness(monkeypatch)
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def choose(*_args):
        if not started.is_set():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        await started.wait()
        raise ProviderError("选区失败", retryable=False)

    provider.trim.side_effect = choose
    await asyncio.wait_for(consumer.handle(message), timeout=5)
    assert cancelled.is_set()
    assert all(not call.args[0].exists() for call in frames.await_args_list)
    api.checkpoint_trims.assert_not_awaited()
    api.complete.assert_not_awaited()
    api.fail.assert_awaited_once()
