from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

from effect_prompt_generation.models import (
    FRAGMENT_TYPE_WEIGHTS,
    FragmentTypeDistribution,
    PromptBatchResult,
    PromptBatchSettings,
    PromptItem,
    PromptMetrics,
    SellingPointCoverage,
)
from effect_prompt_generation.combinations import fragment_type_targets


def test_pydantic_result_matches_shared_json_schema(prompt_item: PromptItem) -> None:
    item = prompt_item
    result = PromptBatchResult(
        settings=PromptBatchSettings(
            count=10,
            duration_seconds=5,
            semantic_limit=15,
            visual_limit=20,
            style_override=None,
            fragment_type_weights=dict(FRAGMENT_TYPE_WEIGHTS),
            selling_point_weights=[],
            additional_disabled_elements=[],
        ),
        items=[item],
        metrics=PromptMetrics(
            target_count=10,
            accepted_count=1,
            generated_candidate_count=1,
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
                for fragment_type, target in fragment_type_targets(10).items()
            ],
            selling_point_coverage=SellingPointCoverage(
                required=[item.dimensions.selling_point],
                covered=[item.dimensions.selling_point],
                missing=[],
            ),
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
