from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import operator
import random
import re
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from itertools import combinations
from typing import Any, Literal, Protocol

import httpx
import numpy as np
import numpy.typing as npt

from .models import CreativeCandidate, PromptItemV6, SharedPrompt
from .quality import normalize_creative_signature

LOGGER = logging.getLogger(__name__)

EMBEDDING_TEXT_VERSION = "effect-prompt-embedding-text-v1"
CONTENT_MMR_EMBEDDING_TEXT_VERSION = "effect-prompt-embedding-text-v2"
MAX_EMBEDDING_INPUTS = 256
VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD = 0.82

_DURATION = re.compile(
    r"(?:(?:视频)?时长\s*[:：]?\s*)?\d+\s*(?:秒|s)(?=\s*[,，。；;]|$)",
    re.IGNORECASE,
)
_ASPECT = re.compile(
    r"(?:(?:画幅|比例)\s*[:：]?\s*)?\d+\s*[:：x×]\s*\d+(?:\s*(?:画幅|比例))?",
    re.IGNORECASE,
)
_RESOLUTION = re.compile(r"(?:分辨率|清晰度)\s*[:：]?\s*\d+[pk]?", re.IGNORECASE)
_CHANNEL = re.compile(r"(?:投放)?渠道\s*[:：][^。；;\n]+", re.IGNORECASE)
_FIXED_TAIL = re.compile(
    r"(?:画面中不得出现以下内容|统一禁用元素|负向约束|合规要求)\s*[:：][^\n]+",
    re.IGNORECASE,
)


class EmbeddingProviderError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class EmbeddingBatchResult:
    vectors: list[tuple[float, ...]]
    request_count: int
    input_tokens: int
    retry_count: int


class EmbeddingProvider(Protocol):
    execution_mode: str
    cache_namespace: str
    max_inputs_per_request: int

    async def embed(self, texts: list[str]) -> EmbeddingBatchResult: ...

    async def aclose(self) -> None: ...


class MockEmbeddingProvider:
    execution_mode = "MOCK"
    cache_namespace = "mock-hashed-trigram-v1"
    max_inputs_per_request = MAX_EMBEDDING_INPUTS

    async def embed(self, texts: list[str]) -> EmbeddingBatchResult:
        if not texts or len(texts) > MAX_EMBEDDING_INPUTS:
            raise ValueError("embedding input count must be between 1 and 256")
        return EmbeddingBatchResult(
            vectors=[_mock_vector(text) for text in texts],
            request_count=1,
            input_tokens=sum(len(text) for text in texts),
            retry_count=0,
        )

    async def aclose(self) -> None:
        return None


class ArkEmbeddingProvider:
    execution_mode = "ARK"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        api_mode: Literal["text", "multimodal"] = "multimodal",
        timeout: float = 30.0,
        max_attempts: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        model = model.strip()
        if not model:
            raise ValueError("Ark embedding model cannot be empty")
        self._model = model
        self._api_mode = api_mode
        self.max_inputs_per_request = (
            1 if api_mode == "multimodal" else MAX_EMBEDDING_INPUTS
        )
        namespace = f"{api_mode}:{model}"
        self.cache_namespace = hashlib.sha256(namespace.encode("utf-8")).hexdigest()[
            :16
        ]
        self._max_attempts = max(1, min(max_attempts, 3))
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=timeout,
            transport=transport,
            headers={
                "authorization": f"Bearer {api_key}",
                "content-type": "application/json",
            },
        )

    async def embed(self, texts: list[str]) -> EmbeddingBatchResult:
        if not texts or len(texts) > self.max_inputs_per_request:
            raise ValueError(
                "embedding input count must be between 1 and "
                f"{self.max_inputs_per_request}"
            )
        if any(not text.strip() for text in texts):
            raise ValueError("embedding inputs cannot be empty")

        attempts = 0
        last_error: Exception | None = None
        while attempts < self._max_attempts:
            attempts += 1
            response: httpx.Response | None = None
            try:
                endpoint, request_input = self._request_payload(texts)
                response = await self._client.post(
                    endpoint,
                    json={
                        "model": self._model,
                        "input": request_input,
                        "encoding_format": "float",
                    },
                )
                if response.status_code == 429 or response.status_code >= 500:
                    raise EmbeddingProviderError(
                        "火山向量服务暂时不可用",
                        retryable=True,
                    )
                if response.status_code >= 400:
                    raise EmbeddingProviderError(
                        "火山向量请求配置或鉴权无效",
                        retryable=False,
                    )
                payload = response.json()
                vectors = _parse_ark_vectors(
                    payload,
                    len(texts),
                    indexed=self._api_mode == "text",
                )
                usage = payload.get("usage") if isinstance(payload, dict) else None
                input_tokens = _usage_input_tokens(usage)
                return EmbeddingBatchResult(
                    vectors=vectors,
                    request_count=attempts,
                    input_tokens=input_tokens,
                    retry_count=attempts - 1,
                )
            except EmbeddingProviderError as exc:
                last_error = exc
                if not exc.retryable or attempts >= self._max_attempts:
                    raise
                await asyncio.sleep(_retry_delay(response, attempts))
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error = exc
                if attempts >= self._max_attempts:
                    raise EmbeddingProviderError(
                        "火山向量服务网络请求失败",
                        retryable=True,
                    ) from exc
                await asyncio.sleep(_retry_delay(response, attempts))
            except (TypeError, ValueError) as exc:
                raise EmbeddingProviderError(
                    "火山向量服务返回了无效响应",
                    retryable=False,
                ) from exc
        raise EmbeddingProviderError(
            "火山向量服务请求失败",
            retryable=True,
        ) from last_error

    async def aclose(self) -> None:
        await self._client.aclose()

    def _request_payload(self, texts: list[str]) -> tuple[str, Any]:
        if self._api_mode == "multimodal":
            return (
                "embeddings/multimodal",
                [{"type": "text", "text": texts[0]}],
            )
        return "embeddings", texts


@dataclass(frozen=True, slots=True)
class PairSimilarity:
    content: float
    creative: float
    structural: float
    risk: float


@dataclass(frozen=True, slots=True)
class EmbeddingComparisonStats:
    input_count: int
    request_count: int
    input_tokens: int
    retry_count: int
    cache_hit_count: int
    comparison_count: int
    duration_ms: float
    local_comparison_ms: float
    content_p50: float
    content_p95: float
    creative_p50: float
    creative_p95: float
    high_risk_pairs: list[dict[str, int | float]]


@dataclass(frozen=True, slots=True)
class CreativeVectorIndex:
    pairs: dict[tuple[str, str], PairSimilarity]
    stats: EmbeddingComparisonStats

    def pair_similarity(self, left_id: str, right_id: str) -> PairSimilarity:
        return self.pairs[_pair_key(left_id, right_id)]

    def dual_novelty(self, left_id: str, right_id: str) -> float:
        pair = self.pair_similarity(left_id, right_id)
        return round(100.0 * (1.0 - pair.risk), 4)

    def content_novelty(self, left_id: str, right_id: str) -> float:
        pair = self.pair_similarity(left_id, right_id)
        return round(100.0 * (1.0 - pair.content), 4)


@dataclass(frozen=True, slots=True)
class ContentEmbeddingStats:
    input_count: int
    request_count: int
    input_tokens: int
    retry_count: int
    cache_hit_count: int
    comparison_count: int
    duration_ms: float
    local_comparison_ms: float
    similarity_p50: float
    similarity_p95: float
    high_risk_pairs: list[dict[str, int | float | bool]]


@dataclass(frozen=True, slots=True)
class RedundancySummary:
    high_risk_group_count: int
    high_risk_pair_count: int
    redundant_candidate_count: int
    high_risk_candidate_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ContentVectorIndex:
    entity_ids: tuple[str, ...]
    row_by_id: dict[str, int]
    candidate_ids: tuple[str, ...]
    anchor_ids: tuple[str, ...]
    similarities: npt.NDArray[np.float32]
    stats: ContentEmbeddingStats

    def _row(self, entity_id: str) -> int:
        try:
            return self.row_by_id[entity_id]
        except KeyError as exc:
            raise KeyError(entity_id) from exc

    def similarity(self, left_id: str, right_id: str) -> float:
        return float(self.similarities[self._row(left_id), self._row(right_id)])

    def novelty(self, left_id: str, right_id: str) -> float:
        return round(100.0 * (1.0 - self.similarity(left_id, right_id)), 4)

    def novelty_to_anchors(self, candidate_id: str) -> float:
        if not self.anchor_ids:
            return 100.0
        risk = max(
            self.similarity(candidate_id, anchor_id) for anchor_id in self.anchor_ids
        )
        return round(100.0 * (1.0 - risk), 4)

    def redundancy_summary(
        self,
        selected_ids: list[str],
        *,
        threshold: float = VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD,
    ) -> RedundancySummary:
        selected = [item for item in selected_ids if item in self.candidate_ids]
        anchors = list(self.anchor_ids)
        nodes = [*selected, *anchors]
        parent = {node: node for node in nodes}

        def find(node: str) -> str:
            while parent[node] != node:
                parent[node] = parent[parent[node]]
                node = parent[node]
            return node

        def union(left: str, right: str) -> None:
            left_root = find(left)
            right_root = find(right)
            if left_root != right_root:
                parent[right_root] = left_root

        pair_count = 0
        for left_index, left_id in enumerate(selected):
            for right_id in selected[left_index + 1 :]:
                if self.similarity(left_id, right_id) >= threshold:
                    pair_count += 1
                    union(left_id, right_id)
            for anchor_id in anchors:
                if self.similarity(left_id, anchor_id) >= threshold:
                    pair_count += 1
                    union(left_id, anchor_id)

        components: dict[str, set[str]] = {}
        for node in nodes:
            components.setdefault(find(node), set()).add(node)
        selected_set = set(selected)
        anchor_set = set(anchors)
        redundant_count = 0
        group_count = 0
        high_risk_ids: set[str] = set()
        for members in components.values():
            candidate_members = members & selected_set
            if not candidate_members:
                continue
            contains_anchor = bool(members & anchor_set)
            if contains_anchor or len(candidate_members) > 1:
                group_count += 1
                high_risk_ids.update(candidate_members)
                redundant_count += (
                    len(candidate_members)
                    if contains_anchor
                    else max(0, len(candidate_members) - 1)
                )
        return RedundancySummary(
            high_risk_group_count=group_count,
            high_risk_pair_count=pair_count,
            redundant_candidate_count=redundant_count,
            high_risk_candidate_ids=tuple(
                item for item in selected if item in high_risk_ids
            ),
        )


async def build_content_vector_index(
    candidates: list[CreativeCandidate],
    anchors: list[PromptItemV6],
    *,
    provider: EmbeddingProvider,
    vector_cache: dict[str, tuple[float, ...]],
    product_name: str | None,
    product_category: str | None,
    shared_prompt: SharedPrompt,
    batch_size: int,
    max_concurrency: int,
) -> ContentVectorIndex:
    started = time.perf_counter()
    ordered_candidates = sorted(candidates, key=lambda item: item.ordinal)
    ordered_anchors = list(anchors)
    documents: dict[str, str] = {}
    entity_document_keys: dict[str, str] = {}
    candidate_ids: list[str] = []
    anchor_ids: list[str] = []

    def register(entity_id: str, content: str) -> None:
        text = compile_content_embedding_text(
            content,
            product_name=product_name,
            product_category=product_category,
            shared_prompt=shared_prompt,
        )
        key = _cache_key(
            provider.cache_namespace,
            text,
            version=CONTENT_MMR_EMBEDDING_TEXT_VERSION,
        )
        documents.setdefault(key, text)
        entity_document_keys[entity_id] = key

    for candidate in ordered_candidates:
        candidate_ids.append(candidate.slot_id)
        register(candidate.slot_id, candidate.content)
    for index, anchor in enumerate(ordered_anchors):
        anchor_id = f"anchor:{index}"
        anchor_ids.append(anchor_id)
        register(anchor_id, anchor.content)

    missing = [
        (key, text) for key, text in documents.items() if key not in vector_cache
    ]
    cache_hit_count = len(documents) - len(missing)
    safe_batch_size = max(
        1,
        min(batch_size, MAX_EMBEDDING_INPUTS, provider.max_inputs_per_request),
    )
    batches = [
        missing[index : index + safe_batch_size]
        for index in range(0, len(missing), safe_batch_size)
    ]
    semaphore = asyncio.Semaphore(max(1, max_concurrency))

    async def embed_batch(
        batch: list[tuple[str, str]],
    ) -> tuple[list[tuple[str, tuple[float, ...]]], EmbeddingBatchResult]:
        async with semaphore:
            result = await provider.embed([text for _, text in batch])
        if len(result.vectors) != len(batch):
            raise EmbeddingProviderError(
                "向量响应数量与请求不一致",
                retryable=False,
            )
        return list(zip((key for key, _ in batch), result.vectors, strict=True)), result

    request_count = input_tokens = retry_count = 0
    if batches:
        responses = await asyncio.gather(*(embed_batch(batch) for batch in batches))
        for rows, result in responses:
            request_count += result.request_count
            input_tokens += result.input_tokens
            retry_count += result.retry_count
            vector_cache.update(rows)

    entity_ids = tuple([*candidate_ids, *anchor_ids])
    comparison_started = time.perf_counter()
    matrix = np.asarray(
        [vector_cache[entity_document_keys[entity_id]] for entity_id in entity_ids],
        dtype=np.float32,
    )
    if matrix.ndim != 2 or matrix.shape[0] != len(entity_ids):
        raise EmbeddingProviderError("向量矩阵结构无效", retryable=False)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    if np.any(~np.isfinite(norms)) or np.any(norms <= 0):
        raise EmbeddingProviderError("向量矩阵包含无效数值", retryable=False)
    normalized = matrix / norms
    similarities = np.clip(normalized @ normalized.T, 0.0, 1.0).astype(
        np.float32,
        copy=False,
    )
    local_comparison_ms = (time.perf_counter() - comparison_started) * 1000.0

    candidate_count = len(candidate_ids)
    candidate_scores = [
        float(similarities[left, right])
        for left in range(candidate_count)
        for right in range(left + 1, candidate_count)
    ]
    safe_pairs: list[dict[str, int | float | bool]] = []
    ranked_pairs: list[tuple[float, int, int, bool]] = []
    for left in range(candidate_count):
        for right in range(left + 1, candidate_count):
            ranked_pairs.append((float(similarities[left, right]), left, right, False))
        for anchor_offset in range(len(anchor_ids)):
            right = candidate_count + anchor_offset
            ranked_pairs.append(
                (float(similarities[left, right]), left, anchor_offset, True)
            )
    for score, left, right, right_is_anchor in sorted(ranked_pairs, reverse=True)[:3]:
        safe_pairs.append(
            {
                "leftOrdinal": ordered_candidates[left].ordinal,
                "rightOrdinal": right + 1,
                "rightIsAnchor": right_is_anchor,
                "similarity": round(score, 4),
            }
        )
    duration_ms = (time.perf_counter() - started) * 1000.0
    LOGGER.info(
        "content embedding comparison completed inputs=%s requests=%s retries=%s pairs=%s duration_ms=%.2f",
        len(documents),
        request_count,
        retry_count,
        len(ranked_pairs),
        duration_ms,
    )
    return ContentVectorIndex(
        entity_ids=entity_ids,
        row_by_id={entity_id: index for index, entity_id in enumerate(entity_ids)},
        candidate_ids=tuple(candidate_ids),
        anchor_ids=tuple(anchor_ids),
        similarities=similarities,
        stats=ContentEmbeddingStats(
            input_count=len(documents),
            request_count=request_count,
            input_tokens=input_tokens,
            retry_count=retry_count,
            cache_hit_count=cache_hit_count,
            comparison_count=len(ranked_pairs),
            duration_ms=round(duration_ms, 3),
            local_comparison_ms=round(local_comparison_ms, 3),
            similarity_p50=round(_percentile(candidate_scores, 0.50), 6),
            similarity_p95=round(_percentile(candidate_scores, 0.95), 6),
            high_risk_pairs=safe_pairs,
        ),
    )


async def build_creative_vector_index(
    candidates: list[CreativeCandidate],
    *,
    provider: EmbeddingProvider,
    vector_cache: dict[str, tuple[float, ...]],
    product_name: str | None,
    product_category: str | None,
    shared_prompt: SharedPrompt,
    batch_size: int,
    max_concurrency: int,
) -> CreativeVectorIndex:
    started = time.perf_counter()
    ordered = sorted(candidates, key=lambda item: item.ordinal)
    documents: dict[str, str] = {}
    slot_keys: dict[str, tuple[str, str]] = {}
    for candidate in ordered:
        content_text = compile_content_embedding_text(
            candidate.content,
            product_name=product_name,
            product_category=product_category,
            shared_prompt=shared_prompt,
        )
        creative_text = compile_creative_embedding_text(
            candidate,
            product_name=product_name,
            product_category=product_category,
        )
        content_key = _cache_key(provider.cache_namespace, content_text)
        creative_key = _cache_key(provider.cache_namespace, creative_text)
        documents.setdefault(content_key, content_text)
        documents.setdefault(creative_key, creative_text)
        slot_keys[candidate.slot_id] = (content_key, creative_key)

    missing = [
        (key, text) for key, text in documents.items() if key not in vector_cache
    ]
    cache_hit_count = len(documents) - len(missing)
    request_count = 0
    input_tokens = 0
    retry_count = 0
    semaphore = asyncio.Semaphore(max(1, max_concurrency))
    safe_batch_size = max(
        1,
        min(batch_size, MAX_EMBEDDING_INPUTS, provider.max_inputs_per_request),
    )
    batches = [
        missing[index : index + safe_batch_size]
        for index in range(0, len(missing), safe_batch_size)
    ]

    async def embed_batch(
        batch: list[tuple[str, str]],
    ) -> tuple[list[tuple[str, tuple[float, ...]]], EmbeddingBatchResult]:
        async with semaphore:
            result = await provider.embed([text for _, text in batch])
        if len(result.vectors) != len(batch):
            raise EmbeddingProviderError(
                "向量响应数量与请求不一致",
                retryable=False,
            )
        return list(zip((key for key, _ in batch), result.vectors, strict=True)), result

    if batches:
        responses = await asyncio.gather(*(embed_batch(batch) for batch in batches))
        for rows, result in responses:
            request_count += result.request_count
            input_tokens += result.input_tokens
            retry_count += result.retry_count
            vector_cache.update(rows)

    comparison_started = time.perf_counter()
    normalized_vectors = {
        key: _normalize_vector(vector_cache[key]) for key in documents
    }
    pair_rows: dict[tuple[str, str], PairSimilarity] = {}
    content_scores: list[float] = []
    creative_scores: list[float] = []
    for left, right in combinations(ordered, 2):
        left_content, left_creative = slot_keys[left.slot_id]
        right_content, right_creative = slot_keys[right.slot_id]
        content = _clamp_similarity(
            _normalized_dot(
                normalized_vectors[left_content],
                normalized_vectors[right_content],
            )
        )
        creative_cosine = _clamp_similarity(
            _normalized_dot(
                normalized_vectors[left_creative],
                normalized_vectors[right_creative],
            )
        )
        structural = _structural_overlap(left, right)
        creative = _clamp_similarity(0.8 * creative_cosine + 0.2 * structural)
        risk = max(content, creative)
        pair_rows[_pair_key(left.slot_id, right.slot_id)] = PairSimilarity(
            content=content,
            creative=creative,
            structural=structural,
            risk=risk,
        )
        content_scores.append(content)
        creative_scores.append(creative)
    local_comparison_ms = (time.perf_counter() - comparison_started) * 1000.0

    candidate_by_id = {item.slot_id: item for item in ordered}
    high_risk = sorted(
        pair_rows.items(),
        key=lambda item: item[1].risk,
        reverse=True,
    )[:3]
    safe_pairs = [
        {
            "leftOrdinal": candidate_by_id[left_id].ordinal,
            "rightOrdinal": candidate_by_id[right_id].ordinal,
            "contentSimilarity": round(row.content, 4),
            "creativeSimilarity": round(row.creative, 4),
            "structuralOverlap": round(row.structural, 4),
            "risk": round(row.risk, 4),
        }
        for (left_id, right_id), row in high_risk
    ]
    duration_ms = (time.perf_counter() - started) * 1000.0
    LOGGER.info(
        "embedding comparison completed inputs=%s requests=%s retries=%s pairs=%s duration_ms=%.2f",
        len(documents),
        request_count,
        retry_count,
        len(pair_rows),
        duration_ms,
    )
    return CreativeVectorIndex(
        pairs=pair_rows,
        stats=EmbeddingComparisonStats(
            input_count=len(documents),
            request_count=request_count,
            input_tokens=input_tokens,
            retry_count=retry_count,
            cache_hit_count=cache_hit_count,
            comparison_count=len(pair_rows),
            duration_ms=round(duration_ms, 3),
            local_comparison_ms=round(local_comparison_ms, 3),
            content_p50=round(_percentile(content_scores, 0.50), 6),
            content_p95=round(_percentile(content_scores, 0.95), 6),
            creative_p50=round(_percentile(creative_scores, 0.50), 6),
            creative_p95=round(_percentile(creative_scores, 0.95), 6),
            high_risk_pairs=safe_pairs,
        ),
    )


def compile_content_embedding_text(
    content: str,
    *,
    product_name: str | None,
    product_category: str | None,
    shared_prompt: SharedPrompt,
) -> str:
    value = unicodedata.normalize("NFKC", content)
    for section in shared_prompt.sections:
        if section.content.strip():
            value = value.replace(section.content.strip(), " ")
    if shared_prompt.compiled_content.strip():
        value = value.replace(shared_prompt.compiled_content.strip(), " ")
    for pattern in (_DURATION, _ASPECT, _RESOLUTION, _CHANNEL, _FIXED_TAIL):
        value = pattern.sub(" ", value)
    return _normalize_embedding_text(
        value,
        product_name=product_name,
        product_category=product_category,
    )


def compile_creative_embedding_text(
    candidate: CreativeCandidate,
    *,
    product_name: str | None,
    product_category: str | None,
) -> str:
    dimensions = candidate.dimensions
    value = "\n".join(
        (
            f"叙事：{dimensions.narrative}",
            f"场景：{dimensions.scene}",
            f"人物：{dimensions.persona}",
            f"产品关联：{dimensions.product_relation}",
            f"镜头：{dimensions.camera}",
            f"情绪：{dimensions.emotion}",
        )
    )
    return _normalize_embedding_text(
        value,
        product_name=product_name,
        product_category=product_category,
    )


def _normalize_embedding_text(
    value: str,
    *,
    product_name: str | None,
    product_category: str | None,
) -> str:
    for source, replacement in (
        (product_name, "[产品]"),
        (product_category, "[品类]"),
    ):
        if source and source.strip():
            value = re.sub(
                re.escape(source.strip()), replacement, value, flags=re.IGNORECASE
            )
    value = re.sub(r"\s+", " ", value).strip()
    return value or "[空画面描述]"


def _parse_ark_vectors(
    payload: Any,
    expected_count: int,
    *,
    indexed: bool,
) -> list[tuple[float, ...]]:
    if not isinstance(payload, dict):
        raise ValueError("embedding response data is missing")
    raw_data = payload.get("data")
    if indexed:
        if not isinstance(raw_data, list):
            raise ValueError("embedding response data is missing")
        rows = raw_data
    elif isinstance(raw_data, dict):
        # doubao-embedding-vision-251215 currently returns one data object for
        # a single multimodal input. Older examples show a one-item array.
        rows = [raw_data]
    elif isinstance(raw_data, list):
        rows = raw_data
    else:
        raise ValueError("embedding response data is missing")
    if len(rows) != expected_count:
        raise ValueError("embedding response count mismatch")
    indexed_vectors: dict[int, tuple[float, ...]] = {}
    dimension: int | None = None
    for position, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError("embedding response row is invalid")
        index = row.get("index") if indexed else position
        if not isinstance(index, int):
            raise ValueError("embedding response index is invalid")
        raw = row.get("embedding")
        if (
            not indexed
            and isinstance(raw, list)
            and len(raw) == 1
            and isinstance(raw[0], list)
        ):
            raw = raw[0]
        if not isinstance(raw, list) or not raw:
            raise ValueError("embedding vector is empty")
        vector = tuple(float(value) for value in raw)
        if any(not math.isfinite(value) for value in vector):
            raise ValueError("embedding vector contains non-finite values")
        if not any(value != 0.0 for value in vector):
            raise ValueError("embedding vector cannot be all zero")
        dimension = dimension or len(vector)
        if len(vector) != dimension:
            raise ValueError("embedding vector dimensions differ")
        if index in indexed_vectors:
            raise ValueError("embedding response index is duplicated")
        indexed_vectors[index] = vector
    expected_indexes = set(range(expected_count))
    if set(indexed_vectors) != expected_indexes:
        raise ValueError("embedding response indexes are incomplete")
    return [indexed_vectors[index] for index in range(expected_count)]


def _usage_input_tokens(value: Any) -> int:
    if not isinstance(value, dict):
        return 0
    for key in ("prompt_tokens", "input_tokens", "total_tokens"):
        token = value.get(key)
        if isinstance(token, int) and token >= 0:
            return token
    return 0


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    if response is not None:
        raw = response.headers.get("retry-after", "").strip()
        if raw:
            try:
                return max(0.0, min(float(raw), 30.0))
            except ValueError:
                try:
                    retry_at = parsedate_to_datetime(raw)
                    now = datetime.now(timezone.utc)
                    if retry_at.tzinfo is None:
                        retry_at = retry_at.replace(tzinfo=timezone.utc)
                    return max(0.0, min((retry_at - now).total_seconds(), 30.0))
                except (TypeError, ValueError, OverflowError):
                    pass
    return float(
        min(
            0.5 * (2 ** max(0, attempt - 1)) + random.uniform(0.0, 0.25),
            8.0,
        )
    )


def _cache_key(
    namespace: str,
    text: str,
    *,
    version: str = EMBEDDING_TEXT_VERSION,
) -> str:
    source = f"{version}|{namespace}|{text}"
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _cosine(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    return _normalized_dot(_normalize_vector(left), _normalize_vector(right))


def _normalize_vector(vector: tuple[float, ...]) -> tuple[float, ...]:
    if not vector:
        raise ValueError("embedding vector cannot be empty")
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0:
        raise ValueError("embedding vectors cannot have zero norm")
    return tuple(value / norm for value in vector)


def _normalized_dot(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    if len(left) != len(right) or not left:
        raise ValueError("embedding vectors must have the same non-zero dimension")
    return float(sum(map(operator.mul, left, right)))


def _clamp_similarity(value: float) -> float:
    return max(0.0, min(value, 1.0))


def _structural_overlap(left: CreativeCandidate, right: CreativeCandidate) -> float:
    left_dimensions = left.dimensions
    right_dimensions = right.dimensions
    pairs = (
        (left_dimensions.narrative, right_dimensions.narrative),
        (left_dimensions.scene, right_dimensions.scene),
        (left_dimensions.persona, right_dimensions.persona),
        (left_dimensions.product_relation, right_dimensions.product_relation),
        (left_dimensions.camera, right_dimensions.camera),
        (left_dimensions.emotion, right_dimensions.emotion),
    )
    return (
        sum(
            normalize_creative_signature(left_value)
            == normalize_creative_signature(right_value)
            for left_value, right_value in pairs
        )
        / 6.0
    )


def _pair_key(left_id: str, right_id: str) -> tuple[str, str]:
    return (left_id, right_id) if left_id < right_id else (right_id, left_id)


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(math.ceil(percentile * len(ordered)) - 1, len(ordered) - 1))
    return ordered[index]


def _mock_vector(value: str, dimension: int = 128) -> tuple[float, ...]:
    normalized = normalize_creative_signature(value)
    grams = (
        {normalized}
        if len(normalized) < 3
        else {normalized[index : index + 3] for index in range(len(normalized) - 2)}
    )
    vector = [0.0] * dimension
    for gram in grams or {"empty"}:
        digest = hashlib.sha256(gram.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimension
        vector[index] += 1.0 if digest[4] % 2 == 0 else -1.0
    if not any(vector):
        vector[0] = 1.0
    return tuple(vector)
