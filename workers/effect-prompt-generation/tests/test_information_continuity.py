"""Structure/transport regression, not a semantic quality oracle."""

import hashlib

import pytest

from effect_prompt_generation.execution_correction import ExecutionCorrectionBatch
from effect_prompt_generation.models import MaterialShotPlan
from effect_prompt_generation.providers import (
    _creative_shot_response_schema,
    _require_decimal_shot_durations,
)
from effect_prompt_generation.reliability import creative_shard_size, creative_item_output_tokens
from effect_prompt_generation.shot_plan import (
    compile_material_shot_plan,
    embedding_text_without_format_headers,
)
from test_shot_plan import _timed_plan


@pytest.mark.parametrize("product", ["果酱", "护理液", "磁吸电源", "旅行箱"])
@pytest.mark.parametrize("duration", range(4, 16))
def test_internal_state_is_retained_but_not_compiled_or_embedded(product: str, duration: int) -> None:
    original = _timed_plan([1.5, duration - 2, 0.5])
    content = compile_material_shot_plan(original, target_duration_seconds=duration)
    evidence = original.model_copy(update={"beats": [
        beat.model_copy(update={
            "information_delta": f"{product}本拍新增的可见接触信息{beat.sequence}",
            "continuity_state": f"内部状态记录{beat.sequence}：手、支撑面、镜头实际状态",
        }) for beat in original.beats
    ]})
    restored = MaterialShotPlan.model_validate_json(evidence.model_dump_json(by_alias=True))
    assert restored == evidence
    assert compile_material_shot_plan(restored, target_duration_seconds=duration) == content
    assert embedding_text_without_format_headers(content) == embedding_text_without_format_headers(
        compile_material_shot_plan(evidence, target_duration_seconds=duration)
    )
    assert "内部状态记录" not in content
    assert "本拍新增的可见接触信息" not in content


def test_absent_legacy_state_does_not_change_serialized_checkpoint_hash() -> None:
    legacy = _timed_plan([1.5, 2.5])
    before = legacy.model_dump_json(by_alias=True)
    assert "informationDelta" not in before and "continuityState" not in before
    restored = MaterialShotPlan.model_validate_json(before)
    assert hashlib.sha256(before.encode()).hexdigest() == hashlib.sha256(
        restored.model_dump_json(by_alias=True).encode()
    ).hexdigest()


def test_generation_and_correction_requests_require_compact_non_null_evidence() -> None:
    schemas = [
        _creative_shot_response_schema(),
        _require_decimal_shot_durations(ExecutionCorrectionBatch.model_json_schema(by_alias=True)),
    ]
    for schema in schemas:
        beat = schema["$defs"]["MaterialShotBeat"]
        for name in ("informationDelta", "continuityState"):
            assert name in beat["required"]
            assert beat["properties"][name]["type"] == "string"
            assert beat["properties"][name]["maxLength"] <= 110
            assert beat["properties"][name]["description"]


@pytest.mark.parametrize("duration", range(4, 16))
def test_new_evidence_fits_existing_model_output_cap(duration: int) -> None:
    size = creative_shard_size(duration, configured_max_size=4, max_output_tokens=8192)
    assert size * creative_item_output_tokens(duration) <= 8192 * 0.9
    assert 1 <= size <= 4


def test_worker_does_not_judge_semantics_of_model_evidence() -> None:
    # A semantic reviewer, not a string-matching gate, must catch a false claim.
    plan = _timed_plan([1.5, 2.5])
    plan.beats[1] = plan.beats[1].model_copy(update={
        "action": "同一个物体继续保持不动",
        "information_delta": "模型声称有新信息",
        "continuity_state": "模型声称没有冲突",
    })
    assert "同一个物体继续保持不动" in compile_material_shot_plan(plan, target_duration_seconds=4)
