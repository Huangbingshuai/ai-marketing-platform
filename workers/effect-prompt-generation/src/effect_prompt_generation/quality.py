from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .models import (
    CreativeCandidate,
    CreativeEvaluation,
    InsightApplicationMap,
)


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


_AI_HARD_ISSUES = {
    "PRODUCT_UNRELATED",
    "FABRICATED_FACT",
    "ABSTRACT_FACT_VISUAL_PROOF",
    "EMPTY_OR_BROKEN_CONTENT",
    "SPEECH_DEPENDENT_MATERIAL",
}


def normalize_creative_signature(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[\s\W_]+", "", normalized)[:240] or "empty"


def validate_creative_evaluation(
    candidate: CreativeCandidate,
    evaluation: CreativeEvaluation,
    application: InsightApplicationMap,
    *,
    target_duration_seconds: int | None = None,
    contextual_fact_ids: Sequence[str] = (),
) -> CreativeEvaluation:
    """Validate model-owned semantics without re-interpreting candidate text.

    The evaluator is the only component allowed to decide whether a fact was
    realized or whether a visual claim is semantically valid. This function only
    checks stable identifiers, enums and the internal consistency of that report.
    """

    del target_duration_seconds
    if evaluation.slot_id != candidate.slot_id:
        raise ValueError("creative evaluation changed slotId")
    declared = set(candidate.declared_fact_ids)
    contextual = {
        fact_id for fact_id in contextual_fact_ids if fact_id in application.by_id
    }
    allowed_evidence = declared | contextual
    valid_evidence = [
        evidence
        for evidence in evaluation.fact_evidence
        if evidence.fact_id in allowed_evidence
    ]
    realized_fact_ids = list(
        dict.fromkeys(
            evidence.fact_id
            for evidence in valid_evidence
            if evidence.support_level in {"EXACT", "SEMANTIC_FULL"}
        )
    )
    unknown_evidence = len(valid_evidence) != len(evaluation.fact_evidence)
    valid_visual_proof_findings = []
    for finding in evaluation.abstract_visual_proof_findings:
        if finding.fact_id in allowed_evidence:
            valid_visual_proof_findings.append(finding)
    issues = [
        issue
        for issue in evaluation.hard_issues
        if issue in _AI_HARD_ISSUES
        and (issue != "ABSTRACT_FACT_VISUAL_PROOF" or bool(valid_visual_proof_findings))
    ]
    warnings = [
        *evaluation.warnings,
        *[issue for issue in evaluation.hard_issues if issue not in _AI_HARD_ISSUES],
    ]
    if unknown_evidence:
        warnings.append("UNKNOWN_OR_UNDECLARED_FACT")
    if (
        "ABSTRACT_FACT_VISUAL_PROOF" in evaluation.hard_issues
        and not valid_visual_proof_findings
    ):
        warnings.append("ABSTRACT_FACT_VISUAL_PROOF_REPORT_INVALID")
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
            "realized_fact_ids": realized_fact_ids,
            "abstract_visual_proof_findings": valid_visual_proof_findings,
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
    required_fact_ids: Sequence[str] = (),
    preferred_item_fact_ids: Sequence[str] = (),
    fixed_covered_fact_ids: Sequence[str] = (),
    quality_weight: float = 0.8,
    novelty_weight: float = 0.2,
    semantic_group_resolver: Callable[[RankedCreative], str] | None = None,
    fixed_semantic_group_ids: Sequence[str] = (),
    semantic_group_repeat_penalty: float = 0.0,
) -> CreativeSelectionResult:
    candidate_by_id = {item.slot_id: item for item in candidates}
    ranked = [
        RankedCreative(
            candidate=candidate_by_id[item.slot_id],
            evaluation=item,
            quality_score=_selection_quality_score(item),
            novelty_score=100.0,
            selection_score=(
                _selection_quality_score(item) * quality_weight + 100.0 * novelty_weight
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
    semantic_group_counts: Counter[str] = Counter(fixed_semantic_group_ids)
    resolve_novelty = novelty_resolver or _creative_novelty
    novelty_by_id = {
        item.candidate.slot_id: (
            fixed_novelty_resolver(item)
            if fixed_novelty_resolver is not None
            else 100.0
        )
        for item in remaining
    }
    uncovered_required = set(required_fact_ids) - set(fixed_covered_fact_ids)
    preferred_item_facts = set(preferred_item_fact_ids)
    while remaining and len(selected) < target_count:
        scored: list[RankedCreative] = []
        for item in remaining:
            novelty = novelty_by_id[item.candidate.slot_id]
            semantic_group = (
                semantic_group_resolver(item)
                if semantic_group_resolver is not None
                else None
            )
            repeat_penalty = (
                semantic_group_counts[semantic_group] * semantic_group_repeat_penalty
                if semantic_group is not None
                else 0.0
            )
            scored.append(
                RankedCreative(
                    candidate=item.candidate,
                    evaluation=item.evaluation,
                    quality_score=item.quality_score,
                    novelty_score=novelty,
                    selection_score=round(
                        item.quality_score * quality_weight
                        + novelty * novelty_weight
                        - repeat_penalty,
                        4,
                    ),
                )
            )
        business_bound_candidates = [
            row
            for row in scored
            if preferred_item_facts.intersection(row.evaluation.realized_fact_ids)
        ]
        business_pool = business_bound_candidates or scored
        coverage_candidates = [
            row
            for row in business_pool
            if uncovered_required.intersection(row.evaluation.realized_fact_ids)
        ]
        selection_pool = coverage_candidates or business_pool
        if semantic_group_resolver is not None:
            unused_group_candidates = [
                row
                for row in selection_pool
                if semantic_group_counts[semantic_group_resolver(row)] == 0
            ]
            if unused_group_candidates:
                selection_pool = unused_group_candidates
        best = max(
            selection_pool,
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
        if semantic_group_resolver is not None:
            semantic_group_counts[semantic_group_resolver(best)] += 1
        uncovered_required.difference_update(best.evaluation.realized_fact_ids)
        remaining = [
            item
            for item in remaining
            if item.candidate.slot_id != best.candidate.slot_id
        ]
        for item in remaining:
            slot_id = item.candidate.slot_id
            novelty_by_id[slot_id] = min(
                novelty_by_id[slot_id],
                resolve_novelty(item, best),
            )
    selected_ids = {item.candidate.slot_id for item in selected}
    rejected = [item for item in ranked if item.candidate.slot_id not in selected_ids]
    return CreativeSelectionResult(
        selected=selected,
        rejected=rejected,
        exact_duplicate_count=exact_duplicate_count,
    )


def _selection_quality_score(evaluation: CreativeEvaluation) -> float:
    # The evaluator already incorporates coherence, executability and duration
    # fitness into its five scores. Worker-side warning penalties would score the
    # same semantics a second time and can amplify a subjective model finding.
    return evaluation.scores.overall_quality


def _creative_novelty(left: RankedCreative, right: RankedCreative) -> float:
    left_profile = left.evaluation.semantic_profile
    right_profile = right.evaluation.semantic_profile
    if left_profile is None or right_profile is None:
        return 100.0
    pairs = (
        (left_profile.narrative_family, right_profile.narrative_family),
        (left_profile.scene_family, right_profile.scene_family),
        (left_profile.persona_family, right_profile.persona_family),
        (left_profile.product_action_family, right_profile.product_action_family),
        (left_profile.camera_family, right_profile.camera_family),
        (left_profile.emotion_family, right_profile.emotion_family),
    )
    same = sum(
        normalize_creative_signature(left_value)
        == normalize_creative_signature(right_value)
        for left_value, right_value in pairs
    )
    return round(100.0 * (1.0 - same / len(pairs)), 4)
