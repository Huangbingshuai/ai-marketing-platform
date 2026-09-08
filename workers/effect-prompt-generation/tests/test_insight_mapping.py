from __future__ import annotations

from effect_prompt_generation.insight_mapping import (
    insight_coverage,
    mandatory_business_facts,
    map_insight,
)
from effect_prompt_generation.models import (
    FragmentType,
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

    legacy_video_fields = {
        InsightField.SOURCE_DURATION,
        InsightField.ASPECT_RATIO,
        InsightField.RESOLUTION,
        InsightField.DELIVERY_CHANNELS,
        InsightField.DISABLED_ELEMENT,
        InsightField.VISUAL_STYLE_BASELINE,
    }
    assert {fact.field for fact in facts} == set(InsightField) - legacy_video_fields
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
    ).eligible_fragment_types == [FragmentType.EFFECT]
    assert application.constraints == []


def test_maps_canonical_audience_items_independently_without_reusing_summary() -> None:
    application = map_insight(_card())

    audiences = [
        fact.value
        for fact in application.required
        if fact.field == InsightField.TARGET_AUDIENCE
    ]

    assert audiences == ["家庭厨房人群", "美食爱好者"]
    assert "家庭厨房人群；美食爱好者" not in audiences


def test_marks_all_confirmed_business_facts_as_mandatory_batch_inputs() -> None:
    application = map_insight(_card())

    values = {fact.value for fact in mandatory_business_facts(application)}

    assert {
        "广式风味",
        "切面油润",
        "便于切配",
        "家庭厨房人群",
        "美食爱好者",
        "年货选择困难",
        "煲仔饭烹饪",
        "蒸制",
        "年货选购",
        "家庭团聚",
    }.issubset(values)


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


def test_coverage_preserves_context_without_requiring_it_in_silent_material() -> None:
    application = map_insight(_card())
    visible = next(fact for fact in application.usable if fact.value == "切面油润")
    coverage = insight_coverage(application, [], required_fact_ids=[visible.fact_id])

    assert [fact.fact_id for fact in coverage.required] == [visible.fact_id]
    assert coverage.missing == coverage.required
    assert "广式风味" in {fact.value for fact in coverage.deferred}
    assert {fact.fact_id for fact in coverage.required + coverage.adaptive} == {
        fact.fact_id for fact in application.usable
    }
    assert not ({fact.fact_id for fact in coverage.required} & {
        fact.fact_id for fact in coverage.adaptive
    })


def test_empty_visual_requirement_does_not_restore_original_required_facts() -> None:
    application = map_insight(_card())
    scoped = insight_coverage(application, [], required_fact_ids=[])
    assert scoped.required == scoped.missing == []
    assert len(scoped.deferred) == len(application.usable)
    legacy = insight_coverage(application, [])
    assert len(legacy.required) == len(application.required)
