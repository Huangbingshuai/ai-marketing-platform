from __future__ import annotations

import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator

from effect_prompt_generation.models import (
    CreativeAverageScores,
    CreativeEvaluationDraft,
    CreativeEvaluationDraftBatch,
    FragmentType,
    PromptBatchResult,
    PromptBatchSettings,
    PromptItem,
    PromptMetrics,
    PurposeDistribution,
    RenderProfile,
    SharedPrompt,
    SharedPromptSection,
    SharedRenderConstraints,
)


def test_evaluation_draft_schema_excludes_worker_derived_fields() -> None:
    schema = CreativeEvaluationDraftBatch.model_json_schema(by_alias=True)
    properties = schema["$defs"]["CreativeEvaluationDraft"]["properties"]

    assert "factEvidence" in properties
    assert "scores" in properties
    assert "realizedFactIds" not in properties
    assert "semanticSignature" not in properties
    assert "visualSignature" not in properties
    assert properties["compatiblePurposes"]["maxItems"] == 3
    assert properties["factEvidence"]["maxItems"] == 3
    assert properties["hardIssues"]["maxItems"] == 5
    assert properties["warnings"]["maxItems"] == 3


def test_evaluation_draft_treats_compatible_purposes_as_other_purposes() -> None:
    draft = CreativeEvaluationDraft(
        slot_id="creative-1",
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[
            FragmentType.PRODUCT_DISPLAY,
            FragmentType.CTA,
            FragmentType.CTA,
        ],
        scores={
            "productRelevance": 90,
            "creativeCoherence": 90,
            "visualExecutability": 90,
            "commercialUsefulness": 90,
            "visualClarity": 90,
        },
    )

    assert draft.compatible_purposes == [FragmentType.CTA]

    primary_only = CreativeEvaluationDraft(
        slot_id="creative-2",
        primary_purpose=FragmentType.HOOK,
        compatible_purposes=[],
        scores={
            "productRelevance": 90,
            "creativeCoherence": 90,
            "visualExecutability": 90,
            "commercialUsefulness": 90,
            "visualClarity": 90,
        },
    )

    assert primary_only.compatible_purposes == []


def test_pydantic_result_matches_shared_json_schema(prompt_item: PromptItem) -> None:
    item = prompt_item.model_copy(
        update={
            "compatible_purposes": [
                prompt_item.fragment_type,
                FragmentType.SELLING_POINT_EXPLANATION,
            ]
        }
    )
    result = PromptBatchResult(
        settings=PromptBatchSettings(target_count=10, default_duration_seconds=5),
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
        metrics=PromptMetrics(
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
