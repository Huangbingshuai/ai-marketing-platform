from __future__ import annotations

import re
from collections.abc import Sequence

from .models import EvidenceMode, FragmentType, InsightField, PlannedCombination

_INTERNAL_METADATA = re.compile(
    r"创意核心|差异化设定|叙事结构\s*[=:：]|场景变量\s*[=:：]|人物变量\s*[=:：]|"
    r"卖点侧重\s*[=:：]|镜头语言\s*[=:：]|情绪基调\s*[=:：]|片段类型\s*[=:：]|时间轴镜头"
)
_SHOT_NUMBERING = re.compile(r"(?:镜头|分镜)\s*[一二三四五六七八九\d]+", re.IGNORECASE)
_TIME_RANGE = re.compile(r"\d+(?:\.\d+)?\s*[-—~至]\s*\d+(?:\.\d+)?\s*秒")
_EDIT_TRANSITION = re.compile(r"切到|切回|转场|第二镜头|下一镜头|随后回到|最后回到")
_CTA = re.compile(r"立即(?:购买|下单)|马上(?:购买|下单)|限时|折扣|优惠|扫码|销量")
_CAMERA = re.compile(
    r"特写|近景|中景|全景|微距|俯拍|俯视|仰拍|低机位|高机位|固定机位|肩后|手持|半身|长镜头|推近|推进|靠近|后拉|拉远|跟拍|跟随|环绕|横移|移焦|聚焦|焦点|景深|主观"
)
_LIGHT_OR_PACING = re.compile(r"光|色温|色彩|冷调|暖调|节奏|停顿|缓慢|快速|利落|舒缓")
_ACTION = re.compile(
    r"拿起|夹起|提起|拎起|托住|扶住|握住|放下|放入|放到|轻放|摆放|摆到|打开|关闭|切开|倒入|"
    r"按下|按压|走入|走出|离开|停下|停住|抬起|指向|触碰|擦拭|拉开|推入|调整|取出|"
    r"转向|转动|倾斜|移动|移到|交互|伸向|寻找|尝试|遮住|受阻|退出|扶正|递近|松开|落到|恢复"
)
_ACTION_SEQUENCE = re.compile(r"随后|接着|然后|再(?:次)?|最后")
_STACKED_PERSONA = re.compile(
    r"两名|多人|一家人|夫妻|情侣|母女|父子|同事们|朋友们|一群|(?:一名|一个).{0,24}(?:和|与)(?:另一名|另一个|一名|一个)"
)
_AUDIENCE_PERSONA = re.compile(
    r"目标受众|受众集合|家庭厨房决策者|美食爱好者|年货送礼人群|全国消费者|消费者人群"
)
_PLACEHOLDER = re.compile(
    r"<[^>]+>|\{[^}]+\}|以信息卡为准|待补充|待填写|TODO|TBD", re.IGNORECASE
)
_SENSITIVE_FACT = re.compile(
    r"\d+(?:\.\d+)?\s*(?:小时|毫升|ml|克|kg|%|折|元|万件)|"
    r"认证|销量(?:第一|领先)?|行业第一|领先|100%|绝对|保证|防漏|保温\s*\d+",
    re.IGNORECASE,
)
_PRICE = re.compile(
    r"\d+(?:\.\d+)?\s*(?:元|块)(?:\s*[-—~至]\s*\d+(?:\.\d+)?\s*(?:元|块)?)?"
)
_BAKED_TEXT = re.compile(
    r"字幕|标题文字|屏幕文字|可读文字|价格贴纸|促销贴纸|二维码|购买按钮|销量角标|库存角标",
    re.IGNORECASE,
)
_AUDIO_OVERREACH = re.compile(
    r"\bBGM\b|背景音乐|配乐|旁白|口播|人声解说|歌词|完整音效设计",
    re.IGNORECASE,
)
_ABSTRACT_EVIDENCE = re.compile(
    r"工厂|生产线|实验室|检测设备|专家背书|原料加工|生产过程|制作过程|工艺流程|配方研发|技术原理"
)
_PHYSICS_BREAK = re.compile(
    r"凭空(?:出现|消失|移动|变形)|瞬间变(?:成|形)|自动悬浮|无接触(?:打开|移动|旋转)|穿透|违反重力"
)
_REFERENCE_DEPENDENCY = re.compile(
    r"精准还原|完全一致|一比一还原|包装文字清晰可读|标签文字清晰可读|"
    r"(?:logo|商标|品牌标识)(?:与参考图)?完全一致",
    re.IGNORECASE,
)
_NEGATIVE_CLAUSE = re.compile(
    r"(?:不得|禁止|不生成|不出现|不要|避免)[^，,。；;!?！？]{2,80}"
)
_CAMERA_CONTEXT = re.compile(
    r"镜头|机位|特写|近景|中景|全景|微距|俯拍|俯视|仰拍|低机位|高机位|"
    r"固定|肩后|手持|跟拍|环绕|横移|移焦|聚焦|焦点|景深|主观|推近|后拉|拉远"
)
_PRIMARY_CAMERA_MOVEMENTS: dict[str, re.Pattern[str]] = {
    "PUSH": re.compile(r"推近|推进|靠近"),
    "PULL": re.compile(r"后拉|拉远"),
    "TRACK": re.compile(r"跟拍|跟随|手持"),
    "ORBIT": re.compile(r"环绕"),
    "SLIDE": re.compile(r"横移|侧移"),
    "RACK_FOCUS": re.compile(r"移焦|焦点从.+(?:移到|转向)"),
}
_HOOK_RESOLVED = re.compile(
    r"答案(?:出现|揭晓)|揭晓(?:答案|原因)|原来是|问题(?:被|已)?解决|成功(?:打开|完成)|恢复正常|效果立刻出现"
)
_PAIN_RESOLVED = re.compile(
    r"(?:使用|拿出|换上|放入).{0,24}(?:解决|完成|恢复|顺利)|问题(?:被|已)?解决|不便消失|轻松完成"
)
_PRODUCT_EFFECT_LEAK = re.compile(
    r"使用后|效果对比|前后对比|问题解决|明显改善|立刻见效|满意(?:微笑|点头)|证明(?:效果|功效)"
)
_PACKAGED_STATE = re.compile(r"真空袋装|袋装|包装|袋身")
_UNPACKAGED_END_STATE = re.compile(
    r"(?:最终|结束时|随后|转眼).{0,80}(?:蒸笼|盘中|碗中|切片|散装|裸露)"
)
_PACKAGE_TRANSITION_ACTION = re.compile(r"打开|拆开|撕开|取出|倒出|拿出")
_SAFE_AREA = re.compile(
    r"留白|安全区|干净空间|简洁背景|无遮挡空间|空白墙面|空白区域|干净无遮挡"
)
_OUTRO_UNSTABLE = re.compile(
    r"快速|奔跑|跳跃|连续旋转|跟拍|跟随|手持|环绕|横移|侧移|推近|推进|靠近|后拉|拉远"
)
_OUTRO_SUBTLE_MOTION = re.compile(
    r"扶正|离开|收焦|焦点.{0,12}(?:落到|稳定|清楚)|光线.{0,12}(?:稳定|恢复)|"
    r"蒸汽.{0,12}(?:变缓|减弱|停止)|背景.{0,12}(?:稳定|安静)|轻微变化"
)
_VISIBLE_ATTRIBUTE_CUE = re.compile(r"外观|表面|轮廓|颜色|材质|纹理|切面|接口|细节|受光")
_VISIBLE_RESULT_CUE = re.compile(r"完成状态|打开状态|稳定状态|结果可见|保持打开|保持闭合|停在完成")
_RENDER_METADATA = re.compile(
    r"(?:画幅\s*)?(?:16:9|4:3|1:1|3:4|9:16|21:9|9:21)(?:竖屏|横屏)?|"
    r"(?:分辨率\s*)?(?:480|720|1080)[pP]|(?:时长\s*)?\d+(?:\.\d+)?秒"
)


def prompt_length_bounds(duration_seconds: int) -> tuple[int, int]:
    if duration_seconds <= 5:
        return 80, 150
    if duration_seconds <= 8:
        return 110, 200
    return 140, 260


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
    maximum_length = prompt_length_bounds(combination.target_duration_seconds)[1]
    budgets = (
        (18, 20, 18, 25, 18, 12, 22)
        if maximum_length == 150
        else (25, 28, 25, 38, 28, 18, 30)
        if maximum_length == 200
        else (32, 36, 32, 50, 36, 24, 40)
    )
    if combination.fragment_type == FragmentType.SELLING_POINT_EXPLANATION:
        budgets = (
            (16, 18, 15, 22, 16, 10, 18)
            if maximum_length == 150
            else (22, 24, 20, 30, 22, 15, 25)
            if maximum_length == 200
            else (28, 32, 28, 42, 30, 20, 34)
        )
    scene, persona, opening, action, camera, emotion, ending = (
        _compact_clause(value, limit)
        for value, limit in zip(
            (
                dims.scene,
                dims.persona,
                combination.opening_state,
                combination.visible_action.replace("产品", product_name),
                dims.camera,
                dims.emotion,
                combination.ending_state,
            ),
            budgets,
            strict=True,
        )
    )
    prefix = f"{scene}，{persona}"
    if combination.fragment_type in {
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.SELLING_POINT_EXPLANATION,
        FragmentType.CTA,
        FragmentType.OUTRO,
    }:
        prefix = f"{scene}，{product_name}首帧清楚可见，{persona}"
    evidence = {
        EvidenceMode.VISIBLE_ATTRIBUTE: "，产品真实表面细节保持清楚",
        EvidenceMode.USAGE_ACTION: "，操作部位和动作关系保持清楚",
        EvidenceMode.VISIBLE_RESULT: "，停在完成状态且结果可见",
        EvidenceMode.TEXT_ONLY: "",
        EvidenceMode.PROCESS_ONLY: "",
    }[combination.evidence_mode]
    content = _clean_paragraph(
        f"{prefix}。{opening}；{action}。{camera}，自然光下{emotion}{evidence}。{ending}。"
    )
    minimum_length, maximum_length = prompt_length_bounds(
        combination.target_duration_seconds
    )
    if len(content) < minimum_length:
        padding = "主体、操作位置和背景层次始终清楚，画面保持真实自然与连续稳定。"
        content = _clean_paragraph(
            f"{content.rstrip('。')}。{padding}"
        )[:maximum_length].rstrip("，；。 ") + "。"
    return content, validate_fragment_prompt(
        content,
        combination,
        product_name=product_name,
        source_facts=source_facts,
    )


def _compact_clause(value: str, limit: int) -> str:
    cleaned = " ".join(value.replace("·", "，").split()).strip("，。； ")
    return cleaned[:limit].rstrip("，。； ")


def validate_fragment_prompt(
    content: str,
    combination: PlannedCombination,
    *,
    product_name: str,
    source_facts: Sequence[str] = (),
) -> list[str]:
    reasons: list[str] = []
    minimum_length, maximum_length = prompt_length_bounds(
        combination.target_duration_seconds
    )
    creative_content = re.sub(r"[，,。；;\s]+$", "", _RENDER_METADATA.sub("", content))
    if not minimum_length <= len(creative_content) <= maximum_length:
        reasons.append("PROMPT_LENGTH_MISMATCH")
    if _INTERNAL_METADATA.search(content):
        reasons.append("META_LANGUAGE")
    if _SHOT_NUMBERING.search(content) or len(_TIME_RANGE.findall(content)) > 1:
        reasons.append("FULL_TIMELINE")
    if _EDIT_TRANSITION.search(content):
        reasons.append("FULL_TIMELINE")
    if _STACKED_PERSONA.search(content) or _AUDIENCE_PERSONA.search(content):
        reasons.append("STACKED_PERSONA")
    if _PLACEHOLDER.search(content) or _broken_text(content):
        reasons.append("BROKEN_TEXT")
    if _has_duplicate_clauses(content):
        reasons.append("FIELD_DUPLICATION")
    if len(combination.insight_bindings) > 3:
        reasons.append("FACT_OVERLOAD")
    source_text = "\n".join(source_facts)
    if _has_source_fact_violation(content, source_text):
        reasons.append("SOURCE_FACT_VIOLATION")
    if not _ACTION.search(content) and not (
        combination.fragment_type == FragmentType.OUTRO
        and _OUTRO_SUBTLE_MOTION.search(content)
    ):
        reasons.append("NO_VISIBLE_ACTION")
    if not _CAMERA.search(content):
        reasons.append("MISSING_CAMERA_EXECUTION")
    if not _LIGHT_OR_PACING.search(content):
        reasons.append("MISSING_LIGHTING_OR_PACING")
    if _has_overloaded_action(content):
        reasons.append("OVERLOADED_ACTION")
    if _has_camera_conflict(content):
        reasons.append("CAMERA_CONFLICT")
    if _BAKED_TEXT.search(content):
        reasons.append("BAKED_TEXT")
    if _AUDIO_OVERREACH.search(content):
        reasons.append("AUDIO_OVERREACH")
    if _PHYSICS_BREAK.search(content):
        reasons.append("PHYSICS_BREAK")
    if _REFERENCE_DEPENDENCY.search(content):
        reasons.append("REFERENCE_DEPENDENCY")
    if len(_NEGATIVE_CLAUSE.findall(content)) >= 3:
        reasons.append("NEGATIVE_TAIL_DUPLICATION")
    if combination.evidence_mode in {
        EvidenceMode.TEXT_ONLY,
        EvidenceMode.PROCESS_ONLY,
    } and (
        combination.dimensions.selling_point in content
        or _ABSTRACT_EVIDENCE.search(content)
    ):
        reasons.append("ABSTRACT_VISUAL")
    if (
        combination.fragment_type
        in {
            FragmentType.PRODUCT_DISPLAY,
            FragmentType.SELLING_POINT_EXPLANATION,
            FragmentType.CTA,
            FragmentType.OUTRO,
        }
        and product_name not in content
    ):
        reasons.append("MISSING_PRODUCT_ANCHOR")
    if combination.fragment_type == FragmentType.SELLING_POINT_EXPLANATION:
        if (
            combination.evidence_mode == EvidenceMode.VISIBLE_ATTRIBUTE
            and not _VISIBLE_ATTRIBUTE_CUE.search(content)
        ):
            reasons.append("EVIDENCE_MODE_MISMATCH")
        if (
            combination.evidence_mode == EvidenceMode.USAGE_ACTION
            and not _ACTION.search(content)
        ):
            reasons.append("EVIDENCE_MODE_MISMATCH")
        if (
            combination.evidence_mode == EvidenceMode.VISIBLE_RESULT
            and not _VISIBLE_RESULT_CUE.search(content)
        ):
            reasons.append("EVIDENCE_MODE_MISMATCH")
    if (
        combination.fragment_type == FragmentType.HOOK
        and _HOOK_RESOLVED.search(content)
    ):
        reasons.append("HOOK_RESOLVED")
    if (
        combination.fragment_type == FragmentType.PAIN
        and _PAIN_RESOLVED.search(content)
    ):
        reasons.append("PAIN_RESOLVED")
    if combination.fragment_type == FragmentType.PRODUCT_DISPLAY:
        if product_name not in content[:80]:
            reasons.append("PRODUCT_NOT_FIRST_FRAME")
        if _PRODUCT_EFFECT_LEAK.search(content):
            reasons.append("PRODUCT_ROLE_OVERLOAD")
        if (
            _PACKAGED_STATE.search(content)
            and _UNPACKAGED_END_STATE.search(content)
            and not _PACKAGE_TRANSITION_ACTION.search(content)
        ):
            reasons.append("PHYSICS_BREAK")
    if combination.fragment_type == FragmentType.CTA and not _SAFE_AREA.search(content):
        reasons.append("CTA_NO_SAFE_AREA")
    if combination.fragment_type == FragmentType.OUTRO:
        if _OUTRO_UNSTABLE.search(content):
            reasons.append("OUTRO_UNSTABLE")
        selling_point = combination.dimensions.selling_point
        if selling_point and selling_point in content and selling_point not in {
            "产品身份与真实外观",
            "不提前展示产品解决方案",
        }:
            reasons.append("OUTRO_NEW_MESSAGE")
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
        if any(
            token in prefix
            for token in ("不出现", "不生成", "不得", "禁止", "避免", "不添加")
        ):
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


def _has_overloaded_action(value: str) -> bool:
    action_count = len(_ACTION.findall(value))
    return len(_ACTION_SEQUENCE.findall(value)) >= 2 or action_count > 12


def _has_camera_conflict(value: str) -> bool:
    camera_chunks = [
        chunk
        for chunk in re.split(r"[，。；;!?！？]", value)
        if _CAMERA_CONTEXT.search(chunk)
    ]
    camera_text = " ".join(camera_chunks)
    movements = {
        name
        for name, pattern in _PRIMARY_CAMERA_MOVEMENTS.items()
        if pattern.search(camera_text)
    }
    if "固定机位" in camera_text and movements - {"RACK_FOCUS"}:
        return True
    return len(movements) > 1


def _trigram_dice(left: str, right: str) -> float:
    left_grams = {left[index : index + 3] for index in range(max(1, len(left) - 2))}
    right_grams = {right[index : index + 3] for index in range(max(1, len(right) - 2))}
    if not left_grams or not right_grams:
        return 0.0
    return 2 * len(left_grams & right_grams) / (len(left_grams) + len(right_grams))
