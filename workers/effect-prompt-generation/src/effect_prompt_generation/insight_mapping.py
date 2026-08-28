from __future__ import annotations

import hashlib
import re
import unicodedata
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

_UNCERTAIN = re.compile(
    r"(?:需确认|待确认|待核实|未知|未提供|暂无|不确定|无法判断|可能|推测|待补充|n/?a|unknown)",
    re.IGNORECASE,
)

_ELIGIBLE: dict[InsightField, tuple[FragmentType, ...]] = {
    InsightField.PRODUCT_NAME: (
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.SELLING_POINT_EXPLANATION,
        FragmentType.CTA,
        FragmentType.OUTRO,
    ),
    InsightField.PRODUCT_CATEGORY: (
        FragmentType.HOOK,
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.OUTRO,
    ),
    InsightField.CORE_SPECIFICATION: (
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.SELLING_POINT_EXPLANATION,
    ),
    InsightField.PRICE_RANGE: (FragmentType.CTA,),
    InsightField.VISUAL_FEATURES: (
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.OUTRO,
    ),
    InsightField.CORE_SELLING_POINT: (
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.SELLING_POINT_EXPLANATION,
        FragmentType.CTA,
    ),
    InsightField.SECONDARY_SELLING_POINT: (FragmentType.SELLING_POINT_EXPLANATION,),
    InsightField.TRUST_BACKING: (FragmentType.SELLING_POINT_EXPLANATION,),
    InsightField.TARGET_AUDIENCE: (
        FragmentType.HOOK,
        FragmentType.PAIN,
        FragmentType.CTA,
    ),
    InsightField.CORE_PAIN_POINT: (FragmentType.HOOK, FragmentType.PAIN),
    InsightField.DECISION_DRIVER: (
        FragmentType.HOOK,
        FragmentType.SELLING_POINT_EXPLANATION,
        FragmentType.CTA,
    ),
    InsightField.MARKETING_GOAL: (FragmentType.CTA,),
    InsightField.USAGE_SCENARIO: (
        FragmentType.HOOK,
        FragmentType.PAIN,
        FragmentType.PRODUCT_DISPLAY,
    ),
    InsightField.PURCHASE_SCENARIO: (
        FragmentType.HOOK,
        FragmentType.PAIN,
        FragmentType.CTA,
    ),
    InsightField.EMOTIONAL_SCENARIO: (FragmentType.HOOK, FragmentType.OUTRO),
}

_PRIMARY_FIELDS = {
    InsightField.CORE_SELLING_POINT,
    InsightField.CORE_PAIN_POINT,
    InsightField.MARKETING_GOAL,
    InsightField.PRICE_RANGE,
}
_EVIDENCE_FIELDS = {InsightField.TRUST_BACKING}


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
        if _UNCERTAIN.search(value):
            fact = _fact(field, value, InsightFactPolicy.EXCLUDED, exclusion_reason="UNCERTAIN")
            excluded.append(fact)
            return fact
        fact = _fact(field, value, policy)
        {
            InsightFactPolicy.REQUIRED: required,
            InsightFactPolicy.ADAPTIVE: adaptive,
            InsightFactPolicy.CONSTRAINT: constraints,
        }[policy].append(fact)
        return fact

    add_value(InsightField.PRODUCT_NAME, _first(payload, "productName", "product_name"), InsightFactPolicy.REQUIRED)
    add_value(InsightField.PRODUCT_CATEGORY, _first(payload, "productCategory", "product_category"), InsightFactPolicy.REQUIRED)
    add_value(InsightField.CORE_SPECIFICATION, _first(payload, "coreSpecification", "core_specification"), InsightFactPolicy.REQUIRED)
    add_value(
        InsightField.PRICE_RANGE,
        _first(payload, "priceRange", "price_range"),
        InsightFactPolicy.ADAPTIVE,
    )
    add_value(InsightField.VISUAL_FEATURES, _first(payload, "visualFeatures", "visual_features"), InsightFactPolicy.REQUIRED)

    _add_values(payload, ("coreSellingPoints", "core_selling_points"), InsightField.CORE_SELLING_POINT, InsightFactPolicy.REQUIRED, add_value)
    _add_values(payload, ("secondarySellingPoints", "secondary_selling_points"), InsightField.SECONDARY_SELLING_POINT, InsightFactPolicy.ADAPTIVE, add_value)
    _add_values(
        payload,
        ("trustBackings", "trust_backings"),
        InsightField.TRUST_BACKING,
        InsightFactPolicy.ADAPTIVE,
        add_value,
    )
    target_audiences = _values(payload, "targetAudiences", "target_audiences")
    if target_audiences:
        for target_audience in target_audiences:
            add_value(
                InsightField.TARGET_AUDIENCE,
                target_audience,
                InsightFactPolicy.REQUIRED,
            )
    else:
        add_value(
            InsightField.TARGET_AUDIENCE,
            _first(payload, "targetAudience", "target_audience"),
            InsightFactPolicy.REQUIRED,
        )
    _add_values(payload, ("corePainPoints", "core_pain_points"), InsightField.CORE_PAIN_POINT, InsightFactPolicy.REQUIRED, add_value)
    _add_values(payload, ("decisionDrivers", "decision_drivers"), InsightField.DECISION_DRIVER, InsightFactPolicy.REQUIRED, add_value)
    add_value(InsightField.MARKETING_GOAL, _first(payload, "marketingGoal", "marketing_goal"), InsightFactPolicy.REQUIRED)

    for keys, field in (
        (("usageScenarios", "usage_scenarios"), InsightField.USAGE_SCENARIO),
        (("purchaseScenarios", "purchase_scenarios"), InsightField.PURCHASE_SCENARIO),
        (("emotionalScenarios", "emotional_scenarios"), InsightField.EMOTIONAL_SCENARIO),
    ):
        values = _values(payload, *keys)
        for index, value in enumerate(values):
            add_value(field, value, InsightFactPolicy.REQUIRED if index == 0 else InsightFactPolicy.ADAPTIVE)

    add_value(InsightField.SOURCE_DURATION, _first(payload, "durationSeconds", "duration_seconds"), InsightFactPolicy.CONSTRAINT)
    add_value(InsightField.ASPECT_RATIO, _first(payload, "aspectRatio", "aspect_ratio"), InsightFactPolicy.CONSTRAINT)
    add_value(InsightField.RESOLUTION, _first(payload, "resolution"), InsightFactPolicy.CONSTRAINT)
    add_value(InsightField.DELIVERY_CHANNELS, _first(payload, "deliveryChannels", "delivery_channels"), InsightFactPolicy.CONSTRAINT)
    _add_values(payload, ("disabledElements", "disabled_elements"), InsightField.DISABLED_ELEMENT, InsightFactPolicy.CONSTRAINT, add_value)
    add_value(InsightField.VISUAL_STYLE_BASELINE, _first(payload, "visualStyleBaseline", "visual_style_baseline"), InsightFactPolicy.CONSTRAINT)

    return InsightApplicationMap(
        required=_dedupe(required),
        adaptive=_dedupe(adaptive),
        excluded=_dedupe(excluded),
        constraints=_dedupe(constraints),
    )


def insight_coverage(application: InsightApplicationMap, items: Sequence[PromptItem]) -> InsightCoverage:
    covered_ids = {
        binding.fact_id
        for item in items
        for binding in item.insight_bindings
        if binding.fact_id in application.by_id
        and item.fragment_type in application.by_id[binding.fact_id].eligible_fragment_types
    }
    required = [_reference(fact) for fact in application.required]
    adaptive = [_reference(fact) for fact in application.adaptive]
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


def bindings_for_fact_ids(
    application: InsightApplicationMap,
    fact_ids: Sequence[str],
    fragment_type: FragmentType,
) -> list[InsightBinding]:
    bindings: list[InsightBinding] = []
    seen: set[str] = set()
    for fact_id in fact_ids:
        fact = application.by_id.get(fact_id)
        if not fact or fact_id in seen or fragment_type not in fact.eligible_fragment_types:
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
    return " ".join(value.split())[:500]


def _normalized(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value).strip().casefold())


def _dedupe(facts: Sequence[InsightFact]) -> list[InsightFact]:
    result: list[InsightFact] = []
    seen: set[str] = set()
    for fact in facts:
        if fact.fact_id not in seen:
            seen.add(fact.fact_id)
            result.append(fact)
    return result
