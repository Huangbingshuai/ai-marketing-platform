from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .models import (
    ExtractionCandidate,
    SemanticField,
    SemanticGroup,
    SemanticRelation,
)
from .providers import AiProvider

SEMANTIC_FIELDS: tuple[tuple[SemanticField, str], ...] = (
    (SemanticField.CORE_PAIN_POINTS, "core_pain_points"),
    (SemanticField.DECISION_DRIVERS, "decision_drivers"),
    (SemanticField.USAGE_SCENARIOS, "usage_scenarios"),
    (SemanticField.PURCHASE_SCENARIOS, "purchase_scenarios"),
    (SemanticField.EMOTIONAL_SCENARIOS, "emotional_scenarios"),
)


@dataclass(frozen=True, slots=True)
class SemanticRefinementResult:
    candidate: ExtractionCandidate
    metadata: dict[str, Any]


async def refine_candidate_semantics(
    candidate: ExtractionCandidate,
    *,
    provider: AiProvider,
) -> SemanticRefinementResult:
    """Use one strict low-cost model call to classify the small fact set."""

    refined = candidate.model_copy(deep=True)
    facts, facts_by_id = _facts(candidate)
    input_count = sum(
        len(getattr(candidate, attr) or []) for _, attr in SEMANTIC_FIELDS
    )
    for field, attr in SEMANTIC_FIELDS:
        cleaned_values = [row["value"] for row in facts if row["field"] == field.value]
        setattr(refined, attr, cleaned_values or None)
    exact_output_count = len(facts)
    fields_with_pairs = {
        row["field"]
        for row in facts
        if sum(other["field"] == row["field"] for other in facts) > 1
    }
    if not fields_with_pairs:
        return SemanticRefinementResult(
            candidate=refined,
            metadata=_metadata(
                input_count=input_count, output_count=exact_output_count
            ),
        )

    ai_call = await provider.refine_semantics(facts=facts)
    groups = _validated_groups(
        ai_call.value.groups,
        facts_by_id=facts_by_id,
    )
    public_groups: list[dict[str, Any]] = []
    for field, attr in SEMANTIC_FIELDS:
        values = getattr(refined, attr) or []
        field_groups = [group for group in groups if group.field == field]
        applied_groups = [
            group
            for group in field_groups
            if group.relation != SemanticRelation.SAME_FAMILY
        ]
        setattr(refined, attr, _apply_groups(values, applied_groups, facts_by_id) or None)
        for group in field_groups:
            representative = facts_by_id[group.representative_fact_id]["value"]
            public_groups.append(
                {
                    "field": field.value,
                    "canonicalValue": representative,
                    "memberValues": [
                        facts_by_id[fact_id]["value"]
                        for fact_id in group.member_fact_ids
                    ],
                    "relation": group.relation.value,
                    "applied": group.relation != SemanticRelation.SAME_FAMILY,
                }
            )
    output_count = sum(len(getattr(refined, attr) or []) for _, attr in SEMANTIC_FIELDS)
    return SemanticRefinementResult(
        candidate=refined,
        metadata=_metadata(
            input_count=input_count,
            output_count=output_count,
            groups=public_groups,
            ai_call=ai_call.metadata.as_dict(),
        ),
    )


def _facts(
    candidate: ExtractionCandidate,
) -> tuple[list[dict[str, str]], dict[str, dict[str, str]]]:
    facts: list[dict[str, str]] = []
    for field, attr in SEMANTIC_FIELDS:
        seen: set[str] = set()
        for value in getattr(candidate, attr) or []:
            cleaned = re.sub(r"\s+", " ", value).strip()
            signature = re.sub(r"[\s，。；、,.!?！？：:（）()\-]+", "", cleaned).lower()
            if not cleaned or signature in seen:
                continue
            seen.add(signature)
            facts.append(
                {
                    "factId": f"{field.value}-{len([row for row in facts if row['field'] == field.value]) + 1:02d}",
                    "field": field.value,
                    "value": cleaned,
                }
            )
    return facts, {row["factId"]: row for row in facts}


def _validated_groups(
    groups: list[SemanticGroup],
    *,
    facts_by_id: dict[str, dict[str, str]],
) -> list[SemanticGroup]:
    used: set[str] = set()
    accepted: list[SemanticGroup] = []
    for group in groups:
        member_ids = list(dict.fromkeys(group.member_fact_ids))
        if len(member_ids) < 2 or any(
            member_id not in facts_by_id for member_id in member_ids
        ):
            continue
        if used.intersection(member_ids):
            continue
        if group.representative_fact_id not in member_ids:
            continue
        rows = [facts_by_id[member_id] for member_id in member_ids]
        if any(row["field"] != group.field.value for row in rows):
            continue
        accepted.append(
            group.model_copy(update={"member_fact_ids": member_ids})
        )
        used.update(member_ids)
    return accepted


def _apply_groups(
    values: list[str],
    groups: list[SemanticGroup],
    facts_by_id: dict[str, dict[str, str]],
) -> list[str]:
    replacements: dict[str, tuple[str, set[str]]] = {}
    for group in groups:
        members = {facts_by_id[fact_id]["value"] for fact_id in group.member_fact_ids}
        representative = facts_by_id[group.representative_fact_id]["value"]
        if representative in values:
            replacements[representative] = (representative, members)
    consumed: set[str] = set()
    output: list[str] = []
    for value in values:
        if value in consumed:
            continue
        replacement = replacements.get(value)
        if replacement is None:
            output.append(value)
            continue
        canonical, members = replacement
        output.append(canonical)
        consumed.update(members)
    return output


def _metadata(
    *,
    input_count: int,
    output_count: int,
    groups: list[dict[str, Any]] | None = None,
    ai_call: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rows = groups or []
    applied_count = sum(row.get("applied") is True for row in rows)
    family_count = sum(row.get("relation") == SemanticRelation.SAME_FAMILY.value for row in rows)
    metadata: dict[str, Any] = {
        "inputCount": input_count,
        "outputCount": output_count,
        "mergedGroupCount": applied_count,
        "familyGroupCount": family_count,
        "decisionGroupCount": len(rows),
        "semanticGroups": rows,
    }
    if ai_call is not None:
        metadata["aiCall"] = ai_call
    return metadata
