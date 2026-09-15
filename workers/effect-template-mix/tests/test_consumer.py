from effect_template_mix.models import Material
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
