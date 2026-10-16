import pytest
from pydantic import ValidationError

from effect_prompt_generation.models import (
    MaterialShotBeat,
    MaterialShotOverview,
    MaterialShotPlan,
    MaterialShotScene,
)
from effect_prompt_generation.shot_plan import (
    ShotPlanCompilationError,
    compile_material_shot_plan,
    embedding_text_without_format_headers,
)


def _plan() -> MaterialShotPlan:
    return MaterialShotPlan(
        overview=MaterialShotOverview(
            visual_intent="说明成年人如何连续完成一次产品使用",
            visual_style="真实清爽的生活记录",
        ),
        scene=MaterialShotScene(
            environment="自然光充足的居家空间",
            lighting="柔和侧光照亮人物和产品",
            initial_state="成年人站在产品旁，双手与必要道具已经就位",
        ),
        beats=[
            MaterialShotBeat(
                sequence=1,
                duration_weight=1,
                framing="人物与产品中景",
                action="人物拿起产品并完成第一阶段动作",
                camera="镜头随手部动作轻推",
                visible_result="产品进入明确的使用状态",
                sound="产品与道具接触的现场声",
            ),
            MaterialShotBeat(
                sequence=2,
                duration_weight=2,
                framing="动作近景",
                action="人物连续完成主要使用动作",
                camera="稳定跟随动作后转为固定观察",
                visible_result="动作形成的结果清楚留在画面中",
            ),
        ],
        final_frame="人物收住动作，产品和结果同时保持清晰可见",
    )


def test_compiler_assigns_exact_duration_without_rewriting_plan() -> None:
    content = compile_material_shot_plan(_plan(), target_duration_seconds=15)

    assert "0–5秒" in content
    assert "5–15秒" in content
    assert "逐字台词" not in content
    assert "声音方向" not in content
    assert "同步声：产品与道具接触的现场声。" in content
    assert "【场景与光线】" not in content
    assert "场景：自然光充足的居家空间。" in content
    assert content.endswith("人物收住动作，产品和结果同时保持清晰可见。")


def test_embedding_text_removes_only_shared_format_scaffold() -> None:
    content = compile_material_shot_plan(_plan(), target_duration_seconds=15)
    normalized = embedding_text_without_format_headers(content)

    assert "【视频概览】" not in normalized
    assert "0–5秒" not in normalized
    assert "目标：" not in normalized
    assert "人物连续完成主要使用动作" in normalized


@pytest.mark.parametrize("value", [None, "null", " NULL "])
def test_optional_focus_and_motion_null_are_not_compiled(value: str | None) -> None:
    plan = _plan()
    plan.beats[0] = MaterialShotBeat.model_validate({
        **plan.beats[0].model_dump(), "focus": value, "motion_source": value,
    })
    content = compile_material_shot_plan(plan, target_duration_seconds=15)
    assert "驱动：" not in content
    assert "焦点：" not in content
    assert "null" not in content.lower()


def test_optional_fields_keep_model_authored_semantics_unchanged() -> None:
    beat = MaterialShotBeat.model_validate({
        **_plan().beats[0].model_dump(),
        "focus": "屏幕上的 null 字样",
        "motion_source": "无额外驱动，主体保持原位",
    })
    assert beat.focus == "屏幕上的 null 字样"
    assert beat.motion_source == "无额外驱动，主体保持原位"


def test_optional_null_like_sound_is_not_compiled_as_literal_text() -> None:
    plan = _plan()
    plan.beats[0] = MaterialShotBeat.model_validate(
        {
            **plan.beats[0].model_dump(),
            "sound": "无",
        }
    )

    content = compile_material_shot_plan(plan, target_duration_seconds=15)

    assert "同步声：无" not in content


def _timed_plan(durations: list[float]) -> MaterialShotPlan:
    template = _plan()
    return template.model_copy(update={"beats": [
        template.beats[0].model_copy(update={
            "sequence": index + 1, "duration_seconds": duration,
        }) for index, duration in enumerate(durations)
    ]})


@pytest.mark.parametrize("target", range(4, 16))
def test_decimal_schedule_covers_every_supported_duration(target: int) -> None:
    plan = _timed_plan([0.5, 1.5, target - 2.7, 0.7])
    before = plan.model_dump()
    content = compile_material_shot_plan(plan, target_duration_seconds=target)
    assert "0–0.5秒" in content
    assert "0.5–2秒" in content
    assert f"{target - 0.7:g}–{target}秒" in content
    assert plan.model_dump() == before
    assert "0.5秒" not in embedding_text_without_format_headers(content)


def test_six_continuous_beats_can_fit_four_seconds() -> None:
    plan = _timed_plan([0.5, 0.5, 0.5, 1.5, 0.5, 0.5])
    content = compile_material_shot_plan(plan, target_duration_seconds=4)
    assert "3.5–4秒" in content


@pytest.mark.parametrize("durations", [[0.5, 1.5], [1.5, 3], [4, 4]])
def test_wrong_total_is_rejected_not_stretched(durations: list[float]) -> None:
    with pytest.raises(ShotPlanCompilationError, match="equal target"):
        compile_material_shot_plan(_timed_plan(durations), target_duration_seconds=4)


def test_mixed_legacy_and_decimal_beats_are_rejected() -> None:
    plan = _plan().model_dump(by_alias=True)
    plan["beats"][0]["durationSeconds"] = 1.5
    with pytest.raises(ValidationError, match="every beat or none"):
        MaterialShotPlan.model_validate(plan)


@pytest.mark.parametrize("duration", [0, -0.1, 15.1, 1.55, float("nan"), float("inf")])
def test_duration_schema_rejects_out_of_range_or_excess_precision(duration: float) -> None:
    with pytest.raises(ValidationError):
        MaterialShotBeat.model_validate({
            **_plan().beats[0].model_dump(), "duration_seconds": duration,
        })


@pytest.mark.parametrize("product", ["果酱", "洗发露", "磁吸电源", "旅行箱"])
@pytest.mark.parametrize("target", [4, 8, 9, 15])
def test_timing_compiler_does_not_interpret_product_actions(product: str, target: int) -> None:
    plan = _timed_plan([0.5, target - 1, 0.5])
    plan.beats[1] = plan.beats[1].model_copy(update={
        "action": f"按已确认结构正常操作{product}，连续呈现同一事件的局部变化",
    })
    content = compile_material_shot_plan(plan, target_duration_seconds=target)
    assert plan.beats[1].action in content
    assert f"{target - 0.5:g}–{target}秒" in content


def test_decimal_json_round_trip_and_historical_schedule_are_stable() -> None:
    plan = _timed_plan([0.1, 0.2, 3.7])
    restored = MaterialShotPlan.model_validate_json(plan.model_dump_json(by_alias=True))
    assert "0.3–4秒" in compile_material_shot_plan(restored, target_duration_seconds=4)
    legacy = _plan().model_dump(by_alias=True)
    for beat in legacy["beats"]:
        beat.pop("durationSeconds", None)
    content = compile_material_shot_plan(MaterialShotPlan.model_validate(legacy), target_duration_seconds=15)
    assert "0–5秒" in content and "5–15秒" in content
    assert all("durationSeconds" not in beat for beat in
               MaterialShotPlan.model_validate(legacy).model_dump(by_alias=True)["beats"])
