from __future__ import annotations

from collections.abc import Mapping, Sequence

import pytest

from effect_extraction.models import (
    ExtractionCandidate,
    SemanticField,
    SemanticGroup,
    SemanticRefinementDecision,
    SemanticRelation,
)
from effect_extraction.providers import AiCallMetadata, AiCallResult
from effect_extraction.semantic_refinement import (
    SemanticFactSource,
    refine_candidate_semantics,
)


class SemanticProvider:
    def __init__(self, groups: list[SemanticGroup]) -> None:
        self.groups = groups
        self.refinement_calls = 0
        self.facts: list[dict[str, str]] = []

    async def refine_semantics(
        self,
        *,
        facts: Sequence[Mapping[str, str]],
    ) -> AiCallResult[SemanticRefinementDecision]:
        self.refinement_calls += 1
        self.facts = [dict(fact) for fact in facts]
        return AiCallResult(
            value=SemanticRefinementDecision(groups=self.groups),
            metadata=AiCallMetadata(
                stage="SEMANTIC_REFINEMENT",
                model="test-mini-model",
                prompt_version="test-v2",
                input_tokens=10,
                output_tokens=5,
                total_tokens=15,
                latency_ms=3,
                attempts=1,
                reasoning_tokens=0,
            ),
        )


@pytest.mark.asyncio
async def test_semantic_refinement_keeps_an_existing_fact_for_same_meaning() -> None:
    candidate = ExtractionCandidate.empty()
    candidate.product_name = "广式腊肠"
    candidate.core_pain_points = [
        "日常佐餐缺少方便入味的腊味食材",
        "日常佐餐缺少方便且有风味的预制食材",
        "节日备货选择困难",
    ]
    provider = SemanticProvider(
        [
            SemanticGroup(
                field=SemanticField.CORE_PAIN_POINTS,
                member_fact_ids=["corePainPoints-01", "corePainPoints-02"],
                representative_fact_id="corePainPoints-01",
                relation=SemanticRelation.SAME_MEANING,
            )
        ]
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        fact_sources={
            SemanticField.CORE_PAIN_POINTS.value: {
                value: SemanticFactSource.IMAGE_SUGGESTION
                for value in candidate.core_pain_points or []
            }
        },
    )

    assert result.candidate.product_name == "广式腊肠"
    assert result.candidate.core_pain_points == [
        "日常佐餐缺少方便入味的腊味食材",
        "节日备货选择困难",
    ]
    assert result.metadata["mergedGroupCount"] == 1
    assert result.metadata["familyGroupCount"] == 0
    assert result.metadata["semanticGroups"][0]["canonicalValue"] == (
        "日常佐餐缺少方便入味的腊味食材"
    )
    assert result.metadata["semanticGroups"][0]["applied"] is True
    assert provider.refinement_calls == 1


@pytest.mark.asyncio
async def test_same_family_groups_are_visible_but_keep_distinct_scenarios() -> None:
    candidate = ExtractionCandidate.empty()
    candidate.usage_scenarios = ["煲仔饭烹饪", "蒸制食用", "炒制食用"]
    provider = SemanticProvider(
        [
            SemanticGroup(
                field=SemanticField.USAGE_SCENARIOS,
                member_fact_ids=[
                    "usageScenarios-01",
                    "usageScenarios-02",
                    "usageScenarios-03",
                ],
                representative_fact_id="usageScenarios-01",
                relation=SemanticRelation.SAME_FAMILY,
            )
        ]
    )

    result = await refine_candidate_semantics(candidate, provider=provider)  # type: ignore[arg-type]

    assert result.candidate.usage_scenarios == ["煲仔饭烹饪", "蒸制食用", "炒制食用"]
    assert result.metadata["inputCount"] == 3
    assert result.metadata["outputCount"] == 3
    assert result.metadata["mergedGroupCount"] == 0
    assert result.metadata["familyGroupCount"] == 1
    assert result.metadata["semanticGroups"][0]["applied"] is False


@pytest.mark.asyncio
async def test_semantic_refinement_skips_ai_when_no_field_has_multiple_items() -> None:
    candidate = ExtractionCandidate.empty()
    candidate.core_pain_points = ["备餐时间有限"]
    candidate.usage_scenarios = ["家庭聚餐"]
    provider = SemanticProvider([])

    result = await refine_candidate_semantics(candidate, provider=provider)  # type: ignore[arg-type]

    assert result.candidate == candidate
    assert result.metadata["mergedGroupCount"] == 0
    assert provider.refinement_calls == 0


@pytest.mark.asyncio
async def test_semantic_refinement_removes_exact_duplicates_without_ai() -> None:
    candidate = ExtractionCandidate.empty()
    candidate.purchase_scenarios = ["年货送礼", " 年货送礼 "]
    provider = SemanticProvider([])

    result = await refine_candidate_semantics(candidate, provider=provider)  # type: ignore[arg-type]

    assert result.candidate.purchase_scenarios == ["年货送礼"]
    assert result.metadata["inputCount"] == 2
    assert result.metadata["outputCount"] == 1
    assert provider.refinement_calls == 0


@pytest.mark.asyncio
async def test_invalid_representative_fact_id_cannot_delete_input_facts() -> None:
    candidate = ExtractionCandidate.empty()
    candidate.emotional_scenarios = ["家庭围餐的温馨氛围", "家人围餐的烟火暖意"]
    provider = SemanticProvider(
        [
            SemanticGroup(
                field=SemanticField.EMOTIONAL_SCENARIOS,
                member_fact_ids=["emotionalScenarios-01", "emotionalScenarios-02"],
                representative_fact_id="corePainPoints-01",
                relation=SemanticRelation.SAME_MEANING,
            )
        ]
    )

    result = await refine_candidate_semantics(candidate, provider=provider)  # type: ignore[arg-type]

    assert result.candidate.emotional_scenarios == [
        "家庭围餐的温馨氛围",
        "家人围餐的烟火暖意",
    ]
    assert result.metadata["mergedGroupCount"] == 0


@pytest.mark.asyncio
async def test_model_cannot_delete_two_user_facts_even_when_it_groups_them() -> None:
    candidate = ExtractionCandidate.empty()
    candidate.decision_drivers = [
        "节庆元素烘托契合年货采购需求",
        "整根腊肠清晰展示，便于判断外观品质",
    ]
    provider = SemanticProvider(
        [
            SemanticGroup(
                field=SemanticField.DECISION_DRIVERS,
                member_fact_ids=["decisionDrivers-01", "decisionDrivers-02"],
                representative_fact_id="decisionDrivers-01",
                relation=SemanticRelation.SAME_MEANING,
            )
        ]
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        fact_sources={
            SemanticField.DECISION_DRIVERS.value: {
                value: SemanticFactSource.USER_FACT
                for value in candidate.decision_drivers or []
            }
        },
    )

    assert result.candidate.decision_drivers == candidate.decision_drivers
    assert result.metadata["mergedGroupCount"] == 0
    assert result.metadata["rejectedMergeCount"] == 1
    assert result.metadata["semanticGroups"][0]["applied"] is False


@pytest.mark.asyncio
async def test_worker_applies_model_parent_child_without_textual_semantic_check() -> (
    None
):
    candidate = ExtractionCandidate.empty()
    candidate.usage_scenarios = ["家庭日常佐餐", "居家日常吃饭场景"]
    provider = SemanticProvider(
        [
            SemanticGroup(
                field=SemanticField.USAGE_SCENARIOS,
                member_fact_ids=["usageScenarios-01", "usageScenarios-02"],
                representative_fact_id="usageScenarios-02",
                relation=SemanticRelation.PARENT_CHILD,
            )
        ]
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        fact_sources={
            SemanticField.USAGE_SCENARIOS.value: {
                value: SemanticFactSource.IMAGE_SUGGESTION
                for value in candidate.usage_scenarios or []
            }
        },
    )

    assert result.candidate.usage_scenarios == ["居家日常吃饭场景"]
    assert result.metadata["mergedGroupCount"] == 1


@pytest.mark.asyncio
async def test_semantic_model_deduplicates_differently_worded_image_selling_points() -> (
    None
):
    candidate = ExtractionCandidate.empty()
    candidate.secondary_selling_points = [
        "肥瘦纹理分明，肉质油润有光泽",
        "肥瘦纹理清晰分明",
        "整根切片同展，形态直观可见",
    ]
    provider = SemanticProvider(
        [
            SemanticGroup(
                field=SemanticField.SECONDARY_SELLING_POINTS,
                member_fact_ids=[
                    "secondarySellingPoints-01",
                    "secondarySellingPoints-02",
                ],
                representative_fact_id="secondarySellingPoints-01",
                relation=SemanticRelation.SAME_MEANING,
            )
        ]
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        fact_sources={
            SemanticField.SECONDARY_SELLING_POINTS.value: {
                value: SemanticFactSource.IMAGE_SUGGESTION
                for value in candidate.secondary_selling_points or []
            }
        },
    )

    assert result.candidate.secondary_selling_points == [
        "肥瘦纹理分明，肉质油润有光泽",
        "整根切片同展，形态直观可见",
    ]
    assert provider.facts[0]["sourceType"] == "IMAGE_SUGGESTION"
    assert result.metadata["mergedGroupCount"] == 1


@pytest.mark.asyncio
async def test_user_fact_is_the_only_allowed_representative_in_a_mixed_group() -> None:
    candidate = ExtractionCandidate.empty()
    candidate.secondary_selling_points = [
        "切片均匀、形态规整",
        "切片形态规整均匀",
    ]
    provider = SemanticProvider(
        [
            SemanticGroup(
                field=SemanticField.SECONDARY_SELLING_POINTS,
                member_fact_ids=[
                    "secondarySellingPoints-01",
                    "secondarySellingPoints-02",
                ],
                representative_fact_id="secondarySellingPoints-01",
                relation=SemanticRelation.SAME_MEANING,
            )
        ]
    )

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        fact_sources={
            SemanticField.SECONDARY_SELLING_POINTS.value: {
                "切片均匀、形态规整": SemanticFactSource.USER_FACT,
                "切片形态规整均匀": SemanticFactSource.IMAGE_SUGGESTION,
            }
        },
    )

    assert result.candidate.secondary_selling_points == ["切片均匀、形态规整"]
    assert result.metadata["mergedGroupCount"] == 1


@pytest.mark.asyncio
async def test_worker_does_not_collapse_punctuation_variants_before_model() -> None:
    candidate = ExtractionCandidate.empty()
    candidate.secondary_selling_points = [
        "肥瘦纹理清晰，油润有光泽",
        "肥瘦纹理清晰、油润有光泽",
    ]
    provider = SemanticProvider([])

    result = await refine_candidate_semantics(
        candidate,
        provider=provider,  # type: ignore[arg-type]
        fact_sources={
            SemanticField.SECONDARY_SELLING_POINTS.value: {
                value: SemanticFactSource.IMAGE_SUGGESTION
                for value in candidate.secondary_selling_points or []
            }
        },
    )

    assert [row["value"] for row in provider.facts] == (
        candidate.secondary_selling_points
    )
    assert result.candidate.secondary_selling_points == (
        candidate.secondary_selling_points
    )
