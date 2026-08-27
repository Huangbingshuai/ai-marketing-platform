from __future__ import annotations

import pytest
from effect_prompt_generation.assembly import (
    hard_execution_reasons,
    prompt_length_bounds,
    validate_fragment_prompt,
)
from effect_prompt_generation.models import (
    EvidenceMode,
    FragmentType,
    PlannedCombination,
    PromptDimensions,
)

PRODUCTS = [
    {
        "product": "广式腊肠",
        "scene": "年节傍晚的家庭厨房",
        "persona": "一位穿米色家居服的成年女性",
        "selling_point": "切面油润可见",
        "action": "用木筷夹起一片产品切面并停在蒸笼上方",
        "material": "暖色侧光照出切面和蒸汽的真实层次",
    },
    {
        "product": "便携杯",
        "scene": "清晨写字楼入口",
        "persona": "一位穿深蓝通勤外套的成年女性",
        "selling_point": "单手按键开盖",
        "action": "用拇指按下杯盖按键并停在打开状态",
        "material": "冷白天光沿杯身形成柔和高光",
    },
    {
        "product": "桌面补光灯",
        "scene": "夜间居家工作台",
        "persona": "一位穿浅灰衬衫的成年男性",
        "selling_point": "按键调节亮度",
        "action": "用食指按下调光按键并停在灯面稳定发光的状态",
        "material": "中性光在灯面和桌面形成自然渐变",
    },
]


def _combination(
    row: dict[str, str], fragment_type: FragmentType
) -> PlannedCombination:
    cameras = {
        FragmentType.HOOK: "低机位近景快速靠近主体",
        FragmentType.PAIN: "俯拍近景固定观察问题状态",
        FragmentType.PRODUCT_DISPLAY: "正面近景轻微横移产品轮廓",
        FragmentType.SELLING_POINT_EXPLANATION: "肩后中近景固定观察动作位置",
        FragmentType.CTA: "正面中近景缓慢靠近产品",
        FragmentType.OUTRO: "固定近景保持产品居中",
    }
    return PlannedCombination(
        slot_id=f"{row['product']}-{fragment_type.value}",
        ordinal=1,
        fragment_type=fragment_type,
        material_tags=[fragment_type.value, "质量样本"],
        target_duration_seconds=5,
        visible_action=row["action"],
        evidence_mode=EvidenceMode.USAGE_ACTION,
        allowed_visual_evidence=row["action"],
        forbidden_inference="不得推导未经确认的功效或结果",
        dimensions=PromptDimensions(
            narrative="单镜头动作片段",
            scene=row["scene"],
            persona=row["persona"],
            selling_point=row["selling_point"],
            camera=cameras[fragment_type],
            emotion="真实自然、动作节奏克制",
        ),
    )


def _prompt(row: dict[str, str], fragment_type: FragmentType) -> str:
    product = row["product"]
    opening = f"{row['scene']}，{row['persona']}位于主体位置。"
    endings = {
        FragmentType.HOOK: (
            f"首帧直接出现{row['action']}前的异常停顿，动作刚开始便停在未揭晓状态。"
            "低机位近景快速靠近主体后停止，焦点保持在动作接触位置，"
            f"{row['material']}，结尾仍保留悬念，只留下与动作同步的真实环境声。"
        ),
        FragmentType.PAIN: (
            "首帧呈现道具占位导致操作受阻的真实状态，人物调整手部位置后自然停下，问题仍未解决。"
            "俯拍近景固定观察手部和拥挤关系，冷静自然光保持材质真实，"
            "节奏略显迟滞，结束时操作依然没有完成，背景环境保持连续。"
        ),
        FragmentType.PRODUCT_DISPLAY: (
            f"{product}在首帧清楚位于画面中央，人物{row['action']}。"
            "正面近景轻微横移产品轮廓，焦点持续落在真实外观与手部接触关系，"
            f"{row['material']}，动作结束后产品正面保持清楚，背景空间没有变化。"
        ),
        FragmentType.SELLING_POINT_EXPLANATION: (
            f"{product}在首帧与使用道具保持清楚关系，人物{row['action']}，"
            f"动作直接呈现{row['selling_point']}。肩后中近景固定观察动作位置，"
            f"{row['material']}，结束时操作状态和产品细节仍清楚，画面一侧保持干净。"
        ),
        FragmentType.CTA: (
            f"{product}在首帧位于人物近侧，人物将产品平稳放到主体位置后手部退出。"
            "正面中近景缓慢靠近产品后停止，焦点保持在真实轮廓，"
            f"{row['material']}，结尾形成产品清楚、右侧自然留白的稳定收束构图。"
        ),
        FragmentType.OUTRO: (
            f"{product}在首帧居中，人物轻轻扶正产品后离开画面。"
            "固定近景保持产品居中，背景光线由轻微变化回到稳定，"
            f"{row['material']}，结尾停在产品轮廓清楚、上方留有干净空间的静物构图，"
            "前后景距离和台面材质在整个镜头中保持一致。"
        ),
    }
    return opening + endings[fragment_type]


@pytest.mark.parametrize("row", PRODUCTS, ids=["food", "daily-use", "device"])
@pytest.mark.parametrize("fragment_type", list(FragmentType))
def test_eighteen_cross_category_prompts_are_clean_single_shot_material(
    row: dict[str, str], fragment_type: FragmentType
) -> None:
    combination = _combination(row, fragment_type)
    prompt = _prompt(row, fragment_type)

    reasons = validate_fragment_prompt(
        prompt,
        combination,
        product_name=row["product"],
        source_facts=[row["selling_point"]],
    )

    assert 80 <= len(prompt) <= 150
    assert reasons == []
    assert not {
        "BAKED_TEXT",
        "AUDIO_OVERREACH",
        "OVERLOADED_ACTION",
        "CAMERA_CONFLICT",
        "NEGATIVE_TAIL_DUPLICATION",
    }.intersection(reasons)


@pytest.mark.parametrize(
    ("fragment_type", "content", "expected"),
    [
        (
            FragmentType.HOOK,
            "清晨办公室入口，一名成年女性伸向被文件遮住的物件，近景固定观察她的手部，冷白侧光下短暂停顿，答案随后揭晓，原来是便携杯解决了问题，结尾产品稳定居中。",
            "HOOK_RESOLVED",
        ),
        (
            FragmentType.PAIN,
            "雨天写字楼入口，一名成年女性尝试腾出双手，俯拍近景固定观察受阻动作，冷色自然光下节奏迟滞，她拿出便携杯后问题已解决并轻松完成动作，结尾状态恢复正常。",
            "PAIN_RESOLVED",
        ),
        (
            FragmentType.PRODUCT_DISPLAY,
            "清晨办公室桌面，背景中的文件、键盘、台灯和窗帘保持清楚，前景纸张与水杯托盘层次分明，窗外冷色天光映入室内，人物先整理散落文件并拿起手机，正面近景保持稳定，画面关系保持连续，便携杯随后进入画面，结尾停在产品正面。",
            "PRODUCT_NOT_FIRST_FRAME",
        ),
        (
            FragmentType.SELLING_POINT_EXPLANATION,
            "夜间工作台上，便携杯首帧清楚，一名成年女性按下杯盖按键后停住，肩后近景固定观察动作位置，中性侧光与克制节奏保持稳定，结尾停在产品轮廓和操作关系清楚的画面。",
            "EVIDENCE_MODE_MISMATCH",
        ),
        (
            FragmentType.CTA,
            "午后办公室桌面，便携杯首帧清楚，一名成年女性把产品扶正后退出画面，正面近景固定观察产品轮廓，暖色侧光下动作平稳收束，结尾产品居中并占满背景，周围道具紧贴边缘。",
            "CTA_NO_SAFE_AREA",
        ),
        (
            FragmentType.OUTRO,
            "夜间工作台上，便携杯首帧居中，一名成年女性扶正产品后离开，镜头快速跟拍并环绕产品，明亮侧光下节奏活跃，画面重新讲解单手按键开盖，结尾继续旋转并引入新的使用剧情。",
            "OUTRO_UNSTABLE",
        ),
    ],
)
def test_six_fragment_roles_reject_their_own_conflicts(
    fragment_type: FragmentType, content: str, expected: str
) -> None:
    combination = _combination(PRODUCTS[1], fragment_type)
    if fragment_type == FragmentType.SELLING_POINT_EXPLANATION:
        combination = combination.model_copy(update={"evidence_mode": EvidenceMode.VISIBLE_RESULT})

    reasons = validate_fragment_prompt(
        content,
        combination,
        product_name=PRODUCTS[1]["product"],
        source_facts=[PRODUCTS[1]["selling_point"]],
    )

    assert expected in reasons


@pytest.mark.parametrize(
    ("duration_seconds", "bounds"),
    [(4, (80, 150)), (5, (80, 150)), (6, (90, 200)), (8, (90, 200)), (9, (100, 260)), (15, (100, 260))],
)
def test_prompt_length_budget_tracks_fragment_duration(
    duration_seconds: int, bounds: tuple[int, int]
) -> None:
    assert prompt_length_bounds(duration_seconds) == bounds


def test_outro_accepts_observable_background_stabilization_as_micro_motion() -> None:
    row = PRODUCTS[0]
    combination = _combination(row, FragmentType.OUTRO)
    content = (
        "夜间家庭厨房的木质台面上，广式腊肠稳定居中，背景蒸汽逐渐变缓，"
        "固定近景保持产品轮廓清楚，暖色侧光落在真实切面，环境亮度持续稳定，"
        "结尾形成上方留白、可持续停留的安静静物构图。"
    )

    reasons = validate_fragment_prompt(
        content,
        combination,
        product_name=row["product"],
        source_facts=[row["selling_point"]],
    )

    assert "NO_VISIBLE_ACTION" not in reasons


def test_cta_accepts_continuous_blank_area_as_safe_composition() -> None:
    row = PRODUCTS[0]
    combination = _combination(row, FragmentType.CTA)
    content = (
        "广式腊肠真空袋斜放在浅木纹防油垫偏左处，右侧留着连续空白区域。"
        "一只手轻轻扶住袋身上沿，平稳挪向画面下方后收手。"
        "侧方近景固定不动，暖调自然光均匀铺开，产品清晰稳定，右侧台面干净无遮挡。"
    )

    reasons = validate_fragment_prompt(
        content,
        combination,
        product_name=row["product"],
        source_facts=[row["selling_point"]],
    )

    assert "CTA_NO_SAFE_AREA" not in reasons


def test_product_display_rejects_unexplained_packaged_to_unpacked_state_jump() -> None:
    row = PRODUCTS[0]
    combination = _combination(row, FragmentType.PRODUCT_DISPLAY)
    content = (
        "广式腊肠500g真空袋装首帧完整放在浅棕餐垫中央，一只手把旁侧香菌移出画面。"
        "近景平视机位缓慢横移后停止，暖柔侧光保持稳定，"
        "最终竹蒸笼上的广式腊肠整齐排列，形成稳定产品构图。"
    )

    reasons = validate_fragment_prompt(
        content,
        combination,
        product_name=row["product"],
        source_facts=[row["selling_point"]],
    )

    assert "PHYSICS_BREAK" in reasons


def test_soft_execution_warnings_do_not_hide_hard_failures() -> None:
    reasons = [
        "PROMPT_LENGTH_MISMATCH",
        "MISSING_LIGHTING_OR_PACING",
        "MISSING_CAMERA_EXECUTION",
        "ABSTRACT_PERSONA",
        "NEGATIVE_TAIL_DUPLICATION",
        "OVERLOADED_ACTION",
        "CAMERA_CONFLICT",
        "PRODUCT_NOT_FIRST_FRAME",
        "CTA_NO_SAFE_AREA",
        "OUTRO_UNSTABLE",
    ]

    assert hard_execution_reasons(reasons) == [
        "OVERLOADED_ACTION",
        "CAMERA_CONFLICT",
        "PRODUCT_NOT_FIRST_FRAME",
        "CTA_NO_SAFE_AREA",
        "OUTRO_UNSTABLE",
    ]
