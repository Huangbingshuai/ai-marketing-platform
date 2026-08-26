from __future__ import annotations

from effect_prompt_generation.assembly import (
    assemble_fragment_prompt,
    validate_fragment_prompt,
)
from effect_prompt_generation.models import (
    EvidenceMode,
    FragmentType,
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


def test_execution_gate_covers_stacked_persona_duplication_fact_and_placeholder() -> None:
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


def test_execution_gate_rejects_render_metadata_in_visible_prompt() -> None:
    reasons = validate_fragment_prompt(
        f"5秒，9:16竖屏，1080P。{_valid_prompt()}",
        _combination(),
        product_name="便携杯",
    )
    assert "TECHNICAL_RENDER_METADATA" in reasons
