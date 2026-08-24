from __future__ import annotations

import os

import pytest

from effect_extraction.models import ExtractionCandidate, ExtractionResult
from effect_extraction.providers import ArkResponsesProvider


_RUN_REAL_ARK = os.getenv("RUN_ARK_INTEGRATION") == "1"

pytestmark = [
    pytest.mark.ark_integration,
    pytest.mark.skipif(
        not _RUN_REAL_ARK,
        reason="set RUN_ARK_INTEGRATION=1 to call the real Ark endpoint",
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
    endpoint = _required_environment("ARK_MODEL")
    if not endpoint.startswith("ep-"):
        pytest.fail("ARK_MODEL must be an Ark Endpoint ID beginning with 'ep-'")

    provider = ArkResponsesProvider(
        base_url=os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        api_key=api_key,
        model=endpoint,
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
            image_metadata={"processedWidth": 64, "processedHeight": 64, "format": "PNG"},
        )
        normalized = await provider.normalize(
            ExtractionCandidate(
                product_category="饮料",
                product_name="山泉气泡水",
                core_specification="500ml",
                price_range=None,
                visual_features="透明瓶身",
                target_audience="成年消费者",
                marketing_goal="商品认知",
                core_selling_points=["无糖"],
                usage_scenarios="户外",
                delivery_channels="短视频",
                brand_tone="清新",
                disabled_elements=["医疗功效承诺"],
            )
        )
    finally:
        await provider.aclose()

    assert isinstance(document, ExtractionCandidate)
    assert isinstance(image, ExtractionCandidate)
    assert isinstance(normalized, ExtractionResult)
    assert normalized.product_name.strip()
    assert isinstance(normalized.core_selling_points, list)
