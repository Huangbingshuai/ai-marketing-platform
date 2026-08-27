from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence

from .insight_mapping import bindings_for_fact_ids
from .models import (
    EvidenceMode,
    FragmentStrategyPool,
    FragmentType,
    InsightApplicationMap,
    InsightBinding,
    InsightField,
    MarketingRelationshipBundle,
    PlannedCombination,
    PromptDimensions,
    SellingPointEvidence,
    ShardPlan,
    StrategyPlan,
)

ORTHOGONAL_ORDER = 17
_QUALIFIERS = (
    "",
    "真实纪实",
    "细节聚焦",
    "快节奏",
    "慢节奏",
    "清晨氛围",
    "午后氛围",
    "夜间氛围",
    "自然光",
    "柔和侧光",
    "高对比光影",
    "轻生活流",
    "产品特写",
    "互动感",
    "第一视角",
    "观察视角",
    "极简表达",
)

_SCENE_LAYOUT_VARIANTS = (
    "主体靠近木质案板，旁侧留出干净操作区",
    "主体置于浅色餐盘中央，背景只保留一件餐具",
    "主体位于台面前沿，后方保留虚化橱柜层次",
    "主体放在深色托盘上，侧边摆放折叠餐巾",
    "主体靠近窗边自然光，桌面保持无杂物",
    "主体与白瓷小碟形成前后层次",
    "主体位于备餐区中央，案板边缘形成引导线",
    "主体靠画面一侧，另一侧保留清楚留白",
    "主体置于竹编垫上，背景保持简洁",
    "主体位于餐桌中央，远处仅保留虚化餐椅",
    "主体与不锈钢操作台形成材质对比",
    "主体置于浅木托板，后方保留暖色墙面",
    "主体靠近蒸盘边缘，周围不出现多余食材",
    "主体位于货架前的小型展示台中央",
    "主体置于白色台面，侧后方保留柔和阴影",
    "主体靠近餐具收纳区，前景保持清楚",
    "主体位于画面中央，背景以单色墙面收束",
)

_PERSONA_BLOCKING_VARIANTS = (
    "双手从画面下方进入",
    "右手从画面右侧进入",
    "左手从画面左侧进入",
    "人物站在台面侧后方",
    "人物仅以肩部和双手进入画面",
    "人物位于主体右后方",
    "人物位于主体左后方",
    "人物先在画外，动作开始时手部进入",
    "双手分别位于主体两侧",
    "人物与台面保持半步距离",
    "人物侧身面对主体",
    "人物正面面对台面但不露脸",
    "只保留一只手完成动作",
    "人物手腕停在主体前方",
    "人物从背景走近后只露出双手",
    "人物位于画面边缘，不遮挡主体",
    "无人出镜，主体独立呈现",
)

_FRAGMENT_VARIANTS: dict[str, tuple[str, ...]] = {
    "opening": (
        "",
        "主体位于画面左侧",
        "主体位于画面右侧",
        "主体位于画面中央",
        "前景保持简洁",
        "背景层次清楚",
    ),
    "action": (
        "",
        "手部先在画外停顿，再沿直线路径进入并完成动作",
        "手部从主体侧后方进入，以较慢速度完成动作后离开",
        "手部在接触前短暂停顿，接触后保持两秒不再移动",
        "动作从台面边缘开始，沿主体轮廓连续移动后停住",
        "动作开始前主体保持静止，完成后双手退出画面",
        "右手负责主动作，左手只在主体另一侧保持稳定",
        "手部先调整一次道具位置，再完成唯一的主体动作",
        "动作以指尖接触开始，沿一个方向推进并自然结束",
        "主体先被轻轻转向镜头，随后在清楚角度保持稳定",
        "动作从画面左侧开始，在主体中央结束并形成停顿",
        "动作从画面右侧开始，经过主体前方后停止",
        "双手同时进入，但只有一只手完成主要操作",
        "动作在近景焦点内完成，全程不离开清晰范围",
        "动作先快后慢，在关键细节完全可见时停止",
        "动作先慢后快，完成后立即恢复稳定展示状态",
        "手部保持低位移动，避免遮挡主体正面与关键细节",
    ),
    "camera": (
        "",
        "固定近景从主体正前方观察，焦点始终落在产品轮廓",
        "固定侧面近景观察手部接触点，背景保持轻微虚化",
        "桌面高度中近景稳定记录，动作结束时焦点回到主体",
        "俯拍近景覆盖主体与双手，机位全程不发生移动",
        "低机位近景沿台面观察，主体边缘保持清楚完整",
        "肩后中近景固定观察操作区，前景不遮挡产品",
        "微距机位对准一个真实细节，动作完成后保持焦点",
        "正侧方中景同时保留人物手部、主体和结束留白",
        "斜上方近景稳定观察，利用景深分开主体与背景",
        "正面中景保持水平构图，动作路径位于画面中央",
        "侧后方近景锁定主体，背景道具只形成轻微层次",
        "顶部固定机位观察台面关系，关键细节处于清晰区",
        "主体左前方近景拍摄，结束构图保留右侧空间",
        "主体右前方近景拍摄，结束构图保留左侧空间",
        "中长焦近景压缩背景，主体和手部保持同一焦平面",
        "广角中近景交代环境后保持稳定，不执行二次运镜",
    ),
    "emotion": (
        "",
        "色温保持一致",
        "光线变化克制",
        "动作结束后自然停顿",
        "背景亮度保持稳定",
        "主体受光持续自然",
    ),
    "ending": (
        "",
        "背景位置保持不变",
        "主体保持稳定",
        "前后景关系连续",
        "结束构图保持清楚",
        "画面在稳定状态停留",
    ),
}

_MATERIAL_TAGS: dict[FragmentType, tuple[str, ...]] = {
    FragmentType.HOOK: ("钩子", "首帧"),
    FragmentType.PAIN: ("痛点", "问题状态"),
    FragmentType.PRODUCT_DISPLAY: ("产品", "特写"),
    FragmentType.SELLING_POINT_EXPLANATION: ("卖点", "口播"),
    FragmentType.CTA: ("CTA", "转化"),
    FragmentType.OUTRO: ("片尾", "品牌"),
}

_EXPRESSION_FIELD_PRIORITY: dict[FragmentType, tuple[InsightField, ...]] = {
    FragmentType.HOOK: (
        InsightField.CORE_PAIN_POINT,
        InsightField.TARGET_AUDIENCE,
        InsightField.DECISION_DRIVER,
        InsightField.USAGE_SCENARIO,
        InsightField.PURCHASE_SCENARIO,
        InsightField.PRODUCT_CATEGORY,
        InsightField.EMOTIONAL_SCENARIO,
    ),
    FragmentType.PAIN: (
        InsightField.CORE_PAIN_POINT,
        InsightField.TARGET_AUDIENCE,
        InsightField.USAGE_SCENARIO,
        InsightField.PURCHASE_SCENARIO,
    ),
    FragmentType.PRODUCT_DISPLAY: (
        InsightField.PRODUCT_NAME,
        InsightField.VISUAL_FEATURES,
        InsightField.CORE_SPECIFICATION,
        InsightField.USAGE_SCENARIO,
        InsightField.CORE_SELLING_POINT,
        InsightField.PRODUCT_CATEGORY,
    ),
    FragmentType.SELLING_POINT_EXPLANATION: (
        InsightField.CORE_SELLING_POINT,
        InsightField.SECONDARY_SELLING_POINT,
        InsightField.VISUAL_FEATURES,
        InsightField.CORE_SPECIFICATION,
        InsightField.DECISION_DRIVER,
        InsightField.TRUST_BACKING,
        InsightField.PRODUCT_NAME,
    ),
    FragmentType.CTA: (
        InsightField.MARKETING_GOAL,
        InsightField.PRODUCT_NAME,
        InsightField.CORE_SELLING_POINT,
        InsightField.DECISION_DRIVER,
        InsightField.TARGET_AUDIENCE,
        InsightField.PRICE_RANGE,
        InsightField.PURCHASE_SCENARIO,
    ),
    FragmentType.OUTRO: (
        InsightField.PRODUCT_NAME,
        InsightField.VISUAL_FEATURES,
        InsightField.PRODUCT_CATEGORY,
        InsightField.EMOTIONAL_SCENARIO,
    ),
}


def expression_bindings(
    bindings: Sequence[InsightBinding],
    *,
    fragment_type: FragmentType,
    occurrence: int,
    priority_fact_ids: set[str] | None = None,
) -> list[InsightBinding]:
    """Choose the one-to-three facts that must visibly shape one short clip."""
    unique = list({item.fact_id: item for item in bindings}.values())
    if len(unique) <= 3:
        return unique

    priority_ids = priority_fact_ids or set()
    field_order = {
        field: index
        for index, field in enumerate(_EXPRESSION_FIELD_PRIORITY[fragment_type])
    }
    ordered = sorted(
        unique,
        key=lambda item: (field_order.get(item.field, len(field_order)), item.fact_id),
    )
    selected: list[InsightBinding] = []
    prioritized = [item for item in ordered if item.fact_id in priority_ids]
    if prioritized:
        selected.append(prioritized[occurrence % len(prioritized)])

    remaining = [
        item
        for item in ordered
        if item.fact_id not in {row.fact_id for row in selected}
    ]
    if remaining:
        start = occurrence % len(remaining)
        rotated = remaining[start:] + remaining[:start]
        selected.extend(rotated[: 3 - len(selected)])
    return selected


def dimension_distance(left: PromptDimensions, right: PromptDimensions) -> int:
    return sum(
        _normalized_value(getattr(left, key)) != _normalized_value(getattr(right, key))
        for key in (
            "narrative",
            "scene",
            "persona",
            "selling_point",
            "camera",
            "emotion",
        )
    )


def fragment_type_targets(
    fragment_counts: Mapping[FragmentType, int],
) -> dict[FragmentType, int]:
    if set(fragment_counts) != set(FragmentType):
        raise ValueError("fragment counts must contain all six fragment types")
    targets = {
        fragment_type: int(fragment_counts[fragment_type])
        for fragment_type in FragmentType
    }
    if (
        any(count < 1 for count in targets.values())
        or not 10 <= sum(targets.values()) <= 200
    ):
        raise ValueError(
            "fragment counts must be positive and total between 10 and 200"
        )
    return targets


def fragment_type_deficits(
    targets: Mapping[FragmentType, int],
    actual: Mapping[FragmentType, int],
) -> dict[FragmentType, int]:
    return {
        fragment_type: max(0, target - actual.get(fragment_type, 0))
        for fragment_type, target in targets.items()
    }


def plan_combinations(
    strategy: StrategyPlan,
    application: InsightApplicationMap,
    *,
    count: int,
    round_number: int,
    ordinal_start: int,
    fragment_targets: Mapping[FragmentType, int],
    fragment_durations: Mapping[FragmentType, int],
    fragment_deficits: Mapping[FragmentType, int] | None = None,
    priority_fact_ids: Sequence[str] = (),
) -> list[PlannedCombination]:
    """Build role-specific blueprints inside validated marketing relationships."""
    if count < 0 or count > ORTHOGONAL_ORDER**2:
        raise ValueError(f"count must be between 0 and {ORTHOGONAL_ORDER**2}")

    pools = strategy.dimension_pools
    evidence_by_selling_point = {
        _normalized_value(item.selling_point): item for item in pools.evidence_plans
    }
    fragment_sequence = _fragment_sequence(count, fragment_deficits, fragment_targets)
    result: list[PlannedCombination] = []
    fragment_occurrences: Counter[FragmentType] = Counter()
    uncovered = set(priority_fact_ids)
    offset = round_number * 67
    for position in range(count):
        encoded = (offset + position) % (ORTHOGONAL_ORDER**2)
        a, b = divmod(encoded, ORTHOGONAL_ORDER)
        ordinal = ordinal_start + position
        fragment_type = (
            _priority_fragment_type(
                application,
                uncovered,
                fragment_occurrences,
                fragment_targets,
            )
            or fragment_sequence[position]
        )
        fragment_occurrence = fragment_occurrences[fragment_type]
        fragment_occurrences[fragment_type] += 1
        bundle = _relationship_bundle(
            strategy.relationship_bundles,
            fragment_type=fragment_type,
            occurrence=fragment_occurrence,
            priority_fact_ids=uncovered,
        )
        if bundle.primary_fact_id:
            openings = _expand_fragment_values(
                [bundle.opening_state], 240, "opening"
            )
            actions = _expand_fragment_values([bundle.action_arc], 400, "action")
            cameras = _expand_fragment_values([bundle.camera], 160, "camera")
            emotions = _expand_fragment_values([bundle.emotion], 120, "emotion")
            endings = _expand_fragment_values(
                [bundle.ending_state], 240, "ending"
            )
        else:
            fragment_pool = _fragment_strategy_pool(
                strategy.fragment_strategy_pools, fragment_type
            )
            openings = _expand_fragment_values(
                fragment_pool.opening_states, 240, "opening"
            )
            actions = _expand_fragment_values(
                fragment_pool.action_arcs, 400, "action"
            )
            cameras = _expand_fragment_values(fragment_pool.cameras, 160, "camera")
            emotions = _expand_fragment_values(
                fragment_pool.emotions, 120, "emotion"
            )
            endings = _expand_fragment_values(
                fragment_pool.ending_states, 240, "ending"
            )
        if fragment_type == FragmentType.OUTRO:
            openings = [_safe_outro_value(value) for value in openings]
            actions = [_safe_outro_value(value) for value in actions]
            cameras = [_safe_outro_value(value) for value in cameras]
            emotions = [_safe_outro_value(value) for value in emotions]
            endings = [_safe_outro_value(value) for value in endings]
        eligible_bindings = bindings_for_fact_ids(
            application, bundle.fact_ids, fragment_type
        )
        if not eligible_bindings:
            raise ValueError(
                f"relationship bundle {bundle.bundle_id} has no eligible facts"
            )
        bindings = expression_bindings(
            eligible_bindings,
            fragment_type=fragment_type,
            occurrence=fragment_occurrence,
            priority_fact_ids=uncovered,
        )
        uncovered.difference_update(binding.fact_id for binding in bindings)
        selling_point = bundle.selling_point
        evidence = evidence_by_selling_point.get(
            _normalized_value(selling_point),
            SellingPointEvidence(
                selling_point=selling_point,
                evidence_mode=EvidenceMode.TEXT_ONLY,
                allowed_visual_evidence="只按片段职责使用已绑定的信息卡原文",
                forbidden_inference="不得扩展为信息卡未确认的功效、数据、认证或承诺",
            ),
        )
        dimensions = PromptDimensions(
            narrative=_round_value(
                (
                    f"{openings[a]}，{bundle.creative_intent}"
                    if bundle.primary_fact_id
                    else openings[a]
                ),
                round_number,
                120,
                "保持该类型的首帧职责",
            ),
            scene=_round_value(
                _cta_safe_scene(
                    _v9_bundle_value(
                        bundle.scene,
                        b,
                        120,
                        _SCENE_LAYOUT_VARIANTS,
                        bundle.primary_fact_id is not None,
                    ),
                    fragment_type,
                ),
                round_number,
                120,
                "背景加入真实生活道具",
            ),
            persona=_round_value(
                _v9_bundle_value(
                    bundle.persona,
                    (a + b) % ORTHOGONAL_ORDER,
                    160,
                    _PERSONA_BLOCKING_VARIANTS,
                    bundle.primary_fact_id is not None,
                ),
                round_number,
                160,
                "位于画面侧前方",
            ),
            selling_point=selling_point,
            camera=_round_value(
                cameras[(a + 2 * b) % ORTHOGONAL_ORDER],
                round_number,
                160,
                "结束时焦点停在主体",
            ),
            emotion=_round_value(
                emotions[(a + 3 * b) % ORTHOGONAL_ORDER],
                round_number,
                120,
                "结束前自然停顿",
            ),
        )
        result.append(
            PlannedCombination(
                slot_id=f"r{round_number}-s{ordinal:04d}",
                ordinal=ordinal,
                fragment_type=fragment_type,
                material_tags=list(_MATERIAL_TAGS[fragment_type]),
                target_duration_seconds=fragment_durations[fragment_type],
                planning_version=(
                    "six-ai-branch-v2"
                    if bundle.primary_fact_id
                    else "six-branch-v1"
                ),
                opening_state=_round_value(
                    openings[a], round_number, 240, "保持该类型的首帧职责"
                ),
                visible_action=_round_value(
                    actions[(a + 5 * b) % ORTHOGONAL_ORDER],
                    round_number,
                    400,
                    "动作弧保持连续",
                ),
                ending_state=_round_value(
                    endings[(a + 7 * b) % ORTHOGONAL_ORDER],
                    round_number,
                    240,
                    "结束状态继续符合该类型职责",
                ),
                evidence_mode=evidence.evidence_mode,
                allowed_visual_evidence=evidence.allowed_visual_evidence,
                forbidden_inference=evidence.forbidden_inference,
                relationship_bundle_id=bundle.bundle_id,
                insight_bindings=bindings,
                dimensions=dimensions,
            )
        )
    return result


def _fragment_strategy_pool(
    pools: Sequence[FragmentStrategyPool], fragment_type: FragmentType
) -> FragmentStrategyPool:
    matches = [item for item in pools if item.fragment_type == fragment_type]
    if len(matches) != 1:
        raise ValueError(
            f"strategy must contain one fragment strategy pool for {fragment_type.value}"
        )
    return matches[0]


def _relationship_bundle(
    bundles: Sequence[MarketingRelationshipBundle],
    *,
    fragment_type: FragmentType,
    occurrence: int,
    priority_fact_ids: set[str],
) -> MarketingRelationshipBundle:
    eligible = [
        item for item in bundles if fragment_type in item.eligible_fragment_types
    ]
    if not eligible:
        raise ValueError(
            f"strategy has no relationship bundle for {fragment_type.value}"
        )
    prioritized = [
        item for item in eligible if priority_fact_ids.intersection(item.fact_ids)
    ]
    pool = prioritized or eligible
    return pool[occurrence % len(pool)]


def _priority_fragment_type(
    application: InsightApplicationMap,
    priority_fact_ids: set[str],
    occurrences: Counter[FragmentType],
    targets: Mapping[FragmentType, int],
) -> FragmentType | None:
    eligible: list[FragmentType] = []
    for fact_id in priority_fact_ids:
        fact = application.by_id.get(fact_id)
        if fact:
            eligible.extend(fact.eligible_fragment_types)
    if not eligible:
        return None
    unique = list(dict.fromkeys(eligible))
    return min(
        unique,
        key=lambda fragment_type: (
            occurrences[fragment_type] / max(1, targets.get(fragment_type, 1)),
            list(FragmentType).index(fragment_type),
        ),
    )


def make_shards(
    combinations: Sequence[PlannedCombination], *, round_number: int, shard_size: int
) -> list[ShardPlan]:
    if not 1 <= shard_size <= 8:
        raise ValueError("shard_size must be between 1 and 8")
    shards: list[ShardPlan] = []
    shard_index = 0
    for fragment_type in FragmentType:
        grouped = [item for item in combinations if item.fragment_type == fragment_type]
        for index in range(0, len(grouped), shard_size):
            shards.append(
                ShardPlan(
                    round=round_number,
                    shard_index=shard_index,
                    combinations=list(grouped[index : index + shard_size]),
                )
            )
            shard_index += 1
    return shards


def _fragment_sequence(
    count: int,
    deficits: Mapping[FragmentType, int] | None,
    targets: Mapping[FragmentType, int],
) -> list[FragmentType]:
    requested = Counter(deficits or targets)
    if not any(requested.values()):
        requested.update(targets)
    sequence: list[FragmentType] = []
    while len(sequence) < count:
        available = [item for item in FragmentType if requested[item] > 0]
        if not available:
            requested.update(targets)
            available = [item for item in FragmentType if requested[item] > 0]
        for fragment_type in available:
            if len(sequence) >= count:
                break
            sequence.append(fragment_type)
            requested[fragment_type] -= 1
    return sequence


def _eligible_selling_point(
    selling_points: Sequence[str],
    evidence_by_selling_point: Mapping[str, SellingPointEvidence],
    fragment_type: FragmentType,
    preferred: str,
    fragment_occurrence: int,
) -> str:
    if fragment_type == FragmentType.SELLING_POINT_EXPLANATION:
        text_only = [
            item
            for item in selling_points
            if evidence_by_selling_point[_normalized_value(item)].evidence_mode
            in {EvidenceMode.TEXT_ONLY, EvidenceMode.PROCESS_ONLY}
        ]
        if text_only:
            # 以当前片段类型内部的序号轮询。若使用全局 ordinal，六类循环
            # 与卖点数量存在公因数时会永久命中同一卖点，无法完成核心覆盖。
            return text_only[fragment_occurrence % len(text_only)]
    allowed_modes = set(EvidenceMode)
    if fragment_type != FragmentType.SELLING_POINT_EXPLANATION:
        allowed_modes = set(EvidenceMode) - {
            EvidenceMode.TEXT_ONLY,
            EvidenceMode.PROCESS_ONLY,
        }
    eligible = [
        item
        for item in selling_points
        if evidence_by_selling_point[_normalized_value(item)].evidence_mode
        in allowed_modes
    ]
    # If an effect has no safe visual evidence, retain the fact; the execution gate rejects
    # it and replenishment keeps the effect quota visible instead of inventing proof.
    pool = eligible or list(selling_points)
    if preferred in pool:
        return preferred
    return pool[fragment_occurrence % len(pool)]


def _selling_point_sequence(
    selling_points: Sequence[str],
    count: int,
) -> list[str]:
    if not selling_points:
        raise ValueError("selling point pool cannot be empty")
    return [selling_points[index % len(selling_points)] for index in range(count)]


def _expand(values: Sequence[str], max_length: int) -> list[str]:
    unique = list(dict.fromkeys(value.strip() for value in values if value.strip()))
    if not unique:
        raise ValueError("cannot expand an empty dimension pool")
    result: list[str] = []
    index = 0
    while len(result) < ORTHOGONAL_ORDER:
        base = unique[index % len(unique)]
        cycle = index // len(unique)
        qualifier = _QUALIFIERS[(index + cycle) % len(_QUALIFIERS)]
        candidate = base if index < len(unique) else f"{base}·{qualifier or '差异表达'}"
        candidate = candidate[:max_length].rstrip("·")
        if candidate not in result:
            result.append(candidate)
        index += 1
    return result


def _expand_fragment_values(
    values: Sequence[str], max_length: int, kind: str
) -> list[str]:
    """Expand a role-specific pool without adding a second action or camera movement."""
    unique = list(dict.fromkeys(value.strip() for value in values if value.strip()))
    if not unique:
        raise ValueError("cannot expand an empty fragment strategy pool")
    variants = _FRAGMENT_VARIANTS[kind]
    result: list[str] = []
    index = 0
    while len(result) < ORTHOGONAL_ORDER:
        base = unique[index % len(unique)]
        cycle = index // len(unique)
        qualifier = variants[cycle % len(variants)]
        detail = _QUALIFIERS[(cycle // len(variants)) % len(_QUALIFIERS)]
        suffixes = [item for item in (qualifier, detail) if item]
        candidate = (
            base
            if index < len(unique) or not suffixes
            else f"{base}，{'，'.join(suffixes)}"
        )
        candidate = candidate[:max_length].rstrip("，。； ")
        if candidate not in result:
            result.append(candidate)
        index += 1
    return result


def _round_value(
    value: str, round_number: int, max_length: int, variation: str = ""
) -> str:
    # round offset 已经会选择新的正交行；不要把“补齐策略”等内部术语污染六维元数据，
    # 更不能让候选模型把它抄进最终视频 Prompt。
    if round_number == 0 or not variation:
        return value[:max_length].rstrip("·")
    suffix = f"，{variation}"
    return value[: max_length - len(suffix)].rstrip("·，") + suffix


def _qualified_bundle_value(value: str, index: int, max_length: int) -> str:
    qualifier = _QUALIFIERS[index % len(_QUALIFIERS)]
    if not qualifier:
        return value[:max_length]
    suffix = f"·{qualifier}"
    return value[: max_length - len(suffix)].rstrip("·") + suffix


def _v9_bundle_value(
    value: str,
    index: int,
    max_length: int,
    variants: Sequence[str],
    enabled: bool,
) -> str:
    if not enabled:
        return _qualified_bundle_value(value, index, max_length)
    prefix = f"{variants[index % len(variants)]}，"
    return prefix + value[: max_length - len(prefix)].lstrip("，")


def _cta_safe_scene(value: str, fragment_type: FragmentType) -> str:
    if fragment_type != FragmentType.CTA or "留白" in value:
        return value
    return f"右侧保留干净留白区，{value}"[:120]


def _safe_outro_value(value: str) -> str:
    replacements = {
        "快速": "平稳",
        "快节奏": "安静节奏",
        "跟拍": "固定观察",
        "跟随": "固定观察",
        "环绕": "固定",
        "横移": "固定",
        "侧移": "固定",
        "推近": "固定近景",
        "推进": "保持固定",
        "靠近": "保持距离",
        "后拉": "保持固定",
        "拉远": "保持固定",
    }
    for source, target in replacements.items():
        value = value.replace(source, target)
    return value


def _normalized_value(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value).strip().casefold())
