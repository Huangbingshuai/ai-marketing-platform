from unittest.mock import AsyncMock

import pytest

from effect_template_mix.api import InternalApi
from effect_template_mix.consumer import Consumer, temporary_video_directory
from effect_template_mix.models import (
    Claim,
    Material,
    Runtime,
    SampledMaterial,
    SamplingCheckpoint,
    TrimCheckpoint,
    TrimOutput,
)
from effect_template_mix.provider import ArkProvider, ProviderError, TrimChoice
from effect_template_mix.reliability import (
    classification_chunks,
    classification_output_token_budget,
)


def material(index: int) -> Material:
    return Material(
        id=f"m{index}",
        code=f"V{index:03d}",
        name=f"片段 {index}",
        duration=15,
        promptId=f"p{index}",
        prompt=f"素材提示词 {index}",
        artifactId=f"a{index}",
        artifactKey=f"render-clip:m{index}",
        artifactRevision=1,
        contentHash="a" * 64,
        fileObjectId=f"f{index}",
    )


def test_classification_chunks_preserve_every_material_once() -> None:
    source = [material(index) for index in range(25)]

    batches = classification_chunks(
        source,
        configured_max_size=10,
        max_output_tokens=8_192,
        max_input_tokens=16_000,
    )

    assert all(1 <= len(batch) <= 4 for batch in batches)
    assert [item.id for batch in batches for item in batch] == [item.id for item in source]


def test_cleanup_error_does_not_mask_retryable_provider_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    class Temporary:
        name = '/tmp/temporary-video-test'

        def cleanup(self) -> None:
            raise OSError(39, 'Directory not empty')

    monkeypatch.setattr('effect_template_mix.consumer.tempfile.TemporaryDirectory', lambda **_kwargs: Temporary())
    with pytest.raises(ProviderError) as caught:
        with temporary_video_directory():
            raise ProviderError('temporary', retryable=True)
    assert caught.value.retryable


def test_classification_chunks_split_large_prompt_by_input_budget() -> None:
    source = [
        material(index).model_copy(update={"prompt": "长提示词" * 2_000})
        for index in range(3)
    ]

    batches = classification_chunks(
        source,
        configured_max_size=10,
        max_output_tokens=8_192,
        max_input_tokens=8_000,
    )

    assert [len(batch) for batch in batches] == [1, 1, 1]
    assert classification_output_token_budget(batches[0]) == 1_205


@pytest.mark.asyncio
async def test_sampling_checkpoint_uses_the_run_lease_and_persists_frame_timestamps(monkeypatch: pytest.MonkeyPatch) -> None:
    api = InternalApi("http://test", "token", 1)
    sample = SampledMaterial(materialId="material-1", frameTimestampsSeconds=[0.5, 1.5])
    request = AsyncMock(return_value={"materialIds": ["material-1"], "samples": [sample.model_dump()]})
    monkeypatch.setattr(api, "request", request)
    runtime = Runtime(project_id="project-1", run_id="run-1", attempt_token="lease-1")

    result = await api.checkpoint_sampling(runtime, [sample])

    assert isinstance(result, SamplingCheckpoint)
    request.assert_awaited_once_with(
        "PUT",
        "internal/workers/effect-template-mix/runs/run-1/sampling/checkpoint",
        headers={"x-attempt-token": "lease-1"},
        json={"projectId": "project-1", "samples": [sample.model_dump()]},
    )
    await api.close()


@pytest.mark.asyncio
async def test_trim_only_refresh_skips_classification_and_retrims_only_the_fixed_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api = AsyncMock(spec=InternalApi)
    selected = {
        "variantIndex": 0,
        "slotId": "slot-updated",
        "role": "PRODUCT",
        "materialId": "clip-updated",
        "matchScore": 0.8,
        "matchLevel": "NORMAL",
        "classificationReason": "保留原槽位素材归属",
        "duration": 4,
    }
    source = material(1).model_copy(update={
        "id": "clip-updated", "duration": 10, "promptId": "prompt-updated",
        "prompt": "新版产品展示画面", "artifactId": "clip-updated",
        "artifactKey": "render-clip:updated", "artifactRevision": 2,
    })
    snapshot = {
        "schemaVersion": 1,
        "template": {"id": "template", "name": "模板", "editVersion": 1,
            "slots": [{"id": "slot-updated", "role": "PRODUCT", "label": "产品展示", "duration": 4}]},
        "draftRevision": 4,
        "targetVariantId": "variant",
        "trimOnly": True,
        "lockedBindings": [],
        "promptArtifacts": [],
        "materials": [source.model_dump()],
    }
    api.claim.return_value = Claim(
        terminal=False,
        attemptToken="lease",
        snapshot=snapshot,
        checkpoint={"selections": [selected]},
    )
    api.video.return_value = b"fake-video"
    api.checkpoint_sampling.return_value = SamplingCheckpoint(
        materialIds=["clip-updated"],
        samples=[SampledMaterial(materialId="clip-updated", frameTimestampsSeconds=[1, 2])],
    )
    api.checkpoint_trims.return_value = TrimCheckpoint(
        trims=[TrimOutput(slotId="slot-updated", materialId="clip-updated", trimStartSeconds=2, trimReason="动作完整")],
        progress=90,
    )
    provider = AsyncMock(spec=ArkProvider)
    provider.trim.return_value = TrimChoice(trimStartSeconds=2, trimReason="动作完整")
    monkeypatch.setattr(
        "effect_template_mix.consumer.sample_frames",
        AsyncMock(return_value=[(1.0, b"frame-1"), (2.0, b"frame-2")]),
    )
    consumer = Consumer(
        "amqp://test", "effect.template-mix.requested", api, provider,
        1000, 10, 16000, 8192, 1,
    )
    message = AsyncMock()
    message.body = b'{"schemaVersion":1,"projectId":"project","runId":"run","requestId":"request"}'

    await consumer.handle(message)

    provider.classify.assert_not_awaited()
    provider.trim.assert_awaited_once()
    assert api.video.await_count == 1
    assert api.video.await_args.args[1:] == ("clip-updated", 1000)
    api.complete.assert_awaited_once()
    assert len(api.complete.await_args.args[1]) == 1
    assert api.complete.await_args.args[1][0].slotId == "slot-updated"
