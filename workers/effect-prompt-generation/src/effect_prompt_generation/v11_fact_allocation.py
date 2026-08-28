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
    InsightField.DECISION_DRIVER,
    InsightField.VISUAL_FEATURES,
    InsightField.USAGE_SCENARIO,
    InsightField.PURCHASE_SCENARIO,
    InsightField.SECONDARY_SELLING_POINT,
    InsightField.CORE_SPECIFICATION,
)

_PRODUCT_ANCHOR_FIELDS = {
    InsightField.PRODUCT_NAME,
    InsightField.PRODUCT_CATEGORY,
    InsightField.CORE_SPECIFICATION,
    InsightField.VISUAL_FEATURES,
    InsightField.CORE_SELLING_POINT,
    InsightField.SECONDARY_SELLING_POINT,
}

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
}


def allocate_v11_creative_facts(
    application: InsightApplicationMap,
    *,
    count: int,
    ordinal_start: int,
    preferred_primary_fact_ids: Sequence[str] = (),
) -> list[CreativeFactAssignment]:
    """Create stable, small fact briefs without reinterpreting upstream content."""

    if count <= 0:
        return []
    usable = application.usable
    if not usable:
        raise ValueError("creative fact allocation requires usable insight facts")

    preferred = [
        application.by_id[fact_id]
        for fact_id in dict.fromkeys(preferred_primary_fact_ids)
        if fact_id in application.by_id
        and application.by_id[fact_id].policy
        in {InsightFactPolicy.REQUIRED, InsightFactPolicy.ADAPTIVE}
    ]
    primary_candidates = preferred or _ordered_facts(
        usable,
        allowed_fields=set(_PRIMARY_FIELD_ORDER),
        field_order=_PRIMARY_FIELD_ORDER,
    )
    anchors = _ordered_facts(
        usable,
        allowed_fields=_PRODUCT_ANCHOR_FIELDS,
        field_order=(
            InsightField.PRODUCT_NAME,
            InsightField.VISUAL_FEATURES,
            InsightField.CORE_SPECIFICATION,
            InsightField.PRODUCT_CATEGORY,
            InsightField.CORE_SELLING_POINT,
            InsightField.SECONDARY_SELLING_POINT,
        ),
    )
    if not primary_candidates:
        primary_candidates = anchors or usable
    if not anchors:
        anchors = primary_candidates

    product_name = next(
        (fact for fact in anchors if fact.field == InsightField.PRODUCT_NAME),
        None,
    )
    assignments: list[CreativeFactAssignment] = []
    for offset in range(count):
        ordinal = ordinal_start + offset
        primary = primary_candidates[(ordinal - 1) % len(primary_candidates)]
        support_ids = _support_fact_ids(
            usable,
            primary=primary,
            ordinal=ordinal,
        )
        anchor_ids = _anchor_fact_ids(
            anchors,
            primary=primary,
            product_name=product_name,
            ordinal=ordinal,
        )
        payload = {
            "ordinal": ordinal,
            "primaryFactId": primary.fact_id,
            "supportFactIds": support_ids,
            "productAnchorFactIds": anchor_ids,
        }
        assignments.append(
            CreativeFactAssignment(
                primary_fact_id=primary.fact_id,
                support_fact_ids=support_ids,
                product_anchor_fact_ids=anchor_ids,
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


def _anchor_fact_ids(
    anchors: Sequence[InsightFact],
    *,
    primary: InsightFact,
    product_name: InsightFact | None,
    ordinal: int,
) -> list[str]:
    selected: list[str] = []
    if product_name is not None:
        selected.append(product_name.fact_id)
    if primary.field in _PRODUCT_ANCHOR_FIELDS:
        selected.append(primary.fact_id)
    else:
        non_name = [
            fact
            for fact in anchors
            if product_name is None or fact.fact_id != product_name.fact_id
        ]
        if non_name:
            selected.append(non_name[(ordinal - 1) % len(non_name)].fact_id)
    if not selected:
        selected.append(primary.fact_id)
    return list(dict.fromkeys(selected))[:2]
