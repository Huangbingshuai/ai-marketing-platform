from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence

from .insight_mapping import bindings_for_fact_ids
from .models import (
    EvidenceMode,
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
    narratives = _expand(pools.narratives, 120)
    cameras = _expand(pools.cameras, 160)
    emotions = _expand(pools.emotions, 120)
    actions = _expand(pools.actions, 400)
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
                narratives[a], round_number, 120, "首帧从局部动作切入"
            ),
            scene=_round_value(
                _qualified_bundle_value(bundle.scene, b, 120),
                round_number,
                120,
                "背景加入真实生活道具",
            ),
            persona=_round_value(
                _qualified_bundle_value(
                    bundle.persona, (a + b) % ORTHOGONAL_ORDER, 160
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
                visible_action=_round_value(
                    actions[(a + 5 * b) % ORTHOGONAL_ORDER],
                    round_number,
                    400,
                    "动作结束后保持稳定",
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


def _normalized_value(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value).strip().casefold())
