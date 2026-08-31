from __future__ import annotations

from datetime import datetime, timezone

import pytest

from effect_prompt_generation.models import (
    CreativeDimensions,
    FragmentType,
    InsightArtifact,
    PromptBatchSettings,
    PromptGenerationSnapshot,
    PromptItem,
    RuntimeContext,
)


@pytest.fixture
def dimensions() -> CreativeDimensions:
    return CreativeDimensions(
        narrative="痛点前置型",
        scene="家庭早餐",
        persona="年轻职场女性",
        product_relation="广式腊肠便于家常蒸制",
        camera="中景转产品特写",
        emotion="活力明快",
    )


@pytest.fixture
def prompt_item(dimensions: CreativeDimensions) -> PromptItem:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return PromptItem(
        id="item-1",
        code="P001",
        origin="AI",
        fragment_type=FragmentType.PRODUCT_DISPLAY,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        classification_status="VERIFIED",
        product_relevance=92,
        material_tags=["产品", "特写"],
        target_duration_seconds=5,
        dimensions=dimensions,
        content="家庭早餐场景中切开广式腊肠，镜头从人物中景切换到油润切面细节。",
        insight_bindings=[],
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
            target_count=10,
            default_duration_seconds=5,
        ),
        selection_policy="MMR_CONTENT",
        insight_artifact=InsightArtifact(
            id="insight-1",
            revision=2,
            content_hash="sha256:insight",
            result={
                "productName": "广式腊肠",
                "productCategory": "腊味肉制品",
                "visualFeatures": ["油润红亮切面"],
                "coreSellingPoints": ["广式甜咸风味"],
                "targetAudienceItems": ["家庭烹饪人群"],
                "usageScenarios": ["家庭蒸制", "年夜饭摆盘"],
                "aspectRatio": "9:16",
                "resolution": "1080p",
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
        source_fingerprint="source-1",
    )
