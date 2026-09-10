import pytest

from effect_prompt_generation.models import (
    MaterialShotBeat,
    MaterialShotOverview,
    MaterialShotPlan,
    MaterialShotScene,
)
from effect_prompt_generation.shot_plan import (
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
