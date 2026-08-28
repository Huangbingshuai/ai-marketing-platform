from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from itertools import combinations
from typing import Callable

from .combinations import dimension_distance
from .insight_mapping import insight_coverage
from .models import (
    CreativeCandidate,
    CreativeEvaluation,
    ExecutionInvalidReason,
    FragmentType,
    FragmentTypeDistribution,
    InsightApplicationMap,
    InsightCoverage,
    InsightField,
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


@dataclass(frozen=True, slots=True)
class RankedCreative:
    candidate: CreativeCandidate
    evaluation: CreativeEvaluation
    quality_score: float
    novelty_score: float
    selection_score: float


@dataclass(frozen=True, slots=True)
class CreativeSelectionResult:
    selected: list[RankedCreative]
    rejected: list[RankedCreative]
    exact_duplicate_count: int


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
    retained_ids = {item.id for item in accepted}
    seen_content = {_normalized_value(item.content) for item in accepted}
    remaining: list[PromptItem] = []
    for candidate in _unique_items(candidates):
        if candidate.id in retained_ids:
            continue
        content_key = _normalized_value(candidate.content)
        if content_key in seen_content:
            # A byte-for-byte-equivalent creative instruction remains a hard
            # duplicate. Threshold-based semantic similarity is handled at the
            # whole-batch level below and must not discard every similar item.
            removed_semantic += 1
            continue
        seen_content.add(content_key)
        remaining.append(candidate)

    uncovered = required_fact_ids.difference(
        binding.fact_id for item in accepted for binding in item.insight_bindings
    )
    while remaining and len(accepted) < target_count:
        eligible = [
            item
            for item in remaining
            if not targets
            or actual_types[item.fragment_type] < targets[item.fragment_type]
        ]
        if not eligible:
            break
        stable_order = {item.id: index for index, item in enumerate(remaining)}

        def selection_score(item: PromptItem) -> tuple[int, int, int, int, int, int]:
            coverage_gain = len(
                uncovered.intersection(
                    binding.fact_id for binding in item.insight_bindings
                )
            )
            semantic_conflicts = sum(
                semantic_similarity(item, current) >= SEMANTIC_DICE_THRESHOLD
                for current in accepted
            )
            visual_conflicts = sum(
                visual_overlap(item, current) >= VISUAL_OVERLAP_THRESHOLD
                for current in accepted
            )
            dimension_conflicts = sum(
                dimension_distance(item.dimensions, current.dimensions) < 3
                for current in accepted
            )
            minimum_distance = min(
                (
                    dimension_distance(item.dimensions, current.dimensions)
                    for current in accepted
                ),
                default=6,
            )
            return (
                coverage_gain,
                -semantic_conflicts,
                -visual_conflicts,
                -dimension_conflicts,
                minimum_distance,
                -stable_order[item.id],
            )

        candidate = max(eligible, key=selection_score)
        remaining.remove(candidate)
        accepted.append(candidate)
        actual_types[candidate.fragment_type] += 1
        uncovered.difference_update(
            binding.fact_id for binding in candidate.insight_bindings
        )

    semantic_pairs = semantic_violations(accepted)
    visual_pairs = visual_violations(accepted)
    semantic_rate = pair_rate(len(semantic_pairs), len(accepted))
    visual_rate = pair_rate(len(visual_pairs), len(accepted))
    covered = {
        _normalized_value(value)
        for item in accepted
        for value in [
            item.dimensions.selling_point,
            *(
                binding.value
                for binding in item.insight_bindings
                if binding.field == InsightField.CORE_SELLING_POINT
            ),
        ]
    }
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
        fallback_count=0,
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


_PRODUCT_RELEVANT_FIELDS = {
    InsightField.PRODUCT_NAME,
    InsightField.PRODUCT_CATEGORY,
    InsightField.CORE_SPECIFICATION,
    InsightField.VISUAL_FEATURES,
    InsightField.CORE_SELLING_POINT,
    InsightField.SECONDARY_SELLING_POINT,
    InsightField.CORE_PAIN_POINT,
    InsightField.DECISION_DRIVER,
    InsightField.USAGE_SCENARIO,
    InsightField.PURCHASE_SCENARIO,
    InsightField.EMOTIONAL_SCENARIO,
}

_GENERIC_STYLE_PHRASES = (
    "电影级",
    "电影感",
    "高级感",
    "高级质感",
    "商业广告质感",
    "大片质感",
    "暖色光线",
    "暖色调",
    "浅景深",
    "缓慢推进",
)

_PURPOSE_ONLY_PHRASES = (
    "展示产品效果",
    "展示产品品质",
    "体现产品品质",
    "突出产品卖点",
    "突出核心卖点",
    "建立信任感",
    "营造高级感",
)


def normalize_creative_signature(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[\s\W_]+", "", normalized)[:240] or "empty"


def creative_soft_warnings(candidate: CreativeCandidate) -> list[str]:
    """Return deterministic quality hints that must never reject a creative."""

    corpus = "|".join(
        (
            candidate.content,
            candidate.dimensions.camera,
            candidate.dimensions.emotion,
        )
    )
    warnings: list[str] = []
    generic_hits = {
        phrase for phrase in _GENERIC_STYLE_PHRASES if phrase in corpus
    }
    if len(generic_hits) >= 3:
        warnings.append("GENERIC_STYLE_STACKING")
    if any(phrase in corpus for phrase in _PURPOSE_ONLY_PHRASES):
        warnings.append("PURPOSE_SENTENCE_INSTEAD_OF_VISIBLE_ACTION")
    return warnings


def validate_creative_evaluation(
    candidate: CreativeCandidate,
    evaluation: CreativeEvaluation,
    application: InsightApplicationMap,
) -> CreativeEvaluation:
    if evaluation.slot_id != candidate.slot_id:
        raise ValueError("creative evaluation changed slotId")
    declared = set(candidate.declared_fact_ids)
    content_text = _normalized_evidence_text(candidate.content)
    valid_evidence = []
    evidence_metadata_codes = {
        "FACT_EVIDENCE_NOT_IN_CONTENT",
        "UNKNOWN_OR_UNDECLARED_FACT",
    }
    issues = [
        issue
        for issue in evaluation.hard_issues
        if issue not in evidence_metadata_codes
    ]
    warnings = [*evaluation.warnings, *creative_soft_warnings(candidate)]
    warnings.extend(
        issue
        for issue in evaluation.hard_issues
        if issue in evidence_metadata_codes
    )
    for evidence in evaluation.fact_evidence:
        fact = application.by_id.get(evidence.fact_id)
        if fact is None or evidence.fact_id not in declared:
            warnings.append("UNKNOWN_OR_UNDECLARED_FACT")
            continue
        if _normalized_evidence_text(evidence.evidence_text) not in content_text:
            warnings.append("FACT_EVIDENCE_NOT_IN_CONTENT")
            continue
        valid_evidence.append(evidence)
    relevant = [
        evidence
        for evidence in valid_evidence
        if application.by_id[evidence.fact_id].field in _PRODUCT_RELEVANT_FIELDS
    ]
    if not relevant:
        issues.append("MISSING_PRODUCT_RELATION")
    if evaluation.scores.product_relevance < 60:
        issues.append("LOW_PRODUCT_RELEVANCE")
    if evaluation.scores.creative_coherence < 50:
        issues.append("DIMENSION_CONTENT_CONFLICT")
    if evaluation.scores.visual_executability < 50:
        issues.append("VISUALLY_UNEXECUTABLE")
    semantic = normalize_creative_signature(candidate.creative_core)
    visual = normalize_creative_signature(
        "|".join(
            (
                candidate.dimensions.scene,
                candidate.dimensions.persona,
                candidate.dimensions.product_relation,
                candidate.dimensions.camera,
            )
        )
    )
    return evaluation.model_copy(
        update={
            "fact_evidence": valid_evidence,
            "realized_fact_ids": [item.fact_id for item in valid_evidence],
            "semantic_signature": semantic,
            "visual_signature": visual,
            "hard_issues": list(dict.fromkeys(issues)),
            "warnings": list(dict.fromkeys(warnings)),
        }
    )


def select_creatives(
    candidates: list[CreativeCandidate],
    evaluations: list[CreativeEvaluation],
    *,
    target_count: int,
    novelty_resolver: Callable[[RankedCreative, RankedCreative], float] | None = None,
    fixed_novelty_resolver: Callable[[RankedCreative], float] | None = None,
    dimension_gain_resolver: Callable[[RankedCreative, list[RankedCreative]], int]
    | None = None,
    quality_weight: float = 0.8,
    novelty_weight: float = 0.2,
) -> CreativeSelectionResult:
    candidate_by_id = {item.slot_id: item for item in candidates}
    ranked = [
        RankedCreative(
            candidate=candidate_by_id[item.slot_id],
            evaluation=item,
            quality_score=item.scores.overall_quality,
            novelty_score=100.0,
            selection_score=(
                item.scores.overall_quality * quality_weight
                + 100.0 * novelty_weight
            ),
        )
        for item in evaluations
        if item.slot_id in candidate_by_id and not item.hard_issues
    ]
    exact_duplicate_count = 0
    unique: list[RankedCreative] = []
    content_seen: set[str] = set()
    creative_seen: set[tuple[str, ...]] = set()
    for item in sorted(ranked, key=lambda row: row.candidate.ordinal):
        content_signature = normalize_creative_signature(item.candidate.content)
        creative_signature = (
            normalize_creative_signature(item.candidate.creative_core),
            normalize_creative_signature(item.candidate.dimensions.narrative),
            normalize_creative_signature(item.candidate.dimensions.scene),
            normalize_creative_signature(item.candidate.dimensions.persona),
            normalize_creative_signature(item.candidate.dimensions.product_relation),
            normalize_creative_signature(item.candidate.dimensions.camera),
            normalize_creative_signature(item.candidate.dimensions.emotion),
        )
        if content_signature in content_seen or creative_signature in creative_seen:
            exact_duplicate_count += 1
            continue
        content_seen.add(content_signature)
        creative_seen.add(creative_signature)
        unique.append(item)

    selected: list[RankedCreative] = []
    remaining = list(unique)
    resolve_novelty = novelty_resolver or _creative_novelty
    while remaining and len(selected) < target_count:
        scored: list[RankedCreative] = []
        for item in remaining:
            novelty_values = [
                resolve_novelty(item, accepted) for accepted in selected
            ]
            if fixed_novelty_resolver is not None:
                novelty_values.append(fixed_novelty_resolver(item))
            novelty = min(novelty_values, default=100.0)
            scored.append(
                RankedCreative(
                    candidate=item.candidate,
                    evaluation=item.evaluation,
                    quality_score=item.quality_score,
                    novelty_score=novelty,
                    selection_score=round(
                        item.quality_score * quality_weight
                        + novelty * novelty_weight,
                        4,
                    ),
                )
            )
        best = max(
            scored,
            key=lambda row: (
                row.selection_score,
                dimension_gain_resolver(row, selected)
                if dimension_gain_resolver is not None
                else 0,
                row.quality_score,
                -row.candidate.ordinal,
            ),
        )
        selected.append(best)
        remaining = [item for item in remaining if item.candidate.slot_id != best.candidate.slot_id]
    selected_ids = {item.candidate.slot_id for item in selected}
    rejected = [item for item in ranked if item.candidate.slot_id not in selected_ids]
    return CreativeSelectionResult(
        selected=selected,
        rejected=rejected,
        exact_duplicate_count=exact_duplicate_count,
    )


def _creative_novelty(left: RankedCreative, right: RankedCreative) -> float:
    semantic = trigram_dice(left.candidate.content, right.candidate.content)
    left_visual = left.candidate.dimensions
    right_visual = right.candidate.dimensions
    visual = sum(
        1
        for left_value, right_value in (
            (left_visual.narrative, right_visual.narrative),
            (left_visual.scene, right_visual.scene),
            (left_visual.persona, right_visual.persona),
            (left_visual.product_relation, right_visual.product_relation),
            (left_visual.camera, right_visual.camera),
            (left_visual.emotion, right_visual.emotion),
        )
        if normalize_creative_signature(left_value)
        == normalize_creative_signature(right_value)
    ) / 6
    return round(100.0 * (1.0 - max(semantic, visual)), 4)


def _normalized_evidence_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())
