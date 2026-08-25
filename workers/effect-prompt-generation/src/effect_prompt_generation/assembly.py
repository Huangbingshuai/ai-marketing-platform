from __future__ import annotations

from collections.abc import Sequence
import re

from .models import EvidenceMode, FragmentType, PlannedCombination


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
    r"拿起|夹起|提起|拎起|托住|扶住|握住|放下|放入|放到|轻放|摆放|打开|关闭|切开|倒入|"
    r"按下|按压|走入|走出|离开|停下|停住|抬起|指向|触碰|擦拭|拉开|推入|调整|取出|"
    r"展示|转向|转动|倾斜|移动|移到|交互"
)
_STACKED_PERSONA = re.compile(r"两名|多人|一家人|夫妻|情侣|母女|父子|同事们|朋友们|一群|(?:一名|一个).{0,24}(?:和|与)(?:另一名|另一个|一名|一个)")
_PLACEHOLDER = re.compile(r"<[^>]+>|\{[^}]+\}|以信息卡为准|待补充|待填写|TODO|TBD", re.IGNORECASE)
_SENSITIVE_FACT = re.compile(
    r"\d+(?:\.\d+)?\s*(?:小时|毫升|ml|克|kg|%|折|元|万件)|"
    r"认证|销量(?:第一|领先)?|行业第一|领先|100%|绝对|保证|防漏|保温\s*\d+",
    re.IGNORECASE,
)


def assemble_fragment_prompt(
    prompt_text: str,
    combination: PlannedCombination,
    *,
    product_name: str,
    aspect_ratio: str,
    disabled_elements: Sequence[str],
    source_facts: Sequence[str] = (),
) -> tuple[str, list[str]]:
    """Normalize one direct-to-video prompt and return deterministic gate failures."""
    content = _clean_paragraph(prompt_text)
    reasons = validate_fragment_prompt(
        content,
        combination,
        product_name=product_name,
        aspect_ratio=aspect_ratio,
        source_facts=source_facts,
    )
    constraints: list[str] = []
    if any("未成年人" in item for item in disabled_elements):
        constraints.append("不出现未成年人")
    if combination.evidence_mode in {EvidenceMode.PROCESS_ONLY, EvidenceMode.TEXT_ONLY}:
        constraints.append("不虚构工厂、实验室或生产过程")
    constraints.append("不添加数据、认证、价格或促销贴纸")
    constraints = _unique(constraints)
    if constraints:
        content = f"{content.rstrip('。')}。画面中{'，'.join(constraints)}。"
    return content, reasons


def validate_fragment_prompt(
    content: str,
    combination: PlannedCombination,
    *,
    product_name: str,
    aspect_ratio: str,
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
    if _has_duplicate_clauses(content):
        reasons.append("FIELD_DUPLICATION")
    source_text = "\n".join(source_facts)
    if _has_source_fact_violation(content, source_text):
        reasons.append("SOURCE_FACT_VIOLATION")
    if not re.search(rf"{combination.target_duration_seconds}\s*秒", content):
        reasons.append("MISSING_TARGET_DURATION")
    if aspect_ratio not in content and aspect_ratio.replace(":", "：") not in content:
        reasons.append("MISSING_ASPECT_RATIO")
    if not _ACTION.search(content):
        reasons.append("NO_VISIBLE_ACTION")
    if not _CAMERA.search(content):
        reasons.append("MISSING_CAMERA_EXECUTION")
    if not _LIGHT_OR_PACING.search(content):
        reasons.append("MISSING_LIGHTING_OR_PACING")
    if combination.fragment_type in {
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.EFFECT_DEMONSTRATION,
        FragmentType.SELLING_POINT_EXPLANATION,
        FragmentType.CTA,
        FragmentType.OUTRO,
    } and product_name not in content:
        reasons.append("MISSING_PRODUCT_ANCHOR")
    if combination.fragment_type in {
        FragmentType.EFFECT_DEMONSTRATION,
        FragmentType.SELLING_POINT_EXPLANATION,
    } and combination.dimensions.selling_point not in content:
        reasons.append("MISSING_ASSIGNED_SELLING_POINT")
    if combination.fragment_type in {
        FragmentType.HOOK,
        FragmentType.PAIN,
        FragmentType.PRODUCT_DISPLAY,
    } and _CTA.search(content):
        reasons.append("FRAGMENT_ROLE_CONFLICT")
    if combination.fragment_type == FragmentType.EFFECT_DEMONSTRATION and combination.evidence_mode in {
        EvidenceMode.PROCESS_ONLY,
        EvidenceMode.TEXT_ONLY,
    }:
        reasons.append("UNFILMABLE_EVIDENCE")
    if "FRAGMENT_ROLE_CONFLICT" in reasons:
        reasons.remove("FRAGMENT_ROLE_CONFLICT")
        reasons.append("ROLE_CONFLICT")
    return list(dict.fromkeys(reasons))


def _clean_paragraph(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _clean(value: str) -> str:
    return " ".join(value.split()).strip("；;。 ")


def _unique(values: Sequence[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = _clean(raw)
        key = value.casefold()
        if value and key not in seen:
            seen.add(key)
            result.append(value)
    return result


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
