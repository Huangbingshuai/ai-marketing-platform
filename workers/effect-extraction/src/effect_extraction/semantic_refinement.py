from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from .models import (
    ExtractionCandidate,
    SemanticField,
    SemanticFieldSelection,
    SemanticGroup,
    SemanticPlacement,
    SemanticRelation,
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


class SemanticFactSource(StrEnum):
    USER_FACT = "USER_FACT"
    IMAGE_SUGGESTION = "IMAGE_SUGGESTION"


@dataclass(frozen=True, slots=True)
class SemanticRefinementResult:
    candidate: ExtractionCandidate
    metadata: dict[str, Any]


async def refine_candidate_semantics(
    candidate: ExtractionCandidate,
    *,
    provider: AiProvider,
    fact_sources: dict[str, dict[str, SemanticFactSource]] | None = None,
) -> SemanticRefinementResult:
    """Let the model resolve semantics while Worker enforces structure and authority."""

    refined = candidate.model_copy(deep=True)
    facts, facts_by_id = _facts(candidate, fact_sources=fact_sources or {})
    input_count = sum(
        len(getattr(candidate, attr) or []) for _, attr in SEMANTIC_FIELDS
    )
    _apply_values(refined, facts)
    if len(facts) < 2:
        return SemanticRefinementResult(
            candidate=refined,
            metadata=_metadata(input_count=input_count, output_count=len(facts)),
        )

    ai_call = await provider.refine_semantics(facts=facts)
    placements = _validated_placements(
        ai_call.value.placements,
        facts_by_id=facts_by_id,
    )
    groups = _validated_groups(
        ai_call.value.groups,
        placements=placements,
        facts_by_id=facts_by_id,
    )
    public_groups = _public_groups(groups, facts_by_id=facts_by_id)
    resolved_facts = _resolved_facts(
        facts,
        groups=groups,
        placements=placements,
        facts_by_id=facts_by_id,
    )
    selected_facts = _validated_selection(
        ai_call.value.selections,
        resolved_facts=resolved_facts,
        facts_by_id=facts_by_id,
    )
    _apply_values(refined, selected_facts, resolved_field_key="resolvedField")

    public_placements = [
        {
            "factId": placement.fact_id,
            "value": facts_by_id[placement.fact_id]["value"],
            "fromField": facts_by_id[placement.fact_id]["field"],
            "targetField": placement.target_field.value,
        }
        for placement in placements.values()
    ]
    return SemanticRefinementResult(
        candidate=refined,
        metadata=_metadata(
            input_count=input_count,
            output_count=len(selected_facts),
            groups=public_groups,
            placements=public_placements,
            dropped_for_limit_count=len(resolved_facts) - len(selected_facts),
            ai_call=ai_call.metadata.as_dict(),
        ),
    )


def _facts(
    candidate: ExtractionCandidate,
    *,
    fact_sources: dict[str, dict[str, SemanticFactSource]],
) -> tuple[list[dict[str, str]], dict[str, dict[str, str]]]:
    facts: list[dict[str, str]] = []
    for field, attr in SEMANTIC_FIELDS:
        seen: set[str] = set()
        field_index = 0
        for value in getattr(candidate, attr) or []:
            cleaned = re.sub(r"\s+", " ", value).strip()
            if not cleaned or cleaned in seen:
                continue
            seen.add(cleaned)
            field_index += 1
            source = fact_sources.get(field.value, {}).get(
                cleaned,
                SemanticFactSource.USER_FACT,
            )
            facts.append(
                {
                    "factId": f"{field.value}-{field_index:02d}",
                    "field": field.value,
                    "value": cleaned,
                    "sourceType": source.value,
                }
            )
    return facts, {row["factId"]: row for row in facts}


def _validated_placements(
    placements: list[SemanticPlacement],
    *,
    facts_by_id: dict[str, dict[str, str]],
) -> dict[str, SemanticPlacement]:
    accepted: dict[str, SemanticPlacement] = {}
    for placement in placements:
        row = facts_by_id.get(placement.fact_id)
        if row is None or placement.fact_id in accepted:
            raise ValueError("semantic placement references an invalid fact")
        if row["sourceType"] != SemanticFactSource.IMAGE_SUGGESTION.value:
            raise ValueError("semantic placement cannot move a user fact")
        if row["field"] == placement.target_field.value:
            raise ValueError("semantic placement must change the field")
        accepted[placement.fact_id] = placement
    return accepted


def _validated_groups(
    groups: list[SemanticGroup],
    *,
    placements: dict[str, SemanticPlacement],
    facts_by_id: dict[str, dict[str, str]],
) -> list[SemanticGroup]:
    used: set[str] = set()
    accepted: list[SemanticGroup] = []
    for group in groups:
        member_ids = list(dict.fromkeys(group.member_fact_ids))
        if len(member_ids) < 2 or any(
            member_id not in facts_by_id for member_id in member_ids
        ):
            raise ValueError("semantic group references an invalid fact")
        if used.intersection(member_ids):
            raise ValueError("semantic fact cannot belong to multiple groups")
        if group.representative_fact_id not in member_ids:
            raise ValueError("semantic representative must belong to its group")

        for member_id in member_ids:
            placement = placements.get(member_id)
            if placement is not None and placement.target_field != group.field:
                raise ValueError("semantic placement conflicts with group destination")
        representative = facts_by_id[group.representative_fact_id]
        if (
            representative["sourceType"] == SemanticFactSource.USER_FACT.value
            and representative["field"] != group.field.value
        ):
            raise ValueError("semantic group cannot move a user representative")
        if (
            representative["sourceType"] == SemanticFactSource.IMAGE_SUGGESTION.value
            and representative["field"] != group.field.value
            and placements.get(group.representative_fact_id) is None
        ):
            raise ValueError("semantic group must place a moved image representative")

        accepted.append(group.model_copy(update={"member_fact_ids": member_ids}))
        used.update(member_ids)
    return accepted


def _source_policy_allows(
    group: SemanticGroup,
    facts_by_id: dict[str, dict[str, str]],
) -> bool:
    """Apply model semantics only when source authority permits the deletion."""

    if group.relation == SemanticRelation.SAME_FAMILY:
        return False
    user_fact_ids = [
        fact_id
        for fact_id in group.member_fact_ids
        if facts_by_id[fact_id]["sourceType"] == SemanticFactSource.USER_FACT.value
    ]
    if not user_fact_ids:
        return True
    return (
        len(user_fact_ids) == 1
        and group.representative_fact_id == user_fact_ids[0]
        and facts_by_id[user_fact_ids[0]]["field"] == group.field.value
    )


def _resolved_facts(
    facts: list[dict[str, str]],
    *,
    groups: list[SemanticGroup],
    placements: dict[str, SemanticPlacement],
    facts_by_id: dict[str, dict[str, str]],
) -> list[dict[str, str]]:
    applied_groups = [
        group for group in groups if _source_policy_allows(group, facts_by_id)
    ]
    groups_by_member = {
        member_id: group
        for group in applied_groups
        for member_id in group.member_fact_ids
    }
    resolved: list[dict[str, str]] = []
    for fact in facts:
        fact_id = fact["factId"]
        group = groups_by_member.get(fact_id)
        if group is not None and fact_id != group.representative_fact_id:
            continue
        placement = placements.get(fact_id)
        target_field = (
            group.field.value
            if group is not None
            else placement.target_field.value
            if placement is not None
            else fact["field"]
        )
        resolved.append({**fact, "resolvedField": target_field})
    return resolved


def _validated_selection(
    selections: list[SemanticFieldSelection],
    *,
    resolved_facts: list[dict[str, str]],
    facts_by_id: dict[str, dict[str, str]],
) -> list[dict[str, str]]:
    selections_by_field: dict[SemanticField, SemanticFieldSelection] = {}
    for selection in selections:
        if selection.field in selections_by_field:
            raise ValueError("semantic field selection is duplicated")
        selections_by_field[selection.field] = selection

    available_by_field: dict[SemanticField, list[dict[str, str]]] = {}
    for fact in resolved_facts:
        field = SemanticField(fact["resolvedField"])
        available_by_field.setdefault(field, []).append(fact)
    if set(selections_by_field) != set(available_by_field):
        raise ValueError("semantic selections must cover every non-empty field")

    selected: list[dict[str, str]] = []
    for field, available in available_by_field.items():
        retained_ids = selections_by_field[field].retained_fact_ids
        if len(retained_ids) != len(set(retained_ids)):
            raise ValueError("semantic selection contains duplicate facts")
        available_by_id = {fact["factId"]: fact for fact in available}
        expected_count = min(SEMANTIC_FIELD_LIMITS[field], len(available))
        if len(retained_ids) != expected_count or any(
            fact_id not in available_by_id for fact_id in retained_ids
        ):
            raise ValueError("semantic selection has an invalid field count")
        required_user_ids = {
            fact["factId"]
            for fact in available
            if facts_by_id[fact["factId"]]["sourceType"]
            == SemanticFactSource.USER_FACT.value
        }
        if len(required_user_ids) <= expected_count:
            if not required_user_ids.issubset(retained_ids):
                raise ValueError("semantic selection cannot drop a user fact")
        elif any(fact_id not in required_user_ids for fact_id in retained_ids):
            raise ValueError(
                "semantic selection cannot prefer an image suggestion over user facts"
            )
        values = [available_by_id[fact_id]["value"] for fact_id in retained_ids]
        if len(values) != len(set(values)):
            raise ValueError("semantic selection contains exact duplicate values")
        selected.extend(available_by_id[fact_id] for fact_id in retained_ids)
    return selected


def _apply_values(
    candidate: ExtractionCandidate,
    facts: list[dict[str, str]],
    *,
    resolved_field_key: str = "field",
) -> None:
    for field, attr in SEMANTIC_FIELDS:
        values = [
            fact["value"] for fact in facts if fact[resolved_field_key] == field.value
        ]
        setattr(candidate, attr, values or None)


def _public_groups(
    groups: list[SemanticGroup],
    *,
    facts_by_id: dict[str, dict[str, str]],
) -> list[dict[str, Any]]:
    return [
        {
            "field": group.field.value,
            "canonicalValue": facts_by_id[group.representative_fact_id]["value"],
            "memberValues": [
                facts_by_id[fact_id]["value"] for fact_id in group.member_fact_ids
            ],
            "memberSourceTypes": [
                facts_by_id[fact_id]["sourceType"] for fact_id in group.member_fact_ids
            ],
            "memberFields": [
                facts_by_id[fact_id]["field"] for fact_id in group.member_fact_ids
            ],
            "relation": group.relation.value,
            "applied": _source_policy_allows(group, facts_by_id),
        }
        for group in groups
    ]


def _metadata(
    *,
    input_count: int,
    output_count: int,
    groups: list[dict[str, Any]] | None = None,
    placements: list[dict[str, Any]] | None = None,
    dropped_for_limit_count: int = 0,
    ai_call: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rows = groups or []
    placement_rows = placements or []
    applied_count = sum(row.get("applied") is True for row in rows)
    family_count = sum(
        row.get("relation") == SemanticRelation.SAME_FAMILY.value for row in rows
    )
    rejected_merge_count = sum(
        row.get("relation") != SemanticRelation.SAME_FAMILY.value
        and row.get("applied") is not True
        for row in rows
    )
    metadata: dict[str, Any] = {
        "inputCount": input_count,
        "outputCount": output_count,
        "mergedGroupCount": applied_count,
        "familyGroupCount": family_count,
        "rejectedMergeCount": rejected_merge_count,
        "decisionGroupCount": len(rows),
        "reclassifiedFactCount": len(placement_rows),
        "droppedForLimitCount": dropped_for_limit_count,
        "semanticGroups": rows,
        "semanticPlacements": placement_rows,
    }
    if ai_call is not None:
        metadata["aiCall"] = ai_call
    return metadata
