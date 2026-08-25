from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
import math
import re
import unicodedata

from .models import (
    DimensionPools,
    EvidenceMode,
    FragmentType,
    FRAGMENT_TYPE_WEIGHTS,
    PlannedCombination,
    PromptDimensions,
    SellingPointEvidence,
    ShardPlan,
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
    FragmentType.EFFECT_DEMONSTRATION: ("效果", "动作演示"),
    FragmentType.SELLING_POINT_EXPLANATION: ("卖点", "口播"),
    FragmentType.CTA: ("CTA", "转化"),
    FragmentType.OUTRO: ("片尾", "品牌"),
}


def dimension_distance(left: PromptDimensions, right: PromptDimensions) -> int:
    return sum(
        _normalized_value(getattr(left, key)) != _normalized_value(getattr(right, key))
        for key in ("narrative", "scene", "persona", "selling_point", "camera", "emotion")
    )


def fragment_type_targets(
    count: int,
    weights: Mapping[FragmentType, int] | None = None,
) -> dict[FragmentType, int]:
    """Allocate the approved 16/14/18/18/16/10/8 mix with largest remainders."""
    if count < 0:
        raise ValueError("count cannot be negative")
    approved_weights = dict(weights or FRAGMENT_TYPE_WEIGHTS)
    if set(approved_weights) != set(FragmentType) or sum(approved_weights.values()) != 100:
        raise ValueError("fragment type weights must contain seven types and sum to 100")
    total_weight = sum(approved_weights.values())
    positive_types = [item for item, weight in approved_weights.items() if weight > 0]
    targets = {fragment_type: 0 for fragment_type in approved_weights}
    remaining = count
    if remaining >= len(positive_types):
        for fragment_type in positive_types:
            targets[fragment_type] = 1
        remaining -= len(positive_types)
    raw = {
        fragment_type: remaining * approved_weights[fragment_type] / total_weight
        for fragment_type in positive_types
    }
    for fragment_type, value in raw.items():
        targets[fragment_type] += math.floor(value)
    remainder = count - sum(targets.values())
    order = sorted(
        positive_types,
        key=lambda fragment_type: (
            -(raw[fragment_type] - math.floor(raw[fragment_type])),
            list(approved_weights).index(fragment_type),
        ),
    )
    for fragment_type in order[:remainder]:
        targets[fragment_type] += 1
    return targets


def fragment_type_deficits(
    target_count: int,
    actual: Mapping[FragmentType, int],
    weights: Mapping[FragmentType, int] | None = None,
) -> dict[FragmentType, int]:
    targets = fragment_type_targets(target_count, weights)
    return {
        fragment_type: max(0, target - actual.get(fragment_type, 0))
        for fragment_type, target in targets.items()
    }


def plan_combinations(
    pools: DimensionPools,
    *,
    count: int,
    round_number: int,
    ordinal_start: int,
    target_duration_seconds: int,
    fragment_type_weights: Mapping[FragmentType, int] | None = None,
    selling_point_weights: Mapping[str, int] | None = None,
    fragment_deficits: Mapping[FragmentType, int] | None = None,
) -> list[PlannedCombination]:
    """Build orthogonal rows and deterministically target missing fragment roles."""
    if count < 0 or count > ORTHOGONAL_ORDER**2:
        raise ValueError(f"count must be between 0 and {ORTHOGONAL_ORDER**2}")

    narratives = _expand(pools.narratives, 120)
    scenes = _expand(pools.scenes, 120)
    personas = _expand(pools.personas, 160)
    cameras = _expand(pools.cameras, 160)
    emotions = _expand(pools.emotions, 120)
    actions = _expand(pools.actions, 400)
    evidence_by_selling_point = {
        _normalized_value(item.selling_point): item for item in pools.evidence_plans
    }
    fragment_sequence = _fragment_sequence(count, fragment_deficits, fragment_type_weights)
    selling_point_sequence = _selling_point_sequence(
        pools.selling_points,
        count,
        selling_point_weights,
    )
    result: list[PlannedCombination] = []
    offset = round_number * 67
    for position in range(count):
        encoded = (offset + position) % (ORTHOGONAL_ORDER**2)
        a, b = divmod(encoded, ORTHOGONAL_ORDER)
        ordinal = ordinal_start + position
        fragment_type = fragment_sequence[position]
        selling_point = _eligible_selling_point(
            pools.selling_points,
            evidence_by_selling_point,
            fragment_type,
            selling_point_sequence[position],
            ordinal,
        )
        evidence = evidence_by_selling_point[_normalized_value(selling_point)]
        dimensions = PromptDimensions(
            narrative=_round_value(narratives[a], round_number, 120),
            scene=_round_value(scenes[b], round_number, 120),
            persona=_round_value(personas[(a + b) % ORTHOGONAL_ORDER], round_number, 160),
            selling_point=selling_point,
            camera=_round_value(cameras[(a + 2 * b) % ORTHOGONAL_ORDER], round_number, 160),
            emotion=_round_value(emotions[(a + 3 * b) % ORTHOGONAL_ORDER], round_number, 120),
        )
        result.append(
            PlannedCombination(
                slot_id=f"r{round_number}-s{ordinal:04d}",
                ordinal=ordinal,
                fragment_type=fragment_type,
                material_tags=list(_MATERIAL_TAGS[fragment_type]),
                target_duration_seconds=target_duration_seconds,
                visible_action=_round_value(
                    actions[(a + 5 * b) % ORTHOGONAL_ORDER], round_number, 400
                ),
                evidence_mode=evidence.evidence_mode,
                allowed_visual_evidence=evidence.allowed_visual_evidence,
                forbidden_inference=evidence.forbidden_inference,
                dimensions=dimensions,
            )
        )
    return result


def make_shards(
    combinations: Sequence[PlannedCombination], *, round_number: int, shard_size: int
) -> list[ShardPlan]:
    if not 1 <= shard_size <= 8:
        raise ValueError("shard_size must be between 1 and 8")
    return [
        ShardPlan(
            round=round_number,
            shard_index=index // shard_size,
            combinations=list(combinations[index : index + shard_size]),
        )
        for index in range(0, len(combinations), shard_size)
    ]


def _fragment_sequence(
    count: int,
    deficits: Mapping[FragmentType, int] | None,
    weights: Mapping[FragmentType, int] | None,
) -> list[FragmentType]:
    requested = Counter(deficits or fragment_type_targets(count, weights))
    if not any(requested.values()):
        requested.update(fragment_type_targets(count, weights))
    sequence: list[FragmentType] = []
    while len(sequence) < count:
        available = [item for item in FRAGMENT_TYPE_WEIGHTS if requested[item] > 0]
        if not available:
            requested.update(fragment_type_targets(count - len(sequence), weights))
            available = [item for item in FRAGMENT_TYPE_WEIGHTS if requested[item] > 0]
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
    ordinal: int,
) -> str:
    allowed_modes = set(EvidenceMode)
    if fragment_type == FragmentType.EFFECT_DEMONSTRATION:
        allowed_modes = {
            EvidenceMode.VISIBLE_ATTRIBUTE,
            EvidenceMode.USAGE_ACTION,
            EvidenceMode.VISIBLE_RESULT,
        }
    elif fragment_type != FragmentType.SELLING_POINT_EXPLANATION:
        allowed_modes = set(EvidenceMode) - {EvidenceMode.TEXT_ONLY}
    eligible = [
        item
        for item in selling_points
        if evidence_by_selling_point[_normalized_value(item)].evidence_mode in allowed_modes
    ]
    # If an effect has no safe visual evidence, retain the fact; the execution gate rejects
    # it and replenishment keeps the effect quota visible instead of inventing proof.
    pool = eligible or list(selling_points)
    if preferred in pool:
        return preferred
    return pool[(ordinal - 1) % len(pool)]


def _selling_point_sequence(
    selling_points: Sequence[str],
    count: int,
    weights: Mapping[str, int] | None,
) -> list[str]:
    if not selling_points:
        raise ValueError("selling point pool cannot be empty")
    normalized_weights = {
        item: max(0, (weights or {}).get(item, 0)) for item in selling_points
    }
    if not any(normalized_weights.values()):
        normalized_weights = {item: 1 for item in selling_points}
    total = sum(normalized_weights.values())
    raw = {item: count * value / total for item, value in normalized_weights.items()}
    targets = {item: math.floor(value) for item, value in raw.items()}
    remainder = count - sum(targets.values())
    order = sorted(
        selling_points,
        key=lambda item: (-(raw[item] - targets[item]), selling_points.index(item)),
    )
    for item in order[:remainder]:
        targets[item] += 1
    sequence: list[str] = []
    while len(sequence) < count:
        for item in selling_points:
            if targets[item] > 0:
                sequence.append(item)
                targets[item] -= 1
                if len(sequence) == count:
                    break
    return sequence


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


def _round_value(value: str, round_number: int, max_length: int) -> str:
    if round_number == 0:
        return value
    suffix = f"·补齐策略{round_number}"
    return value[: max_length - len(suffix)].rstrip("·") + suffix


def _normalized_value(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value).strip().casefold())
