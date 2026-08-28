from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import replace
from typing import Any

import pytest

from effect_prompt_generation.embeddings import (
    EmbeddingBatchResult,
    EmbeddingProviderError,
    MockEmbeddingProvider,
)
from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDimensions,
    CreativeEvaluation,
    CreativeScores,
    FactEvidence,
    FactVisualStrategy,
    FragmentType,
    ProgressPayload,
    PromptBatchResultV6,
    PromptBatchSettingsV6,
    PromptGenerationSnapshot,
    PromptItemV6,
    RuntimeContext,
    ShardRecord,
    StageOutput,
)
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import (
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)
from effect_prompt_generation.quality import (
    RankedCreative,
    _creative_novelty,
    creative_soft_warnings,
    select_creatives,
    validate_creative_evaluation,
)


class V11Api:
    def __init__(self) -> None:
        self.stages: list[StageOutput] = []
        self.shards: dict[str, ShardRecord] = {}
        self.result: PromptBatchResultV6 | None = None
        self.execution_mode: str | None = None
        self.failure: Any | None = None

    async def put_stage(self, context: RuntimeContext, output: StageOutput) -> None:
        del context
        self.stages.append(output)

    async def put_shard(self, context: RuntimeContext, shard: ShardRecord) -> None:
        del context
        self.shards[shard.key] = shard

    async def get_shards(self, context: RuntimeContext) -> list[ShardRecord]:
        del context
        return list(self.shards.values())

    async def heartbeat(
        self, context: RuntimeContext, payload: ProgressPayload
    ) -> None:
        del context, payload

    async def complete(
        self,
        context: RuntimeContext,
        result: Any,
        *,
        execution_mode: str = "ARK",
    ) -> str:
        del context
        self.result = PromptBatchResultV6.model_validate(result)
        self.execution_mode = execution_mode
        return "prompt-result-v11"

    async def fail(self, context: RuntimeContext, payload: Any) -> None:
        del context
        self.failure = payload


class FirstRoundRejectingProvider(MockAiProvider):
    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        application: Any,
        fact_visual_strategy: FactVisualStrategy | None = None,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            application=application,
            fact_visual_strategy=fact_visual_strategy,
        )
        items = [
            item.model_copy(update={"hard_issues": ["TEST_FIRST_ROUND_REJECTION"]})
            if candidate.round == 0 and candidate.ordinal <= 3
            else item
            for candidate, item in zip(candidates, call.value.items, strict=True)
        ]
        return replace(call, value=call.value.model_copy(update={"items": items}))


class FirstTwoRoundsRejectingProvider(MockAiProvider):
    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        application: Any,
        fact_visual_strategy: FactVisualStrategy | None = None,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            application=application,
            fact_visual_strategy=fact_visual_strategy,
        )
        items = [
            item.model_copy(update={"hard_issues": ["TEST_EARLY_ROUND_REJECTION"]})
            if candidate.round < 2
            else item
            for candidate, item in zip(candidates, call.value.items, strict=True)
        ]
        return replace(call, value=call.value.model_copy(update={"items": items}))


class AlwaysRejectingProvider(MockAiProvider):
    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        application: Any,
        fact_visual_strategy: FactVisualStrategy | None = None,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            application=application,
            fact_visual_strategy=fact_visual_strategy,
        )
        items = [
            item.model_copy(update={"hard_issues": ["TEST_SAFETY_REJECTION"]})
            for item in call.value.items
        ]
        return replace(call, value=call.value.model_copy(update={"items": items}))


class FailingEmbeddingProvider(MockEmbeddingProvider):
    cache_namespace = "failing-test-provider"

    async def embed(self, texts: list[str]):  # type: ignore[no-untyped-def]
        del texts
        raise EmbeddingProviderError("向量服务测试不可用", retryable=True)


class IdenticalEmbeddingProvider(MockEmbeddingProvider):
    cache_namespace = "identical-vector-test-provider"

    def __init__(self) -> None:
        self.input_count = 0
        self.call_count = 0

    async def embed(self, texts: list[str]) -> EmbeddingBatchResult:
        self.input_count += len(texts)
        self.call_count += 1
        return EmbeddingBatchResult(
            vectors=[(1.0, 0.0) for _ in texts],
            request_count=1,
            input_tokens=sum(len(text) for text in texts),
            retry_count=0,
        )


class ConcurrencyTrackingProvider(MockAiProvider):
    def __init__(self) -> None:
        self.active = 0
        self.maximum = 0
        self._lock = asyncio.Lock()

    async def _enter(self) -> None:
        async with self._lock:
            self.active += 1
            self.maximum = max(self.maximum, self.active)

    async def _leave(self) -> None:
        async with self._lock:
            self.active -= 1

    async def generate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        await self._enter()
        try:
            await asyncio.sleep(0.01)
            return await super().generate_creatives(*args, **kwargs)
        finally:
            await self._leave()

    async def evaluate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        await self._enter()
        try:
            await asyncio.sleep(0.01)
            return await super().evaluate_creatives(*args, **kwargs)
        finally:
            await self._leave()


class OneClassificationFailureProvider(MockAiProvider):
    def __init__(self) -> None:
        self.failures_remaining = 2

    async def evaluate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        if self.failures_remaining:
            self.failures_remaining -= 1
            raise ProviderError(
                "test classification response invalid",
                retryable=True,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        return await super().evaluate_creatives(*args, **kwargs)


class OneTransientClassificationFailureProvider(MockAiProvider):
    def __init__(self) -> None:
        self.calls = 0

    async def evaluate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        self.calls += 1
        if self.calls == 1:
            raise ProviderError(
                "test transient classification response invalid",
                retryable=True,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        return await super().evaluate_creatives(*args, **kwargs)


def _snapshot() -> PromptGenerationSnapshot:
    return PromptGenerationSnapshot(
        schema_version=6,
        graph_version="V11_COHERENT_CREATIVE_GENERATION",
        project_id="project-v11",
        workflow_run_id="workflow-v11",
        product_id="sausage",
        operation="BATCH_GENERATE",
        settings=PromptBatchSettingsV6(
            target_count=10,
            default_duration_seconds=5,
        ),
        insight_artifact={
            "id": "insight-v11",
            "revision": 1,
            "contentHash": "sha256:sausage",
            "result": {
                "productName": "广式腊肠",
                "productCategory": "中式腊味",
                "visualFeatures": ["油润红亮切面"],
                "coreSellingPoints": ["广式甜咸风味", "蒸熟后油润有光泽"],
                "corePainPoints": ["普通腊味口感偏干"],
                "decisionDrivers": ["年节家宴方便摆盘"],
                "usageScenarios": ["家庭蒸制", "年夜饭摆盘"],
                "aspectRatio": "9:16",
                "disabledElements": ["虚构医疗功效"],
            },
        },
    )


def _runtime() -> RuntimeContext:
    return RuntimeContext(
        run_id="run-v11",
        project_id="project-v11",
        workflow_run_id="workflow-v11",
        product_id="sausage",
        request_id="request-v11",
        attempt_token="attempt-v11",
        source_fingerprint="source-v11",
    )


@pytest.mark.asyncio
async def test_v11_graph_generates_120_percent_then_selects_exact_count() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    result = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert result["prompt_result_id"] == "prompt-result-v11"
    assert api.result is not None
    assert api.result.schema_version == 6
    assert api.result.metrics.candidate_target_count == 12
    assert api.result.metrics.generated_candidate_count == 12
    assert len(api.result.items) == 10
    assert api.result.quality_status == "PASS"
    assert api.execution_mode == "MOCK"
    assert all(item.target_duration_seconds == 5 for item in api.result.items)
    assert all(item.fragment_type == item.primary_purpose for item in api.result.items)
    assert all(
        item.primary_purpose in item.compatible_purposes for item in api.result.items
    )
    assert all("广式腊肠" in item.content for item in api.result.items)
    assert all("虚构医疗功效" not in item.content for item in api.result.items)
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CREATIVE": 3,
        "CLASSIFICATION": 4,
    }
    creative_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
    ]
    assert len(creative_tasks) == 12
    assert all(task.fact_assignment is not None for task in creative_tasks)
    assert all(
        len(task.fact_assignment.support_fact_ids) <= 2
        and 1 <= len(task.fact_assignment.product_anchor_fact_ids) <= 2
        for task in creative_tasks
        if task.fact_assignment is not None
    )
    assert (
        len(
            {
                task.fact_assignment.primary_fact_id
                for task in creative_tasks
                if task.fact_assignment is not None
            }
        )
        > 1
    )
    mapping_stage = next(
        stage for stage in reversed(api.stages) if stage.node_id == "INSIGHT_MAPPING"
    )
    shared_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id == "SHARED_PROMPT_COMPILATION"
    )
    creative_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id == "COHERENT_CREATIVE_GENERATION"
    )
    classification_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id == "CREATIVE_EVALUATION_CLASSIFICATION"
    )
    assert mapping_stage.metadata["requiredFacts"]
    assert all("factId" not in item for item in mapping_stage.metadata["requiredFacts"])
    assert shared_stage.metadata["compiledContent"]
    assert creative_stage.status == "SUCCEEDED"
    assert creative_stage.metadata["candidateCount"] == 12
    assert creative_stage.metadata["factSelectionMode"] == "WORKER_ASSIGNMENT_V1"
    assert classification_stage.status == "SUCCEEDED"
    assert classification_stage.metadata["evaluatedCount"] == 12
    assert classification_stage.metadata["averageScores"]["productRelevance"] >= 0


@pytest.mark.asyncio
async def test_visual_strategy_graph_compiles_roles_before_creative_generation() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _snapshot().model_copy(
        update={"graph_version": "V11_VISUAL_USAGE_STRATEGY"}
    )
    pipeline.register_snapshot(runtime, snapshot)

    result = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert result["prompt_result_id"] == "prompt-result-v11"
    strategy_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id == "FACT_VISUAL_STRATEGY_COMPILATION"
    )
    assert strategy_stage.status == "SUCCEEDED"
    assert strategy_stage.metadata["policyCount"] > 0
    assert strategy_stage.metadata["usageCounts"]["FORBIDDEN_VISUAL_PROOF"] > 0
    creative_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id == "COHERENT_CREATIVE_GENERATION"
    )
    assert (
        creative_stage.metadata["factSelectionMode"]
        == "VISUAL_TASK_AND_BUSINESS_CONTEXT_V1"
    )
    assignments = [
        task.fact_assignment
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
        if task.fact_assignment is not None
    ]
    assert assignments
    assert all(assignment.visual_task_fact_id for assignment in assignments)
    assert any(assignment.business_context_fact_ids for assignment in assignments)


@pytest.mark.asyncio
async def test_v11_ai_shards_use_one_sliding_concurrency_limit() -> None:
    api = V11Api()
    provider = ConcurrencyTrackingProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        ai_max_concurrency=2,
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert provider.maximum == 2
    assert provider.active == 0


@pytest.mark.asyncio
async def test_v11_retries_one_invalid_classification_response_inside_its_shard() -> (
    None
):
    api = V11Api()
    provider = OneTransientClassificationFailureProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert provider.calls == 5
    assert api.result is not None
    assert api.result.metrics.generated_candidate_count == 12


@pytest.mark.asyncio
async def test_v11_classification_retry_keeps_stable_shard_assignments() -> None:
    api = V11Api()
    provider = OneClassificationFailureProvider()
    runtime = _runtime()
    first = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    first.register_snapshot(runtime, _snapshot())

    with pytest.raises(ProviderError, match="classification response invalid"):
        await build_graph(first).ainvoke(
            {"project_id": runtime.project_id},
            context=runtime,
        )

    resumed = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    resumed.register_snapshot(runtime, _snapshot())
    await build_graph(resumed).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    classification_shards = [
        shard for shard in api.shards.values() if shard.phase.value == "CLASSIFICATION"
    ]
    assert {shard.shard_index for shard in classification_shards} == {0, 1, 2, 3}
    assert all(shard.status == "SUCCEEDED" for shard in classification_shards)
    assert sum(len(shard.evaluations) for shard in classification_shards) == 12
    assert api.result is not None
    assert api.result.metrics.generated_candidate_count == 12


@pytest.mark.asyncio
async def test_v11_vector_selection_keeps_exact_count_and_reports_safe_metrics() -> (
    None
):
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        embedding_batch_size=64,
        embedding_max_concurrency=2,
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert len(api.result.items) == 10
    selection_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert selection_stage.metadata["selectionMethod"] == "VECTOR"
    assert selection_stage.metadata["embeddingInputCount"] == 24
    assert selection_stage.metadata["embeddingRequestCount"] == 1
    assert selection_stage.metadata["comparisonCount"] == 66
    assert "model" not in selection_stage.metadata


@pytest.mark.asyncio
async def test_v11_content_mmr_shadow_uses_one_vector_per_candidate() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="shadow",
        embedding_batch_size=64,
        embedding_max_concurrency=2,
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _snapshot().model_copy(
        update={
            "selection_policy_version": "MMR_CONTENT_V2",
            "similarity_anchors": [],
        }
    )
    pipeline.register_snapshot(runtime, snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert len(api.result.items) == 10
    selection_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert selection_stage.metadata["selectionPolicyVersion"] == "MMR_CONTENT_V2"
    assert selection_stage.metadata["selectionMethod"] == "TRIGRAM_SHADOW"
    assert selection_stage.metadata["embeddingInputCount"] == 12
    assert selection_stage.metadata["embeddingRequestCount"] == 1
    assert selection_stage.metadata["mmrQualityWeight"] == 0.7
    assert selection_stage.metadata["mmrDiversityWeight"] == 0.3
    assert selection_stage.metadata["contentMmrSelection"]["selectedCount"] == 10
    assert "dualVectorSelection" not in selection_stage.metadata


@pytest.mark.asyncio
async def test_v11_content_mmr_diversity_supplement_runs_once_and_keeps_exact_count() -> (
    None
):
    api = V11Api()
    embedding_provider = IdenticalEmbeddingProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=embedding_provider,
        similarity_mode="vector",
        embedding_batch_size=64,
        embedding_max_concurrency=2,
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _snapshot().model_copy(
        update={
            "selection_policy_version": "MMR_CONTENT_V2",
            "similarity_anchors": [],
        }
    )
    pipeline.register_snapshot(runtime, snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert len(api.result.items) == 10
    assert api.result.metrics.generated_candidate_count == 14
    assert embedding_provider.input_count == 14
    final_selection_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert final_selection_stage.metadata["diversitySupplementTriggered"] is True
    assert final_selection_stage.metadata["diversitySupplementCount"] == 2
    assert final_selection_stage.metadata["embeddingInputCount"] == 14
    assert final_selection_stage.metadata["embeddingRequestCount"] == 2
    assert final_selection_stage.metadata["finalAccurateCount"] == 10
    assert final_selection_stage.warnings == ["SEMANTIC_DIVERSITY_SOFT_TARGET_NOT_MET"]

    # Simulate an in-flight MMR_CONTENT_V2 shard written before supplementKind
    # was added. Recovery infers that round 1 started after quantity was met.
    for key, shard in list(api.shards.items()):
        if shard.phase.value == "CREATIVE" and shard.round > 0:
            api.shards[key] = shard.model_copy(
                update={
                    "creative_plan": [
                        task.model_copy(update={"supplement_kind": None})
                        for task in shard.creative_plan
                    ]
                }
            )
    resumed = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=IdenticalEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    resumed.register_snapshot(runtime, snapshot)
    await resumed.load_and_snapshot(runtime)
    restored_cache = resumed._cache(runtime)
    assert restored_cache.v11_diversity_supplemented is True
    assert restored_cache.v11_diversity_supplement_count == 2
    assert restored_cache.v11_replenishment_rounds == 0


@pytest.mark.asyncio
async def test_v11_shadow_selection_reports_comparison_without_changing_result() -> (
    None
):
    baseline_api = V11Api()
    shadow_api = V11Api()
    baseline = PromptGenerationPipeline(
        api=baseline_api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    shadow = PromptGenerationPipeline(
        api=shadow_api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="shadow",
        shard_size=5,
    )
    baseline_runtime = _runtime()
    shadow_runtime = replace(_runtime(), run_id="run-v11-shadow")
    baseline.register_snapshot(baseline_runtime, _snapshot())
    shadow.register_snapshot(shadow_runtime, _snapshot())

    await build_graph(baseline).ainvoke(
        {"project_id": baseline_runtime.project_id},
        context=baseline_runtime,
    )
    await build_graph(shadow).ainvoke(
        {"project_id": shadow_runtime.project_id},
        context=shadow_runtime,
    )

    assert baseline_api.result is not None
    assert shadow_api.result is not None
    assert [item.content for item in shadow_api.result.items] == [
        item.content for item in baseline_api.result.items
    ]
    selection_stage = next(
        stage
        for stage in reversed(shadow_api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert selection_stage.metadata["selectionMethod"] == "TRIGRAM_SHADOW"
    assert selection_stage.metadata["baselineSelection"]["selectedCount"] == 10
    assert selection_stage.metadata["contentVectorSelection"]["selectedCount"] == 10
    assert selection_stage.metadata["dualVectorSelection"]["selectedCount"] == 10
    assert selection_stage.metadata["vectorChangedItemCount"] >= 0
    assert selection_stage.metadata["contentChangedItemCount"] >= 0
    assert isinstance(
        selection_stage.metadata["vectorAverageQualityDelta"],
        float,
    )
    assert set(
        selection_stage.metadata["dualVectorSelection"]["dimensionUniqueCounts"]
    ) == {
        "narrative",
        "scene",
        "persona",
        "product_relation",
        "camera",
        "emotion",
    }


@pytest.mark.asyncio
async def test_v11_shadow_embedding_failure_keeps_baseline_with_warning() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=FailingEmbeddingProvider(),
        similarity_mode="shadow",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert len(api.result.items) == 10
    selection_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert selection_stage.metadata["selectionMethod"] == "TRIGRAM_SHADOW_UNAVAILABLE"
    assert selection_stage.warnings == ["向量服务测试不可用"]


@pytest.mark.asyncio
async def test_v11_vector_embedding_failure_is_retryable_and_safely_coded() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
    )

    await pipeline.mark_failed(
        _runtime(),
        EmbeddingProviderError("向量服务暂时不可用", retryable=True),
    )

    assert api.failure is not None
    assert api.failure.retryable is True
    assert api.failure.error_code == "EMBEDDING_SERVICE_UNAVAILABLE"
    assert api.failure.error_message == "向量服务暂时不可用"


@pytest.mark.asyncio
async def test_v11_item_evaluate_preserves_content_and_only_runs_classification() -> (
    None
):
    snapshot = _snapshot()
    now = "2026-08-27T10:00:00Z"
    target = PromptItemV6(
        id="manual-prompt-1",
        code="P004",
        origin="MANUAL",
        fragment_type=FragmentType.PRODUCT_DISPLAY,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        classification_status="PENDING",
        product_relevance=0,
        material_tags=["待重新评估"],
        target_duration_seconds=5,
        dimensions=CreativeDimensions(
            narrative="从成品摆盘推进到切面细节",
            scene="节日家宴餐桌",
            persona="仅一双成年人手部",
            product_relation="广式腊肠油润红亮切面",
            camera="近景缓慢横移",
            emotion="温暖真实",
        ),
        content="节日家宴餐桌上，一双成年人手部夹起广式腊肠，近景清楚呈现油润红亮切面。",
        insight_bindings=[],
        manual_edited=True,
        created_at=now,
        updated_at=now,
    )
    item_snapshot = snapshot.model_copy(
        update={
            "operation": "ITEM_EVALUATE",
            "target_item_id": target.id,
            "target_item": target,
            "target_item_index": 3,
            "replacement_dimensions": target.dimensions,
        }
    )
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, item_snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert len(api.result.items) == 1
    assert api.result.items[0].content == target.content
    assert api.result.items[0].classification_status == "VERIFIED"
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CLASSIFICATION": 1
    }
    assert not any(
        stage.node_id.value == "COHERENT_CREATIVE_GENERATION" for stage in api.stages
    )
    assert any(stage.node_id.value == "ITEM_EVALUATE" for stage in api.stages)


@pytest.mark.asyncio
async def test_v11_stops_supplementing_as_soon_as_exact_quantity_is_reached() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=FirstRoundRejectingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert api.result.quality_status == "PASS"
    assert len(api.result.items) == 10
    assert api.result.metrics.candidate_target_count == 12
    assert api.result.metrics.generated_candidate_count == 14
    assert api.result.metrics.replenishment_rounds == 1
    assert api.result.metrics.rejected_count > 0
    assert api.result.metrics.hard_issue_counts == []
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CREATIVE": 4,
        "CLASSIFICATION": 5,
    }


@pytest.mark.asyncio
async def test_v11_can_run_multiple_supplement_rounds_to_reach_exact_quantity() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=FirstTwoRoundsRejectingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert api.result.quality_status == "PASS"
    assert len(api.result.items) == 10
    assert api.result.metrics.generated_candidate_count == 36
    assert api.result.metrics.replenishment_rounds == 2
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CREATIVE": 9,
        "CLASSIFICATION": 12,
    }


@pytest.mark.asyncio
async def test_v11_stops_after_three_rounds_when_real_safety_issues_remain() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=AlwaysRejectingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert api.result.quality_status == "NEEDS_REVIEW"
    assert api.result.items == []
    assert api.result.metrics.generated_candidate_count == 48
    assert api.result.metrics.replenishment_rounds == 3


def test_v11_evaluation_requires_real_text_evidence() -> None:
    application = map_insight(
        {"productName": "广式腊肠", "coreSellingPoints": ["油润红亮切面"]}
    )
    fact = next(item for item in application.usable if item.value == "广式腊肠")
    candidate = CreativeCandidate(
        slot_id="candidate-1",
        ordinal=1,
        round=0,
        creative_core="通用遮挡悬念",
        declared_fact_ids=[fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="遮挡后停住",
            scene="午后书桌",
            persona="成年女性侧身",
            product_relation="没有产品进入画面",
            camera="中景固定",
            emotion="悬念",
        ),
        content="午后书桌前，成年女性缓慢移开一小部分遮挡物，然后停住观察。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.HOOK,
        compatible_purposes=[FragmentType.HOOK],
        fact_evidence=[FactEvidence(fact_id=fact.fact_id, evidence_text="广式腊肠")],
        realized_fact_ids=[fact.fact_id],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=80,
            visual_clarity=90,
        ),
        semantic_signature="ignored",
        visual_signature="ignored",
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert "FACT_EVIDENCE_NOT_IN_CONTENT" in validated.warnings
    assert "FACT_EVIDENCE_NOT_IN_CONTENT" not in validated.hard_issues
    assert "MISSING_PRODUCT_RELATION" in validated.hard_issues


def test_v11_generic_visual_language_is_a_soft_warning_only() -> None:
    application = map_insight({"productName": "广式腊肠"})
    fact = next(item for item in application.usable if item.value == "广式腊肠")
    candidate = CreativeCandidate(
        slot_id="candidate-generic-style",
        ordinal=1,
        round=0,
        creative_core="切片动作展示",
        declared_fact_ids=[fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="切片后夹起",
            scene="家庭厨房",
            persona="成年人手部",
            product_relation="广式腊肠作为动作主体",
            camera="电影级浅景深镜头缓慢推进",
            emotion="暖色调高级质感",
        ),
        content=(
            "家庭厨房里，成年人切开广式腊肠并用筷子夹起一片，"
            "镜头展示产品品质后停留在切面。"
        ),
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[FactEvidence(fact_id=fact.fact_id, evidence_text="广式腊肠")],
        realized_fact_ids=[fact.fact_id],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=85,
            visual_clarity=90,
        ),
        semantic_signature="ignored",
        visual_signature="ignored",
    )

    assert creative_soft_warnings(candidate) == [
        "GENERIC_STYLE_STACKING",
        "PURPOSE_SENTENCE_INSTEAD_OF_VISIBLE_ACTION",
    ]
    validated = validate_creative_evaluation(candidate, evaluation, application)
    assert validated.hard_issues == []
    assert validated.warnings == [
        "GENERIC_STYLE_STACKING",
        "PURPOSE_SENTENCE_INSTEAD_OF_VISIBLE_ACTION",
    ]


def test_v11_novelty_uses_narrative_and_emotion_as_soft_dimensions() -> None:
    def ranked(
        slot_id: str,
        *,
        narrative: str,
        emotion: str,
        content: str,
    ) -> RankedCreative:
        candidate = CreativeCandidate(
            slot_id=slot_id,
            ordinal=1,
            round=0,
            creative_core=slot_id,
            declared_fact_ids=["fact-product"],
            dimensions=CreativeDimensions(
                narrative=narrative,
                scene="家庭厨房",
                persona="成年人手部",
                product_relation="广式腊肠切面",
                camera="微距固定侧拍",
                emotion=emotion,
            ),
            content=content,
        )
        evaluation = CreativeEvaluation(
            slot_id=slot_id,
            primary_purpose=FragmentType.PRODUCT_DISPLAY,
            compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
            scores=CreativeScores(
                product_relevance=90,
                creative_coherence=90,
                visual_executability=90,
                commercial_usefulness=85,
                visual_clarity=90,
            ),
            semantic_signature=slot_id,
            visual_signature=slot_id,
        )
        return RankedCreative(
            candidate=candidate,
            evaluation=evaluation,
            quality_score=90,
            novelty_score=100,
            selection_score=92,
        )

    first = ranked(
        "first",
        narrative="动作直接展示",
        emotion="利落明快",
        content="刀锋切开广式腊肠，切面在厨房自然光下稳定停留。",
    )
    second = ranked(
        "second",
        narrative="家庭体验代入",
        emotion="温馨治愈",
        content="筷子夹起广式腊肠放进白瓷碟，家人在餐桌旁自然互动。",
    )

    assert _creative_novelty(first, second) > 0


def test_v11_discards_bad_evidence_excerpt_without_rejecting_valid_prompt() -> None:
    application = map_insight(
        {"productName": "广式腊肠", "coreSellingPoints": ["油润红亮切面"]}
    )
    product_fact = next(item for item in application.usable if item.value == "广式腊肠")
    selling_fact = next(
        item for item in application.usable if item.value == "油润红亮切面"
    )
    candidate = CreativeCandidate(
        slot_id="candidate-valid-product",
        ordinal=1,
        round=0,
        creative_core="切面细节展示",
        declared_fact_ids=[product_fact.fact_id, selling_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="从摆盘推进到切面停留",
            scene="家庭餐桌",
            persona="成年人手部",
            product_relation="广式腊肠切面",
            camera="近景缓慢靠近",
            emotion="温暖真实",
        ),
        content="家庭餐桌上，成年人夹起一片广式腊肠，近景缓慢靠近后稳定停留。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠"),
            FactEvidence(
                fact_id=selling_fact.fact_id, evidence_text="油亮红润的真实切面"
            ),
        ],
        realized_fact_ids=[product_fact.fact_id, selling_fact.fact_id],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=85,
            visual_clarity=90,
        ),
        semantic_signature="ignored",
        visual_signature="ignored",
        hard_issues=["FACT_EVIDENCE_NOT_IN_CONTENT"],
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert validated.hard_issues == []
    assert validated.warnings == ["FACT_EVIDENCE_NOT_IN_CONTENT"]
    assert validated.realized_fact_ids == [product_fact.fact_id]


def test_v11_evidence_excerpt_noise_does_not_reduce_a_50_item_batch() -> None:
    application = map_insight(
        {"productName": "广式腊肠", "coreSellingPoints": ["油润红亮切面"]}
    )
    product_fact = next(item for item in application.usable if item.value == "广式腊肠")
    selling_fact = next(
        item for item in application.usable if item.value == "油润红亮切面"
    )
    candidates: list[CreativeCandidate] = []
    evaluations: list[CreativeEvaluation] = []
    for index in range(60):
        candidate = CreativeCandidate(
            slot_id=f"candidate-{index:03d}",
            ordinal=index + 1,
            round=0,
            creative_core=f"第{index + 1}种连续展示动作",
            declared_fact_ids=[product_fact.fact_id, selling_fact.fact_id],
            dimensions=CreativeDimensions(
                narrative=f"展示动作{index + 1}",
                scene=f"家庭餐桌位置{index + 1}",
                persona=f"成年人手部姿态{index + 1}",
                product_relation="广式腊肠切面",
                camera=f"近景机位{index + 1}",
                emotion=f"温暖氛围{index + 1}",
            ),
            content=(
                f"家庭餐桌位置{index + 1}上，成年人夹起一片广式腊肠，"
                f"完成第{index + 1}种连续动作后稳定停留。"
            ),
        )
        raw_evaluation = CreativeEvaluation(
            slot_id=candidate.slot_id,
            primary_purpose=FragmentType.PRODUCT_DISPLAY,
            compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
            fact_evidence=[
                FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠"),
                FactEvidence(
                    fact_id=selling_fact.fact_id,
                    evidence_text="模型改写后的油润切面摘录",
                ),
            ],
            realized_fact_ids=[product_fact.fact_id, selling_fact.fact_id],
            scores=CreativeScores(
                product_relevance=90,
                creative_coherence=88,
                visual_executability=90,
                commercial_usefulness=85,
                visual_clarity=90,
            ),
            semantic_signature="ignored",
            visual_signature="ignored",
            hard_issues=["FACT_EVIDENCE_NOT_IN_CONTENT"],
        )
        candidates.append(candidate)
        evaluations.append(
            validate_creative_evaluation(candidate, raw_evaluation, application)
        )

    result = select_creatives(candidates, evaluations, target_count=50)

    assert len(result.selected) == 50
    assert all(not item.evaluation.hard_issues for item in result.selected)
    assert all(
        item.evaluation.warnings == ["FACT_EVIDENCE_NOT_IN_CONTENT"]
        for item in result.selected
    )


def test_v11_selection_uses_quality_80_and_novelty_20() -> None:
    def candidate(index: int, scene: str) -> CreativeCandidate:
        return CreativeCandidate(
            slot_id=f"c-{index}",
            ordinal=index,
            round=0,
            creative_core=f"创意{index}",
            declared_fact_ids=["fact-product"],
            dimensions=CreativeDimensions(
                narrative=f"叙事{index}",
                scene=scene,
                persona="成年人手部",
                product_relation="广式腊肠切面",
                camera="微距轻推",
                emotion="温暖",
            ),
            content=f"{scene}里展示广式腊肠切面并完成连续摆盘动作，镜头稳定停留。",
        )

    candidates = [candidate(1, "厨房"), candidate(2, "厨房"), candidate(3, "家宴餐桌")]

    def evaluation(item: CreativeCandidate, quality: float) -> CreativeEvaluation:
        return CreativeEvaluation(
            slot_id=item.slot_id,
            primary_purpose=FragmentType.PRODUCT_DISPLAY,
            compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
            fact_evidence=[],
            realized_fact_ids=[],
            scores=CreativeScores(
                product_relevance=quality,
                creative_coherence=quality,
                visual_executability=quality,
                commercial_usefulness=quality,
                visual_clarity=quality,
            ),
            semantic_signature=f"s-{item.ordinal}",
            visual_signature=f"v-{item.ordinal}",
        )

    result = select_creatives(
        candidates,
        [
            evaluation(candidates[0], 95),
            evaluation(candidates[1], 94),
            evaluation(candidates[2], 85),
        ],
        target_count=2,
    )

    assert [item.candidate.slot_id for item in result.selected] == ["c-1", "c-3"]
    assert result.selected[1].novelty_score > 0


def test_v11_content_mmr_uses_70_30_and_fixed_anchor_from_first_choice() -> None:
    def candidate(index: int) -> CreativeCandidate:
        return CreativeCandidate(
            slot_id=f"mmr-{index}",
            ordinal=index,
            round=0,
            creative_core=f"创意{index}",
            declared_fact_ids=["fact-product"],
            dimensions=CreativeDimensions(
                narrative=f"叙事{index}",
                scene=f"场景{index}",
                persona=f"人物{index}",
                product_relation=f"产品关系{index}",
                camera=f"镜头{index}",
                emotion=f"情绪{index}",
            ),
            content=(
                f"第{index}条可执行的连续产品动作画面，主体完成动作后保持稳定构图。"
            ),
        )

    def evaluation(item: CreativeCandidate, quality: float) -> CreativeEvaluation:
        return CreativeEvaluation(
            slot_id=item.slot_id,
            primary_purpose=FragmentType.PRODUCT_DISPLAY,
            compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
            scores=CreativeScores(
                product_relevance=quality,
                creative_coherence=quality,
                visual_executability=quality,
                commercial_usefulness=quality,
                visual_clarity=quality,
            ),
            semantic_signature=f"s-{item.ordinal}",
            visual_signature=f"v-{item.ordinal}",
        )

    candidates = [candidate(1), candidate(2)]
    evaluations = [evaluation(candidates[0], 95), evaluation(candidates[1], 90)]
    no_anchor = select_creatives(
        candidates,
        evaluations,
        target_count=1,
        quality_weight=0.7,
        novelty_weight=0.3,
    )
    with_anchor = select_creatives(
        candidates,
        evaluations,
        target_count=1,
        fixed_novelty_resolver=lambda item: (
            0.0 if item.candidate.slot_id == "mmr-1" else 100.0
        ),
        quality_weight=0.7,
        novelty_weight=0.3,
    )

    assert [item.candidate.slot_id for item in no_anchor.selected] == ["mmr-1"]
    assert [item.candidate.slot_id for item in with_anchor.selected] == ["mmr-2"]
