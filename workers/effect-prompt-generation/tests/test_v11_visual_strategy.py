from __future__ import annotations

import pytest

from effect_prompt_generation.insight_mapping import InsightApplicationMap, map_insight
from effect_prompt_generation.models import (
    FactVisualPolicyDraft,
    FactVisualStrategyResponse,
    FactVisualUsage,
    InsightArtifact,
    NodeId,
    ProgressPayload,
    PromptBatchSettingsV6,
    PromptGenerationSnapshot,
    RuntimeContext,
    StageOutput,
    StrategyCheckpoint,
)
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import AiCallResult, MockAiProvider
from effect_prompt_generation.v11_fact_allocation import allocate_v11_creative_facts
from effect_prompt_generation.v11_visual_strategy import validate_fact_visual_strategy


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
                    if candidate.value
                    in {"腊肠油润透亮的肉质质感", "家庭蒸煮"}
                    and candidate.fact_id != fact.fact_id
                ],
                forbidden_inferences=forbidden,
            )
        )
    return FactVisualStrategyResponse(policies=policies)


def test_visual_strategy_splits_abstract_fact_from_visible_task() -> None:
    application = _application()
    strategy = validate_fact_visual_strategy(
        _response(application),
        application,
        source_content_hash="insight-hash",
        prompt_version="effect-prompt-v11-fact-visual-strategy-v1",
    )

    no_starch = next(fact for fact in application.usable if fact.value == "纯猪肉无淀粉")
    assignments = allocate_v11_creative_facts(
        application,
        count=1,
        ordinal_start=1,
        preferred_primary_fact_ids=[no_starch.fact_id],
        fact_visual_strategy=strategy,
    )

    assignment = assignments[0]
    assert assignment.visual_task_fact_id != no_starch.fact_id
    assert no_starch.fact_id in assignment.business_context_fact_ids
    assert strategy.by_id[no_starch.fact_id].visual_usage == FactVisualUsage.FORBIDDEN_VISUAL_PROOF


def test_visual_strategy_rejects_missing_or_unknown_fact_ids() -> None:
    application = _application()
    response = _response(application)

    with pytest.raises(ValueError, match="cover every usable fact"):
        validate_fact_visual_strategy(
            response.model_copy(update={"policies": response.policies[:-1]}),
            application,
            source_content_hash="insight-hash",
            prompt_version="effect-prompt-v11-fact-visual-strategy-v1",
        )

    unknown = response.policies[0].model_copy(
        update={"compatible_fact_ids": ["unknown-fact"]}
    )
    with pytest.raises(ValueError, match="unknown compatible fact"):
        validate_fact_visual_strategy(
            response.model_copy(update={"policies": [unknown, *response.policies[1:]]}),
            application,
            source_content_hash="insight-hash",
            prompt_version="effect-prompt-v11-fact-visual-strategy-v1",
        )


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


@pytest.mark.asyncio
async def test_pipeline_reuses_strategy_checkpoint_for_same_insight_hash() -> None:
    application = _application()
    strategy = validate_fact_visual_strategy(
        _response(application),
        application,
        source_content_hash="insight-hash",
        prompt_version="effect-prompt-v11-fact-visual-strategy-v1",
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
        schema_version=6,
        graph_version="V11_VISUAL_USAGE_STRATEGY",
        project_id=context.project_id,
        workflow_run_id=context.workflow_run_id,
        product_id=context.product_id,
        operation="BATCH_GENERATE",
        settings=PromptBatchSettingsV6(
            target_count=10,
            default_duration_seconds=5,
        ),
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
        prompt_version=strategy.prompt_version,
        plan=strategy,
    )
    pipeline.register_snapshot(context, snapshot, [checkpoint])

    await pipeline.map_insight(context)
    restored = await pipeline.compile_fact_visual_strategy(context)

    assert restored.strategy_hash == strategy.strategy_hash
    assert provider.strategy_calls == 0
    assert api.stages[-1].metadata["reusedCheckpoint"] is True
