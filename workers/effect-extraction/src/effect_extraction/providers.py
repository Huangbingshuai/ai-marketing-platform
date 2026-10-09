from __future__ import annotations
from extraction_runtime.responses import AiCallMetadata as AiCallMetadata, AiCallResult as AiCallResult, ProviderError as ProviderError, ProviderErrorType as ProviderErrorType, StructuredResponsesMixin as StructuredResponsesMixin, _PROVIDER_ERROR_MESSAGES as _PROVIDER_ERROR_MESSAGES, _RetryStructuredResponse as _RetryStructuredResponse, _incomplete_reason as _incomplete_reason, _is_output_truncated_reason as _is_output_truncated_reason, _output_text as _output_text, _response_status as _response_status, _token as _token, _usage as _usage

import asyncio
import json
import logging
import random
import re
import time
from collections.abc import Awaitable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Generic, Protocol, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .models import (
    ExtractionCandidate,
    ExtractionResult,
    ImageVisibleFacts,
    SemanticField,
    SemanticImageEvidenceBasis,
    SemanticImageSuggestionModelReview,
    SemanticImageSuggestionReview,
    SemanticRefinementDecision,
    SemanticSuggestionDecision,
    SemanticSuggestionDisposition,
    SemanticSuggestionReason,
    SemanticUserFactIssue,
    SemanticUserFactModelReview,
    SemanticUserFactNotice,
    SemanticUserFactPairDecision,
    SemanticUserFactPairRelation,
    SemanticUserFactReview,
)
from .prompt_loader import load_prompt_version, render_prompt

TModel = TypeVar("TModel", bound=BaseModel)
TResult = TypeVar("TResult", bound=BaseModel)

DOCUMENT_EXTRACTION_PROMPT = "document_extraction.prompt.txt"
IMAGE_ANALYSIS_PROMPT = "image_analysis.prompt.txt"
COMMERCE_EXTRACTION_PROMPT = "commerce_extraction.prompt.txt"
RESULT_NORMALIZATION_PROMPT = "result_normalization.prompt.txt"
SEMANTIC_REFINEMENT_PROMPT = "semantic_refinement.prompt.txt"
SEMANTIC_IMAGE_SUGGESTION_REVIEW_PROMPT = "semantic_image_suggestion_review.prompt.txt"
LOGGER = logging.getLogger(__name__)
_HIGH_DETAIL_FILE_NAME = re.compile(
    r"(?:包装|背面|背标|标签|说明|配料|成分|规格|净含量|认证|检测|奖项|证书|package|packaging|label|back)",
    re.IGNORECASE,
)
_SEMANTIC_NOTICE_FIELDS_BY_LAYER: dict[str, tuple[str, ...]] = {
    "SELLING_POINT": ("sellingPoints",),
}












class AiProvider(Protocol):
    @property
    def image_cache_namespace(self) -> str: ...

    async def refine_semantics(
        self,
        *,
        user_facts: Sequence[Mapping[str, str]],
        image_suggestions: Sequence[Mapping[str, str]],
        reference_facts: Sequence[Mapping[str, str]],
        remaining_capacity_by_field: Mapping[str, int],
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

    @property
    def image_cache_namespace(self) -> str:
        return (
            f"mock:{load_prompt_version(IMAGE_ANALYSIS_PROMPT)}:"
            "image-visible:unified-selling-points:low-high"
        )

    async def refine_semantics(
        self,
        *,
        user_facts: Sequence[Mapping[str, str]],
        image_suggestions: Sequence[Mapping[str, str]],
        reference_facts: Sequence[Mapping[str, str]],
        remaining_capacity_by_field: Mapping[str, int],
    ) -> AiCallResult[SemanticRefinementDecision]:
        del user_facts, reference_facts
        kept_by_field: dict[SemanticField, int] = {}
        suggestion_decisions: list[SemanticSuggestionDecision] = []
        for fact in image_suggestions:
            field = SemanticField(str(fact["field"]))
            kept_count = kept_by_field.get(field, 0)
            capacity = remaining_capacity_by_field.get(field.value, 0)
            keep = kept_count < capacity
            if keep:
                kept_by_field[field] = kept_count + 1
            suggestion_decisions.append(
                SemanticSuggestionDecision(
                    fact_id=str(fact["factId"]),
                    disposition=(
                        SemanticSuggestionDisposition.KEEP
                        if keep
                        else SemanticSuggestionDisposition.DROP
                    ),
                    target_field=field if keep else None,
                    reason=(
                        SemanticSuggestionReason.INDEPENDENT_VISIBLE_FACT
                        if keep
                        else SemanticSuggestionReason.CAPACITY
                    ),
                    evidence_basis=SemanticImageEvidenceBasis.DIRECT_PRODUCT_ATTRIBUTE,
                )
            )
        return _mock_result(
            SemanticRefinementDecision(
                suggestion_decisions=suggestion_decisions,
                user_fact_notices=[],
            ),
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
            candidate.core_specification = (
                content[1][:240] if len(content) > 1 else None
            )
            candidate.selling_points = content[2:12] or None
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
        candidate.visual_features = (
            f"{source_name}，图像尺寸 {width}×{height}，产品主体清晰"
        )
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
        candidate.product_category = (
            _clean(category) if isinstance(category, str) else None
        )
        if isinstance(description, str) and (cleaned := _clean(description)):
            candidate.selling_points = [cleaned[:240]]
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
        if not fused.selling_points:
            raise ProviderError(
                "未提取到可用卖点，请补充产品资料后重新提炼",
                error_type=ProviderErrorType.RESPONSE_INVALID,
                retryable=False,
            )
        result = ExtractionResult(
            product_category=fused.product_category or "待补充",
            product_name=fused.product_name or "待补充",
            core_specification=fused.core_specification or "待补充",
            price_range=fused.price_range or "待补充",
            visual_features=fused.visual_features or "待补充",
            selling_points=fused.selling_points[0:100],
        )
        return _mock_result(result, "NORMALIZATION", RESULT_NORMALIZATION_PROMPT)


class ArkResponsesProvider(StructuredResponsesMixin):
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
        timeout: float = 120.0,
        max_attempts: int = 3,
        document_timeout: float = 180.0,
        document_max_attempts: int = 1,
        document_max_output_tokens: int = 8192,
        document_reasoning_effort: str = "minimal",
        image_timeout: float = 90.0,
        image_max_attempts: int = 2,
        image_max_output_tokens: int = 4096,
        image_retry_max_output_tokens: int = 6144,
        image_detail: str = "low",
        image_reasoning_effort: str = "minimal",
        image_adaptive_high_detail: bool = True,
        semantic_timeout: float = 30.0,
        semantic_max_attempts: int = 1,
        semantic_max_output_tokens: int = 3072,
        semantic_reasoning_effort: str = "minimal",
        semantic_user_review_reasoning_effort: str = "minimal",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._document_model = _specific_model(document_model, model)
        self._commerce_model = _specific_model(commerce_model, self._document_model)
        self._image_model = _specific_model(image_model, model)
        self._semantic_model = _specific_model(semantic_model, model)
        self._normalization_model = _specific_model(normalization_model, model)
        self._max_attempts = max(1, max_attempts)
        self._document_timeout = max(1.0, document_timeout)
        self._document_max_attempts = max(1, min(document_max_attempts, 2))
        self._document_max_output_tokens = max(256, document_max_output_tokens)
        self._document_reasoning_effort = (
            document_reasoning_effort
            if document_reasoning_effort in {"minimal", "low", "medium", "high"}
            else "low"
        )
        self._image_timeout = max(1.0, image_timeout)
        self._image_max_attempts = max(1, image_max_attempts)
        self._image_max_output_tokens = max(256, image_max_output_tokens)
        self._image_retry_max_output_tokens = max(
            self._image_max_output_tokens, image_retry_max_output_tokens
        )
        self._image_detail = (
            image_detail if image_detail in {"low", "high", "auto"} else "low"
        )
        self._image_reasoning_effort = (
            image_reasoning_effort
            if image_reasoning_effort in {"minimal", "low", "medium", "high"}
            else "minimal"
        )
        self._image_adaptive_high_detail = image_adaptive_high_detail
        self._semantic_timeout = max(1.0, semantic_timeout)
        self._semantic_max_attempts = max(1, semantic_max_attempts)
        self._semantic_max_output_tokens = max(256, semantic_max_output_tokens)
        self._semantic_reasoning_effort = (
            semantic_reasoning_effort
            if semantic_reasoning_effort in {"minimal", "low", "medium", "high"}
            else "minimal"
        )
        self._semantic_user_review_reasoning_effort = (
            semantic_user_review_reasoning_effort
            if semantic_user_review_reasoning_effort
            in {"minimal", "low", "medium", "high"}
            else "minimal"
        )
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=timeout,
            transport=transport,
            headers={
                "authorization": f"Bearer {api_key}",
                "content-type": "application/json",
            },
        )

    @property
    def image_cache_namespace(self) -> str:
        prompt_version = load_prompt_version(IMAGE_ANALYSIS_PROMPT)
        return (
            f"ark:{self._image_model}:{prompt_version}:"
            f"image-visible:unified-selling-points:adaptive-{int(self._image_adaptive_high_detail)}:"
            f"{self._image_detail}-high:{self._image_reasoning_effort}"
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def refine_semantics(
        self,
        *,
        user_facts: Sequence[Mapping[str, str]],
        image_suggestions: Sequence[Mapping[str, str]],
        reference_facts: Sequence[Mapping[str, str]],
        remaining_capacity_by_field: Mapping[str, int],
    ) -> AiCallResult[SemanticRefinementDecision]:
        calls: list[Awaitable[AiCallResult[Any]]] = []
        if user_facts:
            calls.append(self._review_user_facts(user_facts))
        if image_suggestions:
            calls.append(
                self._review_image_suggestions(
                    user_facts=user_facts,
                    image_suggestions=image_suggestions,
                    reference_facts=reference_facts,
                    remaining_capacity_by_field=remaining_capacity_by_field,
                )
            )
        results = await asyncio.gather(*calls)
        user_fact_notices: list[SemanticUserFactNotice] = []
        suggestion_decisions: list[SemanticSuggestionDecision] = []
        for result in results:
            if isinstance(result.value, SemanticUserFactReview):
                user_fact_notices = result.value.user_fact_notices
            elif isinstance(result.value, SemanticImageSuggestionReview):
                suggestion_decisions = result.value.suggestion_decisions
        return AiCallResult(
            value=SemanticRefinementDecision(
                suggestion_decisions=suggestion_decisions,
                user_fact_notices=user_fact_notices,
            ),
            metadata=_combine_parallel_ai_call_metadata(
                [result.metadata for result in results],
                model=self._semantic_model,
            ),
        )

    async def _review_user_facts(
        self,
        user_facts: Sequence[Mapping[str, str]],
    ) -> AiCallResult[SemanticUserFactReview]:
        facts_by_layer = _semantic_user_facts_by_layer(user_facts)
        fact_pairs = _semantic_user_fact_pairs(user_facts)
        scopes: list[
            tuple[
                str,
                str,
                list[Mapping[str, str]],
                list[dict[str, Any]],
            ]
        ] = []
        review_calls: list[Awaitable[AiCallResult[SemanticUserFactModelReview]]] = []
        for layer, fields in _SEMANTIC_NOTICE_FIELDS_BY_LAYER.items():
            layer_facts = facts_by_layer[layer]
            for field in fields:
                field_facts = layer_facts[field]
                if not field_facts:
                    continue
                field_pairs = [pair for pair in fact_pairs if pair["field"] == field]
                scopes.append((layer, field, field_facts, field_pairs))
                # Two focused votes prevent a broad full-card review from
                # outvoting the field-specific semantic distinction.
                review_calls.extend(
                    [
                        self._review_user_fact_scope_once(
                            facts_by_layer={layer: {field: field_facts}},
                            fact_pairs=field_pairs,
                            review_scope="单字段独立审查",
                        )
                        for _ in range(2)
                    ]
                )
        review_calls.append(
            self._review_user_fact_scope_once(
                facts_by_layer=facts_by_layer,
                fact_pairs=fact_pairs,
                review_scope="全字段独立复核",
            )
        )
        results = await asyncio.gather(*review_calls)
        global_review = results[len(scopes) * 2 :]
        if len(global_review) != 1:
            raise ProviderError(
                _PROVIDER_ERROR_MESSAGES[ProviderErrorType.RESPONSE_INVALID],
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        _validate_user_fact_model_review(global_review[0].value, fact_pairs=fact_pairs)

        notices: list[SemanticUserFactNotice] = []
        for index, (_, _, scope_field_facts, scope_field_pairs) in enumerate(scopes):
            field_reviews = results[index * 2 : index * 2 + 2]
            fact_ids = {str(fact.get("factId", "")) for fact in scope_field_facts}
            review_votes = [
                *[result.value for result in field_reviews],
                _semantic_user_fact_review_subset(
                    global_review[0].value,
                    fact_pairs=scope_field_pairs,
                    fact_ids=fact_ids,
                ),
            ]
            consensus = _semantic_user_fact_consensus(
                review_votes,
                fact_pairs=scope_field_pairs,
            )
            notices.extend(
                _map_user_fact_model_review(
                    consensus,
                    fact_pairs=scope_field_pairs,
                ).user_fact_notices
            )
        return AiCallResult(
            value=SemanticUserFactReview(user_fact_notices=notices),
            metadata=_combine_parallel_ai_call_metadata(
                [result.metadata for result in results],
                model=self._semantic_model,
            ),
        )

    async def _review_user_fact_scope_once(
        self,
        *,
        facts_by_layer: Mapping[str, Mapping[str, Sequence[Mapping[str, str]]]],
        fact_pairs: Sequence[Mapping[str, Any]],
        review_scope: str,
    ) -> AiCallResult[SemanticUserFactModelReview]:
        prompt = render_prompt(
            SEMANTIC_REFINEMENT_PROMPT,
            review_scope=review_scope,
            user_facts_by_layer_json=json.dumps(
                facts_by_layer,
                ensure_ascii=False,
            ),
            user_fact_pairs_json=json.dumps(fact_pairs, ensure_ascii=False),
        )
        return await self._structured(
            [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            SemanticUserFactModelReview,
            schema_name="effect_semantic_user_fact_review",
            stage="SEMANTIC_REFINEMENT",
            model=self._semantic_model,
            prompt_version=load_prompt_version(SEMANTIC_REFINEMENT_PROMPT),
            request_timeout=self._semantic_timeout,
            max_attempts=self._semantic_max_attempts,
            max_output_tokens=self._semantic_max_output_tokens,
            reasoning_effort=self._semantic_user_review_reasoning_effort,
        )

    async def _review_image_suggestions(
        self,
        *,
        user_facts: Sequence[Mapping[str, str]],
        image_suggestions: Sequence[Mapping[str, str]],
        reference_facts: Sequence[Mapping[str, str]],
        remaining_capacity_by_field: Mapping[str, int],
    ) -> AiCallResult[SemanticImageSuggestionReview]:
        prompt = render_prompt(
            SEMANTIC_IMAGE_SUGGESTION_REVIEW_PROMPT,
            user_facts_json=json.dumps(user_facts, ensure_ascii=False, sort_keys=True),
            image_suggestions_json=json.dumps(
                image_suggestions, ensure_ascii=False, sort_keys=True
            ),
            reference_facts_json=json.dumps(
                reference_facts, ensure_ascii=False, sort_keys=True
            ),
            remaining_capacity_json=json.dumps(
                remaining_capacity_by_field, ensure_ascii=False, sort_keys=True
            ),
        )
        result = await self._structured(
            [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            SemanticImageSuggestionModelReview,
            schema_name="effect_semantic_image_suggestion_review",
            stage="SEMANTIC_REFINEMENT",
            model=self._semantic_model,
            prompt_version=load_prompt_version(SEMANTIC_IMAGE_SUGGESTION_REVIEW_PROMPT),
            request_timeout=self._semantic_timeout,
            max_attempts=self._semantic_max_attempts,
            max_output_tokens=self._semantic_max_output_tokens,
            reasoning_effort=self._semantic_reasoning_effort,
        )
        strict_decisions: list[SemanticSuggestionDecision] = []
        seen_ids: set[str] = set()
        for raw_decision in result.value.suggestion_decisions:
            if raw_decision.fact_id in seen_ids:
                continue
            try:
                decision = SemanticSuggestionDecision.model_validate(
                    raw_decision.model_dump(mode="json", by_alias=True)
                )
            except ValidationError:
                # Keep valid decisions from the same batch. The downstream
                # structural validator treats this item as a missing decision
                # and safely drops only that suggestion.
                continue
            seen_ids.add(decision.fact_id)
            strict_decisions.append(decision)
        return AiCallResult(
            value=SemanticImageSuggestionReview(
                suggestion_decisions=strict_decisions,
            ),
            metadata=result.metadata,
        )

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
            request_timeout=self._document_timeout,
            max_attempts=self._document_max_attempts,
            max_output_tokens=self._document_max_output_tokens,
            reasoning_effort=self._document_reasoning_effort,
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
        first = await self._analyze_image_once(
            prompt=prompt,
            data_uri=data_uri,
            detail=self._image_detail,
        )
        should_escalate = (
            self._image_adaptive_high_detail
            and self._image_detail == "low"
            and (
                first.value.high_detail_recommended
                or _HIGH_DETAIL_FILE_NAME.search(source_name) is not None
            )
        )
        if not should_escalate:
            return AiCallResult(
                value=first.value.to_candidate(),
                metadata=first.metadata,
            )
        try:
            refined = await self._analyze_image_once(
                prompt=prompt,
                data_uri=data_uri,
                detail="high",
            )
        except ProviderError as exc:
            LOGGER.warning(
                "Ark adaptive image detail fallback error_type=%s attempts=%s elapsed_ms=%s",
                exc.error_type.value,
                exc.attempts,
                exc.elapsed_ms,
            )
            return AiCallResult(
                value=first.value.to_candidate(),
                metadata=first.metadata,
                cacheable=False,
            )
        return AiCallResult(
            value=_merge_image_visible_facts(first.value, refined.value).to_candidate(),
            metadata=_combine_ai_call_metadata(first.metadata, refined.metadata),
        )

    async def _analyze_image_once(
        self,
        *,
        prompt: str,
        data_uri: str,
        detail: str,
    ) -> AiCallResult[ImageVisibleFacts]:
        return await self._structured(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {
                            "type": "input_image",
                            "image_url": data_uri,
                            "detail": detail,
                        },
                    ],
                }
            ],
            ImageVisibleFacts,
            schema_name="effect_image_visible_facts",
            stage="IMAGE",
            model=self._image_model,
            prompt_version=load_prompt_version(IMAGE_ANALYSIS_PROMPT),
            request_timeout=self._image_timeout,
            max_attempts=self._image_max_attempts,
            max_output_tokens=self._image_max_output_tokens,
            retry_max_output_tokens=self._image_retry_max_output_tokens,
            reasoning_effort=self._image_reasoning_effort,
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



def _specific_model(value: str | None, fallback: str) -> str:
    specific = value.strip() if value is not None else ""
    resolved = specific or fallback.strip()
    if not resolved:
        raise ValueError("Ark model cannot be empty")
    return resolved


def _semantic_user_facts_by_layer(
    user_facts: Sequence[Mapping[str, str]],
) -> dict[str, dict[str, list[Mapping[str, str]]]]:
    """Group facts structurally so the model can audit every same-layer pair."""

    grouped: dict[str, dict[str, list[Mapping[str, str]]]] = {
        layer: {field: [] for field in fields}
        for layer, fields in _SEMANTIC_NOTICE_FIELDS_BY_LAYER.items()
    }
    field_targets = {
        field: grouped[layer][field]
        for layer, fields in _SEMANTIC_NOTICE_FIELDS_BY_LAYER.items()
        for field in fields
    }
    for fact in user_facts:
        target = field_targets.get(str(fact.get("field", "")))
        if target is not None:
            target.append(fact)
    return grouped


def _semantic_user_fact_pairs(
    user_facts: Sequence[Mapping[str, str]],
) -> list[dict[str, Any]]:
    """Build every same-field unordered pair without interpreting fact text."""

    by_field: dict[str, list[Mapping[str, str]]] = {
        field: []
        for fields in _SEMANTIC_NOTICE_FIELDS_BY_LAYER.values()
        for field in fields
    }
    for fact in user_facts:
        field = str(fact.get("field", ""))
        if field in by_field:
            by_field[field].append(fact)
    pairs: list[dict[str, Any]] = []
    for fields in _SEMANTIC_NOTICE_FIELDS_BY_LAYER.values():
        for field in fields:
            facts = by_field[field]
            for left_index, left in enumerate(facts):
                for right in facts[left_index + 1 :]:
                    pairs.append(
                        {
                            "pairId": f"pair-{len(pairs) + 1:04d}",
                            "field": field,
                            "leftFact": {
                                "factId": str(left.get("factId", "")),
                                "value": str(left.get("value", "")),
                            },
                            "rightFact": {
                                "factId": str(right.get("factId", "")),
                                "value": str(right.get("value", "")),
                            },
                        }
                    )
    return pairs


def _map_user_fact_model_review(
    review: SemanticUserFactModelReview,
    *,
    fact_pairs: Sequence[Mapping[str, Any]],
) -> SemanticUserFactReview:
    expected_by_id = _validate_user_fact_model_review(
        review,
        fact_pairs=fact_pairs,
    )
    notices = list(review.user_fact_notices)
    for decision in review.pair_decisions:
        if decision.relation == SemanticUserFactPairRelation.DISTINCT:
            continue
        pair = expected_by_id[decision.pair_id]
        left = pair["leftFact"]
        right = pair["rightFact"]
        notices.append(
            SemanticUserFactNotice(
                fact_id=str(left["factId"]),
                issue=(
                    SemanticUserFactIssue.POSSIBLE_DUPLICATE
                    if decision.relation
                    == SemanticUserFactPairRelation.POSSIBLE_DUPLICATE
                    else SemanticUserFactIssue.POSSIBLE_OVERLAP
                ),
                related_fact_ids=[str(right["factId"])],
                suggested_field=None,
            )
        )
    return SemanticUserFactReview(user_fact_notices=notices)


def _validate_user_fact_model_review(
    review: SemanticUserFactModelReview,
    *,
    fact_pairs: Sequence[Mapping[str, Any]],
) -> dict[str, Mapping[str, Any]]:
    expected_by_id = {str(pair["pairId"]): pair for pair in fact_pairs}
    expected_ids = list(expected_by_id)
    returned_ids = [decision.pair_id for decision in review.pair_decisions]
    if returned_ids != expected_ids or any(
        notice.issue
        not in {
            SemanticUserFactIssue.AMBIGUOUS_EXPRESSION,
        }
        for notice in review.user_fact_notices
    ):
        raise ProviderError(
            _PROVIDER_ERROR_MESSAGES[ProviderErrorType.RESPONSE_INVALID],
            retryable=False,
            error_type=ProviderErrorType.RESPONSE_INVALID,
        )
    return expected_by_id


def _semantic_user_fact_consensus(
    reviews: Sequence[SemanticUserFactModelReview],
    *,
    fact_pairs: Sequence[Mapping[str, Any]],
) -> SemanticUserFactModelReview:
    if len(reviews) not in {2, 3}:
        raise ValueError("semantic user fact consensus requires two or three reviews")
    for review in reviews:
        _validate_user_fact_model_review(review, fact_pairs=fact_pairs)

    pair_decisions: list[SemanticUserFactPairDecision] = []
    for pair_index, pair in enumerate(fact_pairs):
        relations = [review.pair_decisions[pair_index].relation for review in reviews]
        selected = next(
            (
                relation
                for relation in SemanticUserFactPairRelation
                if relations.count(relation) >= 2
            ),
            None,
        )
        if selected is None:
            raise ProviderError(
                _PROVIDER_ERROR_MESSAGES[ProviderErrorType.RESPONSE_INVALID],
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        pair_decisions.append(
            SemanticUserFactPairDecision(
                pair_id=str(pair["pairId"]),
                relation=selected,
            )
        )

    notice_counts: dict[
        tuple[str, SemanticUserFactIssue, tuple[str, ...], SemanticField | None], int
    ] = {}
    notice_by_signature: dict[
        tuple[str, SemanticUserFactIssue, tuple[str, ...], SemanticField | None],
        SemanticUserFactNotice,
    ] = {}
    for review in reviews:
        seen_in_review: set[
            tuple[str, SemanticUserFactIssue, tuple[str, ...], SemanticField | None]
        ] = set()
        for notice in review.user_fact_notices:
            signature = (
                notice.fact_id,
                notice.issue,
                tuple(notice.related_fact_ids),
                notice.suggested_field,
            )
            if signature in seen_in_review:
                continue
            seen_in_review.add(signature)
            notice_counts[signature] = notice_counts.get(signature, 0) + 1
            notice_by_signature.setdefault(signature, notice)
    notices = [
        notice_by_signature[signature]
        for signature, count in notice_counts.items()
        if count >= 2
    ]
    return SemanticUserFactModelReview(
        pair_decisions=pair_decisions,
        user_fact_notices=notices,
    )


def _semantic_user_fact_review_subset(
    review: SemanticUserFactModelReview,
    *,
    fact_pairs: Sequence[Mapping[str, Any]],
    fact_ids: set[str],
) -> SemanticUserFactModelReview:
    decisions_by_id = {decision.pair_id: decision for decision in review.pair_decisions}
    return SemanticUserFactModelReview(
        pair_decisions=[decisions_by_id[str(pair["pairId"])] for pair in fact_pairs],
        user_fact_notices=[
            notice for notice in review.user_fact_notices if notice.fact_id in fact_ids
        ],
    )


def _merge_image_visible_facts(
    first: ImageVisibleFacts,
    refined: ImageVisibleFacts,
) -> ImageVisibleFacts:
    merged: dict[str, Any] = {}
    for field_name in ImageVisibleFacts.model_fields:
        if field_name == "high_detail_recommended":
            merged[field_name] = False
            continue
        if field_name == "selling_points":
            merged[field_name] = (
                list(
                    dict.fromkeys(
                        [*(first.selling_points or []), *(refined.selling_points or [])]
                    )
                )
                or None
            )
            continue
        refined_value = getattr(refined, field_name)
        merged[field_name] = (
            refined_value if refined_value is not None else getattr(first, field_name)
        )
    return ImageVisibleFacts.model_validate(merged)


def _combined_token_count(first: int | None, refined: int | None) -> int | None:
    if first is None and refined is None:
        return None
    return (first or 0) + (refined or 0)


def _combine_ai_call_metadata(
    first: AiCallMetadata,
    refined: AiCallMetadata,
) -> AiCallMetadata:
    return AiCallMetadata(
        stage=refined.stage,
        model=refined.model,
        prompt_version=refined.prompt_version,
        input_tokens=_combined_token_count(first.input_tokens, refined.input_tokens),
        output_tokens=_combined_token_count(first.output_tokens, refined.output_tokens),
        total_tokens=_combined_token_count(first.total_tokens, refined.total_tokens),
        latency_ms=first.latency_ms + refined.latency_ms,
        attempts=first.attempts + refined.attempts,
        reasoning_tokens=_combined_token_count(
            first.reasoning_tokens, refined.reasoning_tokens
        ),
    )


def _combine_parallel_ai_call_metadata(
    calls: Sequence[AiCallMetadata],
    *,
    model: str,
) -> AiCallMetadata:
    if not calls:
        return AiCallMetadata(
            stage="SEMANTIC_REFINEMENT",
            model=model,
            prompt_version="none",
            input_tokens=None,
            output_tokens=None,
            total_tokens=None,
            latency_ms=0,
            attempts=1,
            reasoning_tokens=None,
        )
    return AiCallMetadata(
        stage="SEMANTIC_REFINEMENT",
        model=model,
        prompt_version="+".join(call.prompt_version for call in calls),
        input_tokens=_sum_optional_tokens(call.input_tokens for call in calls),
        output_tokens=_sum_optional_tokens(call.output_tokens for call in calls),
        total_tokens=_sum_optional_tokens(call.total_tokens for call in calls),
        latency_ms=max(call.latency_ms for call in calls),
        attempts=max(call.attempts for call in calls),
        reasoning_tokens=_sum_optional_tokens(call.reasoning_tokens for call in calls),
    )


def _sum_optional_tokens(values: Iterable[int | None]) -> int | None:
    materialized = list(values)
    if not any(value is not None for value in materialized):
        return None
    return sum(value or 0 for value in materialized)














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
