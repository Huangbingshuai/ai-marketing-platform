from __future__ import annotations

from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import CreativeFactAssignment, InsightField
from effect_prompt_generation.fact_allocation import (
    allocate_creative_facts,
    allocate_regeneration_facts,
)


def _application():
    return map_insight(
        {
            "productName": "广式腊肠",
            "productCategory": "腌腊肉制品",
            "coreSpecification": "七分瘦三分肥",
            "visualFeatures": "红润油亮、切面肉粒清晰",
            "coreSellingPoints": ["传统广式风味", "蒸制后油润有嚼劲"],
            "secondarySellingPoints": ["切片即可搭配米饭"],
            "targetAudience": "喜欢家常广式风味的成年人",
            "corePainPoints": ["家常菜缺少有辨识度的风味"],
            "decisionDrivers": ["看得见真实肉粒"],
            "marketingGoal": "促进购买",
            "usageScenarios": ["家庭厨房蒸制", "家宴餐桌切片分享"],
            "purchaseScenarios": ["年节家宴备货"],
            "emotionalScenarios": ["温暖团聚"],
            "disabledElements": ["医疗功效宣称"],
        }
    )


def test_fact_allocation_is_small_deterministic_and_business_only() -> None:
    application = _application()

    first = allocate_creative_facts(
        application,
        count=12,
        ordinal_start=1,
    )
    second = allocate_creative_facts(
        application,
        count=12,
        ordinal_start=1,
    )

    assert first == second
    assert all(2 <= len(item.fact_ids) <= 4 for item in first)
    assert all(
        fact_id in application.by_id for item in first for fact_id in item.fact_ids
    )
    product_name_id = next(
        fact.fact_id
        for fact in application.usable
        if fact.field == InsightField.PRODUCT_NAME
    )
    assert all(product_name_id not in item.fact_ids for item in first)
    assert all(len(item.assignment_hash) == 64 for item in first)


def test_fact_allocation_rotates_business_facts_across_bundles() -> None:
    application = _application()
    expected_primary_ids = {
        fact.fact_id
        for fact in application.usable
        if fact.field
        in {
            InsightField.CORE_SELLING_POINT,
            InsightField.CORE_PAIN_POINT,
            InsightField.DECISION_DRIVER,
            InsightField.TARGET_AUDIENCE,
            InsightField.USAGE_SCENARIO,
            InsightField.PURCHASE_SCENARIO,
            InsightField.EMOTIONAL_SCENARIO,
            InsightField.SECONDARY_SELLING_POINT,
            InsightField.MARKETING_GOAL,
        }
    }
    assignments = allocate_creative_facts(
        application,
        count=len(expected_primary_ids),
        ordinal_start=1,
    )

    allocated_ids = {
        fact_id for assignment in assignments for fact_id in assignment.fact_ids
    }
    assert expected_primary_ids.issubset(allocated_ids)
    allocated_fields = {application.by_id[fact_id].field for fact_id in allocated_ids}
    assert InsightField.MARKETING_GOAL in allocated_fields
    assert InsightField.TARGET_AUDIENCE in allocated_fields
    assert InsightField.DISABLED_ELEMENT not in allocated_fields


def test_fact_allocation_keeps_regeneration_preferred_binding() -> None:
    application = _application()
    preferred = next(
        fact.fact_id
        for fact in application.usable
        if fact.field == InsightField.CORE_PAIN_POINT
    )

    assignments = allocate_creative_facts(
        application,
        count=3,
        ordinal_start=20,
        preferred_fact_ids=[preferred],
    )

    assert all(preferred in item.fact_ids for item in assignments)


def test_regeneration_preserves_the_verified_fact_bundle_for_all_three_options() -> (
    None
):
    application = _application()
    original = [
        fact.fact_id
        for fact in application.usable
        if fact.field in {InsightField.CORE_SELLING_POINT, InsightField.USAGE_SCENARIO}
    ][:2]

    assignments = allocate_regeneration_facts(
        application,
        count=3,
        ordinal_start=1,
        original_fact_ids=original,
        preserve_product_relation=True,
    )

    assert len(assignments) == 3
    assert all(item.fact_ids == original for item in assignments)
    assert len({item.assignment_hash for item in assignments}) == 3


def test_legacy_fact_roles_migrate_to_fact_bundle() -> None:
    assignment = CreativeFactAssignment.model_validate(
        {
            "primaryFactId": "visual-fact",
            "visualTaskFactId": "visual-fact",
            "businessContextFactIds": ["business-focus", "support-fact"],
            "supportFactIds": ["support-fact"],
            "productAnchorFactIds": ["product-name"],
            "productBoundaryFactIds": ["specification"],
            "assignmentHash": "a" * 64,
        }
    )

    assert assignment.fact_ids == [
        "business-focus",
        "support-fact",
        "visual-fact",
        "product-name",
        "specification",
    ]
