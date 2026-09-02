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


def fact(
    fact_id: str,
    field: SemanticField,
    value: str,
    source_type: str,
) -> dict[str, str]:
    return {
        "factId": fact_id,
        "field": field.value,
        "value": value,
        "sourceType": source_type,
    }


class SemanticProvider:
    def __init__(self, decision: SemanticRefinementDecision) -> None:
        self.decision = decision
        self.calls = 0
        self.user_facts: list[dict[str, str]] = []
        self.image_suggestions: list[dict[str, str]] = []
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
        self.calls += 1
        self.user_facts = [dict(row) for row in user_facts]
        self.image_suggestions = [dict(row) for row in image_suggestions]
        self.reference_facts = [dict(row) for row in reference_facts]
        self.remaining_capacity = dict(remaining_capacity_by_field)
        return AiCallResult(
            value=self.decision,
            metadata=AiCallMetadata(
                stage="SEMANTIC_REFINEMENT",
                model="test-model",
                prompt_version="test-v5",
                input_tokens=20,
                output_tokens=10,
                total_tokens=30,
                latency_ms=12,
                attempts=1,
                reasoning_tokens=0,
            ),
        )


def keep(
    fact_id: str,
    field: SemanticField,
    *,
    reason: SemanticSuggestionReason = SemanticSuggestionReason.INDEPENDENT_VISIBLE_FACT,
) -> SemanticSuggestionDecision:
    return SemanticSuggestionDecision(
        fact_id=fact_id,
        disposition=SemanticSuggestionDisposition.KEEP,
        target_field=field,
        reason=reason,
        evidence_basis=SemanticImageEvidenceBasis.DIRECT_PRODUCT_ATTRIBUTE,
    )


def drop(
    fact_id: str,
    reason: SemanticSuggestionReason,
    *,
    evidence_basis: SemanticImageEvidenceBasis = (
        SemanticImageEvidenceBasis.DIRECT_PRODUCT_ATTRIBUTE
    ),
) -> SemanticSuggestionDecision:
    return SemanticSuggestionDecision(
        fact_id=fact_id,
        disposition=SemanticSuggestionDisposition.DROP,
        target_field=None,
        reason=reason,
        evidence_basis=evidence_basis,
    )


@pytest.mark.asyncio
async def test_user_facts_are_preserved_and_only_receive_notices() -> None:
    candidate = ExtractionCandidate.empty()
    users = [
        fact(
            "user-pain-01", SemanticField.CORE_PAIN_POINTS, "家庭备餐耗时", "USER_FACT"
        ),
        fact(
            "user-pain-02",
            SemanticField.CORE_PAIN_POINTS,
            "家庭做饭时间长",
            "USER_FACT",
        ),
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[],
            user_fact_notices=[
                SemanticUserFactNotice(
                    fact_id="user-pain-02",
                    issue=SemanticUserFactIssue.POSSIBLE_DUPLICATE,
                    related_fact_ids=["user-pain-01"],
                )
            ],
        )
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=[],
    )

    assert result.candidate.core_pain_points == ["家庭备餐耗时", "家庭做饭时间长"]
    assert result.metadata["userNoticeCount"] == 1
    assert result.metadata["userFactNotices"][0]["relatedValues"] == ["家庭备餐耗时"]
    assert provider.calls == 1


@pytest.mark.asyncio
async def test_image_suggestions_can_be_dropped_moved_and_ranked() -> None:
    candidate = ExtractionCandidate.empty()
    users = [
        fact(
            "user-sell-01",
            SemanticField.CORE_SELLING_POINTS,
            "传统糖酒腌制",
            "USER_FACT",
        )
    ]
    images = [
        fact(
            "image-sell-01",
            SemanticField.SECONDARY_SELLING_POINTS,
            "传统糖酒腌制",
            "IMAGE_SUGGESTION",
        ),
        fact(
            "image-sell-02",
            SemanticField.SECONDARY_SELLING_POINTS,
            "切片清晰便于判断肉质",
            "IMAGE_SUGGESTION",
        ),
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[
                drop("image-sell-01", SemanticSuggestionReason.DUPLICATE_USER_FACT),
                keep(
                    "image-sell-02",
                    SemanticField.DECISION_DRIVERS,
                    reason=SemanticSuggestionReason.WRONG_FIELD,
                ),
            ],
            user_fact_notices=[],
        )
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=images,
    )

    assert result.candidate.core_selling_points == ["传统糖酒腌制"]
    assert result.candidate.secondary_selling_points is None
    assert result.candidate.decision_drivers == ["切片清晰便于判断肉质"]
    assert result.metadata["imageSuggestionKeptCount"] == 1
    assert result.metadata["imageSuggestionMovedCount"] == 1
    assert result.metadata["imageSuggestionDroppedCount"] == 1


@pytest.mark.asyncio
async def test_read_only_product_references_are_only_used_by_the_model() -> None:
    candidate = ExtractionCandidate.empty()
    images = [
        fact(
            "image-sell-01",
            SemanticField.SECONDARY_SELLING_POINTS,
            "肥瘦相间纹理清晰",
            "IMAGE_SUGGESTION",
        )
    ]
    references = [
        {
            "factId": "reference-visualFeatures",
            "field": "visualFeatures",
            "value": "红白相间的肥瘦纹理清晰",
            "sourceType": "USER_REFERENCE",
        }
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[
                drop("image-sell-01", SemanticSuggestionReason.DUPLICATE_USER_FACT)
            ],
            user_fact_notices=[],
        )
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=[],
        image_suggestions=images,
        reference_facts=references,
    )

    assert result.candidate.secondary_selling_points is None
    assert provider.reference_facts == references
    assert result.metadata["referenceFactCount"] == 1
    assert result.metadata["userFactNotices"] == []


@pytest.mark.asyncio
async def test_user_facts_over_recommended_limit_are_all_preserved() -> None:
    candidate = ExtractionCandidate.empty()
    users = [
        fact(
            f"user-core-{index:02d}",
            SemanticField.CORE_SELLING_POINTS,
            f"用户核心卖点{index}",
            "USER_FACT",
        )
        for index in range(1, 5)
    ]
    images = [
        fact(
            "image-core-01",
            SemanticField.CORE_SELLING_POINTS,
            "图片补充卖点",
            "IMAGE_SUGGESTION",
        )
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[
                drop("image-core-01", SemanticSuggestionReason.CAPACITY)
            ],
            user_fact_notices=[],
        )
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=images,
    )

    assert result.candidate.core_selling_points == [
        "用户核心卖点1",
        "用户核心卖点2",
        "用户核心卖点3",
        "用户核心卖点4",
    ]
    assert provider.remaining_capacity[SemanticField.CORE_SELLING_POINTS.value] == 0
    assert result.metadata["userFactNotices"][0]["issue"] == (
        SemanticUserFactIssue.FIELD_OVER_RECOMMENDED_COUNT.value
    )
    assert result.metadata["userFactNotices"][0]["actualCount"] == 4


@pytest.mark.asyncio
async def test_exact_duplicate_user_facts_are_not_removed() -> None:
    candidate = ExtractionCandidate.empty()
    users = [
        fact("user-usage-01", SemanticField.USAGE_SCENARIOS, "煲仔饭烹饪", "USER_FACT"),
        fact("user-usage-02", SemanticField.USAGE_SCENARIOS, "煲仔饭烹饪", "USER_FACT"),
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[],
            user_fact_notices=[
                SemanticUserFactNotice(
                    fact_id="user-usage-02",
                    issue=SemanticUserFactIssue.POSSIBLE_DUPLICATE,
                    related_fact_ids=["user-usage-01"],
                )
            ],
        )
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=[],
    )

    assert result.candidate.usage_scenarios == ["煲仔饭烹饪", "煲仔饭烹饪"]


@pytest.mark.asyncio
async def test_worker_rejects_cross_field_user_notices() -> None:
    candidate = ExtractionCandidate.empty()
    users = [
        fact(
            "user-pain-01",
            SemanticField.CORE_PAIN_POINTS,
            "日常佐餐缺少方便搭配",
            "USER_FACT",
        ),
        fact(
            "user-usage-01",
            SemanticField.USAGE_SCENARIOS,
            "家庭日常佐餐",
            "USER_FACT",
        ),
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[],
            user_fact_notices=[
                SemanticUserFactNotice(
                    fact_id="user-pain-01",
                    issue=SemanticUserFactIssue.POSSIBLE_OVERLAP,
                    related_fact_ids=["user-usage-01"],
                ),
                SemanticUserFactNotice(
                    fact_id="user-pain-01",
                    issue=SemanticUserFactIssue.POSSIBLE_WRONG_FIELD,
                    suggested_field=SemanticField.USAGE_SCENARIOS,
                ),
            ],
        )
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=[],
    )

    assert result.metadata["userFactNotices"] == []
    assert result.metadata["validation"]["correctionCounts"] == {
        "CROSS_FIELD_USER_NOTICE": 1,
        "CROSS_LAYER_USER_NOTICE": 1,
    }


@pytest.mark.asyncio
async def test_worker_rejects_cross_field_overlap_but_allows_same_layer_move() -> None:
    candidate = ExtractionCandidate.empty()
    users = [
        fact(
            "user-core-01",
            SemanticField.CORE_SELLING_POINTS,
            "广府糖酒腌制工艺",
            "USER_FACT",
        ),
        fact(
            "user-secondary-01",
            SemanticField.SECONDARY_SELLING_POINTS,
            "传统糖酒腌制风味",
            "USER_FACT",
        ),
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[],
            user_fact_notices=[
                SemanticUserFactNotice(
                    fact_id="user-core-01",
                    issue=SemanticUserFactIssue.POSSIBLE_OVERLAP,
                    related_fact_ids=["user-secondary-01"],
                ),
                SemanticUserFactNotice(
                    fact_id="user-secondary-01",
                    issue=SemanticUserFactIssue.POSSIBLE_WRONG_FIELD,
                    suggested_field=SemanticField.CORE_SELLING_POINTS,
                ),
            ],
        )
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=[],
    )

    assert result.metadata["userNoticeCount"] == 1
    assert result.metadata["userFactNotices"][0]["suggestedField"] == (
        SemanticField.CORE_SELLING_POINTS.value
    )
    assert result.metadata["validation"]["status"] == "CORRECTED"
    assert result.metadata["validation"]["correctionCounts"] == {
        "CROSS_FIELD_USER_NOTICE": 1
    }


@pytest.mark.asyncio
async def test_single_user_fact_skips_the_model() -> None:
    candidate = ExtractionCandidate.empty()
    users = [
        fact("user-usage-01", SemanticField.USAGE_SCENARIOS, "煲仔饭烹饪", "USER_FACT")
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(suggestion_decisions=[], user_fact_notices=[])
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=[],
    )

    assert result.candidate.usage_scenarios == ["煲仔饭烹饪"]
    assert provider.calls == 0


@pytest.mark.asyncio
async def test_worker_treats_missing_image_decisions_as_safe_drops() -> None:
    candidate = ExtractionCandidate.empty()
    images = [
        fact(
            "image-usage-01",
            SemanticField.USAGE_SCENARIOS,
            "蒸制食用",
            "IMAGE_SUGGESTION",
        )
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(suggestion_decisions=[], user_fact_notices=[])
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=[],
        image_suggestions=images,
    )

    assert result.candidate.usage_scenarios is None
    assert result.metadata["validation"] == {
        "status": "CORRECTED",
        "correctionCount": 1,
        "correctionCodes": ["MISSING_SUGGESTION_DECISION"],
        "correctionCounts": {"MISSING_SUGGESTION_DECISION": 1},
    }


@pytest.mark.asyncio
async def test_worker_accepts_inferred_drop_with_duplicate_reason() -> None:
    candidate = ExtractionCandidate.empty()
    images = [
        fact(
            "image-purchase-01",
            SemanticField.PURCHASE_SCENARIOS,
            "由静物推断的采购意图",
            "IMAGE_SUGGESTION",
        )
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[
                drop(
                    "image-purchase-01",
                    SemanticSuggestionReason.DUPLICATE_USER_FACT,
                    evidence_basis=(
                        SemanticImageEvidenceBasis.INFERRED_INTENT_OR_CLAIM
                    ),
                )
            ],
            user_fact_notices=[],
        )
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=[],
        image_suggestions=images,
    )

    assert result.candidate.purchase_scenarios is None
    assert result.metadata["validation"]["status"] == "VERIFIED"


@pytest.mark.asyncio
async def test_worker_drops_image_suggestions_over_remaining_capacity() -> None:
    candidate = ExtractionCandidate.empty()
    users = [
        fact(
            f"user-core-{index:02d}",
            SemanticField.CORE_SELLING_POINTS,
            f"卖点{index}",
            "USER_FACT",
        )
        for index in range(1, 4)
    ]
    images = [
        fact(
            "image-core-01",
            SemanticField.CORE_SELLING_POINTS,
            "图片卖点",
            "IMAGE_SUGGESTION",
        )
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[
                keep("image-core-01", SemanticField.CORE_SELLING_POINTS)
            ],
            user_fact_notices=[],
        )
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=images,
    )

    assert result.candidate.core_selling_points == ["卖点1", "卖点2", "卖点3"]
    assert result.metadata["validation"]["correctionCounts"] == {
        "FIELD_CAPACITY_EXCEEDED": 1
    }


@pytest.mark.asyncio
async def test_worker_ignores_notice_for_unknown_user_fact() -> None:
    candidate = ExtractionCandidate.empty()
    users = [
        fact("user-usage-01", SemanticField.USAGE_SCENARIOS, "蒸制食用", "USER_FACT"),
        fact("user-usage-02", SemanticField.USAGE_SCENARIOS, "炒制食用", "USER_FACT"),
    ]
    provider = SemanticProvider(
        SemanticRefinementDecision(
            suggestion_decisions=[],
            user_fact_notices=[
                SemanticUserFactNotice(
                    fact_id="missing",
                    issue=SemanticUserFactIssue.AMBIGUOUS_EXPRESSION,
                )
            ],
        )
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        user_facts=users,
        image_suggestions=[],
    )

    assert result.metadata["userNoticeCount"] == 0
    assert result.metadata["validation"]["correctionCounts"] == {
        "UNKNOWN_USER_NOTICE_FACT": 1
    }
