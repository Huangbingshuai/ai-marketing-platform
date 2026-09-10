from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from typing import Any, Literal

from .models import (
    ExcludedInsight,
    FragmentType,
    InsightApplicationMap,
    InsightBinding,
    InsightBindingRole,
    InsightCoverage,
    InsightFact,
    InsightFactPolicy,
    InsightField,
    InsightReference,
    PromptItem,
)

_ELIGIBLE: dict[InsightField, tuple[FragmentType, ...]] = {
    InsightField.SELLING_POINT: tuple(FragmentType),
    InsightField.PRODUCT_NAME: (
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.EFFECT,
        FragmentType.CTA,
    ),
    InsightField.PRODUCT_CATEGORY: (
        FragmentType.HOOK,
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.CTA,
    ),
    InsightField.CORE_SPECIFICATION: (
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.EFFECT,
    ),
    InsightField.PRICE_RANGE: (FragmentType.CTA,),
    InsightField.VISUAL_FEATURES: (
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.CTA,
    ),
    InsightField.CORE_SELLING_POINT: (
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.EFFECT,
        FragmentType.CTA,
    ),
    InsightField.SECONDARY_SELLING_POINT: (FragmentType.EFFECT,),
    InsightField.TRUST_BACKING: (FragmentType.EFFECT,),
    InsightField.TARGET_AUDIENCE: (
        FragmentType.HOOK,
        FragmentType.CTA,
    ),
    InsightField.CORE_PAIN_POINT: (FragmentType.HOOK, FragmentType.EFFECT),
    InsightField.DECISION_DRIVER: (
        FragmentType.HOOK,
        FragmentType.EFFECT,
        FragmentType.CTA,
    ),
    InsightField.MARKETING_GOAL: (FragmentType.CTA,),
    InsightField.USAGE_SCENARIO: (
        FragmentType.HOOK,
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.EFFECT,
    ),
    InsightField.PURCHASE_SCENARIO: (
        FragmentType.HOOK,
        FragmentType.CTA,
    ),
    InsightField.EMOTIONAL_SCENARIO: (FragmentType.HOOK, FragmentType.CTA),
}

_PRIMARY_FIELDS = {
    InsightField.SELLING_POINT,
    InsightField.PRODUCT_NAME,
    InsightField.PRODUCT_CATEGORY,
    InsightField.CORE_SELLING_POINT,
    InsightField.CORE_PAIN_POINT,
    InsightField.MARKETING_GOAL,
    InsightField.PRICE_RANGE,
}
_EVIDENCE_FIELDS = {InsightField.TRUST_BACKING}

# These are the business facts that make a Prompt materially use the upstream
# insight card. Product identity/specification alone is not deep coverage.
MANDATORY_BUSINESS_FIELDS = {
    InsightField.SELLING_POINT,
    InsightField.CORE_SELLING_POINT,
}


def map_insight(payload: Mapping[str, Any]) -> InsightApplicationMap:
    required: list[InsightFact] = []
    adaptive: list[InsightFact] = []
    excluded: list[InsightFact] = []
    constraints: list[InsightFact] = []

    def add_value(
        field: InsightField,
        raw: object,
        policy: InsightFactPolicy,
    ) -> InsightFact | None:
        value = _clean_value(raw)
        if not value:
            return None
        fact = _fact(field, value, policy)
        {
            InsightFactPolicy.REQUIRED: required,
            InsightFactPolicy.ADAPTIVE: adaptive,
            InsightFactPolicy.CONSTRAINT: constraints,
        }[policy].append(fact)
        return fact

    add_value(
        InsightField.PRODUCT_NAME,
        _first(payload, "productName", "product_name"),
        InsightFactPolicy.REQUIRED,
    )
    add_value(
        InsightField.PRODUCT_CATEGORY,
        _first(payload, "productCategory", "product_category"),
        InsightFactPolicy.REQUIRED,
    )
    add_value(
        InsightField.CORE_SPECIFICATION,
        _first(payload, "coreSpecification", "core_specification"),
        InsightFactPolicy.REQUIRED,
    )
    add_value(
        InsightField.PRICE_RANGE,
        _first(payload, "priceRange", "price_range"),
        InsightFactPolicy.ADAPTIVE,
    )
    add_value(
        InsightField.VISUAL_FEATURES,
        _first(payload, "visualFeatures", "visual_features"),
        InsightFactPolicy.REQUIRED,
    )

    selling_points = _values(payload, "sellingPoints", "selling_points")
    if "sellingPoints" not in payload and "selling_points" not in payload:
        # Defensive support for already-claimed jobs created before the API read
        # boundary started projecting the old information-card fields. Every
        # usable value is flattened into the same current selling-point stream;
        # the old field names do not retain priority or downstream semantics.
        selling_points = _values(
            payload,
            "coreSellingPoints",
            "core_selling_points",
            "secondarySellingPoints",
            "secondary_selling_points",
            "trustBackings",
            "trust_backings",
            "targetAudiences",
            "target_audiences",
            "corePainPoints",
            "core_pain_points",
            "decisionDrivers",
            "decision_drivers",
            "usageScenarios",
            "usage_scenarios",
            "purchaseScenarios",
            "purchase_scenarios",
            "emotionalScenarios",
            "emotional_scenarios",
        )
        if "targetAudiences" not in payload and "target_audiences" not in payload:
            selling_points.extend(_values(payload, "targetAudience", "target_audience"))
    for value in selling_points:
        add_value(
            InsightField.SELLING_POINT,
            value,
            InsightFactPolicy.REQUIRED,
        )

    return InsightApplicationMap(
        required=_dedupe(required),
        adaptive=_dedupe(adaptive),
        excluded=_dedupe(excluded),
        constraints=_dedupe(constraints),
    )


def insight_coverage(
    application: InsightApplicationMap,
    items: Sequence[PromptItem],
    *,
    required_fact_ids: Sequence[str] | None = None,
) -> InsightCoverage:
    covered_ids = {
        binding.fact_id
        for item in items
        for binding in item.insight_bindings
        if binding.fact_id in application.by_id
    }
    # A supplied scope is the AI visual strategy's batch requirement, including
    # an intentionally empty scope. Keep other facts available without treating
    # copy-only context as missing evidence in silent material clips.
    required_ids = (
        {fact.fact_id for fact in application.required}
        if required_fact_ids is None
        else set(required_fact_ids)
    )
    required = [
        _reference(fact) for fact in application.usable if fact.fact_id in required_ids
    ]
    adaptive = [
        _reference(fact)
        for fact in application.usable
        if fact.fact_id not in required_ids
    ]
    return InsightCoverage(
        required=required,
        covered=[item for item in required if item.fact_id in covered_ids],
        missing=[item for item in required if item.fact_id not in covered_ids],
        adaptive=adaptive,
        deferred=[item for item in adaptive if item.fact_id not in covered_ids],
        excluded=[
            ExcludedInsight(
                **_reference(fact).model_dump(),
                reason=fact.exclusion_reason or "UNSUPPORTED",
            )
            for fact in application.excluded
        ],
        applied_constraints=[_reference(fact) for fact in application.constraints],
    )


def mandatory_business_facts(application: InsightApplicationMap) -> list[InsightFact]:
    """Return confirmed facts that the batch must genuinely use.

    The list deliberately excludes product name/category/specification. Those
    facts keep the product identifiable, but must not make a generic product
    shot look like deep insight coverage.
    """

    return [
        fact for fact in application.usable if fact.field in MANDATORY_BUSINESS_FIELDS
    ]


def bindings_for_fact_ids(
    application: InsightApplicationMap,
    fact_ids: Sequence[str],
    fragment_type: FragmentType,
) -> list[InsightBinding]:
    bindings: list[InsightBinding] = []
    seen: set[str] = set()
    for fact_id in fact_ids:
        fact = application.by_id.get(fact_id)
        if (
            not fact
            or fact_id in seen
            or fragment_type not in fact.eligible_fragment_types
        ):
            continue
        seen.add(fact_id)
        bindings.append(
            InsightBinding(
                **_reference(fact).model_dump(),
                role=fact.preferred_role,
            )
        )
    return bindings


def _fact(
    field: InsightField,
    value: str,
    policy: InsightFactPolicy,
    *,
    exclusion_reason: Literal["UNCERTAIN", "EMPTY", "UNSUPPORTED"] | None = None,
) -> InsightFact:
    normalized = _normalized(value)
    value_hash = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    role = (
        InsightBindingRole.EVIDENCE
        if field in _EVIDENCE_FIELDS
        else InsightBindingRole.PRIMARY
        if field in _PRIMARY_FIELDS
        else InsightBindingRole.CONTEXT
    )
    return InsightFact(
        fact_id=f"{field.value}:{value_hash[:20]}",
        field=field,
        value=value,
        value_hash=value_hash,
        policy=policy,
        eligible_fragment_types=list(_ELIGIBLE.get(field, ())),
        preferred_role=role,
        exclusion_reason=exclusion_reason,
    )


def _reference(fact: InsightFact) -> InsightReference:
    return InsightReference(
        fact_id=fact.fact_id,
        field=fact.field,
        value=fact.value,
        value_hash=fact.value_hash,
    )


def _add_values(
    payload: Mapping[str, Any],
    keys: tuple[str, ...],
    field: InsightField,
    policy: InsightFactPolicy,
    add_value: Any,
) -> None:
    for value in _values(payload, *keys):
        add_value(field, value, policy)


def _values(payload: Mapping[str, Any], *keys: str) -> list[str]:
    result: list[str] = []
    for key in keys:
        raw = payload.get(key)
        values = raw if isinstance(raw, list) else [raw] if isinstance(raw, str) else []
        result.extend(value for item in values if (value := _clean_value(item)))
    return list(dict.fromkeys(result))


def _first(payload: Mapping[str, Any], *keys: str) -> object:
    for key in keys:
        if key in payload:
            return payload[key]
    return ""


def _clean_value(value: object) -> str:
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, (int, float)):
        return str(value)
    if not isinstance(value, str):
        return ""
    return value.strip()


def _normalized(value: str) -> str:
    return value.strip()


def _dedupe(facts: Sequence[InsightFact]) -> list[InsightFact]:
    result: list[InsightFact] = []
    seen: set[str] = set()
    for fact in facts:
        if fact.fact_id not in seen:
            seen.add(fact.fact_id)
            result.append(fact)
    return result
