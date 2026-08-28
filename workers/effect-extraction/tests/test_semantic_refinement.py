from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from effect_extraction.models import (
    ExtractionCandidate,
    SemanticField,
    SemanticGroup,
    SemanticRefinementDecision,
    SemanticRelation,
)
from effect_extraction.providers import (
    AiCallMetadata,
    AiCallResult,
    EmbeddingBatchResult,
)
from effect_extraction.semantic_refinement import refine_candidate_semantics


class SemanticProvider:
    def __init__(self) -> None:
        self.embedding_calls = 0
        self.refinement_calls = 0

    async def embed_semantic_texts(self, texts: list[str]) -> EmbeddingBatchResult:
        self.embedding_calls += 1
        vectors = []
        for text in texts:
            if "日常佐餐" in text or "方便且有风味" in text:
                vectors.append((1.0, 0.0, 0.0))
            elif "聚餐" in text:
                vectors.append((0.0, 1.0, 0.0))
            else:
                vectors.append((0.0, 0.0, 1.0))
        return EmbeddingBatchResult(
            vectors=vectors,
            model="test-embedding",
            request_count=1,
            retry_count=0,
            input_tokens=10,
            latency_ms=2,
        )

    async def refine_semantics(
        self,
        *,
        facts: list[Mapping[str, str]],
        candidate_pairs: list[Mapping[str, Any]],
    ) -> AiCallResult[SemanticRefinementDecision]:
        self.refinement_calls += 1
        pain_ids = [row["factId"] for row in facts if row["field"] == "corePainPoints"]
        return AiCallResult(
            value=SemanticRefinementDecision(
                groups=[
                    SemanticGroup(
                        field=SemanticField.CORE_PAIN_POINTS,
                        member_fact_ids=pain_ids[:2],
                        canonical_value="家庭日常佐餐需要方便、有风味的腊味食材",
                        relation=SemanticRelation.SAME_MEANING,
                    )
                ]
            ),
            metadata=AiCallMetadata(
                stage="SEMANTIC_REFINEMENT",
                model="test-model",
                prompt_version="test-v1",
                input_tokens=10,
                output_tokens=5,
                total_tokens=15,
                latency_ms=3,
                attempts=1,
            ),
        )


@pytest.mark.asyncio
async def test_semantic_refinement_merges_only_selected_fields_and_keeps_audit_values() -> (
    None
):
    candidate = ExtractionCandidate.empty()
    candidate.product_name = "广式腊肠"
    candidate.core_pain_points = [
        "日常佐餐缺少方便入味的腊味食材",
        "日常佐餐缺少方便且有风味的预制食材",
        "节日备货选择困难",
    ]
    candidate.usage_scenarios = ["家庭聚餐"]
    provider = SemanticProvider()

    result = await refine_candidate_semantics(candidate, provider=provider)  # type: ignore[arg-type]

    assert result.candidate.product_name == "广式腊肠"
    assert result.candidate.core_pain_points == [
        "家庭日常佐餐需要方便、有风味的腊味食材",
        "节日备货选择困难",
    ]
    assert result.candidate.usage_scenarios == ["家庭聚餐"]
    assert result.metadata["mergedGroupCount"] == 1
    assert result.metadata["semanticGroups"][0]["memberValues"] == [
        "日常佐餐缺少方便入味的腊味食材",
        "日常佐餐缺少方便且有风味的预制食材",
    ]
    assert provider.embedding_calls == 1
    assert provider.refinement_calls == 1


@pytest.mark.asyncio
async def test_semantic_refinement_skips_vector_and_ai_when_no_field_has_multiple_items() -> (
    None
):
    candidate = ExtractionCandidate.empty()
    candidate.core_pain_points = ["备餐时间有限"]
    candidate.usage_scenarios = ["家庭聚餐"]
    provider = SemanticProvider()

    result = await refine_candidate_semantics(candidate, provider=provider)  # type: ignore[arg-type]

    assert result.candidate == candidate
    assert result.metadata["mergedGroupCount"] == 0
    assert provider.embedding_calls == 0
    assert provider.refinement_calls == 0


@pytest.mark.asyncio
async def test_semantic_refinement_removes_exact_duplicates_without_ai() -> None:
    candidate = ExtractionCandidate.empty()
    candidate.purchase_scenarios = ["年货送礼", " 年货送礼 "]
    provider = SemanticProvider()

    result = await refine_candidate_semantics(candidate, provider=provider)  # type: ignore[arg-type]

    assert result.candidate.purchase_scenarios == ["年货送礼"]
    assert result.metadata["inputCount"] == 2
    assert result.metadata["outputCount"] == 1
    assert provider.embedding_calls == 0
    assert provider.refinement_calls == 0
