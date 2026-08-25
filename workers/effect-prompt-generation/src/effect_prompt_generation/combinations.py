from __future__ import annotations

from collections.abc import Sequence
import re
import unicodedata

from .models import DimensionPools, PlannedCombination, PromptDimensions, ShardPlan


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


def dimension_distance(left: PromptDimensions, right: PromptDimensions) -> int:
    return sum(
        _normalized_value(getattr(left, key)) != _normalized_value(getattr(right, key))
        for key in ("narrative", "scene", "persona", "selling_point", "camera", "emotion")
    )


def plan_combinations(
    pools: DimensionPools,
    *,
    count: int,
    round_number: int,
    ordinal_start: int,
) -> list[PlannedCombination]:
    """Build a q-ary linear code; any two generated rows differ in >=4 non-selling dimensions."""
    if count < 0 or count > ORTHOGONAL_ORDER**2:
        raise ValueError(f"count must be between 0 and {ORTHOGONAL_ORDER**2}")

    narratives = _expand(pools.narratives, 120)
    scenes = _expand(pools.scenes, 120)
    personas = _expand(pools.personas, 160)
    cameras = _expand(pools.cameras, 160)
    emotions = _expand(pools.emotions, 120)
    result: list[PlannedCombination] = []
    offset = round_number * 67
    for position in range(count):
        encoded = (offset + position) % (ORTHOGONAL_ORDER**2)
        a, b = divmod(encoded, ORTHOGONAL_ORDER)
        ordinal = ordinal_start + position
        dimensions = PromptDimensions(
            narrative=_round_value(narratives[a], round_number, 120),
            scene=_round_value(scenes[b], round_number, 120),
            persona=_round_value(personas[(a + b) % ORTHOGONAL_ORDER], round_number, 160),
            selling_point=pools.selling_points[(ordinal - 1) % len(pools.selling_points)],
            camera=_round_value(cameras[(a + 2 * b) % ORTHOGONAL_ORDER], round_number, 160),
            emotion=_round_value(emotions[(a + 3 * b) % ORTHOGONAL_ORDER], round_number, 120),
        )
        result.append(
            PlannedCombination(
                slot_id=f"r{round_number}-s{ordinal:04d}",
                ordinal=ordinal,
                fragment_type=pools.fragment_types[(ordinal - 1) % len(pools.fragment_types)],
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
