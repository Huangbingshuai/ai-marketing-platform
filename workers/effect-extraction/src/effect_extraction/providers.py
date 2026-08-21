from __future__ import annotations

import asyncio
import json
import random
import re
from collections.abc import Mapping
from typing import Any, Protocol, TypeVar, cast

import httpx
from pydantic import BaseModel, ValidationError

from .models import ExtractionCandidate, ExtractionResult

TModel = TypeVar("TModel", bound=BaseModel)


class ProviderError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


class AiProvider(Protocol):
    async def extract_document(self, markdown: str, *, source_name: str) -> ExtractionCandidate: ...

    async def analyze_image(
        self,
        data_uri: str,
        *,
        source_name: str,
        image_metadata: Mapping[str, Any],
    ) -> ExtractionCandidate: ...

    async def normalize(self, fused: ExtractionCandidate) -> ExtractionResult: ...


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    compact = re.sub(r"\s+", " ", value).strip(" #\t\r\n")
    return compact or None


class MockAiProvider:
    """Deterministic provider used only when explicitly selected."""

    async def extract_document(self, markdown: str, *, source_name: str) -> ExtractionCandidate:
        lines = [_clean(line) for line in markdown.splitlines()]
        content = [line for line in lines if line]
        candidate = ExtractionCandidate.empty()
        if content:
            candidate.product_name = content[0][:120]
            candidate.core_specification = content[1][:240] if len(content) > 1 else None
            candidate.core_selling_points = content[2:5] or None
        return candidate

    async def analyze_image(
        self,
        data_uri: str,
        *,
        source_name: str,
        image_metadata: Mapping[str, Any],
    ) -> ExtractionCandidate:
        width = image_metadata.get("processedWidth")
        height = image_metadata.get("processedHeight")
        candidate = ExtractionCandidate.empty()
        candidate.visual_features = f"{source_name}，图像尺寸 {width}×{height}，产品主体清晰"
        return candidate

    async def normalize(self, fused: ExtractionCandidate) -> ExtractionResult:
        return ExtractionResult(
            product_category=fused.product_category or "待补充",
            product_name=fused.product_name or "待补充",
            core_specification=fused.core_specification or "待补充",
            price_range=fused.price_range or "待补充",
            visual_features=fused.visual_features or "待补充",
            target_audience=fused.target_audience or "待补充",
            marketing_goal=fused.marketing_goal or "待补充",
            core_selling_points=fused.core_selling_points or [],
            usage_scenarios=fused.usage_scenarios or "待补充",
            delivery_channels=fused.delivery_channels or "待补充",
            brand_tone=fused.brand_tone or "待补充",
            disabled_elements=fused.disabled_elements or [],
        )


class ArkResponsesProvider:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float = 120.0,
        max_attempts: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._model = model
        self._max_attempts = max_attempts
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=timeout,
            transport=transport,
            headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def extract_document(self, markdown: str, *, source_name: str) -> ExtractionCandidate:
        prompt = (
            "从以下产品资料 Markdown 中抽取可明确支持的字段。未知字段必须为 null，"
            "不得推测价格、功效或人群。\n"
            f"资料名：{source_name}\n\n{markdown}"
        )
        return await self._structured(
            [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            ExtractionCandidate,
            schema_name="effect_document_candidate",
        )

    async def analyze_image(
        self,
        data_uri: str,
        *,
        source_name: str,
        image_metadata: Mapping[str, Any],
    ) -> ExtractionCandidate:
        prompt = (
            "识别产品图片中可见且可验证的信息，包括包装文字、产品名称、品类、规格线索、"
            "外观、卖点和使用场景。不可见字段必须为 null。"
            f"\n文件名：{source_name}\n本地元数据：{json.dumps(dict(image_metadata), ensure_ascii=False)}"
        )
        return await self._structured(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {"type": "input_image", "image_url": data_uri},
                    ],
                }
            ],
            ExtractionCandidate,
            schema_name="effect_image_candidate",
        )

    async def normalize(self, fused: ExtractionCandidate) -> ExtractionResult:
        prompt = (
            "将已按来源优先级融合的候选数据标准化为最终产品 JSON。保持已给字段含义，"
            "不得引入无法从候选数据支持的具体价格、功效或规格；缺失字符串写“待补充”，"
            "缺失数组写空数组。候选数据：\n"
            + fused.model_dump_json(by_alias=True)
        )
        return await self._structured(
            [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            ExtractionResult,
            schema_name="effect_extraction_result",
        )

    async def _structured(
        self,
        input_items: list[dict[str, Any]],
        model_type: type[TModel],
        *,
        schema_name: str,
    ) -> TModel:
        schema = model_type.model_json_schema(by_alias=True)
        payload = {
            "model": self._model,
            "input": input_items,
            "store": False,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": schema_name,
                    "schema": schema,
                    "strict": True,
                }
            },
        }
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._client.post("responses", json=payload)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                retryable = True
            else:
                if not response.is_error:
                    try:
                        return model_type.model_validate_json(_output_text(response.json()))
                    except (ValueError, ValidationError, KeyError, TypeError) as exc:
                        last_error = exc
                        retryable = attempt == 1
                else:
                    last_error = RuntimeError(f"Ark returned HTTP {response.status_code}")
                    retryable = response.status_code == 429 or response.status_code >= 500
            if not retryable or attempt >= self._max_attempts:
                break
            delay = min(4.0, 0.4 * (2 ** (attempt - 1))) + random.uniform(0.0, 0.15)
            await asyncio.sleep(delay)
        raise ProviderError("Ark structured-output request failed", retryable=retryable) from last_error


def _output_text(payload: Any) -> str:
    if isinstance(payload, Mapping):
        direct = payload.get("output_text")
        if isinstance(direct, str) and direct.strip():
            return direct
        output = payload.get("output")
        if isinstance(output, list):
            for item in output:
                if not isinstance(item, Mapping) or item.get("type") != "message":
                    continue
                content = item.get("content")
                if not isinstance(content, list):
                    continue
                for part in content:
                    if isinstance(part, Mapping) and part.get("type") == "output_text":
                        text = part.get("text")
                        if isinstance(text, str) and text.strip():
                            return text
    raise ValueError("Ark response does not contain output_text")
