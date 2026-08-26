from __future__ import annotations

import pytest

from effect_prompt_generation.combinations import plan_combinations
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    FragmentConfig,
    FragmentType,
    InsightArtifact,
    InsightField,
    PromptBatchSettings,
    PromptGenerationSnapshot,
    PromptItem,
    utc_now,
)
from effect_prompt_generation.pipeline import _freeze_item_regeneration_combination
from effect_prompt_generation.providers import MockAiProvider


@pytest.mark.asyncio
async def test_item_regeneration_freezes_identity_fields_and_rebinds_selling_point() -> None:
    insight = {
        "productName": "便携杯",
        "productCategory": "随行杯",
        "coreSellingPoints": ["单手开合", "轻量便携"],
        "secondarySellingPoints": ["易清洗"],
        "targetAudience": "通勤人群",
        "corePainPoints": ["通勤途中不便双手操作"],
        "decisionDrivers": ["拿取方便"],
        "marketingGoal": "形成产品认知",
        "usageScenarios": ["地铁通勤"],
    }
    application = map_insight(insight)
    strategy = (await MockAiProvider().plan_strategy(application, target_count=10)).value
    fragment_targets = {
        FragmentType.HOOK: 2,
        FragmentType.PAIN: 2,
        FragmentType.PRODUCT_DISPLAY: 2,
        FragmentType.SELLING_POINT_EXPLANATION: 2,
        FragmentType.CTA: 1,
        FragmentType.OUTRO: 1,
    }
    combination = plan_combinations(
        strategy,
        application,
        count=1,
        round_number=0,
        ordinal_start=1,
        fragment_targets=fragment_targets,
        fragment_durations={fragment_type: 5 for fragment_type in FragmentType},
        fragment_deficits={
            fragment_type: int(fragment_type == FragmentType.SELLING_POINT_EXPLANATION)
            for fragment_type in FragmentType
        },
    )[0]
    now = utc_now()
    target = PromptItem(
        id="prompt-target",
        code="SP-001",
        origin="MANUAL",
        fragment_type=FragmentType.SELLING_POINT_EXPLANATION,
        material_tags=["卖点", "口播"],
        target_duration_seconds=5,
        dimensions=combination.dimensions,
        content="当前提示词正文",
        insight_bindings=combination.insight_bindings,
        manual_edited=True,
        created_at=now,
        updated_at=now,
    )
    replacement_dimensions = combination.dimensions.model_copy(
        update={"selling_point": "轻量便携", "scene": "清晨地铁站入口"}
    )
    snapshot = PromptGenerationSnapshot(
        project_id="project-1",
        workflow_run_id="workflow-1",
        product_id="product-1",
        operation="ITEM_REGENERATE",
        target_item_id=target.id,
        target_item=target,
        target_item_index=7,
        replacement_dimensions=replacement_dimensions,
        regeneration_instruction="产品更早出现",
        settings=PromptBatchSettings(
            fragment_configs={
                fragment_type: FragmentConfig(
                    count=fragment_targets[fragment_type], duration_seconds=5
                )
                for fragment_type in FragmentType
            },
            semantic_limit=15,
            visual_limit=20,
        ),
        insight_artifact=InsightArtifact(
            id="insight-1", revision=1, content_hash="hash", result=insight
        ),
        retained_manual_items=[],
        base_result_revision=3,
    )

    frozen = _freeze_item_regeneration_combination(
        combination,
        snapshot=snapshot,
        strategy=strategy,
        application=application,
    )

    assert frozen.fragment_type == target.fragment_type
    assert frozen.material_tags == target.material_tags
    assert frozen.target_duration_seconds == target.target_duration_seconds
    assert frozen.dimensions == replacement_dimensions
    selling_bindings = [
        binding
        for binding in frozen.insight_bindings
        if binding.field in {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT}
    ]
    assert [(binding.field, binding.value) for binding in selling_bindings] == [
        (InsightField.CORE_SELLING_POINT, "轻量便携")
    ]


def test_batch_snapshot_rejects_item_regeneration_fields() -> None:
    with pytest.raises(ValueError, match="batch generation cannot contain"):
        PromptGenerationSnapshot.model_validate(
            {
                "projectId": "project-1",
                "workflowRunId": "workflow-1",
                "productId": "product-1",
                "operation": "BATCH_GENERATE",
                "settings": {
                    "fragmentConfigs": {
                        "HOOK": {"count": 2, "durationSeconds": 5},
                        "PAIN": {"count": 2, "durationSeconds": 5},
                        "PRODUCT_DISPLAY": {"count": 2, "durationSeconds": 5},
                        "SELLING_POINT_EXPLANATION": {"count": 2, "durationSeconds": 5},
                        "CTA": {"count": 1, "durationSeconds": 5},
                        "OUTRO": {"count": 1, "durationSeconds": 5},
                    },
                    "semanticLimit": 15,
                    "visualLimit": 20,
                },
                "insightArtifact": {
                    "id": "insight-1",
                    "revision": 1,
                    "contentHash": "hash",
                    "result": {},
                },
                "regenerationInstruction": "不应允许",
            }
        )
