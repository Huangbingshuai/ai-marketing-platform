from __future__ import annotations

from collections.abc import Mapping, Sequence

import pytest

from effect_extraction.models import (
    ExtractionCandidate,
    SemanticField,
    SemanticImageEvidenceBasis,
    SemanticRefinementDecision,
    SemanticSuggestionDecision,
    SemanticSuggestionDisposition,
    SemanticSuggestionReason,
    SemanticUserFactIssue,
    SemanticUserFactNotice,
)
from effect_extraction.providers import AiCallMetadata, AiCallResult
from effect_extraction.semantic_refinement import refine_candidate_semantics


def fact(fact_id: str, value: str, source_type: str) -> dict[str, str]:
    return {
        "factId": fact_id,
        "field": SemanticField.SELLING_POINTS.value,
        "value": value,
        "sourceType": source_type,
    }


class SemanticProvider:
    def __init__(self, decision: SemanticRefinementDecision) -> None:
        self.decision = decision
        self.calls = 0
        self.reference_facts: list[dict[str, str]] = []
        self.remaining_capacity: dict[str, int] = {}

    async def refine_semantics(
        self,
        *,
        user_facts: Sequence[Mapping[str, str]],
        image_suggestions: Sequence[Mapping[str, str]],
        reference_facts: Sequence[Mapping[str, str]],
        remaining_capacity_by_field: Mapping[str, int],
    ) -> AiCallResult[SemanticRefinementDecision]:
        del user_facts, image_suggestions
        self.calls += 1
        self.reference_facts = [dict(row) for row in reference_facts]
        self.remaining_capacity = dict(remaining_capacity_by_field)
        return AiCallResult(
            value=self.decision,
            metadata=AiCallMetadata(
                stage="SEMANTIC_REFINEMENT",
                model="test-model",
                prompt_version="test-current",
                input_tokens=20,
                output_tokens=10,
                total_tokens=30,
                latency_ms=12,
                attempts=1,
                reasoning_tokens=0,
            ),
        )


def keep(fact_id: str) -> SemanticSuggestionDecision:
    return SemanticSuggestionDecision(
        fact_id=fact_id,
        disposition=SemanticSuggestionDisposition.KEEP,
        target_field=SemanticField.SELLING_POINTS,
        reason=SemanticSuggestionReason.INDEPENDENT_VISIBLE_FACT,
        evidence_basis=SemanticImageEvidenceBasis.DIRECT_PRODUCT_ATTRIBUTE,
    )


def drop(
    fact_id: str,
    reason: SemanticSuggestionReason = SemanticSuggestionReason.DUPLICATE_USER_FACT,
) -> SemanticSuggestionDecision:
    return SemanticSuggestionDecision(
        fact_id=fact_id,
        disposition=SemanticSuggestionDisposition.DROP,
        target_field=None,
        reason=reason,
        evidence_basis=SemanticImageEvidenceBasis.DIRECT_PRODUCT_ATTRIBUTE,
    )


@pytest.mark.asyncio
async def test_user_selling_points_are_preserved_and_receive_soft_notices() -> None:
    users = [
        fact("user-selling-01", "适合家庭蒸制", "USER_FACT"),
        fact("user-selling-02", "适合家庭蒸食", "USER_FACT"),
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[],
            user_fact_notices=[
                SemanticUserFactNotice(
                    fact_id="user-selling-02",
                    issue=SemanticUserFactIssue.POSSIBLE_OVERLAP,
                    related_fact_ids=["user-selling-01"],
                )
            ],
        )
    )
    result = await refine_candidate_semantics(
        ExtractionCandidate.empty(),
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=[],
    )
    assert result.candidate.selling_points == ["适合家庭蒸制", "适合家庭蒸食"]
    assert result.metadata["userFactNotices"][0]["relatedValues"] == ["适合家庭蒸制"]


@pytest.mark.asyncio
async def test_image_selling_points_are_kept_or_dropped_without_field_movement() -> (
    None
):
    users = [fact("user-selling-01", "真空包装", "USER_FACT")]
    images = [
        fact("image-selling-01", "真空包装", "IMAGE_SUGGESTION"),
        fact("image-selling-02", "可见梅肉颗粒", "IMAGE_SUGGESTION"),
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[drop("image-selling-01"), keep("image-selling-02")],
            user_fact_notices=[],
        )
    )
    result = await refine_candidate_semantics(
        ExtractionCandidate.empty(),
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=images,
    )
    assert result.candidate.selling_points == ["真空包装", "可见梅肉颗粒"]
    assert result.metadata["imageSuggestionKeptCount"] == 1
    assert result.metadata["imageSuggestionMovedCount"] == 0


@pytest.mark.asyncio
async def test_image_inference_cannot_be_kept_as_a_fact() -> None:
    image = fact("image-selling-01", "具有保健功效", "IMAGE_SUGGESTION")
    unsafe_keep = SemanticSuggestionDecision(
        fact_id=image["factId"],
        disposition=SemanticSuggestionDisposition.KEEP,
        target_field=SemanticField.SELLING_POINTS,
        reason=SemanticSuggestionReason.INDEPENDENT_VISIBLE_FACT,
        evidence_basis=SemanticImageEvidenceBasis.INFERRED_INTENT_OR_CLAIM,
    )
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[unsafe_keep], user_fact_notices=[]
        )
    )
    result = await refine_candidate_semantics(
        ExtractionCandidate.empty(),
        provider=provider,  # type: ignore[arg-type]
        user_facts=[],
        image_suggestions=[image],
    )
    assert result.candidate.selling_points is None
    assert result.metadata["validation"]["correctionCounts"] == {
        "INFERRED_SUGGESTION_KEPT": 1
    }


@pytest.mark.asyncio
async def test_product_references_are_read_only_context() -> None:
    image = fact("image-selling-01", "红紫色酱体", "IMAGE_SUGGESTION")
    references = [
        {
            "factId": "reference-visualFeatures",
            "field": "visualFeatures",
            "value": "深红紫色、可见果肉颗粒",
            "sourceType": "USER_REFERENCE",
        }
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[drop("image-selling-01")], user_fact_notices=[]
        )
    )
    result = await refine_candidate_semantics(
        ExtractionCandidate.empty(),
        provider=provider,  # type: ignore[arg-type]
        user_facts=[],
        image_suggestions=[image],
        reference_facts=references,
    )
    assert result.candidate.selling_points is None
    assert provider.reference_facts == references


@pytest.mark.asyncio
async def test_single_user_fact_skips_the_model() -> None:
    provider = SemanticProvider(
        SemanticRefinementDecision(suggestion_decisions=[], user_fact_notices=[])
    )
    result = await refine_candidate_semantics(
        ExtractionCandidate.empty(),
        provider=provider,  # type: ignore[arg-type]
        user_facts=[fact("user-selling-01", "适合刷制烤物", "USER_FACT")],
        image_suggestions=[],
    )
    assert result.candidate.selling_points == ["适合刷制烤物"]
    assert provider.calls == 0


@pytest.mark.asyncio
async def test_missing_image_decision_is_a_safe_drop() -> None:
    provider = SemanticProvider(
        SemanticRefinementDecision(suggestion_decisions=[], user_fact_notices=[])
    )
    result = await refine_candidate_semantics(
        ExtractionCandidate.empty(),
        provider=provider,  # type: ignore[arg-type]
        user_facts=[],
        image_suggestions=[
            fact("image-selling-01", "瓶身标签清晰", "IMAGE_SUGGESTION")
        ],
    )
    assert result.candidate.selling_points is None
    assert result.metadata["validation"]["correctionCounts"] == {
        "MISSING_SUGGESTION_DECISION": 1
    }
