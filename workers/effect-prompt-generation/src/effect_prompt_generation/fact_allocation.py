from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence

from .models import (
    CreativeFactAssignment,
    InsightApplicationMap,
    InsightFact,
    InsightFactPolicy,
    InsightField,
)


_PRIMARY_FIELD_ORDER = (
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

_PRODUCT_SNAPSHOT_FIELDS = (
    InsightField.PRODUCT_NAME,
    InsightField.PRODUCT_CATEGORY,
    InsightField.CORE_SPECIFICATION,
    InsightField.VISUAL_FEATURES,
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
    preferred_focus_fact_ids: Sequence[str] = (),
) -> list[CreativeFactAssignment]:
    """Create one business focus and a small compatible fact set per task."""

    if count <= 0:
        return []
    usable = application.usable
    if not usable:
        raise ValueError("creative fact allocation requires usable insight facts")

    preferred = [
        application.by_id[fact_id]
        for fact_id in dict.fromkeys(preferred_focus_fact_ids)
        if fact_id in application.by_id
        and application.by_id[fact_id].policy
        in {InsightFactPolicy.REQUIRED, InsightFactPolicy.ADAPTIVE}
        and application.by_id[fact_id].field in _PRIMARY_FIELD_ORDER
    ]
    focus_candidates = preferred or _ordered_facts(
        usable,
        allowed_fields=set(_PRIMARY_FIELD_ORDER),
        field_order=_PRIMARY_FIELD_ORDER,
    )
    if not focus_candidates:
        focus_candidates = usable
    product_snapshot_facts = _ordered_facts(
        usable,
        allowed_fields=set(_PRODUCT_SNAPSHOT_FIELDS),
        field_order=_PRODUCT_SNAPSHOT_FIELDS,
    )

    assignments: list[CreativeFactAssignment] = []
    for offset in range(count):
        ordinal = ordinal_start + offset
        focus = focus_candidates[(ordinal - 1) % len(focus_candidates)]
        support_ids = _support_fact_ids(
            usable,
            primary=focus,
            ordinal=ordinal,
        )
        product_name_ids = [
            fact.fact_id
            for fact in product_snapshot_facts
            if fact.field == InsightField.PRODUCT_NAME
        ][:1]
        other_snapshot_ids = [
            fact.fact_id
            for fact in product_snapshot_facts
            if fact.field != InsightField.PRODUCT_NAME
        ]
        rotated_snapshot_ids = (
            other_snapshot_ids[(ordinal - 1) % len(other_snapshot_ids) :]
            + other_snapshot_ids[: (ordinal - 1) % len(other_snapshot_ids)]
            if other_snapshot_ids
            else []
        )
        allowed_ids = list(
            dict.fromkeys(
                [
                    focus.fact_id,
                    *support_ids,
                    *product_name_ids,
                    *rotated_snapshot_ids[:1],
                ]
            )
        )[:5]
        payload = {
            "ordinal": ordinal,
            "focusFactId": focus.fact_id,
            "allowedFactIds": allowed_ids,
        }
        assignments.append(
            CreativeFactAssignment(
                focus_fact_id=focus.fact_id,
                allowed_fact_ids=allowed_ids,
                assignment_hash=hashlib.sha256(
                    json.dumps(
                        payload,
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode("utf-8")
                ).hexdigest(),
            )
        )
    return assignments


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
