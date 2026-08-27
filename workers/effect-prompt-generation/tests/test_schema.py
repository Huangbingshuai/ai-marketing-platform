from __future__ import annotations

import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator

from effect_prompt_generation.models import (
    CreativeAverageScores,
    CreativeDimensions,
    FragmentType,
    PromptBatchResultV6,
    PromptBatchSettingsV6,
    PromptItem,
    PromptItemV6,
    PromptMetricsV6,
    PurposeDistribution,
    RenderProfile,
    SharedPrompt,
    SharedPromptSection,
    SharedRenderConstraints,
)


def test_pydantic_result_matches_shared_json_schema(prompt_item: PromptItem) -> None:
    item = PromptItemV6(
        id=prompt_item.id,
        code=prompt_item.code,
        origin=prompt_item.origin,
        fragment_type=prompt_item.fragment_type,
        primary_purpose=prompt_item.fragment_type,
        compatible_purposes=[
            prompt_item.fragment_type,
            FragmentType.SELLING_POINT_EXPLANATION,
        ],
        classification_status="VERIFIED",
        product_relevance=92,
        material_tags=prompt_item.material_tags,
        target_duration_seconds=prompt_item.target_duration_seconds,
        dimensions=CreativeDimensions(
            narrative=prompt_item.dimensions.narrative,
            scene=prompt_item.dimensions.scene,
            persona=prompt_item.dimensions.persona,
            product_relation=prompt_item.dimensions.selling_point,
            camera=prompt_item.dimensions.camera,
            emotion=prompt_item.dimensions.emotion,
        ),
        content=prompt_item.content,
        insight_bindings=prompt_item.insight_bindings,
        manual_edited=prompt_item.manual_edited,
        created_at=prompt_item.created_at,
        updated_at=prompt_item.updated_at,
    )
    result = PromptBatchResultV6(
        settings=PromptBatchSettingsV6(target_count=10, default_duration_seconds=5),
        render_profile=RenderProfile(
            ratio="9:16",
            resolution="1080p",
            capability_key="SEEDANCE_2_0",
            shared_constraints=SharedRenderConstraints(
                disabled_elements=["医疗暗示"],
                content_hash="0" * 64,
            ),
        ),
        shared_prompt=SharedPrompt(
            sections=[
                SharedPromptSection(
                    key="DISABLED_ELEMENTS",
                    title="禁用元素",
                    source="SYSTEM",
                    content="画面中不得出现以下内容：医疗暗示。",
                    editable=False,
                    source_hash="1" * 64,
                ),
                SharedPromptSection(
                    key="USER_ADDITIONAL",
                    title="补充共用内容",
                    source="USER",
                    content="",
                    editable=True,
                    source_hash=hashlib.sha256(b"").hexdigest(),
                ),
            ],
            compiled_content="画面中不得出现以下内容：医疗暗示。",
            content_hash=hashlib.sha256(
                "画面中不得出现以下内容：医疗暗示。".encode()
            ).hexdigest(),
        ),
        items=[item],
        metrics=PromptMetricsV6(
            target_count=10,
            candidate_target_count=12,
            accepted_count=1,
            generated_candidate_count=12,
            rejected_count=11,
            replenishment_rounds=0,
            exact_duplicate_count=0,
            purpose_distribution=[
                PurposeDistribution(
                    purpose=purpose,
                    primary_count=1 if purpose == item.primary_purpose else 0,
                    compatible_count=1 if purpose in item.compatible_purposes else 0,
                )
                for purpose in FragmentType
            ],
            average_scores=CreativeAverageScores(
                product_relevance=92,
                creative_coherence=90,
                visual_executability=88,
                commercial_usefulness=86,
                visual_clarity=91,
            ),
            hard_issue_counts=[],
            warning_counts=[],
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

    Draft202012Validator(
        schema, format_checker=Draft202012Validator.FORMAT_CHECKER
    ).validate(result.model_dump(mode="json", by_alias=True))
