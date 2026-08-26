from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from itertools import combinations

from .combinations import dimension_distance
from .insight_mapping import insight_coverage
from .models import (
    ExecutionInvalidReason,
    FragmentType,
    FragmentTypeDistribution,
    InsightApplicationMap,
    InsightCoverage,
    PairViolation,
    PromptItem,
    PromptMetrics,
    SellingPointCoverage,
)

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
_COMPLIANCE = re.compile(r"(?:合规|禁用元素|注意事项|避免)\s*[:：][^。\n]+", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class EvaluationResult:
    items: list[PromptItem]
    metrics: PromptMetrics
    quality_status: str
    semantic_pairs: list[PairViolation]
    visual_pairs: list[PairViolation]
    missing_selling_points: list[str]
    missing_fact_ids: list[str]


def semantic_signature(item: PromptItem) -> str:
    parts = (
        item.fragment_type.value,
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
    insight_application: InsightApplicationMap | None = None,
    fragment_type_targets: dict[FragmentType, int] | None = None,
    generated_candidate_count: int | None = None,
    removed_execution_invalid: int = 0,
    execution_invalid_reasons: dict[str, int] | None = None,
) -> EvaluationResult:
    accepted = _unique_items(retained)[:target_count]
    targets = fragment_type_targets or {}
    actual_types = {item: 0 for item in FragmentType}
    for item in accepted:
        actual_types[item.fragment_type] += 1
    removed_semantic = 0
    removed_visual = 0
    removed_dimension = 0

    required_fact_ids = {
        fact.fact_id for fact in insight_application.required
    } if insight_application else set()
    candidate_order = _coverage_order(_unique_items(candidates), required_fact_ids)
    for candidate in candidate_order:
        if len(accepted) >= target_count or candidate.id in {item.id for item in accepted}:
            continue
        if targets and actual_types[candidate.fragment_type] >= targets[candidate.fragment_type]:
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
        actual_types[candidate.fragment_type] += 1

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
    distribution = [
        FragmentTypeDistribution(
            fragment_type=fragment_type,
            target_count=targets.get(fragment_type, 0),
            actual_count=actual_types[fragment_type],
        )
        for fragment_type in FragmentType
    ]
    distribution_valid = not targets or all(
        item.actual_count == item.target_count for item in distribution
    )
    covered_selling_points = [
        item
        for item in dict.fromkeys(required_selling_points or [])
        if _normalized_value(item) in covered
    ]
    coverage = insight_coverage(insight_application, accepted) if insight_application else None
    missing_fact_ids = [item.fact_id for item in coverage.missing] if coverage else []
    passed = (
        len(accepted) == target_count
        and dimensions_valid
        and semantic_rate <= semantic_limit
        and visual_rate <= visual_limit
        and not missing_selling_points
        and not missing_fact_ids
        and distribution_valid
    )
    metrics = PromptMetrics(
        target_count=target_count,
        accepted_count=len(accepted),
        generated_candidate_count=generated_candidate_count
        if generated_candidate_count is not None
        else len(_unique_items(candidates)),
        removed_semantic_duplicates=removed_semantic,
        removed_visual_duplicates=removed_visual,
        removed_dimension_conflicts=removed_dimension,
        removed_execution_invalid=removed_execution_invalid,
        execution_invalid_reasons=[
            ExecutionInvalidReason(code=code, count=count)
            for code, count in sorted((execution_invalid_reasons or {}).items())
            if count > 0
        ],
        semantic_duplicate_rate=semantic_rate,
        visual_overlap_rate=visual_rate,
        replenishment_rounds=round_number,
        fragment_type_distribution=distribution,
        selling_point_coverage=SellingPointCoverage(
            required=list(dict.fromkeys(required_selling_points or [])),
            covered=covered_selling_points,
            missing=missing_selling_points,
        ),
        insight_coverage=coverage or InsightCoverage(),
    )
    return EvaluationResult(
        items=accepted,
        metrics=metrics,
        quality_status="PASS" if passed else "NEEDS_REVIEW",
        semantic_pairs=semantic_pairs,
        visual_pairs=visual_pairs,
        missing_selling_points=missing_selling_points,
        missing_fact_ids=missing_fact_ids,
    )


def _coverage_order(items: list[PromptItem], required_fact_ids: set[str]) -> list[PromptItem]:
    remaining = list(items)
    uncovered = set(required_fact_ids)
    ordered: list[PromptItem] = []
    while remaining and uncovered:
        best_index, _ = max(
            enumerate(remaining),
            key=lambda entry: len(
                uncovered.intersection(binding.fact_id for binding in entry[1].insight_bindings)
            ),
        )
        score = len(
            uncovered.intersection(binding.fact_id for binding in remaining[best_index].insight_bindings)
        )
        if score == 0:
            break
        item = remaining.pop(best_index)
        ordered.append(item)
        uncovered.difference_update(binding.fact_id for binding in item.insight_bindings)
    return [*ordered, *remaining]


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
