from __future__ import annotations

from datetime import UTC, datetime

from effect_prompt_generation.insight_mapping import (
    bindings_for_fact_ids,
    insight_coverage,
    map_insight,
)
from effect_prompt_generation.models import (
    FragmentType,
    InsightFactPolicy,
    InsightField,
    PromptDimensions,
    PromptItem,
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


def test_maps_every_non_empty_field_to_required_adaptive_excluded_or_constraint() -> None:
    application = map_insight(_card())
    facts = [
        *application.required,
        *application.adaptive,
        *application.excluded,
        *application.constraints,
    ]

    assert {fact.field for fact in facts} == set(InsightField)
    assert next(fact for fact in application.excluded if fact.field == InsightField.PRICE_RANGE).exclusion_reason == "UNCERTAIN"
    assert next(fact for fact in application.adaptive if fact.field == InsightField.TRUST_BACKING).eligible_fragment_types == [
        FragmentType.SELLING_POINT_EXPLANATION
    ]
    assert all(fact.policy == InsightFactPolicy.CONSTRAINT for fact in application.constraints)
    assert next(
        fact for fact in application.constraints if fact.field == InsightField.RESOLUTION
    ).value == "1080p"


def test_maps_canonical_audience_items_independently_without_reusing_summary() -> None:
    application = map_insight(_card())

    audiences = [
        fact.value
        for fact in application.required
        if fact.field == InsightField.TARGET_AUDIENCE
    ]

    assert audiences == ["家庭厨房人群", "美食爱好者"]
    assert "家庭厨房人群；美食爱好者" not in audiences


def test_falls_back_to_legacy_audience_summary_only_when_canonical_list_is_empty() -> None:
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


def test_fragment_bindings_reject_incompatible_sensitive_facts() -> None:
    card = _card()
    card["priceRange"] = "88-108元"
    application = map_insight(card)
    price = next(fact for fact in application.adaptive if fact.field == InsightField.PRICE_RANGE)
    trust = next(fact for fact in application.adaptive if fact.field == InsightField.TRUST_BACKING)

    assert bindings_for_fact_ids(application, [price.fact_id], FragmentType.HOOK) == []
    assert bindings_for_fact_ids(application, [price.fact_id], FragmentType.CTA)[0].value == "88-108元"
    assert bindings_for_fact_ids(application, [trust.fact_id], FragmentType.CTA) == []
    assert (
        bindings_for_fact_ids(
            application, [trust.fact_id], FragmentType.SELLING_POINT_EXPLANATION
        )[0].role.value
        == "EVIDENCE"
    )


def test_coverage_counts_only_compatible_bindings_that_survive_the_batch() -> None:
    application = map_insight(_card())
    product_name = next(
        fact for fact in application.required if fact.field == InsightField.PRODUCT_NAME
    )
    bindings = bindings_for_fact_ids(
        application, [product_name.fact_id], FragmentType.PRODUCT_DISPLAY
    )
    now = datetime(2026, 8, 26, tzinfo=UTC)
    item = PromptItem(
        id="item-1",
        code="P001",
        origin="AI",
        fragment_type=FragmentType.PRODUCT_DISPLAY,
        material_tags=["产品", "特写"],
        target_duration_seconds=5,
        dimensions=PromptDimensions(
            narrative="产品细节",
            scene="家庭厨房",
            persona="无人出镜，只展示成年人的手",
            selling_point="广式风味",
            camera="近景连续推近",
            emotion="温暖自然",
        ),
        content="双手拿起广式腊肠并转向镜头，近景连续推近真实切面后停住。",
        insight_bindings=bindings,
        manual_edited=False,
        created_at=now,
        updated_at=now,
    )

    coverage = insight_coverage(application, [item])
    assert [fact.fact_id for fact in coverage.covered] == [product_name.fact_id]
    assert product_name.fact_id not in {fact.fact_id for fact in coverage.missing}
    assert coverage.applied_constraints
