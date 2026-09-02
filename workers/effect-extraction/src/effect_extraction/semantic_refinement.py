from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from .models import (
    ExtractionCandidate,
    SemanticField,
    SemanticRefinementDecision,
    SemanticSuggestionDisposition,
    SemanticUserFactIssue,
)
from .providers import AiProvider

SEMANTIC_FIELDS: tuple[tuple[SemanticField, str], ...] = (
    (SemanticField.CORE_SELLING_POINTS, "core_selling_points"),
    (SemanticField.SECONDARY_SELLING_POINTS, "secondary_selling_points"),
    (SemanticField.CORE_PAIN_POINTS, "core_pain_points"),
    (SemanticField.DECISION_DRIVERS, "decision_drivers"),
    (SemanticField.USAGE_SCENARIOS, "usage_scenarios"),
    (SemanticField.PURCHASE_SCENARIOS, "purchase_scenarios"),
    (SemanticField.EMOTIONAL_SCENARIOS, "emotional_scenarios"),
)
SEMANTIC_REFERENCE_FIELDS = frozenset(
    {"productCategory", "productName", "coreSpecification", "visualFeatures"}
)
SEMANTIC_FIELD_LIMITS: dict[SemanticField, int] = {
    SemanticField.CORE_SELLING_POINTS: 3,
    SemanticField.SECONDARY_SELLING_POINTS: 6,
    SemanticField.CORE_PAIN_POINTS: 5,
    SemanticField.DECISION_DRIVERS: 5,
    SemanticField.USAGE_SCENARIOS: 5,
    SemanticField.PURCHASE_SCENARIOS: 5,
    SemanticField.EMOTIONAL_SCENARIOS: 5,
}
SEMANTIC_FIELD_LAYERS: dict[SemanticField, str] = {
    SemanticField.CORE_SELLING_POINTS: "SELLING_POINT",
    SemanticField.SECONDARY_SELLING_POINTS: "SELLING_POINT",
    SemanticField.CORE_PAIN_POINTS: "USER",
    SemanticField.DECISION_DRIVERS: "USER",
    SemanticField.USAGE_SCENARIOS: "SCENARIO",
    SemanticField.PURCHASE_SCENARIOS: "SCENARIO",
    SemanticField.EMOTIONAL_SCENARIOS: "SCENARIO",
}
MAX_USER_FACTS_PER_FIELD = 20


@dataclass(frozen=True, slots=True)
class SemanticRefinementResult:
    candidate: ExtractionCandidate
    metadata: dict[str, Any]


CorrectionCounts = Counter[str]


async def refine_candidate_semantics(
    candidate: ExtractionCandidate,
    *,
    provider: AiProvider,
    user_facts: Sequence[Mapping[str, str]],
    image_suggestions: Sequence[Mapping[str, str]],
    reference_facts: Sequence[Mapping[str, str]] = (),
) -> SemanticRefinementResult:
    """Apply model decisions only to image suggestions; user facts are immutable."""

    users = _validated_input_rows(user_facts, expected_source="USER_FACT")
    suggestions = _validated_input_rows(
        image_suggestions,
        expected_source="IMAGE_SUGGESTION",
    )
    references = _validated_reference_rows(reference_facts)
    all_ids = [row["factId"] for row in [*users, *suggestions, *references]]
    if len(all_ids) != len(set(all_ids)):
        raise ValueError("semantic fact ids must be unique")

    remaining_capacity = _remaining_capacity(users)
    structural_notices = _over_limit_notices(users)
    if not suggestions and len(users) < 2:
        refined = _candidate_with_facts(candidate, users, [])
        return SemanticRefinementResult(
            candidate=refined,
            metadata=_metadata(
                users=users,
                suggestions=suggestions,
                references=references,
                kept=[],
                notices=structural_notices,
            ),
        )

    ai_call = await provider.refine_semantics(
        user_facts=users,
        image_suggestions=suggestions,
        reference_facts=references,
        remaining_capacity_by_field={
            field.value: capacity for field, capacity in remaining_capacity.items()
        },
    )
    kept, decision_corrections = _safe_suggestion_decisions(
        ai_call.value,
        suggestions=suggestions,
        remaining_capacity=remaining_capacity,
    )
    model_notices, notice_corrections = _safe_user_notices(
        ai_call.value,
        users=users,
    )
    corrections = decision_corrections + notice_corrections
    notices = [*model_notices, *structural_notices]
    refined = _candidate_with_facts(candidate, users, kept)
    return SemanticRefinementResult(
        candidate=refined,
        metadata=_metadata(
            users=users,
            suggestions=suggestions,
            references=references,
            kept=kept,
            notices=notices,
            decisions=ai_call.value,
            ai_call=ai_call.metadata.as_dict(),
            corrections=corrections,
        ),
    )


def user_only_candidate(
    candidate: ExtractionCandidate,
    user_facts: Sequence[Mapping[str, str]],
) -> ExtractionCandidate:
    users = _validated_input_rows(user_facts, expected_source="USER_FACT")
    return _candidate_with_facts(candidate, users, [])


def semantic_fallback_metadata(
    *,
    user_facts: Sequence[Mapping[str, str]],
    image_suggestions: Sequence[Mapping[str, str]],
    reference_facts: Sequence[Mapping[str, str]] = (),
    failure: dict[str, Any],
) -> dict[str, Any]:
    users = _validated_input_rows(user_facts, expected_source="USER_FACT")
    suggestions = _validated_input_rows(
        image_suggestions,
        expected_source="IMAGE_SUGGESTION",
    )
    references = _validated_reference_rows(reference_facts)
    metadata = _metadata(
        users=users,
        suggestions=suggestions,
        references=references,
        kept=[],
        notices=_over_limit_notices(users),
        validation_status="NOT_VERIFIED",
    )
    metadata["failures"] = [failure]
    metadata["degraded"] = True
    return metadata


def _validated_input_rows(
    rows: Sequence[Mapping[str, str]],
    *,
    expected_source: str,
) -> list[dict[str, str]]:
    accepted: list[dict[str, str]] = []
    for row in rows:
        fact_id = str(row.get("factId", "")).strip()
        value = str(row.get("value", "")).strip()
        source_type = str(row.get("sourceType", "")).strip()
        field = SemanticField(str(row.get("field", "")))
        if not fact_id or not value or source_type != expected_source:
            raise ValueError("semantic input fact is invalid")
        accepted.append(
            {
                "factId": fact_id,
                "field": field.value,
                "value": value,
                "sourceType": source_type,
            }
        )
    if len(accepted) != len({row["factId"] for row in accepted}):
        raise ValueError("semantic input contains duplicate fact ids")
    return accepted


def _validated_reference_rows(
    rows: Sequence[Mapping[str, str]],
) -> list[dict[str, str]]:
    accepted: list[dict[str, str]] = []
    for row in rows:
        fact_id = str(row.get("factId", "")).strip()
        value = str(row.get("value", "")).strip()
        source_type = str(row.get("sourceType", "")).strip()
        field = str(row.get("field", "")).strip()
        if (
            not fact_id
            or not value
            or source_type != "USER_REFERENCE"
            or field not in SEMANTIC_REFERENCE_FIELDS
        ):
            raise ValueError("semantic reference fact is invalid")
        accepted.append(
            {
                "factId": fact_id,
                "field": field,
                "value": value,
                "sourceType": source_type,
            }
        )
    if len(accepted) != len({row["factId"] for row in accepted}):
        raise ValueError("semantic reference facts contain duplicate ids")
    return accepted


def _remaining_capacity(
    users: Sequence[Mapping[str, str]],
) -> dict[SemanticField, int]:
    counts = {field: 0 for field, _ in SEMANTIC_FIELDS}
    for row in users:
        counts[SemanticField(row["field"])] += 1
    return {
        field: max(0, SEMANTIC_FIELD_LIMITS[field] - counts[field])
        for field, _ in SEMANTIC_FIELDS
    }


def _safe_suggestion_decisions(
    decision: SemanticRefinementDecision,
    *,
    suggestions: Sequence[Mapping[str, str]],
    remaining_capacity: Mapping[SemanticField, int],
) -> tuple[list[dict[str, str]], CorrectionCounts]:
    suggestions_by_id = {row["factId"]: dict(row) for row in suggestions}
    corrections: CorrectionCounts = Counter()
    seen: set[str] = set()
    kept: list[dict[str, str]] = []
    kept_counts = {field: 0 for field, _ in SEMANTIC_FIELDS}
    for row in decision.suggestion_decisions:
        original = suggestions_by_id.get(row.fact_id)
        if original is None:
            corrections["UNKNOWN_SUGGESTION_ID"] += 1
            continue
        if row.fact_id in seen:
            corrections["DUPLICATE_SUGGESTION_DECISION"] += 1
            continue
        seen.add(row.fact_id)
        if row.disposition == SemanticSuggestionDisposition.DROP:
            if row.target_field is not None:
                corrections["DROP_TARGET_IGNORED"] += 1
            continue
        if row.target_field is None:
            corrections["KEEP_TARGET_MISSING"] += 1
            continue
        kept_counts[row.target_field] += 1
        if kept_counts[row.target_field] > remaining_capacity[row.target_field]:
            corrections["FIELD_CAPACITY_EXCEEDED"] += 1
            continue
        kept.append({**original, "resolvedField": row.target_field.value})
    missing_count = len(suggestions_by_id) - len(seen)
    if missing_count > 0:
        corrections["MISSING_SUGGESTION_DECISION"] += missing_count
    return kept, corrections


def _safe_user_notices(
    decision: SemanticRefinementDecision,
    *,
    users: Sequence[Mapping[str, str]],
) -> tuple[list[dict[str, Any]], CorrectionCounts]:
    users_by_id = {row["factId"]: dict(row) for row in users}
    seen: set[tuple[str, SemanticUserFactIssue]] = set()
    notices: list[dict[str, Any]] = []
    corrections: CorrectionCounts = Counter()
    for notice in decision.user_fact_notices:
        fact = users_by_id.get(notice.fact_id)
        key = (notice.fact_id, notice.issue)
        if fact is None:
            corrections["UNKNOWN_USER_NOTICE_FACT"] += 1
            continue
        if key in seen:
            corrections["DUPLICATE_USER_NOTICE"] += 1
            continue
        if notice.issue == SemanticUserFactIssue.FIELD_OVER_RECOMMENDED_COUNT:
            corrections["MODEL_CAPACITY_NOTICE_IGNORED"] += 1
            continue
        related_ids = list(dict.fromkeys(notice.related_fact_ids))
        if notice.fact_id in related_ids or any(
            related_id not in users_by_id for related_id in related_ids
        ):
            corrections["INVALID_RELATED_USER_FACT"] += 1
            continue
        fact_field = SemanticField(fact["field"])
        if any(
            SEMANTIC_FIELD_LAYERS[SemanticField(users_by_id[related_id]["field"])]
            != SEMANTIC_FIELD_LAYERS[fact_field]
            for related_id in related_ids
        ):
            corrections["CROSS_LAYER_USER_NOTICE"] += 1
            continue
        if (
            notice.issue
            in {
                SemanticUserFactIssue.POSSIBLE_DUPLICATE,
                SemanticUserFactIssue.POSSIBLE_OVERLAP,
            }
            and not related_ids
        ):
            corrections["INVALID_RELATED_USER_FACT"] += 1
            continue
        if notice.issue == SemanticUserFactIssue.POSSIBLE_WRONG_FIELD:
            if notice.suggested_field is None or notice.suggested_field == fact_field:
                corrections["INVALID_SUGGESTED_FIELD"] += 1
                continue
            if (
                SEMANTIC_FIELD_LAYERS[notice.suggested_field]
                != SEMANTIC_FIELD_LAYERS[fact_field]
            ):
                corrections["CROSS_LAYER_USER_NOTICE"] += 1
                continue
        elif notice.suggested_field is not None:
            corrections["UNEXPECTED_SUGGESTED_FIELD"] += 1
            continue
        notices.append(
            {
                "factId": notice.fact_id,
                "field": fact["field"],
                "value": fact["value"],
                "issue": notice.issue.value,
                "relatedFactIds": related_ids,
                "relatedValues": [users_by_id[item]["value"] for item in related_ids],
                "suggestedField": (
                    notice.suggested_field.value
                    if notice.suggested_field is not None
                    else None
                ),
            }
        )
        seen.add(key)
    return notices, corrections


def _over_limit_notices(
    users: Sequence[Mapping[str, str]],
) -> list[dict[str, Any]]:
    by_field: dict[SemanticField, list[Mapping[str, str]]] = {}
    for row in users:
        by_field.setdefault(SemanticField(row["field"]), []).append(row)
    notices: list[dict[str, Any]] = []
    for field, rows in by_field.items():
        if len(rows) <= SEMANTIC_FIELD_LIMITS[field]:
            continue
        first = rows[0]
        notices.append(
            {
                "factId": first["factId"],
                "field": field.value,
                "value": first["value"],
                "issue": SemanticUserFactIssue.FIELD_OVER_RECOMMENDED_COUNT.value,
                "relatedFactIds": [],
                "relatedValues": [],
                "suggestedField": None,
                "actualCount": len(rows),
                "recommendedCount": SEMANTIC_FIELD_LIMITS[field],
            }
        )
    return notices


def _candidate_with_facts(
    candidate: ExtractionCandidate,
    users: Sequence[Mapping[str, str]],
    kept_suggestions: Sequence[Mapping[str, str]],
) -> ExtractionCandidate:
    refined = candidate.model_copy(deep=True)
    for field, attr in SEMANTIC_FIELDS:
        user_values = [row["value"] for row in users if row["field"] == field.value]
        image_values = [
            row["value"]
            for row in kept_suggestions
            if row.get("resolvedField") == field.value
        ]
        values = [*user_values, *image_values]
        setattr(refined, attr, values or None)
    return refined


def _metadata(
    *,
    users: Sequence[Mapping[str, str]],
    suggestions: Sequence[Mapping[str, str]],
    references: Sequence[Mapping[str, str]],
    kept: Sequence[Mapping[str, str]],
    notices: Sequence[Mapping[str, Any]],
    decisions: SemanticRefinementDecision | None = None,
    ai_call: dict[str, Any] | None = None,
    corrections: Mapping[str, int] | None = None,
    validation_status: str | None = None,
) -> dict[str, Any]:
    original_fields = {row["factId"]: row["field"] for row in suggestions}
    moved_count = sum(
        original_fields[row["factId"]] != row.get("resolvedField") for row in kept
    )
    metadata: dict[str, Any] = {
        "inputCount": len(users) + len(suggestions),
        "outputCount": len(users) + len(kept),
        "userFactCount": len(users),
        "referenceFactCount": len(references),
        "userNoticeCount": len(notices),
        "imageSuggestionInputCount": len(suggestions),
        "imageSuggestionKeptCount": len(kept),
        "imageSuggestionMovedCount": moved_count,
        "imageSuggestionDroppedCount": len(suggestions) - len(kept),
        "userFactNotices": list(notices),
    }
    if decisions is not None:
        metadata["semanticDecisionCount"] = len(decisions.suggestion_decisions)
    if ai_call is not None:
        metadata["aiCall"] = ai_call
    correction_counts = {
        code: int(count)
        for code, count in sorted((corrections or {}).items())
        if count > 0
    }
    metadata["validation"] = {
        "status": validation_status
        or ("CORRECTED" if correction_counts else "VERIFIED"),
        "correctionCount": sum(correction_counts.values()),
        "correctionCodes": list(correction_counts),
        "correctionCounts": correction_counts,
    }
    return metadata
