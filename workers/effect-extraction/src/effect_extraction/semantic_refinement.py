from __future__ import annotations

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
SEMANTIC_FIELD_LIMITS: dict[SemanticField, int] = {
    SemanticField.CORE_SELLING_POINTS: 3,
    SemanticField.SECONDARY_SELLING_POINTS: 6,
    SemanticField.CORE_PAIN_POINTS: 5,
    SemanticField.DECISION_DRIVERS: 5,
    SemanticField.USAGE_SCENARIOS: 5,
    SemanticField.PURCHASE_SCENARIOS: 5,
    SemanticField.EMOTIONAL_SCENARIOS: 5,
}
MAX_USER_FACTS_PER_FIELD = 20


@dataclass(frozen=True, slots=True)
class SemanticRefinementResult:
    candidate: ExtractionCandidate
    metadata: dict[str, Any]


async def refine_candidate_semantics(
    candidate: ExtractionCandidate,
    *,
    provider: AiProvider,
    user_facts: Sequence[Mapping[str, str]],
    image_suggestions: Sequence[Mapping[str, str]],
) -> SemanticRefinementResult:
    """Apply model decisions only to image suggestions; user facts are immutable."""

    users = _validated_input_rows(user_facts, expected_source="USER_FACT")
    suggestions = _validated_input_rows(
        image_suggestions,
        expected_source="IMAGE_SUGGESTION",
    )
    all_ids = [row["factId"] for row in [*users, *suggestions]]
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
                kept=[],
                notices=structural_notices,
            ),
        )

    ai_call = await provider.refine_semantics(
        user_facts=users,
        image_suggestions=suggestions,
        remaining_capacity_by_field={
            field.value: capacity for field, capacity in remaining_capacity.items()
        },
    )
    kept = _validated_suggestion_decisions(
        ai_call.value,
        suggestions=suggestions,
        remaining_capacity=remaining_capacity,
    )
    model_notices = _validated_user_notices(ai_call.value, users=users)
    notices = [*model_notices, *structural_notices]
    refined = _candidate_with_facts(candidate, users, kept)
    return SemanticRefinementResult(
        candidate=refined,
        metadata=_metadata(
            users=users,
            suggestions=suggestions,
            kept=kept,
            notices=notices,
            decisions=ai_call.value,
            ai_call=ai_call.metadata.as_dict(),
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
    failure: dict[str, Any],
) -> dict[str, Any]:
    users = _validated_input_rows(user_facts, expected_source="USER_FACT")
    suggestions = _validated_input_rows(
        image_suggestions,
        expected_source="IMAGE_SUGGESTION",
    )
    metadata = _metadata(
        users=users,
        suggestions=suggestions,
        kept=[],
        notices=_over_limit_notices(users),
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


def _validated_suggestion_decisions(
    decision: SemanticRefinementDecision,
    *,
    suggestions: Sequence[Mapping[str, str]],
    remaining_capacity: Mapping[SemanticField, int],
) -> list[dict[str, str]]:
    suggestions_by_id = {row["factId"]: dict(row) for row in suggestions}
    decision_ids = [row.fact_id for row in decision.suggestion_decisions]
    if len(decision_ids) != len(set(decision_ids)):
        raise ValueError("semantic suggestion decision is duplicated")
    if set(decision_ids) != set(suggestions_by_id):
        raise ValueError("semantic decisions must cover every image suggestion")

    kept: list[dict[str, str]] = []
    kept_counts = {field: 0 for field, _ in SEMANTIC_FIELDS}
    for row in decision.suggestion_decisions:
        original = suggestions_by_id[row.fact_id]
        if row.disposition == SemanticSuggestionDisposition.DROP:
            if row.target_field is not None:
                raise ValueError("dropped image suggestion cannot have a target field")
            continue
        if row.target_field is None:
            raise ValueError("kept image suggestion requires a target field")
        kept_counts[row.target_field] += 1
        if kept_counts[row.target_field] > remaining_capacity[row.target_field]:
            raise ValueError("semantic decisions exceed the remaining field capacity")
        kept.append({**original, "resolvedField": row.target_field.value})
    return kept


def _validated_user_notices(
    decision: SemanticRefinementDecision,
    *,
    users: Sequence[Mapping[str, str]],
) -> list[dict[str, Any]]:
    users_by_id = {row["factId"]: dict(row) for row in users}
    seen: set[tuple[str, SemanticUserFactIssue]] = set()
    notices: list[dict[str, Any]] = []
    for notice in decision.user_fact_notices:
        fact = users_by_id.get(notice.fact_id)
        key = (notice.fact_id, notice.issue)
        if fact is None or key in seen:
            raise ValueError("semantic notice references an invalid user fact")
        if notice.issue == SemanticUserFactIssue.FIELD_OVER_RECOMMENDED_COUNT:
            raise ValueError("field capacity notices are generated structurally")
        related_ids = list(dict.fromkeys(notice.related_fact_ids))
        if notice.fact_id in related_ids or any(
            related_id not in users_by_id for related_id in related_ids
        ):
            raise ValueError("semantic notice has invalid related user facts")
        if notice.issue == SemanticUserFactIssue.POSSIBLE_WRONG_FIELD:
            if (
                notice.suggested_field is None
                or notice.suggested_field.value == fact["field"]
            ):
                raise ValueError("wrong-field notice requires a different field")
        elif notice.suggested_field is not None:
            raise ValueError("only wrong-field notices may suggest another field")
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
    return notices


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
    kept: Sequence[Mapping[str, str]],
    notices: Sequence[Mapping[str, Any]],
    decisions: SemanticRefinementDecision | None = None,
    ai_call: dict[str, Any] | None = None,
) -> dict[str, Any]:
    original_fields = {row["factId"]: row["field"] for row in suggestions}
    moved_count = sum(
        original_fields[row["factId"]] != row.get("resolvedField") for row in kept
    )
    metadata: dict[str, Any] = {
        "inputCount": len(users) + len(suggestions),
        "outputCount": len(users) + len(kept),
        "userFactCount": len(users),
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
    return metadata
