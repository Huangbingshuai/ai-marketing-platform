from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Callable

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
        issue for issue in evaluation.hard_issues if issue in evidence_metadata_codes
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
                item.scores.overall_quality * quality_weight + 100.0 * novelty_weight
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
    novelty_by_id = {
        item.candidate.slot_id: (
            fixed_novelty_resolver(item)
            if fixed_novelty_resolver is not None
            else 100.0
        )
        for item in remaining
    }
    while remaining and len(selected) < target_count:
        scored: list[RankedCreative] = []
        for item in remaining:
            novelty = novelty_by_id[item.candidate.slot_id]
            scored.append(
                RankedCreative(
                    candidate=item.candidate,
                    evaluation=item.evaluation,
                    quality_score=item.quality_score,
                    novelty_score=novelty,
                    selection_score=round(
                        item.quality_score * quality_weight + novelty * novelty_weight,
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
    return round(100.0 * (1.0 - max(semantic, visual)), 4)


def _normalized_evidence_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())
