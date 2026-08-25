from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from itertools import combinations

from .combinations import dimension_distance
from .models import PairViolation, PromptItem, PromptMetrics


SEMANTIC_DICE_THRESHOLD = 0.82
VISUAL_OVERLAP_THRESHOLD = 0.75
VISUAL_WEIGHTS = {
    "scene": 0.35,
    "persona": 0.20,
    "camera": 0.30,
    "emotion": 0.15,
}

_DURATION = re.compile(r"(?:视频)?时长\s*[:：]?\s*\d+\s*(?:秒|s)", re.IGNORECASE)
_ASPECT = re.compile(r"(?:画幅|比例)\s*[:：]?\s*\d+\s*[:：x×]\s*\d+", re.IGNORECASE)
_CHANNEL = re.compile(r"(?:投放)?渠道\s*[:：][^。；;\n]+", re.IGNORECASE)
_COMPLIANCE = re.compile(r"(?:合规|禁用元素|注意事项)\s*[:：][^。；;\n]+", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class EvaluationResult:
    items: list[PromptItem]
    metrics: PromptMetrics
    quality_status: str
    semantic_pairs: list[PairViolation]
    visual_pairs: list[PairViolation]
    missing_selling_points: list[str]


def semantic_signature(item: PromptItem) -> str:
    parts = (
        item.dimensions.narrative,
        item.dimensions.selling_point,
        item.dimensions.scene,
    )
    return "|".join(_normalized_value(part) for part in parts)


def trigram_dice(left: str, right: str) -> float:
    left_grams = _ngrams(_semantic_text(left), 3)
    right_grams = _ngrams(_semantic_text(right), 3)
    if not left_grams and not right_grams:
        return 1.0
    if not left_grams or not right_grams:
        return 0.0
    return 2.0 * len(left_grams & right_grams) / (len(left_grams) + len(right_grams))


def semantic_similarity(left: PromptItem, right: PromptItem) -> float:
    if semantic_signature(left) == semantic_signature(right):
        return 1.0
    return trigram_dice(left.content, right.content)


def visual_overlap(left: PromptItem, right: PromptItem) -> float:
    return sum(
        weight
        for key, weight in VISUAL_WEIGHTS.items()
        if _normalized_value(getattr(left.dimensions, key))
        == _normalized_value(getattr(right.dimensions, key))
    )


def semantic_violations(items: list[PromptItem]) -> list[PairViolation]:
    return [
        PairViolation(left_id=left.id, right_id=right.id, score=round(score, 6))
        for left, right in combinations(items, 2)
        if (score := semantic_similarity(left, right)) >= SEMANTIC_DICE_THRESHOLD
    ]


def visual_violations(items: list[PromptItem]) -> list[PairViolation]:
    return [
        PairViolation(left_id=left.id, right_id=right.id, score=round(score, 6))
        for left, right in combinations(items, 2)
        if (score := visual_overlap(left, right)) >= VISUAL_OVERLAP_THRESHOLD
    ]


def pair_rate(violating_pairs: int, item_count: int) -> float:
    total_pairs = item_count * (item_count - 1) // 2
    if total_pairs == 0:
        return 0.0
    percentage = Decimal(violating_pairs * 100) / Decimal(total_pairs)
    return float(percentage.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def evaluate_candidates(
    retained: list[PromptItem],
    candidates: list[PromptItem],
    *,
    target_count: int,
    semantic_limit: float,
    visual_limit: float,
    round_number: int,
    required_selling_points: list[str] | None = None,
) -> EvaluationResult:
    accepted = _unique_items(retained)[:target_count]
    removed_semantic = 0
    removed_visual = 0
    removed_dimension = 0

    for candidate in _unique_items(candidates):
        if len(accepted) >= target_count or candidate.id in {item.id for item in accepted}:
            continue
        if any(dimension_distance(candidate.dimensions, item.dimensions) < 3 for item in accepted):
            removed_dimension += 1
            continue
        if any(
            semantic_similarity(candidate, item) >= SEMANTIC_DICE_THRESHOLD for item in accepted
        ):
            removed_semantic += 1
            continue
        if any(visual_overlap(candidate, item) >= VISUAL_OVERLAP_THRESHOLD for item in accepted):
            removed_visual += 1
            continue
        accepted.append(candidate)

    semantic_pairs = semantic_violations(accepted)
    visual_pairs = visual_violations(accepted)
    semantic_rate = pair_rate(len(semantic_pairs), len(accepted))
    visual_rate = pair_rate(len(visual_pairs), len(accepted))
    dimensions_valid = all(
        dimension_distance(left.dimensions, right.dimensions) >= 3
        for left, right in combinations(accepted, 2)
    )
    covered = {_normalized_value(item.dimensions.selling_point) for item in accepted}
    missing_selling_points = [
        item
        for item in dict.fromkeys(required_selling_points or [])
        if _normalized_value(item) not in covered
    ]
    passed = (
        len(accepted) == target_count
        and dimensions_valid
        and semantic_rate <= semantic_limit
        and visual_rate <= visual_limit
        and not missing_selling_points
    )
    metrics = PromptMetrics(
        target_count=target_count,
        accepted_count=len(accepted),
        generated_candidate_count=len(_unique_items(candidates)),
        removed_semantic_duplicates=removed_semantic,
        removed_visual_duplicates=removed_visual,
        removed_dimension_conflicts=removed_dimension,
        semantic_duplicate_rate=semantic_rate,
        visual_overlap_rate=visual_rate,
        replenishment_rounds=round_number,
    )
    return EvaluationResult(
        items=accepted,
        metrics=metrics,
        quality_status="PASS" if passed else "NEEDS_REVIEW",
        semantic_pairs=semantic_pairs,
        visual_pairs=visual_pairs,
        missing_selling_points=missing_selling_points,
    )


def _semantic_text(value: str) -> str:
    normalized = _normalized_value(value)
    for pattern in (_DURATION, _ASPECT, _CHANNEL, _COMPLIANCE):
        normalized = pattern.sub("", normalized)
    return "".join(
        character
        for character in normalized
        if not character.isspace()
        and unicodedata.category(character)[0] not in {"P", "S"}
    )


def _normalized_value(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value).strip().casefold())


def _ngrams(value: str, size: int) -> set[str]:
    if not value:
        return set()
    if len(value) < size:
        return {value}
    return {value[index : index + size] for index in range(len(value) - size + 1)}


def _unique_items(items: list[PromptItem]) -> list[PromptItem]:
    result: list[PromptItem] = []
    seen: set[str] = set()
    for item in items:
        if item.id not in seen:
            seen.add(item.id)
            result.append(item)
    return result
