from __future__ import annotations

import hashlib
from io import BytesIO

import pytest
from PIL import Image

from effect_prompt_generation.insight_mapping import InsightApplicationMap, map_insight
from effect_prompt_generation.models import (
    FactVisualPolicyDraft,
    FactVisualStrategyResponse,
    FactVisualUsage,
    InsightArtifact,
    NodeId,
    ProgressPayload,
    PromptBatchSettings,
    PromptGenerationSnapshot,
    ProductImageReference,
    RuntimeContext,
    StageOutput,
    StrategyCheckpoint,
)
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import (
    FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
    AiCallResult,
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)
from effect_prompt_generation.product_images import (
    PreparedProductImage,
    ProductImageProcessor,
)
from effect_prompt_generation.fact_allocation import allocate_creative_facts
from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy


def _application() -> InsightApplicationMap:
    return map_insight(
        {
            "productName": "广式腊肠",
            "productCategory": "腊味肉制品",
            "visualFeatures": "腊肠油润透亮的肉质质感",
            "coreSellingPoints": ["纯猪肉无淀粉"],
            "usageScenarios": ["家庭蒸煮"],
            "priceRange": "建议零售价需结合渠道确认",
        }
    )


def _response(application: InsightApplicationMap) -> FactVisualStrategyResponse:
    policies: list[FactVisualPolicyDraft] = []
    for fact in application.usable:
        if fact.value == "纯猪肉无淀粉":
            usage = FactVisualUsage.FORBIDDEN_VISUAL_PROOF
            visual_instruction = ""
            context_instruction = "只作为商业背景，不要求画面证明"
            forbidden = ["不得用切面、肉纤维或粉质感证明无淀粉"]
        elif fact.value == "家庭蒸煮":
            usage = FactVisualUsage.ACTION_DEMONSTRABLE
            visual_instruction = "展示产品在家庭厨房中的连续蒸煮动作"
            context_instruction = ""
            forbidden = []
        elif fact.value == "腊肠油润透亮的肉质质感":
            usage = FactVisualUsage.DIRECTLY_VISIBLE
            visual_instruction = "展示蒸熟产品表面的自然油光和肉质纹理"
            context_instruction = ""
            forbidden = ["不得用光泽证明配方或工艺"]
        else:
            usage = FactVisualUsage.IDENTITY_ANCHOR
            visual_instruction = "让当前产品身份成为明确画面主体"
            context_instruction = ""
            forbidden = []
        policies.append(
            FactVisualPolicyDraft(
                fact_id=fact.fact_id,
                visual_usage=usage,
                visual_instruction=visual_instruction,
                context_instruction=context_instruction,
                compatible_fact_ids=[
                    candidate.fact_id
                    for candidate in application.usable
                    if candidate.value in {"腊肠油润透亮的肉质质感", "家庭蒸煮"}
                    and candidate.fact_id != fact.fact_id
                ],
                forbidden_inferences=forbidden,
            )
        )
    return FactVisualStrategyResponse(policies=policies)


def test_visual_strategy_keeps_abstract_business_fact_in_assignment() -> None:
    application = _application()
    strategy = validate_fact_visual_strategy(
        _response(application),
        application,
        source_content_hash="insight-hash",
        template_hash=FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
    )

    no_starch = next(
        fact for fact in application.usable if fact.value == "纯猪肉无淀粉"
    )
    assignments = allocate_creative_facts(
        application,
        count=1,
        ordinal_start=1,
        preferred_fact_ids=[no_starch.fact_id],
    )

    assignment = assignments[0]
    assert no_starch.fact_id in assignment.fact_ids
    assert (
        strategy.by_id[no_starch.fact_id].visual_usage
        == FactVisualUsage.FORBIDDEN_VISUAL_PROOF
    )


def test_visual_strategy_rejects_missing_or_unknown_fact_ids() -> None:
    application = _application()
    response = _response(application)

    with pytest.raises(ValueError, match="cover every usable fact"):
        validate_fact_visual_strategy(
            response.model_copy(update={"policies": response.policies[:-1]}),
            application,
            source_content_hash="insight-hash",
            template_hash=FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
        )

    unknown = response.policies[0].model_copy(
        update={"compatible_fact_ids": ["unknown-fact"]}
    )
    with pytest.raises(ValueError, match="unknown compatible fact"):
        validate_fact_visual_strategy(
            response.model_copy(update={"policies": [unknown, *response.policies[1:]]}),
            application,
            source_content_hash="insight-hash",
            template_hash=FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
        )


def test_visual_strategy_fills_missing_explanations_without_changing_ai_role() -> None:
    application = _application()
    response = _response(application)
    source = next(
        policy
        for policy in response.policies
        if policy.visual_usage == FactVisualUsage.FORBIDDEN_VISUAL_PROOF
    )
    incomplete = source.model_copy(
        update={"context_instruction": "", "forbidden_inferences": []}
    )
    strategy = validate_fact_visual_strategy(
        response.model_copy(
            update={
                "policies": [
                    incomplete if policy.fact_id == source.fact_id else policy
                    for policy in response.policies
                ]
            }
        ),
        application,
        source_content_hash="insight-hash",
        template_hash=FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
    )

    normalized = strategy.by_id[source.fact_id]
    assert normalized.visual_usage == FactVisualUsage.FORBIDDEN_VISUAL_PROOF
    assert normalized.context_instruction == "只作商业背景，不作为视觉证明"
    assert normalized.forbidden_inferences == ["不得用成品外观或人物反应证明该事实"]


def test_fact_allocation_keeps_product_snapshot_out_of_business_bundle() -> None:
    application = map_insight(
        {
            "productName": "广式腊肠",
            "coreSpecification": "500g 真空袋装",
            "purchaseScenarios": ["年货送礼"],
            "usageScenarios": ["家庭蒸煮"],
        }
    )
    product_name = next(fact for fact in application.usable if fact.value == "广式腊肠")
    specification = next(
        fact for fact in application.usable if fact.value == "500g 真空袋装"
    )
    assignments = allocate_creative_facts(
        application,
        count=8,
        ordinal_start=1,
    )

    assert all(product_name.fact_id not in assignment.fact_ids for assignment in assignments)
    assert all(specification.fact_id not in assignment.fact_ids for assignment in assignments)
    assert all(assignment.fact_ids for assignment in assignments)


class _StageApi:
    def __init__(self) -> None:
        self.stages: list[StageOutput] = []

    async def put_stage(self, context: RuntimeContext, output: StageOutput) -> None:
        del context
        self.stages.append(output)

    async def heartbeat(
        self,
        context: RuntimeContext,
        payload: ProgressPayload,
    ) -> None:
        del context, payload


class _CountingProvider(MockAiProvider):
    def __init__(self) -> None:
        self.strategy_calls = 0

    async def compile_fact_visual_strategy(
        self,
        application: InsightApplicationMap,
    ) -> AiCallResult[FactVisualStrategyResponse]:
        self.strategy_calls += 1
        return await super().compile_fact_visual_strategy(application)


class _InvalidJsonOnceProvider(_CountingProvider):
    async def compile_fact_visual_strategy(
        self,
        application: InsightApplicationMap,
    ) -> AiCallResult[FactVisualStrategyResponse]:
        self.strategy_calls += 1
        if self.strategy_calls == 1:
            raise ProviderError(
                "temporary invalid structured response",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        return await MockAiProvider.compile_fact_visual_strategy(self, application)


class _ImageStageApi(_StageApi):
    def __init__(self, content: bytes) -> None:
        super().__init__()
        self.content = content
        self.download_count = 0

    async def download_product_image(
        self,
        context: RuntimeContext,
        file_object_id: str,
    ) -> bytes:
        del context
        assert file_object_id == "image-file-1"
        self.download_count += 1
        return self.content


class _ImageProvider(MockAiProvider):
    def __init__(self) -> None:
        self.received_images: list[PreparedProductImage] = []

    async def compile_fact_visual_strategy(
        self,
        application: InsightApplicationMap,
        *,
        product_images: list[PreparedProductImage] | tuple[PreparedProductImage, ...] = (),
    ) -> AiCallResult[FactVisualStrategyResponse]:
        self.received_images = list(product_images)
        return await super().compile_fact_visual_strategy(
            application,
            product_images=product_images,
        )


@pytest.mark.asyncio
async def test_pipeline_retries_invalid_visual_strategy_json_once() -> None:
    provider = _InvalidJsonOnceProvider()
    api = _StageApi()
    pipeline = PromptGenerationPipeline(api=api, provider=provider)  # type: ignore[arg-type]
    context = RuntimeContext(
        run_id="run-invalid-json",
        project_id="project-1",
        workflow_run_id="workflow-1",
        product_id="product-1",
        request_id="request-1",
        attempt_token="attempt-1",
        source_fingerprint="run-source",
    )
    pipeline.register_snapshot(
        context,
        PromptGenerationSnapshot(
            project_id=context.project_id,
            workflow_run_id=context.workflow_run_id,
            product_id=context.product_id,
            operation="BATCH_GENERATE",
            settings=PromptBatchSettings(
                target_count=10,
                default_duration_seconds=5,
            ),
            selection_policy="MMR_CONTENT",
            insight_artifact=InsightArtifact(
                id="insight-1",
                revision=1,
                content_hash="insight-hash",
                result={
                    "productName": "广式腊肠",
                    "productCategory": "腊味肉制品",
                    "visualFeatures": "腊肠油润透亮的肉质质感",
                    "coreSellingPoints": ["纯猪肉无淀粉"],
                    "usageScenarios": ["家庭蒸煮"],
                },
            ),
        ),
    )

    await pipeline.map_insight(context)
    strategy = await pipeline.compile_fact_visual_strategy(context)

    assert strategy.policies
    assert provider.strategy_calls == 2


@pytest.mark.asyncio
async def test_pipeline_reuses_strategy_checkpoint_for_same_insight_hash() -> None:
    application = _application()
    strategy = validate_fact_visual_strategy(
        _response(application),
        application,
        source_content_hash="insight-hash",
        template_hash=FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
    )
    provider = _CountingProvider()
    api = _StageApi()
    pipeline = PromptGenerationPipeline(api=api, provider=provider)  # type: ignore[arg-type]
    context = RuntimeContext(
        run_id="run-1",
        project_id="project-1",
        workflow_run_id="workflow-1",
        product_id="product-1",
        request_id="request-1",
        attempt_token="attempt-1",
        source_fingerprint="run-source",
    )
    snapshot = PromptGenerationSnapshot(
        project_id=context.project_id,
        workflow_run_id=context.workflow_run_id,
        product_id=context.product_id,
        operation="BATCH_GENERATE",
        settings=PromptBatchSettings(
            target_count=10,
            default_duration_seconds=5,
        ),
        selection_policy="MMR_CONTENT",
        insight_artifact=InsightArtifact(
            id="insight-1",
            revision=1,
            content_hash="insight-hash",
            result={
                "productName": "广式腊肠",
                "productCategory": "腊味肉制品",
                "visualFeatures": "腊肠油润透亮的肉质质感",
                "coreSellingPoints": ["纯猪肉无淀粉"],
                "usageScenarios": ["家庭蒸煮"],
                "priceRange": "建议零售价需结合渠道确认",
            },
        ),
    )
    checkpoint = StrategyCheckpoint(
        node_id=NodeId.FACT_VISUAL_STRATEGY_COMPILATION,
        source_fingerprint="insight-hash",
        allocation_hash=strategy.strategy_hash,
        template_hash=strategy.template_hash,
        plan=strategy,
    )
    pipeline.register_snapshot(context, snapshot, [checkpoint])

    await pipeline.map_insight(context)
    restored = await pipeline.compile_fact_visual_strategy(context)

    assert restored.strategy_hash == strategy.strategy_hash
    assert provider.strategy_calls == 0
    assert api.stages[-1].metadata["reusedCheckpoint"] is True


@pytest.mark.asyncio
async def test_pipeline_downloads_and_passes_snapshotted_product_images() -> None:
    output = BytesIO()
    Image.new("RGB", (1200, 800), color=(120, 126, 132)).save(output, format="PNG")
    content = output.getvalue()
    provider = _ImageProvider()
    api = _ImageStageApi(content)
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        product_image_processor=ProductImageProcessor(
            max_input_bytes=2_000_000,
            max_dimension=640,
            max_output_bytes=500_000,
        ),
    )
    context = RuntimeContext(
        run_id="run-with-image",
        project_id="project-1",
        workflow_run_id="workflow-1",
        product_id="product-1",
        request_id="request-1",
        attempt_token="attempt-1",
        source_fingerprint="run-source",
    )
    snapshot = PromptGenerationSnapshot(
            project_id=context.project_id,
            workflow_run_id=context.workflow_run_id,
            product_id=context.product_id,
            operation="BATCH_GENERATE",
            settings=PromptBatchSettings(
                target_count=10,
                default_duration_seconds=5,
            ),
            selection_policy="MMR_CONTENT",
            insight_artifact=InsightArtifact(
                id="insight-1",
                revision=1,
                content_hash="insight-hash",
                result={
                    "productName": "磁吸移动电源",
                    "visualFeatures": "云灰色圆角机身",
                    "coreSellingPoints": ["磁吸贴合"],
                },
            ),
            product_images=[
                ProductImageReference(
                    file_object_id="image-file-1",
                    original_file_name="产品主图.png",
                    mime_type="image/png",
                    size_bytes=len(content),
                    sha256=hashlib.sha256(content).hexdigest(),
                )
            ],
            fact_visual_strategy_source_hash="a" * 64,
        )
    pipeline.register_snapshot(
        context,
        snapshot,
    )

    await pipeline.map_insight(context)
    strategy = await pipeline.compile_fact_visual_strategy(context)

    assert strategy.source_content_hash == "a" * 64
    assert api.download_count == 1
    assert len(provider.received_images) == 1
    assert provider.received_images[0].data_uri.startswith("data:image/jpeg;base64,")
    assert api.stages[-1].metadata["referenceImageCount"] == 1
    assert api.stages[-1].metadata["referenceMode"] == "MULTIMODAL"

    resumed_provider = _ImageProvider()
    resumed_api = _ImageStageApi(content)
    resumed = PromptGenerationPipeline(
        api=resumed_api,  # type: ignore[arg-type]
        provider=resumed_provider,
        product_image_processor=ProductImageProcessor(
            max_input_bytes=2_000_000,
            max_dimension=640,
            max_output_bytes=500_000,
        ),
    )
    resumed.register_snapshot(
        context,
        snapshot,
        [
            StrategyCheckpoint(
                node_id=NodeId.FACT_VISUAL_STRATEGY_COMPILATION,
                source_fingerprint="a" * 64,
                allocation_hash=strategy.strategy_hash,
                template_hash=FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
                plan=strategy,
            )
        ],
    )

    await resumed.map_insight(context)
    restored = await resumed.compile_fact_visual_strategy(context)

    assert restored.strategy_hash == strategy.strategy_hash
    assert resumed_api.download_count == 0
    assert resumed_provider.received_images == []
    assert resumed_api.stages[-1].metadata["reusedCheckpoint"] is True
