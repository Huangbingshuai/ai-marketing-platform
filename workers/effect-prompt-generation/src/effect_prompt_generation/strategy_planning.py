from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping

from .models import (
    FragmentFactAllocation,
    FragmentMarketingPlan,
    FragmentType,
    InsightApplicationMap,
    InsightFact,
    InsightField,
)

_OWNER_PREFERENCE: dict[InsightField, tuple[FragmentType, ...]] = {
    InsightField.PRODUCT_NAME: (FragmentType.PRODUCT_DISPLAY, FragmentType.OUTRO),
    InsightField.PRODUCT_CATEGORY: (FragmentType.PRODUCT_DISPLAY, FragmentType.OUTRO),
    InsightField.CORE_SPECIFICATION: (
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.SELLING_POINT_EXPLANATION,
    ),
    InsightField.PRICE_RANGE: (FragmentType.CTA,),
    InsightField.VISUAL_FEATURES: (FragmentType.PRODUCT_DISPLAY, FragmentType.OUTRO),
    InsightField.CORE_SELLING_POINT: (
        FragmentType.SELLING_POINT_EXPLANATION,
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.CTA,
    ),
    InsightField.SECONDARY_SELLING_POINT: (
        FragmentType.SELLING_POINT_EXPLANATION,
    ),
    InsightField.TRUST_BACKING: (FragmentType.SELLING_POINT_EXPLANATION,),
    InsightField.TARGET_AUDIENCE: (
        FragmentType.HOOK,
        FragmentType.PAIN,
        FragmentType.CTA,
    ),
    InsightField.CORE_PAIN_POINT: (FragmentType.PAIN, FragmentType.HOOK),
    InsightField.DECISION_DRIVER: (
        FragmentType.SELLING_POINT_EXPLANATION,
        FragmentType.HOOK,
        FragmentType.CTA,
    ),
    InsightField.MARKETING_GOAL: (FragmentType.CTA,),
    InsightField.USAGE_SCENARIO: (
        FragmentType.PRODUCT_DISPLAY,
        FragmentType.PAIN,
        FragmentType.HOOK,
    ),
    InsightField.PURCHASE_SCENARIO: (
        FragmentType.CTA,
        FragmentType.PAIN,
        FragmentType.HOOK,
    ),
    InsightField.EMOTIONAL_SCENARIO: (FragmentType.OUTRO, FragmentType.HOOK),
}


def allocate_fragment_facts(
    application: InsightApplicationMap,
    fragment_counts: Mapping[FragmentType, int],
) -> dict[FragmentType, FragmentFactAllocation]:
    mandatory: dict[FragmentType, list[str]] = {
        fragment_type: [] for fragment_type in FragmentType
    }
    for fact in application.required:
        owner = _owner_for_fact(fact)
        if owner is None:
            raise ValueError(f"required fact {fact.fact_id} has no eligible fragment owner")
        mandatory[owner].append(fact.fact_id)

    allocations: dict[FragmentType, FragmentFactAllocation] = {}
    for fragment_type in FragmentType:
        candidate_ids = [
            fact.fact_id
            for fact in application.usable
            if fragment_type in fact.eligible_fragment_types
        ]
        if not candidate_ids:
            raise ValueError(f"{fragment_type.value} has no eligible confirmed facts")
        target_count = fragment_counts[fragment_type]
        bundle_target = min(4, max(1, math.ceil(target_count / 3)))
        payload = {
            "fragmentType": fragment_type.value,
            "targetCount": target_count,
            "bundleTarget": bundle_target,
            "mandatoryFactIds": mandatory[fragment_type],
            "candidateFactIds": candidate_ids,
        }
        allocation_hash = hashlib.sha256(
            json.dumps(
                payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
        ).hexdigest()
        allocations[fragment_type] = FragmentFactAllocation(
            fragment_type=fragment_type,
            target_count=target_count,
            bundle_target=bundle_target,
            mandatory_fact_ids=mandatory[fragment_type],
            candidate_fact_ids=candidate_ids,
            allocation_hash=allocation_hash,
        )
    return allocations


def validate_fragment_marketing_plan(
    plan: FragmentMarketingPlan,
    allocation: FragmentFactAllocation,
    application: InsightApplicationMap,
) -> None:
    if plan.fragment_type != allocation.fragment_type:
        raise ValueError("fragment marketing plan changed fragmentType")
    if plan.allocation_hash != allocation.allocation_hash:
        raise ValueError("fragment marketing plan allocation hash mismatch")
    if len(plan.bundles) != allocation.bundle_target:
        raise ValueError("fragment marketing plan bundle count mismatch")

    candidates = set(allocation.candidate_fact_ids)
    known = application.by_id
    covered: set[str] = set()
    signatures: set[tuple[str, ...]] = set()
    bundle_ids: set[str] = set()
    for bundle in plan.bundles:
        if bundle.bundle_id in bundle_ids:
            raise ValueError("fragment marketing plan contains duplicate bundleId")
        bundle_ids.add(bundle.bundle_id)
        if len(bundle.fact_ids) != len(set(bundle.fact_ids)):
            raise ValueError("fragment marketing bundle contains duplicate factId")
        if bundle.primary_fact_id not in bundle.fact_ids:
            raise ValueError("primaryFactId must be included in factIds")
        if any(fact_id not in candidates for fact_id in bundle.fact_ids):
            raise ValueError("fragment marketing plan referenced an unallocated fact")
        if any(
            allocation.fragment_type not in known[fact_id].eligible_fragment_types
            for fact_id in bundle.fact_ids
        ):
            raise ValueError("fragment marketing plan contains a role-conflicting fact")
        signature = tuple(sorted(bundle.fact_ids))
        if signature in signatures:
            raise ValueError("fragment marketing plan repeats the same fact set")
        signatures.add(signature)
        covered.update(bundle.fact_ids)
    if not set(allocation.mandatory_fact_ids).issubset(covered):
        raise ValueError("fragment marketing plan missed mandatory facts")


def _owner_for_fact(fact: InsightFact) -> FragmentType | None:
    eligible = set(fact.eligible_fragment_types)
    for fragment_type in _OWNER_PREFERENCE.get(fact.field, ()):
        if fragment_type in eligible:
            return fragment_type
    return next(iter(fact.eligible_fragment_types), None)
