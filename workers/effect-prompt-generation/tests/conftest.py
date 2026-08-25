from __future__ import annotations

from datetime import datetime, timezone

import pytest

from effect_prompt_generation.models import (
    InsightArtifact,
    FragmentType,
    FRAGMENT_TYPE_WEIGHTS,
    PromptBatchSettings,
    PromptDimensions,
    PromptGenerationSnapshot,
    PromptItem,
    RuntimeContext,
)


@pytest.fixture
def dimensions() -> PromptDimensions:
    return PromptDimensions(
        narrative="痛点前置型",
        scene="家庭早餐",
        persona="年轻职场女性",
        selling_point="便携易用",
        camera="中景转产品特写",
        emotion="活力明快",
    )


@pytest.fixture
def prompt_item(dimensions: PromptDimensions) -> PromptItem:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return PromptItem(
        id="item-1",
        code="P001",
        origin="AI",
        fragment_type=FragmentType.PRODUCT_DISPLAY,
        material_tags=["产品", "特写"],
        target_duration_seconds=5,
        dimensions=dimensions,
        content="家庭早餐场景中展示产品便携易用，镜头从人物中景切换到产品细节。",
        manual_edited=False,
        created_at=now,
        updated_at=now,
    )


@pytest.fixture
def snapshot() -> PromptGenerationSnapshot:
    return PromptGenerationSnapshot(
        project_id="project-1",
        workflow_run_id="workflow-run-1",
        product_id="product-1",
        operation="BATCH_GENERATE",
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
        insight_artifact=InsightArtifact(
            id="insight-1",
            revision=2,
            content_hash="sha256:insight",
            result={
                "productName": "便携杯",
                "coreSellingPoints": ["单手开合", "轻量便携"],
                "secondarySellingPoints": ["易清洗"],
                "targetAudience": "通勤人群",
                "usageScenarios": ["通勤路上", "办公室"],
                "durationSeconds": 5,
                "aspectRatio": "9:16",
                "deliveryChannels": "抖音",
                "disabledElements": ["夸大功效"],
                "visualStyleBaseline": "明亮生活化",
            },
        ),
    )


@pytest.fixture
def runtime() -> RuntimeContext:
    return RuntimeContext(
        run_id="run-1",
        project_id="project-1",
        workflow_run_id="workflow-run-1",
        product_id="product-1",
        request_id="request-1",
        attempt_token="attempt-1",
        source_fingerprint="source-fingerprint-1",
    )
