from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

from effect_prompt_generation.models import (
    PromptBatchResult,
    PromptBatchSettings,
    PromptItem,
    PromptMetrics,
)


def test_pydantic_result_matches_shared_json_schema(prompt_item: PromptItem) -> None:
    item = prompt_item
    result = PromptBatchResult(
        settings=PromptBatchSettings(
            count=10,
            duration_seconds=15,
            semantic_limit=15,
            visual_limit=20,
        ),
        items=[item],
        metrics=PromptMetrics(
            target_count=10,
            accepted_count=1,
            generated_candidate_count=1,
            removed_semantic_duplicates=0,
            removed_visual_duplicates=0,
            removed_dimension_conflicts=0,
            semantic_duplicate_rate=0,
            visual_overlap_rate=0,
            replenishment_rounds=0,
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
