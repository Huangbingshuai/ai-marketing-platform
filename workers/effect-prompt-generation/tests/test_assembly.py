from __future__ import annotations

from effect_prompt_generation.assembly import (
    assemble_fragment_prompt,
    validate_fragment_prompt,
)
from effect_prompt_generation.models import (
    EvidenceMode,
    FragmentType,
    InsightBinding,
    InsightBindingRole,
    InsightField,
    PlannedCombination,
    PromptDimensions,
)


def _combination(
    fragment_type: FragmentType = FragmentType.SELLING_POINT_EXPLANATION,
    evidence_mode: EvidenceMode = EvidenceMode.USAGE_ACTION,
) -> PlannedCombination:
    return PlannedCombination(
        slot_id="slot-1",
        ordinal=1,
        fragment_type=fragment_type,
        material_tags=["卖点", "口播"],
        target_duration_seconds=5,
        visible_action="一名通勤女性用拇指按下开盖按键，杯盖打开后停住",
        evidence_mode=evidence_mode,
        allowed_visual_evidence="单手按键开盖动作",
        forbidden_inference="不得推导防漏或保温效果",
        dimensions=PromptDimensions(
            narrative="动作悬念",
            scene="写字楼电梯口",
            persona="一名穿米色风衣的年轻通勤女性",
            selling_point="单手按键开盖",
            camera="低机位微距连续推近",
            emotion="冷白光下利落节奏",
        ),
    )


def _valid_prompt() -> str:
    return (
        "清晨写字楼电梯口，一名穿米色风衣的年轻通勤女性右手握便携杯，"
        "左手拿手机；低机位微距从杯盖侧面连续推近，她的右手拇指按下按键，杯盖打开后手掌仍稳定握住杯身，"
        "整个单手按键开盖动作只发生一次。冷白环境光勾出产品轮廓，动作节奏利落，按键声处短暂停顿，"
        "结尾保持便携杯占据画面中心并清楚展示打开状态。"
    )


def test_fragment_prompt_is_direct_and_has_no_render_metadata_appended() -> None:
    content, reasons = assemble_fragment_prompt(
        _valid_prompt(),
        _combination(),
        product_name="便携杯",
    )

    assert reasons == []
    assert "5秒" not in content
    assert "9:16" not in content
    assert "夸大功效" not in content
    assert "视频生成方案" not in content
    assert "时间轴镜头" not in content
    assert "差异化设定" not in content


def test_execution_gate_rejects_full_ad_timeline_and_internal_dimensions() -> None:
    invalid = (
        "5秒，9:16竖屏。差异化设定：叙事=痛点前置；镜头一0-1秒建立痛点，"
        "镜头二1-3秒切到便携杯并展示单手按键开盖，最后回到购买字幕，冷白光快速推近。"
        "人物按下按键并停住，产品保持清楚。"
    )
    reasons = validate_fragment_prompt(
        invalid,
        _combination(),
        product_name="便携杯",
    )

    assert "META_LANGUAGE" in reasons
    assert "FULL_TIMELINE" in reasons


def test_user_reported_full_video_plan_is_rejected_by_quality_v4() -> None:
    combination = _combination(evidence_mode=EvidenceMode.TEXT_ONLY).model_copy(
        update={
            "dimensions": _combination().dimensions.model_copy(
                update={"selling_point": "广府糖酒腌制工艺"}
            )
        }
    )
    content = (
        "视频生成方案。差异化设定：叙事=痛点前置型；人物变量=25-45岁家庭厨房决策者、"
        "美食爱好者、年货送礼人群、全国消费者。0-3秒人物拿起产品，3-7秒演示广府糖酒腌制工艺，"
        "7-11秒展示效果，11-15秒转场到购买引导。低机位缓慢推近，暖色光保持温馨。"
    )

    reasons = validate_fragment_prompt(content, combination, product_name="广式腊肠")

    assert {
        "META_LANGUAGE",
        "FULL_TIMELINE",
        "STACKED_PERSONA",
        "ABSTRACT_VISUAL",
    } <= set(reasons)


def test_hook_and_pain_may_omit_product_but_selling_point_cannot() -> None:
    base = (
        "雨天办公楼入口，一名年轻男性一手握手机、一手拎雨伞和电脑包，"
        "胸前中近景连续下移到双手特写，他调整包带后仍无法腾出手。冷白自然光下节奏略急，"
        "衣料摩擦声清楚，结尾停在双手仍被占用的状态，画面保持同一地点和一个连续动作。"
    )
    pain = _combination(FragmentType.PAIN)
    assert "MISSING_PRODUCT_ANCHOR" not in validate_fragment_prompt(
        base, pain, product_name="便携杯"
    )
    assert "MISSING_PRODUCT_ANCHOR" in validate_fragment_prompt(
        base, _combination(), product_name="便携杯"
    )


def test_execution_gate_covers_stacked_persona_duplication_fact_and_placeholder() -> (
    None
):
    clause = "一名女性拿起便携杯并按下按键，低机位特写连续推近，冷白光下节奏利落"
    content = (
        f"一名女性和另一名男性在办公室，{clause}；{clause}。"
        "产品获得权威认证并保证100%防漏，结尾字幕写<TODO>。"
    )
    reasons = validate_fragment_prompt(
        content,
        _combination(),
        product_name="便携杯",
        source_facts=["单手按键开盖"],
    )

    assert "STACKED_PERSONA" in reasons
    assert "FIELD_DUPLICATION" in reasons
    assert "SOURCE_FACT_VIOLATION" in reasons
    assert "BROKEN_TEXT" in reasons


def test_execution_gate_reports_action_selling_point_and_role_failures() -> None:
    no_action = (
        "办公室桌面只有便携杯，固定机位近景聚焦产品，冷白侧光保持清晰轮廓，"
        "画面节奏舒缓，结尾仍停在产品正面，单手按键开盖字幕保持清楚且不出现其他人物。"
    )
    assert "NO_VISIBLE_ACTION" in validate_fragment_prompt(
        no_action, _combination(), product_name="便携杯"
    )

    missing_selling_point = _valid_prompt().replace("单手按键开盖", "一次开盖")
    assert "MISSING_ASSIGNED_SELLING_POINT" in validate_fragment_prompt(
        missing_selling_point, _combination(), product_name="便携杯"
    )

    hook_with_cta = _combination(FragmentType.HOOK)
    role_prompt = _valid_prompt() + " 立即下单购买。"
    assert "ROLE_CONFLICT" in validate_fragment_prompt(
        role_prompt, hook_with_cta, product_name="便携杯"
    )


def test_render_metadata_is_not_an_execution_failure() -> None:
    reasons = validate_fragment_prompt(
        f"5秒，9:16竖屏，1080P。{_valid_prompt()}",
        _combination(),
        product_name="便携杯",
    )
    assert "TECHNICAL_RENDER_METADATA" not in reasons
    assert "SHARED_CONSTRAINT_LEAK" not in reasons


def test_quality_v4_rejects_overloaded_action_camera_text_audio_and_fact_overload() -> (
    None
):
    bindings = [
        InsightBinding(
            fact_id=f"fact-{index}",
            field=InsightField.DECISION_DRIVER,
            value=f"事实{index}",
            value_hash=f"{index:x}" * 64,
            role=InsightBindingRole.CONTEXT,
        )
        for index in range(1, 5)
    ]
    combination = _combination().model_copy(update={"insight_bindings": bindings})
    content = (
        "办公室桌面前，一名成年女性拿起便携杯。她随后打开杯盖并倒入清水。"
        "最后放下杯子并离开。固定机位环绕推近产品，冷白侧光保持清楚。"
        "字幕显示卖点，旁白配合BGM讲解。"
    )

    reasons = validate_fragment_prompt(content, combination, product_name="便携杯")

    assert {
        "OVERLOADED_ACTION",
        "CAMERA_CONFLICT",
        "FACT_OVERLOAD",
        "BAKED_TEXT",
        "AUDIO_OVERREACH",
    } <= set(reasons)


def test_quality_v4_rejects_abstract_proof_physics_reference_and_negative_tail() -> (
    None
):
    combination = _combination(evidence_mode=EvidenceMode.TEXT_ONLY).model_copy(
        update={
            "dimensions": _combination().dimensions.model_copy(
                update={"selling_point": "专业配方工艺"}
            )
        }
    )
    content = (
        "明亮实验室里，一名成年女性拿起便携杯，生产线在背景展示专业配方工艺。"
        "近景固定机位聚焦杯身，冷白光保持清晰，杯子随后凭空变形，"
        "包装文字与Logo完全一致。不得出现促销，不要添加认证，禁止生成价格。"
    )

    reasons = validate_fragment_prompt(content, combination, product_name="便携杯")

    assert {
        "ABSTRACT_VISUAL",
        "PHYSICS_BREAK",
        "REFERENCE_DEPENDENCY",
        "NEGATIVE_TAIL_DUPLICATION",
    } <= set(reasons)


def test_text_only_selling_point_uses_clean_visual_without_burning_claim() -> None:
    combination = _combination(evidence_mode=EvidenceMode.TEXT_ONLY).model_copy(
        update={
            "dimensions": _combination().dimensions.model_copy(
                update={"selling_point": "专业配方工艺"}
            )
        }
    )
    content = (
        "午后办公桌旁，一名穿深蓝外套的成年女性握住便携杯，拇指按下杯盖后停住。"
        "肩后中近景保持固定，焦点落在手指与杯盖接触位置，柔和窗光沿浅蓝杯身移动，"
        "动作节奏利落，结束时产品保持清楚，右侧留下干净空间，环境中只保留轻微按键声。"
    )

    reasons = validate_fragment_prompt(content, combination, product_name="便携杯")

    assert "MISSING_ASSIGNED_SELLING_POINT" not in reasons
    assert "ABSTRACT_VISUAL" not in reasons
    assert "BAKED_TEXT" not in reasons
