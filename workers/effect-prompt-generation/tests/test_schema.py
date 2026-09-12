from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from effect_prompt_generation.models import (
    CreativeAverageScores,
    CreativeDirection,
    CreativeEvaluation,
    CreativeEvaluationDraft,
    CreativeEvaluationDraftBatch,
    CreativeEvaluationBatch,
    CreativeScores,
    FactEvidence,
    FragmentType,
    InsightCoverage,
    PromptBatchResult,
    PromptBatchSettings,
    PromptGenerationSnapshot,
    PromptItem,
    PromptMetrics,
    PurposeDistribution,
    RenderProfile,
    SemanticEvaluation,
    SharedPrompt,
    SharedPromptSection,
    SharedRenderConstraints,
)


def test_creative_direction_trims_extra_avoidance_hints_without_semantic_rewrite() -> None:
    direction = CreativeDirection.model_validate(
        {
            "directionId": "direction-1",
            "territoryId": "PRODUCT_TEXTURE",
            "primaryActionId": "VISIBLE_ACTION",
            "factApplications": [
                {
                    "factId": "CORE_SELLING_POINT:1",
                    "creativeUsage": "通过真实使用动作承载已确认卖点",
                }
            ],
            "creativeDirection": "用一个连续动作展示产品的真实使用结果",
            "priorityDimensions": ["NARRATIVE", "CAMERA"],
            "semanticProfile": {
                "narrativeFamily": "状态变化",
                "sceneFamily": "真实使用场景",
                "personaFamily": "成年使用者",
                "productActionFamily": "取用产品",
                "cameraFamily": "近景跟随",
                "emotionFamily": "清晰可信",
            },
            "avoidFamilies": ["拥挤动作", "空泛展示", "重复摆拍"],
        }
    )

    assert direction.avoid_families == ["拥挤动作", "空泛展示"]


def test_evaluation_draft_ignores_unknown_optional_evidence_source() -> None:
    draft = CreativeEvaluationDraft.model_validate(
        {
            "slotId": "creative-1",
            "primaryPurpose": "PRODUCT_DISPLAY",
            "compatiblePurposes": [],
            "factEvidence": [
                {
                    "factId": "CORE_SELLING_POINT:1",
                    "evidenceSource": "SHOT_PLAN",
                    "supportLevel": "SEMANTIC_FULL",
                }
            ],
            "scores": {
                "productRelevance": 90,
                "creativeCoherence": 90,
                "visualExecutability": 90,
                "commercialUsefulness": 90,
                "visualClarity": 90,
            },
        }
    )

    assert draft.fact_evidence[0].evidence_source is None


def test_item_evaluate_allows_retained_items_above_batch_target(
    prompt_item: PromptItem,
) -> None:
    snapshot = PromptGenerationSnapshot(
        project_id="project-current",
        workflow_run_id="workflow-current",
        product_id="product-current",
        operation="ITEM_EVALUATE",
        target_item_id=prompt_item.id,
        target_item=prompt_item,
        target_item_index=10,
        settings=PromptBatchSettings(target_count=10, default_duration_seconds=5),
        insight_artifact={
            "id": "insight-current",
            "revision": 1,
            "contentHash": "sha256:current",
            "result": {"productName": "测试商品"},
        },
        retained_manual_items=[prompt_item] * 11,
        selection_policy="MMR_CONTENT",
    )

    assert len(snapshot.retained_manual_items) == 11


def test_prompt_batch_target_count_has_a_hard_limit_of_100() -> None:
    assert PromptBatchSettings(
        target_count=100, default_duration_seconds=5
    ).target_count == 100
    with pytest.raises(ValidationError):
        PromptBatchSettings(target_count=101, default_duration_seconds=5)


def test_prompt_duration_has_a_hard_limit_of_15_seconds() -> None:
    assert PromptBatchSettings(
        target_count=10, default_duration_seconds=15
    ).default_duration_seconds == 15
    with pytest.raises(ValidationError):
        PromptBatchSettings(target_count=10, default_duration_seconds=16)


def test_prompt_item_schema_has_no_secondary_material_tags() -> None:
    schema = PromptItem.model_json_schema(by_alias=True)

    assert "materialTags" not in schema["properties"]


def test_evaluation_draft_schema_excludes_worker_derived_fields() -> None:
    schema = CreativeEvaluationDraftBatch.model_json_schema(by_alias=True)
    properties = schema["$defs"]["CreativeEvaluationDraft"]["properties"]

    assert "factEvidence" in properties
    assert "scores" in properties
    assert "realizedFactIds" not in properties
    assert "semanticSignature" not in properties
    assert "visualSignature" not in properties
    assert "semanticProfile" in properties
    assert "abstractVisualProofFindings" in properties
    assert properties["compatiblePurposes"]["maxItems"] == 4
    assert properties["factEvidence"]["maxItems"] == 16
    assert properties["hardIssues"]["maxItems"] == 5
    assert properties["warnings"]["maxItems"] == 3


def test_evaluation_models_share_public_fact_binding_capacity() -> None:
    draft_schema = CreativeEvaluationDraftBatch.model_json_schema(by_alias=True)
    draft_properties = draft_schema["$defs"]["CreativeEvaluationDraft"]["properties"]
    evaluation_schema = CreativeEvaluationBatch.model_json_schema(by_alias=True)
    evaluation_properties = evaluation_schema["$defs"]["CreativeEvaluation"]["properties"]

    assert draft_properties["factEvidence"]["maxItems"] == 16
    assert evaluation_properties["factEvidence"]["maxItems"] == 16
    assert evaluation_properties["realizedFactIds"]["maxItems"] == 16


def test_evaluation_accepts_the_failed_run_shape_without_losing_evidence() -> None:
    evidence = [
        FactEvidence(
            factId=f"SELLING_POINT:{index}",
            supportLevel="SEMANTIC_FULL" if index < 14 else "PARTIAL",
        )
        for index in range(16)
    ]

    evaluation = CreativeEvaluation(
        slotId="shampoo-material-1",
        primaryPurpose="PRODUCT_DISPLAY",
        compatiblePurposes=["PRODUCT_DISPLAY"],
        factEvidence=evidence,
        realizedFactIds=[item.fact_id for item in evidence[:14]],
        scores=CreativeScores(
            productRelevance=90,
            creativeCoherence=90,
            visualExecutability=90,
            commercialUsefulness=90,
            visualClarity=90,
        ),
        semanticSignature="shampoo-material",
        visualSignature="bathroom-close-up",
    )

    assert len(evaluation.fact_evidence) == 16
    assert len(evaluation.realized_fact_ids) == 14


def test_evaluation_draft_rejects_more_than_public_binding_capacity() -> None:
    payload = {
        "slotId": "shampoo-material-1",
        "primaryPurpose": "PRODUCT_DISPLAY",
        "compatiblePurposes": [],
        "factEvidence": [
            {"factId": f"SELLING_POINT:{index}", "supportLevel": "PARTIAL"}
            for index in range(17)
        ],
        "scores": {
            "productRelevance": 90,
            "creativeCoherence": 90,
            "visualExecutability": 90,
            "commercialUsefulness": 90,
            "visualClarity": 90,
        },
    }

    with pytest.raises(ValidationError):
        CreativeEvaluationDraft.model_validate(payload)


def test_evaluation_schema_requires_auditable_visual_proof_findings() -> None:
    schema = CreativeEvaluationBatch.model_json_schema(by_alias=True)
    properties = schema["$defs"]["CreativeEvaluation"]["properties"]
    finding = schema["$defs"]["AbstractVisualProofFinding"]["properties"]

    assert properties["abstractVisualProofFindings"]["maxItems"] == 5
    assert set(finding) == {
        "factId",
        "evidenceText",
        "evidenceSource",
        "violatedPolicy",
    }


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
    disabled_elements = ["医疗暗示"]
    disabled_hash = hashlib.sha256(
        json.dumps(
            disabled_elements,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    item = prompt_item.model_copy(
        update={
            "compatible_purposes": [
                prompt_item.fragment_type,
                FragmentType.EFFECT,
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
                disabled_elements=disabled_elements,
                content_hash=disabled_hash,
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
                        source_hash=disabled_hash,
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
            semantic_evaluation=SemanticEvaluation(
                status="VERIFIED",
                evaluated_count=1,
                duplicate_group_count=0,
                duplicate_count=0,
                duplicate_rate=0,
            ),
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

    assert schema["properties"]["settings"]["properties"][
        "defaultDurationSeconds"
    ]["maximum"] == 15
    assert schema["$defs"]["item"]["properties"]["targetDurationSeconds"][
        "maximum"
    ] == 15

    Draft202012Validator(
        schema, format_checker=Draft202012Validator.FORMAT_CHECKER
    ).validate(result.model_dump(mode="json", by_alias=True))


def test_semantic_evaluation_accepts_large_candidate_pool() -> None:
    evaluation = SemanticEvaluation(
        status="VERIFIED",
        evaluated_count=140,
        duplicate_group_count=36,
        duplicate_count=105,
        duplicate_rate=75,
    )

    assert evaluation.evaluated_count == 140
