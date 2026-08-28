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
from effect_extraction.semantic_refinement import refine_candidate_semantics


class SemanticProvider:
    def __init__(self, groups: list[SemanticGroup]) -> None:
        self.groups = groups
        self.refinement_calls = 0

    async def refine_semantics(
        self,
        *,
        facts: Sequence[Mapping[str, str]],
    ) -> AiCallResult[SemanticRefinementDecision]:
        self.refinement_calls += 1
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

    result = await refine_candidate_semantics(candidate, provider=provider)  # type: ignore[arg-type]

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
