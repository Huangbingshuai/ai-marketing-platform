from __future__ import annotations

import re
from collections.abc import Sequence

from .models import FragmentType, InsightField, PlannedCombination

_INTERNAL_METADATA = re.compile(
    r"创意核心|差异化设定|叙事结构\s*[=:：]|场景变量\s*[=:：]|人物变量\s*[=:：]|"
    r"卖点侧重\s*[=:：]|镜头语言\s*[=:：]|情绪基调\s*[=:：]|片段类型\s*[=:：]|时间轴镜头"
)
_SHOT_NUMBERING = re.compile(r"(?:镜头|分镜)\s*[一二三四五六七八九\d]+", re.IGNORECASE)
_TIME_RANGE = re.compile(r"\d+(?:\.\d+)?\s*[-—~至]\s*\d+(?:\.\d+)?\s*秒")
_EDIT_TRANSITION = re.compile(r"切到|切回|转场|第二镜头|下一镜头|随后回到|最后回到")
_CTA = re.compile(r"立即(?:购买|下单)|马上(?:购买|下单)|限时|折扣|优惠|扫码|销量")
_CAMERA = re.compile(r"特写|近景|中景|全景|微距|俯拍|俯视|仰拍|低机位|高机位|固定机位|肩后|手持|半身|长镜头|推近|靠近|后拉|跟拍|跟随|环绕|横移|移焦|聚焦|焦点|景深|主观")
_LIGHT_OR_PACING = re.compile(r"光|色温|色彩|冷调|暖调|节奏|停顿|缓慢|快速|利落|舒缓")
_ACTION = re.compile(
    r"拿起|夹起|提起|拎起|托住|扶住|握住|放下|放入|放到|轻放|摆放|摆到|打开|关闭|切开|倒入|"
    r"按下|按压|走入|走出|离开|停下|停住|抬起|指向|触碰|擦拭|拉开|推入|调整|取出|"
    r"展示|转向|转动|倾斜|移动|移到|交互"
)
_STACKED_PERSONA = re.compile(r"两名|多人|一家人|夫妻|情侣|母女|父子|同事们|朋友们|一群|(?:一名|一个).{0,24}(?:和|与)(?:另一名|另一个|一名|一个)")
_PLACEHOLDER = re.compile(r"<[^>]+>|\{[^}]+\}|以信息卡为准|待补充|待填写|TODO|TBD", re.IGNORECASE)
_TECHNICAL_RENDER_METADATA = re.compile(
    r"\d+(?:\.\d+)?\s*秒|(?:16\s*[:：]\s*9|4\s*[:：]\s*3|1\s*[:：]\s*1|3\s*[:：]\s*4|9\s*[:：]\s*16|21\s*[:：]\s*9)|(?:480|720|1080)\s*[pP]"
)
_SENSITIVE_FACT = re.compile(
    r"\d+(?:\.\d+)?\s*(?:小时|毫升|ml|克|kg|%|折|元|万件)|"
    r"认证|销量(?:第一|领先)?|行业第一|领先|100%|绝对|保证|防漏|保温\s*\d+",
    re.IGNORECASE,
)
_PRICE = re.compile(r"\d+(?:\.\d+)?\s*(?:元|块)(?:\s*[-—~至]\s*\d+(?:\.\d+)?\s*(?:元|块)?)?")


def assemble_fragment_prompt(
    prompt_text: str,
    combination: PlannedCombination,
    *,
    product_name: str,
    source_facts: Sequence[str] = (),
) -> tuple[str, list[str]]:
    """Normalize one direct-to-video prompt and return deterministic gate failures."""
    content = _clean_paragraph(prompt_text)
    reasons = validate_fragment_prompt(
        content,
        combination,
        product_name=product_name,
        source_facts=source_facts,
    )
    return content, reasons


def assemble_safe_fallback_prompt(
    combination: PlannedCombination,
    *,
    product_name: str,
    source_facts: Sequence[str] = (),
) -> tuple[str, list[str]]:
    """Build a deterministic, renderable creative prompt without technical render metadata."""
    dims = combination.dimensions
    persona = dims.persona if dims.persona.startswith("无人出镜") else f"{dims.persona}位于主体位置"
    action = combination.visible_action.replace("产品", product_name).replace("·", "，")
    endings = {
        FragmentType.HOOK: (
            f"首帧直接捕捉反常但真实的动作细节：{action}，只留下未揭晓的悬念；"
            f"{dims.camera}跟住动作，{dims.emotion}，柔和光线下停在问题即将发生的状态"
        ),
        FragmentType.PAIN: (
            f"画面呈现尚未解决的不便：{action}，动作受阻后自然停下，不展示解决方案；"
            f"{dims.camera}聚焦手部和问题状态，{dims.emotion}，节奏克制"
        ),
        FragmentType.PRODUCT_DISPLAY: (
            f"{product_name}清楚出现在画面中心，主体完成一次连续动作：{action}；"
            f"{dims.camera}展示真实轮廓和表面细节，{dims.emotion}，暖调光线下稳定收束"
        ),
        FragmentType.SELLING_POINT_EXPLANATION: (
            f"围绕{product_name}只讲解“{dims.selling_point}”，主体完成一次可见指示动作：{action}；"
            f"{dims.camera}聚焦被指向的真实细节，{dims.emotion}，光线清晰，结束时产品保持可辨"
        ),
        FragmentType.CTA: (
            f"{product_name}完成一次明确收束动作：{action}；{dims.camera}保留干净字幕安全区，"
            f"{dims.emotion}，明亮光线下停在便于继续了解产品的结束状态"
        ),
        FragmentType.OUTRO: (
            f"{product_name}居中完成品牌定格动作：{action}；{dims.camera}缓慢稳定焦点，"
            f"{dims.emotion}，柔和光线下停在简洁产品轮廓"
        ),
    }
    content = _clean_paragraph(f"{dims.scene}，{persona}。{endings[combination.fragment_type]}。")
    return content, validate_fragment_prompt(
        content,
        combination,
        product_name=product_name,
        source_facts=source_facts,
    )


def validate_fragment_prompt(
    content: str,
    combination: PlannedCombination,
    *,
    product_name: str,
    source_facts: Sequence[str] = (),
) -> list[str]:
    reasons: list[str] = []
    if _INTERNAL_METADATA.search(content):
        reasons.append("META_LANGUAGE")
    if _SHOT_NUMBERING.search(content) or len(_TIME_RANGE.findall(content)) > 1:
        reasons.append("FULL_TIMELINE")
    if _EDIT_TRANSITION.search(content):
        reasons.append("FULL_TIMELINE")
    if _STACKED_PERSONA.search(content):
        reasons.append("STACKED_PERSONA")
    if _PLACEHOLDER.search(content) or _broken_text(content):
        reasons.append("BROKEN_TEXT")
    if _TECHNICAL_RENDER_METADATA.search(content):
        reasons.append("TECHNICAL_RENDER_METADATA")
    if _has_duplicate_clauses(content):
        reasons.append("FIELD_DUPLICATION")
    source_text = "\n".join(source_facts)
    if _has_source_fact_violation(content, source_text):
        reasons.append("SOURCE_FACT_VIOLATION")
    if not _ACTION.search(content):
        reasons.append("NO_VISIBLE_ACTION")
    if not _CAMERA.search(content):
        reasons.append("MISSING_CAMERA_EXECUTION")
    if not _LIGHT_OR_PACING.search(content):
        reasons.append("MISSING_LIGHTING_OR_PACING")
    if combination.fragment_type in {
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.SELLING_POINT_EXPLANATION,
        FragmentType.CTA,
        FragmentType.OUTRO,
    } and product_name not in content:
        reasons.append("MISSING_PRODUCT_ANCHOR")
    if (
        combination.fragment_type == FragmentType.SELLING_POINT_EXPLANATION
        and combination.dimensions.selling_point not in content
    ):
        reasons.append("MISSING_ASSIGNED_SELLING_POINT")
    if combination.fragment_type in {
        FragmentType.HOOK,
        FragmentType.PAIN,
        FragmentType.PRODUCT_DISPLAY,
    } and _CTA.search(content):
        reasons.append("FRAGMENT_ROLE_CONFLICT")
    price_allowed = combination.fragment_type == FragmentType.CTA and any(
        binding.field == InsightField.PRICE_RANGE
        for binding in combination.insight_bindings
    )
    if _PRICE.search(content) and not price_allowed:
        reasons.append("FRAGMENT_ROLE_CONFLICT")
    if "FRAGMENT_ROLE_CONFLICT" in reasons:
        reasons.remove("FRAGMENT_ROLE_CONFLICT")
        reasons.append("ROLE_CONFLICT")
    return list(dict.fromkeys(reasons))


def _clean_paragraph(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _broken_text(value: str) -> bool:
    return bool(re.search(r"[，。；、]{3,}|(.)\1{7,}", value))


def _has_source_fact_violation(content: str, source_text: str) -> bool:
    for match in _SENSITIVE_FACT.finditer(content):
        prefix = content[max(0, match.start() - 12) : match.start()]
        if any(token in prefix for token in ("不出现", "不生成", "不得", "禁止", "避免", "不添加")):
            continue
        if match.group(0) not in source_text:
            return True
    return False


def _has_duplicate_clauses(value: str) -> bool:
    compact = re.sub(r"[\s，。；;!?！？、]", "", value)
    for index in range(max(0, len(compact) - 15)):
        gram = compact[index : index + 16]
        if gram and compact.find(gram, index + 16) >= 0:
            return True
    clauses = [
        re.sub(r"\s+", "", item)
        for item in re.split(r"[。；;!?！？]", value)
        if len(re.sub(r"\s+", "", item)) >= 16
    ]
    for index, left in enumerate(clauses):
        for right in clauses[index + 1 :]:
            if left == right or _trigram_dice(left, right) >= 0.9:
                return True
    return False


def _trigram_dice(left: str, right: str) -> float:
    left_grams = {left[index : index + 3] for index in range(max(1, len(left) - 2))}
    right_grams = {right[index : index + 3] for index in range(max(1, len(right) - 2))}
    if not left_grams or not right_grams:
        return 0.0
    return 2 * len(left_grams & right_grams) / (len(left_grams) + len(right_grams))
