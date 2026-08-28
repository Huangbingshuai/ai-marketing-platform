from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import random
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Generic, Protocol, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .models import (
    ExtractionCandidate,
    ExtractionResult,
    SemanticField,
    SemanticGroup,
    SemanticRefinementDecision,
    SemanticRelation,
)
from .prompt_loader import load_prompt_version, render_prompt

TModel = TypeVar("TModel", bound=BaseModel)
TResult = TypeVar("TResult", bound=BaseModel)

DOCUMENT_EXTRACTION_PROMPT = "document_extraction.prompt.txt"
IMAGE_ANALYSIS_PROMPT = "image_analysis.prompt.txt"
COMMERCE_EXTRACTION_PROMPT = "commerce_extraction.prompt.txt"
RESULT_NORMALIZATION_PROMPT = "result_normalization.prompt.txt"
SEMANTIC_REFINEMENT_PROMPT = "semantic_refinement.prompt.txt"
LOGGER = logging.getLogger(__name__)


class ProviderErrorType(StrEnum):
    TIMEOUT = "AI_TIMEOUT"
    NETWORK = "AI_NETWORK"
    RATE_LIMIT = "AI_RATE_LIMIT"
    SERVICE = "AI_SERVICE"
    RESPONSE_INVALID = "AI_RESPONSE_INVALID"
    REQUEST_REJECTED = "AI_REQUEST_REJECTED"
    UNKNOWN = "AI_UNKNOWN"


_PROVIDER_ERROR_MESSAGES: dict[ProviderErrorType, str] = {
    ProviderErrorType.TIMEOUT: "AI request timed out",
    ProviderErrorType.NETWORK: "AI network request failed",
    ProviderErrorType.RATE_LIMIT: "AI service rate limit exceeded",
    ProviderErrorType.SERVICE: "AI service request failed",
    ProviderErrorType.RESPONSE_INVALID: "AI structured response is invalid",
    ProviderErrorType.REQUEST_REJECTED: "AI request was rejected",
    ProviderErrorType.UNKNOWN: "AI structured-output request failed",
}


class ProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool,
        error_type: ProviderErrorType = ProviderErrorType.UNKNOWN,
        attempts: int = 1,
        elapsed_ms: int = 0,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.error_type = error_type
        self.attempts = max(1, attempts)
        self.elapsed_ms = max(0, elapsed_ms)


@dataclass(frozen=True, slots=True)
class AiCallMetadata:
    stage: str
    model: str
    prompt_version: str
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    latency_ms: int
    attempts: int

    def as_dict(self) -> dict[str, str | int | None]:
        return {
            "stage": self.stage,
            "model": self.model,
            "promptVersion": self.prompt_version,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "totalTokens": self.total_tokens,
            "latencyMs": self.latency_ms,
            "attempts": self.attempts,
        }


@dataclass(frozen=True, slots=True)
class AiCallResult(Generic[TResult]):
    value: TResult
    metadata: AiCallMetadata


@dataclass(frozen=True, slots=True)
class EmbeddingBatchResult:
    vectors: list[tuple[float, ...]]
    model: str
    request_count: int
    retry_count: int
    input_tokens: int
    latency_ms: int


class AiProvider(Protocol):
    async def embed_semantic_texts(self, texts: list[str]) -> EmbeddingBatchResult: ...

    async def refine_semantics(
        self,
        *,
        facts: Sequence[Mapping[str, str]],
        candidate_pairs: Sequence[Mapping[str, Any]],
    ) -> AiCallResult[SemanticRefinementDecision]: ...

    async def extract_document(
        self, markdown: str, *, source_name: str
    ) -> AiCallResult[ExtractionCandidate]: ...

    async def analyze_image(
        self,
        data_uri: str,
        *,
        source_name: str,
        image_metadata: Mapping[str, Any],
    ) -> AiCallResult[ExtractionCandidate]: ...

    async def extract_commerce(
        self,
        markdown: str,
        *,
        source_host: str,
        structured_metadata: Mapping[str, Any],
    ) -> AiCallResult[ExtractionCandidate]: ...

    async def normalize(
        self,
        fused: ExtractionCandidate,
        *,
        protected_input: Mapping[str, Any] | None = None,
    ) -> AiCallResult[ExtractionResult]: ...


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    compact = re.sub(r"\s+", " ", value).strip(" #\t\r\n")
    return compact or None


class MockAiProvider:
    """Deterministic provider used only when explicitly selected."""

    async def embed_semantic_texts(self, texts: list[str]) -> EmbeddingBatchResult:
        if not texts:
            raise ValueError("semantic embedding inputs cannot be empty")
        return EmbeddingBatchResult(
            vectors=[_mock_embedding(text) for text in texts],
            model="mock-hashed-bigram-v1",
            request_count=1,
            retry_count=0,
            input_tokens=sum(len(text) for text in texts),
            latency_ms=0,
        )

    async def refine_semantics(
        self,
        *,
        facts: Sequence[Mapping[str, str]],
        candidate_pairs: Sequence[Mapping[str, Any]],
    ) -> AiCallResult[SemanticRefinementDecision]:
        facts_by_id = {str(row["factId"]): row for row in facts}
        parent: dict[str, str] = {fact_id: fact_id for fact_id in facts_by_id}

        def find(value: str) -> str:
            while parent[value] != value:
                parent[value] = parent[parent[value]]
                value = parent[value]
            return value

        def union(left: str, right: str) -> None:
            left_root, right_root = find(left), find(right)
            if left_root != right_root:
                parent[right_root] = left_root

        for pair in candidate_pairs:
            score = pair.get("similarity")
            left, right = str(pair.get("leftFactId")), str(pair.get("rightFactId"))
            if isinstance(score, (int, float)) and score >= 0.58 and left in parent and right in parent:
                union(left, right)
        components: dict[str, list[str]] = {}
        for fact_id in parent:
            components.setdefault(find(fact_id), []).append(fact_id)
        groups: list[SemanticGroup] = []
        for member_ids in components.values():
            if len(member_ids) < 2:
                continue
            rows = [facts_by_id[member_id] for member_id in member_ids]
            if len({row["field"] for row in rows}) != 1:
                continue
            canonical = min((str(row["value"]) for row in rows), key=lambda value: (len(value), value))
            groups.append(
                SemanticGroup(
                    field=SemanticField(str(rows[0]["field"])),
                    member_fact_ids=member_ids,
                    canonical_value=canonical,
                    relation=SemanticRelation.SAME_MEANING,
                )
            )
        return _mock_result(
            SemanticRefinementDecision(groups=groups),
            "SEMANTIC_REFINEMENT",
            SEMANTIC_REFINEMENT_PROMPT,
        )

    async def extract_document(
        self, markdown: str, *, source_name: str
    ) -> AiCallResult[ExtractionCandidate]:
        lines = [_clean(line) for line in markdown.splitlines()]
        content = [line for line in lines if line]
        candidate = ExtractionCandidate.empty()
        if content:
            candidate.product_name = content[0][:120]
            candidate.core_specification = content[1][:240] if len(content) > 1 else None
            candidate.core_selling_points = content[2:5] or None
        return _mock_result(candidate, "DOCUMENT", DOCUMENT_EXTRACTION_PROMPT)

    async def analyze_image(
        self,
        data_uri: str,
        *,
        source_name: str,
        image_metadata: Mapping[str, Any],
    ) -> AiCallResult[ExtractionCandidate]:
        width = image_metadata.get("processedWidth")
        height = image_metadata.get("processedHeight")
        candidate = ExtractionCandidate.empty()
        candidate.visual_features = f"{source_name}，图像尺寸 {width}×{height}，产品主体清晰"
        return _mock_result(candidate, "IMAGE", IMAGE_ANALYSIS_PROMPT)

    async def extract_commerce(
        self,
        markdown: str,
        *,
        source_host: str,
        structured_metadata: Mapping[str, Any],
    ) -> AiCallResult[ExtractionCandidate]:
        candidate = ExtractionCandidate.empty()
        name = structured_metadata.get("name")
        category = structured_metadata.get("category")
        description = structured_metadata.get("description")
        candidate.product_name = _clean(name) if isinstance(name, str) else None
        candidate.product_category = _clean(category) if isinstance(category, str) else None
        if isinstance(description, str) and (cleaned := _clean(description)):
            candidate.secondary_selling_points = [cleaned[:240]]
        if candidate.product_name is None:
            lines = [_clean(line) for line in markdown.splitlines()]
            candidate.product_name = next((line[:120] for line in lines if line), None)
        return _mock_result(candidate, "COMMERCE", COMMERCE_EXTRACTION_PROMPT)

    async def normalize(
        self,
        fused: ExtractionCandidate,
        *,
        protected_input: Mapping[str, Any] | None = None,
    ) -> AiCallResult[ExtractionResult]:
        result = ExtractionResult(
            product_category=fused.product_category or "待补充",
            product_name=fused.product_name or "待补充",
            core_specification=fused.core_specification or "待补充",
            price_range=fused.price_range or "待补充",
            visual_features=fused.visual_features or "待补充",
            core_selling_points=(fused.core_selling_points or ["待补充"])[0:3],
            secondary_selling_points=(fused.secondary_selling_points or [])[0:6],
            trust_backings=(fused.trust_backings or [])[0:6],
            target_audience=fused.target_audience or "待补充",
            core_pain_points=(fused.core_pain_points or [])[0:5],
            decision_drivers=(fused.decision_drivers or [])[0:5],
            marketing_goal=fused.marketing_goal or "待补充",
            usage_scenarios=(fused.usage_scenarios or [])[0:5],
            purchase_scenarios=(fused.purchase_scenarios or [])[0:5],
            emotional_scenarios=(fused.emotional_scenarios or [])[0:5],
            duration_seconds=fused.duration_seconds or 20,
            aspect_ratio=fused.aspect_ratio or "9:16",
            resolution=fused.resolution or "1080P",
            delivery_channels=fused.delivery_channels or "待补充",
            disabled_elements=fused.disabled_elements or [],
            visual_style_baseline=fused.visual_style_baseline or "待补充",
        )
        return _mock_result(result, "NORMALIZATION", RESULT_NORMALIZATION_PROMPT)


class ArkResponsesProvider:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        document_model: str | None = None,
        commerce_model: str | None = None,
        image_model: str | None = None,
        semantic_model: str | None = None,
        normalization_model: str | None = None,
        embedding_model: str = "doubao-embedding-vision-251215",
        embedding_max_concurrency: int = 8,
        timeout: float = 120.0,
        max_attempts: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._document_model = _specific_model(document_model, model)
        self._commerce_model = _specific_model(commerce_model, self._document_model)
        self._image_model = _specific_model(image_model, model)
        self._semantic_model = _specific_model(semantic_model, model)
        self._normalization_model = _specific_model(normalization_model, model)
        self._embedding_model = _specific_model(embedding_model, embedding_model)
        self._embedding_max_concurrency = max(1, min(embedding_max_concurrency, 32))
        self._max_attempts = max(1, max_attempts)
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=timeout,
            transport=transport,
            headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def embed_semantic_texts(self, texts: list[str]) -> EmbeddingBatchResult:
        if not texts or any(not text.strip() for text in texts):
            raise ValueError("semantic embedding inputs cannot be empty")
        started_at = time.perf_counter()
        semaphore = asyncio.Semaphore(self._embedding_max_concurrency)

        async def request(text: str) -> tuple[tuple[float, ...], int, int]:
            async with semaphore:
                return await self._embed_one(text)

        rows = await asyncio.gather(*(request(text) for text in texts))
        return EmbeddingBatchResult(
            vectors=[row[0] for row in rows],
            model=self._embedding_model,
            request_count=sum(row[1] for row in rows),
            retry_count=sum(max(0, row[1] - 1) for row in rows),
            input_tokens=sum(row[2] for row in rows),
            latency_ms=max(0, round((time.perf_counter() - started_at) * 1000)),
        )

    async def refine_semantics(
        self,
        *,
        facts: Sequence[Mapping[str, str]],
        candidate_pairs: Sequence[Mapping[str, Any]],
    ) -> AiCallResult[SemanticRefinementDecision]:
        prompt = render_prompt(
            SEMANTIC_REFINEMENT_PROMPT,
            facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
            candidate_pairs_json=json.dumps(
                candidate_pairs, ensure_ascii=False, sort_keys=True
            ),
        )
        return await self._structured(
            [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            SemanticRefinementDecision,
            schema_name="effect_semantic_refinement",
            stage="SEMANTIC_REFINEMENT",
            model=self._semantic_model,
            prompt_version=load_prompt_version(SEMANTIC_REFINEMENT_PROMPT),
        )

    async def _embed_one(self, text: str) -> tuple[tuple[float, ...], int, int]:
        last_error: Exception | None = None
        last_error_type = ProviderErrorType.UNKNOWN
        retryable = False
        started_at = time.perf_counter()
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._client.post(
                    "embeddings/multimodal",
                    json={
                        "model": self._embedding_model,
                        "input": [{"type": "text", "text": text}],
                        "encoding_format": "float",
                    },
                )
            except httpx.TimeoutException as exc:
                last_error = exc
                last_error_type = ProviderErrorType.TIMEOUT
                retryable = True
            except httpx.NetworkError as exc:
                last_error = exc
                last_error_type = ProviderErrorType.NETWORK
                retryable = True
            else:
                if not response.is_error:
                    try:
                        payload = response.json()
                        vector = _embedding_vector(payload)
                        usage = _usage(payload)
                        return vector, attempt, usage["inputTokens"] or 0
                    except (TypeError, ValueError, KeyError) as exc:
                        last_error = exc
                        last_error_type = ProviderErrorType.RESPONSE_INVALID
                        retryable = attempt == 1
                elif response.status_code == 429:
                    last_error = RuntimeError("Ark embedding rate limited")
                    last_error_type = ProviderErrorType.RATE_LIMIT
                    retryable = True
                elif response.status_code >= 500:
                    last_error = RuntimeError("Ark embedding service unavailable")
                    last_error_type = ProviderErrorType.SERVICE
                    retryable = True
                else:
                    last_error = RuntimeError("Ark embedding request rejected")
                    last_error_type = ProviderErrorType.REQUEST_REJECTED
                    retryable = False
            if not retryable or attempt >= self._max_attempts:
                break
            await asyncio.sleep(min(4.0, 0.4 * (2 ** (attempt - 1))) + random.uniform(0.0, 0.15))
        raise ProviderError(
            _PROVIDER_ERROR_MESSAGES[last_error_type],
            retryable=retryable,
            error_type=last_error_type,
            attempts=attempt,
            elapsed_ms=max(0, round((time.perf_counter() - started_at) * 1000)),
        ) from last_error

    async def extract_document(
        self, markdown: str, *, source_name: str
    ) -> AiCallResult[ExtractionCandidate]:
        prompt = render_prompt(
            DOCUMENT_EXTRACTION_PROMPT,
            source_name=source_name,
            document_markdown=markdown,
        )
        return await self._structured(
            [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            ExtractionCandidate,
            schema_name="effect_document_candidate",
            stage="DOCUMENT",
            model=self._document_model,
            prompt_version=load_prompt_version(DOCUMENT_EXTRACTION_PROMPT),
        )

    async def analyze_image(
        self,
        data_uri: str,
        *,
        source_name: str,
        image_metadata: Mapping[str, Any],
    ) -> AiCallResult[ExtractionCandidate]:
        prompt = render_prompt(
            IMAGE_ANALYSIS_PROMPT,
            source_name=source_name,
            image_metadata_json=json.dumps(dict(image_metadata), ensure_ascii=False),
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
            stage="IMAGE",
            model=self._image_model,
            prompt_version=load_prompt_version(IMAGE_ANALYSIS_PROMPT),
        )

    async def extract_commerce(
        self,
        markdown: str,
        *,
        source_host: str,
        structured_metadata: Mapping[str, Any],
    ) -> AiCallResult[ExtractionCandidate]:
        prompt = render_prompt(
            COMMERCE_EXTRACTION_PROMPT,
            source_host=source_host,
            structured_metadata_json=json.dumps(
                dict(structured_metadata), ensure_ascii=False, sort_keys=True
            ),
            commerce_markdown=markdown,
        )
        return await self._structured(
            [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            ExtractionCandidate,
            schema_name="effect_commerce_candidate",
            stage="COMMERCE",
            model=self._commerce_model,
            prompt_version=load_prompt_version(COMMERCE_EXTRACTION_PROMPT),
        )

    async def normalize(
        self,
        fused: ExtractionCandidate,
        *,
        protected_input: Mapping[str, Any] | None = None,
    ) -> AiCallResult[ExtractionResult]:
        prompt = render_prompt(
            RESULT_NORMALIZATION_PROMPT,
            fused_candidate_json=fused.model_dump_json(by_alias=True),
            protected_user_input_json=json.dumps(
                dict(protected_input or {}), ensure_ascii=False, sort_keys=True
            ),
        )
        return await self._structured(
            [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            ExtractionResult,
            schema_name="effect_extraction_result",
            stage="NORMALIZATION",
            model=self._normalization_model,
            prompt_version=load_prompt_version(RESULT_NORMALIZATION_PROMPT),
        )

    async def _structured(
        self,
        input_items: list[dict[str, Any]],
        model_type: type[TModel],
        *,
        schema_name: str,
        stage: str,
        model: str,
        prompt_version: str,
    ) -> AiCallResult[TModel]:
        schema = model_type.model_json_schema(by_alias=True)
        payload = {
            "model": model,
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
        last_error_type = ProviderErrorType.UNKNOWN
        retryable = False
        attempts = 0
        started_at = time.perf_counter()
        for attempt in range(1, self._max_attempts + 1):
            attempts = attempt
            try:
                response = await self._client.post("responses", json=payload)
            except httpx.TimeoutException as exc:
                last_error = exc
                last_error_type = ProviderErrorType.TIMEOUT
                retryable = True
            except httpx.NetworkError as exc:
                last_error = exc
                last_error_type = ProviderErrorType.NETWORK
                retryable = True
            else:
                if not response.is_error:
                    try:
                        response_payload = response.json()
                        value = model_type.model_validate_json(_output_text(response_payload))
                        usage = _usage(response_payload)
                        metadata = AiCallMetadata(
                            stage=stage,
                            model=model,
                            prompt_version=prompt_version,
                            input_tokens=usage["inputTokens"],
                            output_tokens=usage["outputTokens"],
                            total_tokens=usage["totalTokens"],
                            latency_ms=max(0, round((time.perf_counter() - started_at) * 1000)),
                            attempts=attempt,
                        )
                        LOGGER.info(
                            "Ark call succeeded stage=%s model=%s prompt_version=%s "
                            "input_tokens=%s output_tokens=%s total_tokens=%s "
                            "latency_ms=%s attempts=%s",
                            metadata.stage,
                            metadata.model,
                            metadata.prompt_version,
                            metadata.input_tokens,
                            metadata.output_tokens,
                            metadata.total_tokens,
                            metadata.latency_ms,
                            metadata.attempts,
                        )
                        return AiCallResult(
                            value=value,
                            metadata=metadata,
                        )
                    except (ValueError, ValidationError, KeyError, TypeError) as exc:
                        last_error = exc
                        last_error_type = ProviderErrorType.RESPONSE_INVALID
                        retryable = attempt == 1
                else:
                    last_error = RuntimeError("Ark returned a non-success response")
                    if response.status_code == 429:
                        last_error_type = ProviderErrorType.RATE_LIMIT
                        retryable = True
                    elif response.status_code >= 500:
                        last_error_type = ProviderErrorType.SERVICE
                        retryable = True
                    else:
                        last_error_type = ProviderErrorType.REQUEST_REJECTED
                        retryable = False
            if not retryable or attempt >= self._max_attempts:
                break
            delay = min(4.0, 0.4 * (2 ** (attempt - 1))) + random.uniform(0.0, 0.15)
            await asyncio.sleep(delay)
        elapsed_ms = max(0, round((time.perf_counter() - started_at) * 1000))
        raise ProviderError(
            _PROVIDER_ERROR_MESSAGES[last_error_type],
            retryable=retryable,
            error_type=last_error_type,
            attempts=attempts,
            elapsed_ms=elapsed_ms,
        ) from last_error


def _specific_model(value: str | None, fallback: str) -> str:
    specific = value.strip() if value is not None else ""
    resolved = specific or fallback.strip()
    if not resolved:
        raise ValueError("Ark model cannot be empty")
    return resolved


def _token(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _usage(payload: Any) -> dict[str, int | None]:
    usage = payload.get("usage") if isinstance(payload, Mapping) else None
    if not isinstance(usage, Mapping):
        usage = {}
    return {
        "inputTokens": _token(usage.get("input_tokens", usage.get("inputTokens"))),
        "outputTokens": _token(usage.get("output_tokens", usage.get("outputTokens"))),
        "totalTokens": _token(usage.get("total_tokens", usage.get("totalTokens"))),
    }


def _mock_result(value: TResult, stage: str, prompt_file: str) -> AiCallResult[TResult]:
    return AiCallResult(
        value=value,
        metadata=AiCallMetadata(
            stage=stage,
            model="mock",
            prompt_version=load_prompt_version(prompt_file),
            input_tokens=None,
            output_tokens=None,
            total_tokens=None,
            latency_ms=0,
            attempts=1,
        ),
    )


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


def _embedding_vector(payload: Any) -> tuple[float, ...]:
    if not isinstance(payload, Mapping):
        raise ValueError("embedding response is invalid")
    data = payload.get("data")
    if isinstance(data, list):
        data = data[0] if data else None
    if not isinstance(data, Mapping):
        raise ValueError("embedding response data is missing")
    raw = data.get("embedding")
    if isinstance(raw, list) and len(raw) == 1 and isinstance(raw[0], list):
        raw = raw[0]
    if not isinstance(raw, list) or not raw:
        raise ValueError("embedding vector is empty")
    vector = tuple(float(value) for value in raw)
    if any(not math.isfinite(value) for value in vector) or not any(vector):
        raise ValueError("embedding vector is invalid")
    return vector


def _mock_embedding(value: str, dimension: int = 128) -> tuple[float, ...]:
    normalized = re.sub(r"[^\w\u4e00-\u9fff]+", "", value.lower())
    grams = (
        {normalized}
        if len(normalized) < 2
        else {normalized[index : index + 2] for index in range(len(normalized) - 1)}
    )
    vector = [0.0] * dimension
    for gram in grams or {"empty"}:
        digest = hashlib.sha256(gram.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimension
        vector[index] += 1.0 if digest[4] % 2 == 0 else -1.0
    if not any(vector):
        vector[0] = 1.0
    return tuple(vector)
