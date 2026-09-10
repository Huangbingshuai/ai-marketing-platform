from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence

from .models import (
    CreativeDirection,
    CreativeFactAssignment,
    InsightApplicationMap,
    InsightFact,
    InsightFactPolicy,
    InsightField,
)

_PRIMARY_FIELD_ORDER = (
    InsightField.SELLING_POINT,
    InsightField.CORE_SELLING_POINT,
    InsightField.CORE_PAIN_POINT,
    InsightField.TARGET_AUDIENCE,
    InsightField.DECISION_DRIVER,
    InsightField.USAGE_SCENARIO,
    InsightField.PURCHASE_SCENARIO,
    InsightField.EMOTIONAL_SCENARIO,
    InsightField.SECONDARY_SELLING_POINT,
    InsightField.MARKETING_GOAL,
)

_SUPPORT_FIELDS: dict[InsightField, tuple[InsightField, ...]] = {
    InsightField.CORE_SELLING_POINT: (
        InsightField.USAGE_SCENARIO,
        InsightField.TARGET_AUDIENCE,
        InsightField.DECISION_DRIVER,
        InsightField.EMOTIONAL_SCENARIO,
    ),
    InsightField.SECONDARY_SELLING_POINT: (
        InsightField.USAGE_SCENARIO,
        InsightField.TARGET_AUDIENCE,
        InsightField.EMOTIONAL_SCENARIO,
        InsightField.DECISION_DRIVER,
    ),
    InsightField.VISUAL_FEATURES: (
        InsightField.USAGE_SCENARIO,
        InsightField.TARGET_AUDIENCE,
        InsightField.EMOTIONAL_SCENARIO,
        InsightField.DECISION_DRIVER,
    ),
    InsightField.CORE_SPECIFICATION: (
        InsightField.USAGE_SCENARIO,
        InsightField.PURCHASE_SCENARIO,
        InsightField.TARGET_AUDIENCE,
    ),
    InsightField.CORE_PAIN_POINT: (
        InsightField.DECISION_DRIVER,
        InsightField.USAGE_SCENARIO,
        InsightField.PURCHASE_SCENARIO,
        InsightField.TARGET_AUDIENCE,
    ),
    InsightField.DECISION_DRIVER: (
        InsightField.CORE_PAIN_POINT,
        InsightField.USAGE_SCENARIO,
        InsightField.PURCHASE_SCENARIO,
        InsightField.TARGET_AUDIENCE,
    ),
    InsightField.USAGE_SCENARIO: (
        InsightField.TARGET_AUDIENCE,
        InsightField.EMOTIONAL_SCENARIO,
        InsightField.DECISION_DRIVER,
    ),
    InsightField.PURCHASE_SCENARIO: (
        InsightField.TARGET_AUDIENCE,
        InsightField.EMOTIONAL_SCENARIO,
        InsightField.DECISION_DRIVER,
    ),
    InsightField.TARGET_AUDIENCE: (
        InsightField.USAGE_SCENARIO,
        InsightField.PURCHASE_SCENARIO,
        InsightField.CORE_PAIN_POINT,
        InsightField.DECISION_DRIVER,
    ),
    InsightField.EMOTIONAL_SCENARIO: (
        InsightField.TARGET_AUDIENCE,
        InsightField.USAGE_SCENARIO,
        InsightField.DECISION_DRIVER,
    ),
    InsightField.MARKETING_GOAL: (
        InsightField.DECISION_DRIVER,
        InsightField.PURCHASE_SCENARIO,
        InsightField.TARGET_AUDIENCE,
    ),
}


def allocate_creative_facts(
    application: InsightApplicationMap,
    *,
    count: int,
    ordinal_start: int,
    preferred_fact_ids: Sequence[str] = (),
) -> list[CreativeFactAssignment]:
    """Build a compact fact bundle for item operations without a batch direction."""

    if count <= 0:
        return []
    usable = application.usable
    if not usable:
        raise ValueError("creative fact allocation requires usable insight facts")

    preferred = [
        application.by_id[fact_id]
        for fact_id in dict.fromkeys(preferred_fact_ids)
        if fact_id in application.by_id
        and application.by_id[fact_id].policy
        in {InsightFactPolicy.REQUIRED, InsightFactPolicy.ADAPTIVE}
        and application.by_id[fact_id].field in _PRIMARY_FIELD_ORDER
    ]
    business_facts = _ordered_facts(
        usable,
        allowed_fields=set(_PRIMARY_FIELD_ORDER),
        field_order=_PRIMARY_FIELD_ORDER,
    )
    candidates = preferred or business_facts or usable

    assignments: list[CreativeFactAssignment] = []
    for offset in range(count):
        ordinal = ordinal_start + offset
        anchor = candidates[(ordinal - 1) % len(candidates)]
        support_ids = _support_fact_ids(
            usable,
            primary=anchor,
            ordinal=ordinal,
        )
        remaining_business_ids = [
            fact.fact_id for fact in business_facts if fact.fact_id != anchor.fact_id
        ]
        rotated_business_ids = (
            remaining_business_ids[(ordinal - 1) % len(remaining_business_ids) :]
            + remaining_business_ids[: (ordinal - 1) % len(remaining_business_ids)]
            if remaining_business_ids
            else []
        )
        fact_ids = list(
            dict.fromkeys(
                [
                    anchor.fact_id,
                    *support_ids,
                    *rotated_business_ids,
                ]
            )
        )[: min(4, max(1, len(business_facts)))]
        assignments.append(_assignment(fact_ids, ordinal=ordinal))
    return assignments


def allocate_regeneration_facts(
    application: InsightApplicationMap,
    *,
    count: int,
    ordinal_start: int,
    original_fact_ids: Sequence[str],
    preserve_product_relation: bool,
) -> list[CreativeFactAssignment]:
    """Reuse verified facts by default; only rotate facts for an explicit fresh creative."""

    verified_original = [
        fact_id
        for fact_id in dict.fromkeys(original_fact_ids)
        if fact_id in application.by_id
        and application.by_id[fact_id].policy
        in {InsightFactPolicy.REQUIRED, InsightFactPolicy.ADAPTIVE}
    ][:4]
    if preserve_product_relation and verified_original:
        return [
            _assignment(verified_original, ordinal=ordinal_start + offset)
            for offset in range(count)
        ]
    return allocate_creative_facts(
        application,
        count=count,
        ordinal_start=ordinal_start,
        preferred_fact_ids=(),
    )


def allocate_automatic_regeneration_facts(
    application: InsightApplicationMap,
    *,
    ordinal_start: int,
    original_fact_ids: Sequence[str],
) -> list[CreativeFactAssignment]:
    """Give the three automatic options stable, intentionally different fact scopes.

    The first and third candidates keep the verified fact bundle so changing the
    presentation or following a narrow user note cannot silently change the
    product message. The middle candidate rotates to another confirmed anchor
    when the information card has one. Creative meaning remains model-owned;
    this helper only assigns verified IDs.
    """

    preserved_first = allocate_regeneration_facts(
        application,
        count=1,
        ordinal_start=ordinal_start,
        original_fact_ids=original_fact_ids,
        preserve_product_relation=True,
    )[0]
    preserved_feedback = allocate_regeneration_facts(
        application,
        count=1,
        ordinal_start=ordinal_start + 2,
        original_fact_ids=original_fact_ids,
        preserve_product_relation=True,
    )[0]
    original_set = set(preserved_first.fact_ids)
    alternatives = allocate_creative_facts(
        application,
        count=max(3, len(application.usable)),
        ordinal_start=ordinal_start + 1,
        preferred_fact_ids=(),
    )
    changed = next(
        (
            assignment
            for assignment in alternatives
            if assignment.fact_ids[0] not in original_set
            or set(assignment.fact_ids) != original_set
        ),
        alternatives[0],
    )
    return [preserved_first, changed, preserved_feedback]


def assignment_for_direction(
    direction: CreativeDirection,
    *,
    ordinal: int,
) -> CreativeFactAssignment:
    """Inherit the model-planned fact bundle without Worker re-allocation."""

    return _assignment(direction.fact_ids, ordinal=ordinal)


def _assignment(
    fact_ids: Sequence[str],
    *,
    ordinal: int,
) -> CreativeFactAssignment:
    normalized = list(dict.fromkeys(fact_ids))
    if not normalized:
        raise ValueError("creative fact assignment requires at least one fact")
    payload = {"ordinal": ordinal, "factIds": normalized}
    return CreativeFactAssignment(
        fact_ids=normalized,
        assignment_hash=hashlib.sha256(
            json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest(),
    )


def _ordered_facts(
    facts: Sequence[InsightFact],
    *,
    allowed_fields: set[InsightField],
    field_order: Sequence[InsightField],
) -> list[InsightFact]:
    field_rank = {field: index for index, field in enumerate(field_order)}
    source_rank = {fact.fact_id: index for index, fact in enumerate(facts)}
    selected = [fact for fact in facts if fact.field in allowed_fields]
    return sorted(
        selected,
        key=lambda fact: (
            0 if fact.policy == InsightFactPolicy.REQUIRED else 1,
            field_rank.get(fact.field, len(field_rank)),
            source_rank[fact.fact_id],
        ),
    )


def _support_fact_ids(
    facts: Sequence[InsightFact],
    *,
    primary: InsightFact,
    ordinal: int,
) -> list[str]:
    allowed = _SUPPORT_FIELDS.get(
        primary.field,
        (
            InsightField.USAGE_SCENARIO,
            InsightField.TARGET_AUDIENCE,
            InsightField.EMOTIONAL_SCENARIO,
            InsightField.DECISION_DRIVER,
        ),
    )
    candidates = _ordered_facts(
        facts,
        allowed_fields=set(allowed),
        field_order=allowed,
    )
    candidates = [fact for fact in candidates if fact.fact_id != primary.fact_id]
    if not candidates:
        return []
    start = (ordinal - 1) % len(candidates)
    rotated = [*candidates[start:], *candidates[:start]]
    selected: list[str] = []
    selected_fields: set[InsightField] = set()
    for fact in rotated:
        if fact.field in selected_fields:
            continue
        selected.append(fact.fact_id)
        selected_fields.add(fact.field)
        if len(selected) == 2:
            break
    return selected
