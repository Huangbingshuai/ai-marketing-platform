from unittest.mock import AsyncMock

import pytest

from effect_template_mix.api import InternalApi
from effect_template_mix.consumer import temporary_video_directory
from effect_template_mix.models import Material, Runtime, SampledMaterial, SamplingCheckpoint
from effect_template_mix.provider import ProviderError
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
