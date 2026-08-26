from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

from effect_prompt_generation.combinations import fragment_type_targets
from effect_prompt_generation.models import (
    FragmentConfig,
    FragmentType,
    FragmentTypeDistribution,
    InsightCoverage,
    PromptBatchResult,
    PromptBatchSettings,
    PromptItem,
    PromptMetrics,
    RenderProfile,
    SellingPointCoverage,
    SharedRenderConstraints,
)


def test_pydantic_result_matches_shared_json_schema(prompt_item: PromptItem) -> None:
    item = prompt_item
    result = PromptBatchResult(
        settings=PromptBatchSettings(
            fragment_configs={
                FragmentType.HOOK: FragmentConfig(count=2, duration_seconds=5),
                FragmentType.PAIN: FragmentConfig(count=2, duration_seconds=5),
                FragmentType.PRODUCT_DISPLAY: FragmentConfig(count=2, duration_seconds=5),
                FragmentType.SELLING_POINT_EXPLANATION: FragmentConfig(count=2, duration_seconds=5),
                FragmentType.CTA: FragmentConfig(count=1, duration_seconds=5),
                FragmentType.OUTRO: FragmentConfig(count=1, duration_seconds=5),
            },
            semantic_limit=15,
            visual_limit=20,
        ),
        render_profile=RenderProfile(
            ratio="9:16",
            resolution="1080p",
            capability_key="SEEDANCE_2_0",
            shared_constraints=SharedRenderConstraints(
                disabled_elements=["医疗暗示"],
                content_hash="0" * 64,
            ),
        ),
        items=[item],
        metrics=PromptMetrics(
            target_count=10,
            accepted_count=1,
            generated_candidate_count=1,
            fallback_count=0,
            removed_semantic_duplicates=0,
            removed_visual_duplicates=0,
            removed_dimension_conflicts=0,
            removed_execution_invalid=0,
            execution_invalid_reasons=[],
            semantic_duplicate_rate=0,
            visual_overlap_rate=0,
            replenishment_rounds=0,
            fragment_type_distribution=[
                FragmentTypeDistribution(
                    fragment_type=fragment_type,
                    target_count=target,
                    actual_count=1 if fragment_type == item.fragment_type else 0,
                )
                for fragment_type, target in fragment_type_targets(
                    {fragment_type: result_count for fragment_type, result_count in {
                        FragmentType.HOOK: 2,
                        FragmentType.PAIN: 2,
                        FragmentType.PRODUCT_DISPLAY: 2,
                        FragmentType.SELLING_POINT_EXPLANATION: 2,
                        FragmentType.CTA: 1,
                        FragmentType.OUTRO: 1,
                    }.items()}
                ).items()
            ],
            selling_point_coverage=SellingPointCoverage(
                required=[item.dimensions.selling_point],
                covered=[item.dimensions.selling_point],
                missing=[],
            ),
            insight_coverage=InsightCoverage(),
        ),
        quality_status="NEEDS_REVIEW",
    )
    schema_path = (
        Path(__file__).resolve().parents[3]
        / "packages"
        / "contracts"
        / "schemas"
        / "effect-prompt-batch.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))

    Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER).validate(
        result.model_dump(mode="json", by_alias=True)
    )
