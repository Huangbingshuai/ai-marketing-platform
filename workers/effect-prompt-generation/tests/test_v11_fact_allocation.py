from __future__ import annotations

from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import InsightField
from effect_prompt_generation.v11_fact_allocation import (
    allocate_v11_creative_facts,
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


def test_v11_fact_allocation_is_small_deterministic_and_product_anchored() -> None:
    application = _application()

    first = allocate_v11_creative_facts(
        application,
        count=12,
        ordinal_start=1,
    )
    second = allocate_v11_creative_facts(
        application,
        count=12,
        ordinal_start=1,
    )

    assert first == second
    assert all(len(item.support_fact_ids) <= 2 for item in first)
    assert all(1 <= len(item.product_anchor_fact_ids) <= 2 for item in first)
    assert all(len(item.allowed_fact_ids) <= 5 for item in first)
    assert all(
        fact_id in application.by_id
        for item in first
        for fact_id in item.allowed_fact_ids
    )
    product_name_id = next(
        fact.fact_id
        for fact in application.usable
        if fact.field == InsightField.PRODUCT_NAME
    )
    assert all(product_name_id in item.product_anchor_fact_ids for item in first)
    assert all(len(item.assignment_hash) == 64 for item in first)


def test_v11_fact_allocation_rotates_creative_primary_facts_before_repeating() -> None:
    application = _application()
    expected_primary_ids = {
        fact.fact_id
        for fact in application.usable
        if fact.field
        in {
            InsightField.CORE_SELLING_POINT,
            InsightField.CORE_PAIN_POINT,
            InsightField.DECISION_DRIVER,
            InsightField.VISUAL_FEATURES,
            InsightField.USAGE_SCENARIO,
            InsightField.PURCHASE_SCENARIO,
            InsightField.SECONDARY_SELLING_POINT,
            InsightField.CORE_SPECIFICATION,
        }
    }
    assignments = allocate_v11_creative_facts(
        application,
        count=len(expected_primary_ids),
        ordinal_start=1,
    )

    actual_primary_ids = [item.primary_fact_id for item in assignments]
    assert len(actual_primary_ids) == len(set(actual_primary_ids))
    assert set(actual_primary_ids) == expected_primary_ids
    primary_fields = {
        application.by_id[item.primary_fact_id].field for item in assignments
    }
    assert InsightField.MARKETING_GOAL not in primary_fields
    assert InsightField.TARGET_AUDIENCE not in primary_fields
    assert InsightField.DISABLED_ELEMENT not in primary_fields


def test_v11_fact_allocation_keeps_regeneration_primary_binding() -> None:
    application = _application()
    preferred = next(
        fact.fact_id
        for fact in application.usable
        if fact.field == InsightField.CORE_PAIN_POINT
    )

    assignments = allocate_v11_creative_facts(
        application,
        count=3,
        ordinal_start=20,
        preferred_primary_fact_ids=[preferred],
    )

    assert {item.primary_fact_id for item in assignments} == {preferred}
