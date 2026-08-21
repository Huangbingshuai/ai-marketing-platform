import json

import httpx
import pytest

from effect_extraction.models import ExtractionCandidate
from effect_extraction.providers import ArkResponsesProvider


@pytest.mark.asyncio
async def test_ark_provider_sends_multimodal_strict_schema_without_store() -> None:
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        candidate = ExtractionCandidate.empty()
        candidate.visual_features = "红色包装"
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {"type": "output_text", "text": candidate.model_dump_json(by_alias=True)}
                        ],
                    }
                ]
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.test/api/v3/",
        api_key="secret",
        model="doubao-seed-2-1-turbo",
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.analyze_image(
            "data:image/jpeg;base64,AAAA",
            source_name="product.jpg",
            image_metadata={"processedWidth": 100, "processedHeight": 80},
        )
    finally:
        await provider.aclose()
    assert result.visual_features == "红色包装"
    assert captured["store"] is False
    assert captured["text"]["format"]["type"] == "json_schema"  # type: ignore[index]
    content = captured["input"][0]["content"]  # type: ignore[index]
    assert any(part.get("type") == "input_image" for part in content)
