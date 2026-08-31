from __future__ import annotations


from effect_prompt_generation.insight_mapping import (
    map_insight,
)
from effect_prompt_generation.models import (
    FragmentType,
    InsightFactPolicy,
    InsightField,
)


def _card() -> dict[str, object]:
    return {
        "productName": "广式腊肠",
        "productCategory": "腊味",
        "coreSpecification": "袋装",
        "priceRange": "需确认",
        "visualFeatures": "红润切面",
        "coreSellingPoints": ["广式风味", "切面油润"],
        "secondarySellingPoints": ["便于切配"],
        "trustBackings": ["非遗工艺说明"],
        "targetAudience": "家庭厨房人群；美食爱好者",
        "targetAudiences": ["家庭厨房人群", "美食爱好者"],
        "corePainPoints": ["年货选择困难"],
        "decisionDrivers": ["真实切面"],
        "marketingGoal": "引导了解产品",
        "usageScenarios": ["煲仔饭烹饪", "蒸制"],
        "purchaseScenarios": ["年货选购"],
        "emotionalScenarios": ["家庭团聚"],
        "durationSeconds": 5,
        "aspectRatio": "3:4",
        "resolution": "1080p",
        "deliveryChannels": "抖音",
        "disabledElements": ["夸大功效"],
        "visualStyleBaseline": "温暖生活化",
    }


def test_maps_every_non_empty_field_to_required_adaptive_excluded_or_constraint() -> (
    None
):
    application = map_insight(_card())
    facts = [
        *application.required,
        *application.adaptive,
        *application.excluded,
        *application.constraints,
    ]

    assert {fact.field for fact in facts} == set(InsightField)
    assert (
        next(
            fact
            for fact in application.excluded
            if fact.field == InsightField.PRICE_RANGE
        ).exclusion_reason
        == "UNCERTAIN"
    )
    assert next(
        fact
        for fact in application.adaptive
        if fact.field == InsightField.TRUST_BACKING
    ).eligible_fragment_types == [FragmentType.SELLING_POINT_EXPLANATION]
    assert all(
        fact.policy == InsightFactPolicy.CONSTRAINT for fact in application.constraints
    )
    assert (
        next(
            fact
            for fact in application.constraints
            if fact.field == InsightField.RESOLUTION
        ).value
        == "1080p"
    )


def test_maps_canonical_audience_items_independently_without_reusing_summary() -> None:
    application = map_insight(_card())

    audiences = [
        fact.value
        for fact in application.required
        if fact.field == InsightField.TARGET_AUDIENCE
    ]

    assert audiences == ["家庭厨房人群", "美食爱好者"]
    assert "家庭厨房人群；美食爱好者" not in audiences


def test_falls_back_to_historical_audience_summary_only_when_canonical_list_is_empty() -> (
    None
):
    card = _card()
    card["targetAudiences"] = []
    application = map_insight(card)

    audiences = [
        fact.value
        for fact in application.required
        if fact.field == InsightField.TARGET_AUDIENCE
    ]

    assert audiences == ["家庭厨房人群；美食爱好者"]


def test_excludes_uncertain_audience_items_individually() -> None:
    card = _card()
    card["targetAudiences"] = ["家庭厨房人群", "待确认人群"]
    application = map_insight(card)

    assert [
        fact.value
        for fact in application.required
        if fact.field == InsightField.TARGET_AUDIENCE
    ] == ["家庭厨房人群"]
    assert [
        fact.value
        for fact in application.excluded
        if fact.field == InsightField.TARGET_AUDIENCE
    ] == ["待确认人群"]
