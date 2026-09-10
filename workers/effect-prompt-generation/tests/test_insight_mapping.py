from __future__ import annotations

from effect_prompt_generation.insight_mapping import (
    insight_coverage,
    mandatory_business_facts,
    map_insight,
)
from effect_prompt_generation.models import InsightField


def _card() -> dict[str, object]:
    return {
        "productName": "紫苏梅子酱",
        "productCategory": "复合调味酱",
        "coreSpecification": "220g 玻璃瓶装",
        "priceRange": "需确认",
        "visualFeatures": "深红紫色酱体，可见梅肉颗粒",
        "sellingPoints": [
            "梅子酸味与紫苏草本香",
            "浓稠可舀取并能挂在食材表面",
            "适合刷制烤物",
            "适合腌制入味",
            "适合家庭烹饪人群",
        ],
    }


def test_current_card_maps_every_selling_point_as_an_equal_required_fact() -> None:
    application = map_insight(_card())
    points = [
        fact
        for fact in application.required
        if fact.field == InsightField.SELLING_POINT
    ]

    assert [fact.value for fact in points] == _card()["sellingPoints"]
    assert len({fact.fact_id for fact in points}) == 5
    assert application.constraints == []
    assert application.excluded == []
    assert "需确认" in {fact.value for fact in application.usable}


def test_marketing_and_render_settings_are_not_product_facts() -> None:
    card = {
        **_card(),
        "marketingGoal": "促进转化",
        "durationSeconds": 15,
        "aspectRatio": "9:16",
        "resolution": "1080p",
        "disabledElements": ["医疗功效"],
    }
    application = map_insight(card)
    values = {fact.value for fact in [*application.usable, *application.excluded]}

    assert "促进转化" not in values
    assert "15" not in values
    assert "9:16" not in values
    assert "1080p" not in values
    assert "医疗功效" not in values


def test_uncertain_word_does_not_let_worker_delete_a_selling_point() -> None:
    card = _card()
    card["sellingPoints"] = ["适合刷制烤物", "配料比例待确认"]
    application = map_insight(card)

    assert [fact.value for fact in mandatory_business_facts(application)] == [
        "适合刷制烤物",
        "配料比例待确认",
    ]
    assert application.excluded == []


def test_old_claimed_job_is_flattened_without_preserving_old_priorities() -> None:
    application = map_insight(
        {
            "productName": "广式腊肠",
            "coreSellingPoints": ["广式甜咸风味"],
            "secondarySellingPoints": ["真空包装"],
            "targetAudiences": ["家庭烹饪人群"],
            "usageScenarios": ["家庭蒸制"],
            "marketingGoal": "促进转化",
        }
    )
    points = [
        fact
        for fact in application.required
        if fact.field == InsightField.SELLING_POINT
    ]

    assert [fact.value for fact in points] == [
        "广式甜咸风味",
        "真空包装",
        "家庭烹饪人群",
        "家庭蒸制",
    ]
    assert "促进转化" not in {fact.value for fact in application.usable}


def test_coverage_uses_only_the_visual_strategy_scope_as_required() -> None:
    application = map_insight(_card())
    visible = next(fact for fact in application.usable if fact.value == "适合刷制烤物")
    coverage = insight_coverage(application, [], required_fact_ids=[visible.fact_id])

    assert [fact.fact_id for fact in coverage.required] == [visible.fact_id]
    assert coverage.missing == coverage.required
    assert "适合腌制入味" in {fact.value for fact in coverage.deferred}


def test_empty_visual_requirement_keeps_all_facts_available_without_forcing_them() -> (
    None
):
    application = map_insight(_card())
    scoped = insight_coverage(application, [], required_fact_ids=[])

    assert scoped.required == scoped.missing == []
    assert len(scoped.deferred) == len(application.usable)
