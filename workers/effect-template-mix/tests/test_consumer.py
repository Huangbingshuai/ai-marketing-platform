from unittest.mock import AsyncMock

import pytest

from effect_template_mix.api import InternalApi
from effect_template_mix.models import Material, Runtime, SamplingCheckpoint
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
async def test_sampling_checkpoint_uses_the_run_lease_and_selected_material_ids() -> None:
    api = InternalApi("http://test", "token", 1)
    api.request = AsyncMock()
    api.request.return_value = {"materialIds": ["material-1"]}
    runtime = Runtime(project_id="project-1", run_id="run-1", attempt_token="lease-1")

    result = await api.checkpoint_sampling(runtime, ["material-1"])

    assert isinstance(result, SamplingCheckpoint)
    api.request.assert_awaited_once_with(
        "PUT",
        "internal/workers/effect-template-mix/runs/run-1/sampling/checkpoint",
        headers={"x-attempt-token": "lease-1"},
        json={"projectId": "project-1", "materialIds": ["material-1"]},
    )
    await api.close()
