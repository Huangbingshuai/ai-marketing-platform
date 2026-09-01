from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .insight_mapping import MANDATORY_BUSINESS_FIELDS
from .models import (
    CreativeCandidate,
    CreativeEvaluation,
    InsightApplicationMap,
    InsightField,
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


def trigram_dice(left: str, right: str) -> float:
    left_grams = _ngrams(_semantic_text(left), 3)
    right_grams = _ngrams(_semantic_text(right), 3)
    if not left_grams and not right_grams:
        return 1.0
    if not left_grams or not right_grams:
        return 0.0
    return 2.0 * len(left_grams & right_grams) / (len(left_grams) + len(right_grams))


def _semantic_text(value: str) -> str:
    normalized = re.sub(r"\s+", " ", unicodedata.normalize("NFC", value).strip().casefold())
    return "".join(
        character
        for character in normalized
        if not character.isspace()
        and unicodedata.category(character)[0] not in {"P", "S"}
    )


def _ngrams(value: str, size: int) -> set[str]:
    if not value:
        return set()
    if len(value) < size:
        return {value}
    return {value[index : index + size] for index in range(len(value) - size + 1)}


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

# Identity and numeric facts must retain their exact value. All other business
# facts are verified by the evaluator as full semantic support, because Chinese
# character overlap cannot distinguish a faithful paraphrase from an unrelated
# phrase that happens to share two characters.
_EXACT_FACT_FIELDS = {
    InsightField.PRODUCT_NAME,
    InsightField.PRODUCT_CATEGORY,
    InsightField.CORE_SPECIFICATION,
    InsightField.PRICE_RANGE,
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
    generic_hits = {phrase for phrase in _GENERIC_STYLE_PHRASES if phrase in corpus}
    if len(generic_hits) >= 3:
        warnings.append("GENERIC_STYLE_STACKING")
    if any(phrase in corpus for phrase in _PURPOSE_ONLY_PHRASES):
        warnings.append("PURPOSE_SENTENCE_INSTEAD_OF_VISIBLE_ACTION")
    return warnings


def validate_creative_evaluation(
    candidate: CreativeCandidate,
    evaluation: CreativeEvaluation,
    application: InsightApplicationMap,
    *,
    target_duration_seconds: int | None = None,
    contextual_fact_ids: Sequence[str] = (),
) -> CreativeEvaluation:
    if evaluation.slot_id != candidate.slot_id:
        raise ValueError("creative evaluation changed slotId")
    declared = set(candidate.declared_fact_ids)
    contextual = {
        fact_id
        for fact_id in contextual_fact_ids
        if fact_id in application.by_id
    }
    allowed_evidence = declared | contextual
    evidence_sources = _candidate_evidence_sources(candidate)
    valid_evidence = []
    evidenced_fact_ids: set[str] = set()
    evidence_metadata_codes = {
        "FACT_EVIDENCE_NOT_IN_CONTENT",
        "UNKNOWN_OR_UNDECLARED_FACT",
    }
    ai_reported_abstract_proof = "ABSTRACT_FACT_VISUAL_PROOF" in evaluation.hard_issues
    subjective_ai_issues = {"DIMENSION_CONTENT_CONFLICT"}
    issues = [
        issue
        for issue in evaluation.hard_issues
        if issue
        not in {
            *evidence_metadata_codes,
            "ABSTRACT_FACT_VISUAL_PROOF",
            *subjective_ai_issues,
        }
    ]
    warnings = [*evaluation.warnings, *creative_soft_warnings(candidate)]
    warnings.extend(
        issue for issue in evaluation.hard_issues if issue in evidence_metadata_codes
    )
    warnings.extend(
        issue for issue in evaluation.hard_issues if issue in subjective_ai_issues
    )
    valid_visual_proof_findings = []
    for finding in evaluation.abstract_visual_proof_findings:
        if finding.fact_id not in allowed_evidence:
            warnings.append("ABSTRACT_VISUAL_PROOF_UNKNOWN_FACT")
            continue
        source = evidence_sources.get(finding.evidence_source)
        evidence_text = _normalized_evidence_text(finding.evidence_text)
        if source is None or not evidence_text or evidence_text not in _normalized_evidence_text(source):
            warnings.append("ABSTRACT_VISUAL_PROOF_EVIDENCE_NOT_FOUND")
            continue
        valid_visual_proof_findings.append(finding)
    if ai_reported_abstract_proof:
        if valid_visual_proof_findings:
            issues.append("ABSTRACT_FACT_VISUAL_PROOF")
        else:
            warnings.append("ABSTRACT_FACT_VISUAL_PROOF_UNVERIFIED")
    elif valid_visual_proof_findings:
        warnings.append("ABSTRACT_VISUAL_PROOF_FINDING_WITHOUT_ISSUE")
    for evidence in evaluation.fact_evidence:
        fact = application.by_id.get(evidence.fact_id)
        if fact is None or evidence.fact_id not in allowed_evidence:
            warnings.append("UNKNOWN_OR_UNDECLARED_FACT")
            continue
        matched_evidence = _match_candidate_evidence(
            evidence.evidence_text,
            evidence_sources,
        )
        if matched_evidence is None:
            warnings.append("FACT_EVIDENCE_NOT_IN_CONTENT")
            continue
        evidence_source, matched_text = matched_evidence
        if evidence.support_level in {"NONE", "PARTIAL"}:
            warnings.append(
                "FACT_EVIDENCE_PARTIAL"
                if evidence.support_level == "PARTIAL"
                else "FACT_EVIDENCE_MISMATCH"
            )
            continue
        exact_support = _evidence_exactly_supports_fact(matched_text, fact.value)
        if fact.field in _EXACT_FACT_FIELDS and not exact_support:
            warnings.append("FACT_EVIDENCE_MISMATCH")
            continue
        if evidence.support_level == "EXACT" and not exact_support:
            warnings.append("FACT_EVIDENCE_MISMATCH")
            continue
        if evidence.fact_id in evidenced_fact_ids:
            continue
        evidenced_fact_ids.add(evidence.fact_id)
        valid_evidence.append(
            evidence.model_copy(
                update={
                    "evidence_text": matched_text[:160],
                    "evidence_source": evidence_source,
                }
            )
        )
    relevant = [
        evidence
        for evidence in valid_evidence
        if application.by_id[evidence.fact_id].field in _PRODUCT_RELEVANT_FIELDS
    ]
    deep_business_evidence = [
        evidence
        for evidence in valid_evidence
        if application.by_id[evidence.fact_id].field in MANDATORY_BUSINESS_FIELDS
    ]
    mandatory_business_facts_available = any(
        fact.field in MANDATORY_BUSINESS_FIELDS for fact in application.usable
    )
    if not relevant:
        issues.append("MISSING_PRODUCT_RELATION")
    if mandatory_business_facts_available and not deep_business_evidence:
        warnings.append("MISSING_DEEP_BUSINESS_FACT")
    if evaluation.scores.product_relevance < 60:
        warnings.append("LOW_PRODUCT_RELEVANCE_SCORE")
    if evaluation.scores.creative_coherence < 50:
        warnings.append("LOW_CREATIVE_COHERENCE_SCORE")
    if evaluation.scores.visual_executability < 50:
        warnings.append("LOW_VISUAL_EXECUTABILITY_SCORE")
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
                _selection_quality_score(item) * quality_weight
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
    penalty = 0.0
    if "MISSING_DEEP_BUSINESS_FACT" in evaluation.warnings:
        # Keep the candidate available for exact-count recovery, but make a
        # correctly bound business fact decisively preferable during MMR.
        penalty += 18.0
    if "DURATION_TOO_DENSE" in evaluation.warnings:
        penalty += 8.0
    if "DURATION_TOO_SPARSE" in evaluation.warnings:
        penalty += 4.0
    return max(0.0, round(evaluation.scores.overall_quality - penalty, 4))


def _creative_novelty(left: RankedCreative, right: RankedCreative) -> float:
    semantic = trigram_dice(left.candidate.content, right.candidate.content)
    left_visual = left.candidate.dimensions
    right_visual = right.candidate.dimensions
    visual = (
        sum(
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
        )
        / 6
    )
    base_novelty = 100.0 * (1.0 - max(semantic, visual))
    left_profile = left.evaluation.semantic_profile
    right_profile = right.evaluation.semantic_profile
    if left_profile is None or right_profile is None:
        return round(base_novelty, 4)
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
    cluster_novelty = 100.0 * (1.0 - same / len(pairs))
    return round(0.70 * base_novelty + 0.30 * cluster_novelty, 4)


def _normalized_evidence_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[\s\W_]+", "", normalized)


def _candidate_evidence_sources(candidate: CreativeCandidate) -> dict[str, str]:
    """Return the only fields allowed to support a final fact binding.

    Clean video content remains the authority for visible facts. Structured
    creative fields may carry audience, scenario or abstract business context
    without pretending the rendered pixels prove a formula, taste or process.
    """

    dimensions = candidate.dimensions
    return {
        "CONTENT": candidate.content,
        "CREATIVE_CORE": candidate.creative_core,
        "NARRATIVE": dimensions.narrative,
        "SCENE": dimensions.scene,
        "PERSONA": dimensions.persona,
        "PRODUCT_RELATION": dimensions.product_relation,
    }


def _match_candidate_evidence(
    evidence_text: str,
    sources: dict[str, str],
) -> tuple[str, str] | None:
    evidence = _normalized_evidence_text(evidence_text)
    if not evidence:
        return None
    for source_name, source in sources.items():
        if evidence in _normalized_evidence_text(source):
            return source_name, evidence_text
    return None


def _evidence_exactly_supports_fact(
    evidence_text: str,
    fact_value: str,
) -> bool:
    evidence = normalize_creative_signature(evidence_text)
    fact = normalize_creative_signature(fact_value)
    if not evidence or not fact:
        return False
    return fact in evidence
