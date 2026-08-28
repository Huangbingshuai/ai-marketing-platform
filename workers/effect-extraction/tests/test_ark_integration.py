from __future__ import annotations

import os

import pytest

from effect_extraction.config import DEFAULT_ARK_MODEL, DEFAULT_ARK_SEMANTIC_MODEL
from effect_extraction.models import (
    ExtractionCandidate,
    ExtractionResult,
    SemanticRelation,
)
from effect_extraction.providers import ArkResponsesProvider


_RUN_REAL_ARK = os.getenv("RUN_ARK_INTEGRATION") == "1"

pytestmark = [
    pytest.mark.ark_integration,
    pytest.mark.skipif(
        not _RUN_REAL_ARK,
        reason="set RUN_ARK_INTEGRATION=1 to call the real Ark model",
    ),
]

# A small generated PNG keeps the multimodal contract test independent of repository assets.
_SMOKE_TEST_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACx"
    "jwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACLSURBVHhe7dAxAQAgEIDAD2slY34G3akAwy2M"
    "zLn7zIbBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDY"
    "NIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYfCkw"
    "UrO2iye6AAAAAElFTkSuQmCC"
)


def _required_environment(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        pytest.fail(f"{name} must be set when RUN_ARK_INTEGRATION=1")
    return value


@pytest.mark.asyncio
async def test_real_ark_text_image_and_normalization_contracts() -> None:
    api_key = _required_environment("ARK_API_KEY")
    model = os.getenv("ARK_MODEL", DEFAULT_ARK_MODEL).strip() or DEFAULT_ARK_MODEL

    provider = ArkResponsesProvider(
        base_url=os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        api_key=api_key,
        model=model,
        document_model=os.getenv("ARK_DOCUMENT_MODEL"),
        image_model=os.getenv("ARK_IMAGE_MODEL"),
        normalization_model=os.getenv("ARK_NORMALIZATION_MODEL"),
        timeout=float(os.getenv("ARK_TIMEOUT_SECONDS", "120")),
        max_attempts=2,
    )
    try:
        document = await provider.extract_document(
            "# 山泉气泡水\n\n规格：500ml。无糖，适合户外饮用。",
            source_name="ark-smoke.md",
        )
        image = await provider.analyze_image(
            _SMOKE_TEST_PNG,
            source_name="ark-smoke.png",
            image_metadata={
                "processedWidth": 64,
                "processedHeight": 64,
                "format": "PNG",
            },
        )
        normalized = await provider.normalize(
            ExtractionCandidate(
                product_category="饮料",
                product_name="山泉气泡水",
                core_specification="500ml",
                price_range=None,
                resolution=None,
                visual_features="透明瓶身",
                core_selling_points=["无糖"],
                secondary_selling_points=None,
                trust_backings=None,
                target_audience="成年消费者",
                core_pain_points=None,
                decision_drivers=None,
                marketing_goal="商品认知",
                usage_scenarios=["户外"],
                purchase_scenarios=None,
                emotional_scenarios=None,
                duration_seconds=20,
                aspect_ratio="9:16",
                delivery_channels="短视频",
                disabled_elements=["医疗功效承诺"],
                visual_style_baseline="清新",
            )
        )
    finally:
        await provider.aclose()

    assert isinstance(document.value, ExtractionCandidate)
    assert isinstance(image.value, ExtractionCandidate)
    assert isinstance(normalized.value, ExtractionResult)
    assert normalized.value.product_name.strip()
    assert isinstance(normalized.value.core_selling_points, list)
    assert document.metadata.stage == "DOCUMENT"
    assert image.metadata.stage == "IMAGE"
    assert normalized.metadata.stage == "NORMALIZATION"


@pytest.mark.asyncio
async def test_real_ark_semantic_decision_merges_only_repeated_meaning() -> None:
    api_key = _required_environment("ARK_API_KEY")
    model = os.getenv("ARK_MODEL", DEFAULT_ARK_MODEL).strip() or DEFAULT_ARK_MODEL
    semantic_model = (
        os.getenv("ARK_SEMANTIC_MODEL", DEFAULT_ARK_SEMANTIC_MODEL).strip()
        or DEFAULT_ARK_SEMANTIC_MODEL
    )
    facts = [
        {
            "factId": "pain-1",
            "field": "corePainPoints",
            "value": "日常佐餐缺少方便入味的腊味食材",
        },
        {
            "factId": "pain-2",
            "field": "corePainPoints",
            "value": "家庭日常佐餐缺少方便且有风味的腊味食材",
        },
        {
            "factId": "pain-3",
            "field": "corePainPoints",
            "value": "年节礼赠难以选择实用又有特色的产品",
        },
        {
            "factId": "usage-1",
            "field": "usageScenarios",
            "value": "制作煲仔饭",
        },
        {
            "factId": "usage-2",
            "field": "usageScenarios",
            "value": "蒸制食用",
        },
        {
            "factId": "usage-3",
            "field": "usageScenarios",
            "value": "炒制食用",
        },
    ]

    provider = ArkResponsesProvider(
        base_url=os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        api_key=api_key,
        model=model,
        semantic_model=semantic_model,
        timeout=float(os.getenv("ARK_TIMEOUT_SECONDS", "120")),
        max_attempts=2,
    )
    try:
        decision = await provider.refine_semantics(facts=facts)
    finally:
        await provider.aclose()

    applied_groups = [
        group
        for group in decision.value.groups
        if group.relation
        in {SemanticRelation.SAME_MEANING, SemanticRelation.PARENT_CHILD}
    ]
    assert any(
        set(group.member_fact_ids) == {"pain-1", "pain-2"} for group in applied_groups
    )
    assert not any(
        len({"usage-1", "usage-2", "usage-3"}.intersection(group.member_fact_ids)) > 1
        for group in applied_groups
    )
    assert decision.metadata.stage == "SEMANTIC_REFINEMENT"
    assert decision.metadata.attempts >= 1
