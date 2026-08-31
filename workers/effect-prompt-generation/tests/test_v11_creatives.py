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
    RedundancySummary,
)
from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDimensions,
    CreativeEvaluation,
    CreativeSemanticProfile,
    CreativeScores,
    FactEvidence,
    FactVisualPolicyDraft,
    FactVisualStrategy,
    FactVisualUsage,
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
from effect_prompt_generation.pipeline import (
    PromptGenerationPipeline,
    _guard_final_selection_risk,
    _is_batch_response_invalid,
)
from effect_prompt_generation.providers import (
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)
from effect_prompt_generation.quality import (
    CreativeSelectionResult,
    RankedCreative,
    _creative_novelty,
    creative_execution_findings,
    creative_soft_warnings,
    select_creatives,
    validate_creative_evaluation,
)
from effect_prompt_generation.v11_creative_directions import (
    action_motif_signature,
    dominant_action_motifs,
    scene_atom_signature,
    semantic_cluster_novelty,
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
        target_durations: Any,
        application: Any,
        fact_visual_strategy: FactVisualStrategy | None = None,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            target_durations=target_durations,
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
        target_durations: Any,
        application: Any,
        fact_visual_strategy: FactVisualStrategy | None = None,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            target_durations=target_durations,
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
        target_durations: Any,
        application: Any,
        fact_visual_strategy: FactVisualStrategy | None = None,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            target_durations=target_durations,
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


class DurationCapturingProvider(MockAiProvider):
    def __init__(self) -> None:
        self.evaluated_durations: list[dict[str, int]] = []

    async def evaluate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        self.evaluated_durations.append(dict(kwargs["target_durations"]))
        return await super().evaluate_creatives(*args, **kwargs)


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


class OneCreativeFailureProvider(MockAiProvider):
    def __init__(self) -> None:
        self.failures_remaining = 2

    async def generate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        if self.failures_remaining:
            self.failures_remaining -= 1
            raise ProviderError(
                "test creative response invalid",
                retryable=True,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        return await super().generate_creatives(*args, **kwargs)


class NetworkClassificationFailureProvider(MockAiProvider):
    async def evaluate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        raise ProviderError(
            "test classification network failure",
            retryable=True,
            error_type=ProviderErrorType.NETWORK,
        )


class DirectionPlanningSpyProvider(MockAiProvider):
    def __init__(self) -> None:
        self.direction_calls = 0

    async def plan_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        self.direction_calls += 1
        return await super().plan_creative_directions(*args, **kwargs)


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
async def test_v11_uses_30_second_duration_for_generation_evaluation_and_recovery() -> (
    None
):
    api = V11Api()
    provider = DurationCapturingProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _snapshot().model_copy(
        update={
            "settings": PromptBatchSettingsV6(
                target_count=10,
                default_duration_seconds=30,
            )
        }
    )
    pipeline.register_snapshot(runtime, snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert all(item.target_duration_seconds == 30 for item in api.result.items)
    assert provider.evaluated_durations
    assert all(
        set(durations.values()) == {30} for durations in provider.evaluated_durations
    )

    resumed = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    resumed.register_snapshot(runtime, snapshot)
    await resumed.load_and_snapshot(runtime)
    restored = resumed._cache(runtime).creative_target_durations
    assert restored
    assert set(restored.values()) == {30}


@pytest.mark.asyncio
async def test_visual_strategy_graph_compiles_roles_before_creative_generation() -> (
    None
):
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _snapshot().model_copy(update={"graph_version": "CURRENT"})
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
async def test_v11_batch_isolates_one_invalid_classification_shard() -> None:
    api = V11Api()
    provider = OneClassificationFailureProvider()
    runtime = _runtime()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    pipeline.register_snapshot(runtime, _snapshot())
    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    classification_shards = [
        shard for shard in api.shards.values() if shard.phase.value == "CLASSIFICATION"
    ]
    assert any(shard.status == "FAILED" for shard in classification_shards)
    assert any(shard.status == "SUCCEEDED" for shard in classification_shards)
    assert api.result is not None
    assert len(api.result.items) == 10


@pytest.mark.asyncio
async def test_v11_batch_isolates_one_invalid_creative_shard() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=OneCreativeFailureProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id}, context=runtime
    )

    creative_shards = [
        shard for shard in api.shards.values() if shard.phase.value == "CREATIVE"
    ]
    assert any(shard.status == "FAILED" for shard in creative_shards)
    assert any(shard.status == "SUCCEEDED" for shard in creative_shards)
    assert api.result is not None
    assert len(api.result.items) == 10


@pytest.mark.asyncio
async def test_v11_batch_does_not_isolate_network_failure() -> None:
    pipeline = PromptGenerationPipeline(
        api=V11Api(),  # type: ignore[arg-type]
        provider=NetworkClassificationFailureProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    with pytest.raises(ProviderError, match="network failure"):
        await build_graph(pipeline).ainvoke(
            {"project_id": runtime.project_id}, context=runtime
        )


def test_v11_item_operation_does_not_isolate_invalid_response() -> None:
    snapshot = _snapshot().model_copy(update={"operation": "ITEM_REGENERATE"})
    error = ProviderError(
        "invalid item response",
        retryable=False,
        error_type=ProviderErrorType.RESPONSE_INVALID,
    )

    assert _is_batch_response_invalid(snapshot, error) is False


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
    assert final_selection_stage.metadata["diversitySupplementAdmittedCount"] == 0
    assert final_selection_stage.metadata["diversitySupplementRejectedCount"] == 2
    assert final_selection_stage.metadata["preSupplementRisk"] == {
        "selectedCount": 10,
        "highRiskGroupCount": 1,
        "highRiskPairCount": 45,
        "redundantCandidateCount": 9,
    }
    assert final_selection_stage.metadata["postSupplementRisk"] == {
        "selectedCount": 10,
        "highRiskGroupCount": 1,
        "highRiskPairCount": 45,
        "redundantCandidateCount": 9,
    }
    assert final_selection_stage.metadata["preFinalGuard"] == (
        final_selection_stage.metadata["postFinalGuard"]
    )
    assert final_selection_stage.metadata["finalGuardApplied"] is False
    assert final_selection_stage.metadata["finalGuardSource"] is None
    assert (
        final_selection_stage.metadata["nearDuplicateReductionBasis"]
        == "PURE_QUALITY_BASELINE_TO_FINAL_GUARD"
    )
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


def test_v11_final_guard_never_keeps_a_pareto_worse_exact_count_batch() -> None:
    def ranked(slot_id: str, ordinal: int) -> RankedCreative:
        candidate = CreativeCandidate(
            slot_id=slot_id,
            ordinal=ordinal,
            round=0,
            creative_core=f"创意{slot_id}",
            declared_fact_ids=["fact-product"],
            dimensions=CreativeDimensions(
                narrative=f"叙事{slot_id}",
                scene=f"场景{slot_id}",
                persona=f"人物{slot_id}",
                product_relation=f"产品动作{slot_id}",
                camera=f"镜头{slot_id}",
                emotion=f"情绪{slot_id}",
            ),
            content=f"候选正文{slot_id}围绕已确认产品完成一条连续且可拍摄的动作。",
        )
        evaluation = CreativeEvaluation(
            slot_id=slot_id,
            primary_purpose=FragmentType.PRODUCT_DISPLAY,
            compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
            scores=CreativeScores(
                product_relevance=90,
                creative_coherence=90,
                visual_executability=90,
                commercial_usefulness=90,
                visual_clarity=90,
            ),
            semantic_signature=slot_id,
            visual_signature=slot_id,
        )
        return RankedCreative(
            candidate=candidate,
            evaluation=evaluation,
            quality_score=90,
            novelty_score=90,
            selection_score=90,
        )

    preferred = CreativeSelectionResult(
        selected=[ranked("mmr-1", 1), ranked("mmr-2", 2)],
        rejected=[],
        exact_duplicate_count=0,
    )
    quality_baseline = CreativeSelectionResult(
        selected=[ranked("quality-1", 3), ranked("quality-2", 4)],
        rejected=[],
        exact_duplicate_count=0,
    )

    class StaticRiskIndex:
        def redundancy_summary(self, selected_ids: list[str]) -> RedundancySummary:
            if set(selected_ids) == {"mmr-1", "mmr-2"}:
                return RedundancySummary(4, 106, 40, tuple(selected_ids))
            return RedundancySummary(3, 100, 35, tuple(selected_ids))

    guarded, source = _guard_final_selection_risk(
        preferred,
        comparators=[("QUALITY_BASELINE", quality_baseline)],
        content_index=StaticRiskIndex(),  # type: ignore[arg-type]
        target_count=2,
    )

    assert source == "QUALITY_BASELINE"
    assert [item.candidate.slot_id for item in guarded.selected] == [
        "quality-1",
        "quality-2",
    ]
    assert len(guarded.selected) == 2


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
@pytest.mark.parametrize("operation", ["ITEM_EVALUATE", "ITEM_REGENERATE"])
async def test_v11_item_operations_skip_batch_direction_planning(
    operation: str,
) -> None:
    target = PromptItemV6(
        id="prompt-item-direction-spy",
        code="P001",
        origin="AI",
        fragment_type=FragmentType.PRODUCT_DISPLAY,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        classification_status="VERIFIED",
        product_relevance=90,
        material_tags=["产品"],
        target_duration_seconds=5,
        dimensions=CreativeDimensions(
            narrative="产品动作",
            scene="家庭餐桌",
            persona="成年人",
            product_relation="广式腊肠摆盘",
            camera="中近景跟随",
            emotion="温暖",
        ),
        content="家庭餐桌上，成年人将广式腊肠摆入餐盘，镜头中近景跟随。",
        insight_bindings=[],
        manual_edited=False,
        created_at="2026-08-27T10:00:00Z",
        updated_at="2026-08-27T10:00:00Z",
    )
    snapshot = _snapshot().model_copy(
        update={
            "operation": operation,
            "target_item_id": target.id,
            "target_item": target,
            "target_item_index": 0,
        }
    )
    provider = DirectionPlanningSpyProvider()
    pipeline = PromptGenerationPipeline(
        api=V11Api(),  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, snapshot)
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    await pipeline.plan_v11_creatives(runtime, round_number=0)

    assert provider.direction_calls == 0


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
async def test_v11_candidate_ceiling_stops_repeated_quantity_supplements() -> None:
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
    assert api.result.quality_status == "NEEDS_REVIEW"
    assert api.result.items == []
    assert api.result.metrics.generated_candidate_count == 16
    assert api.result.metrics.replenishment_rounds == 3


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
    assert api.result.metrics.generated_candidate_count == 16
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


def test_v11_evaluation_deduplicates_repeated_fact_evidence() -> None:
    application = map_insight({"productName": "广式腊肠"})
    fact = next(item for item in application.usable if item.value == "广式腊肠")
    candidate = CreativeCandidate(
        slot_id="candidate-duplicate-evidence",
        ordinal=1,
        round=0,
        creative_core="展示广式腊肠切面",
        declared_fact_ids=[fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="产品展示",
            scene="家庭厨房",
            persona="成年人手部",
            product_relation="广式腊肠作为画面主体",
            camera="近景推进到切面",
            emotion="自然温暖",
        ),
        content="家庭厨房里，成年人切开广式腊肠，镜头推进并停留在切面。",
    )
    duplicate = FactEvidence(fact_id=fact.fact_id, evidence_text="广式腊肠")
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[duplicate, duplicate],
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

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert validated.fact_evidence == [duplicate]
    assert validated.realized_fact_ids == [fact.fact_id]


def test_v11_fact_evidence_must_support_the_bound_fact() -> None:
    application = map_insight(
        {"productName": "广式腊肠", "coreSellingPoints": ["蒸熟后油润有光泽"]}
    )
    product_fact = next(item for item in application.usable if item.value == "广式腊肠")
    selling_fact = next(
        item for item in application.usable if item.value == "蒸熟后油润有光泽"
    )
    candidate = CreativeCandidate(
        slot_id="candidate-mismatched-binding",
        ordinal=1,
        round=0,
        creative_core="产品身份展示",
        declared_fact_ids=[product_fact.fact_id, selling_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="直接展示",
            scene="家庭厨房",
            persona="成年人手部",
            product_relation="广式腊肠作为主体",
            camera="固定近景",
            emotion="自然",
        ),
        content="家庭厨房里，成年人把广式腊肠放在白瓷盘中，镜头固定观察。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠"),
            FactEvidence(fact_id=selling_fact.fact_id, evidence_text="广式腊肠"),
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
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert validated.realized_fact_ids == [product_fact.fact_id]
    assert "FACT_EVIDENCE_MISMATCH" in validated.warnings


def test_v11_accepts_concise_evidence_excerpt_from_a_longer_fact() -> None:
    application = map_insight(
        {"productName": "广式腊肠", "usageScenarios": ["煲仔饭烹饪"]}
    )
    product_fact = next(item for item in application.usable if item.value == "广式腊肠")
    scenario_fact = next(
        item for item in application.usable if item.value == "煲仔饭烹饪"
    )
    candidate = CreativeCandidate(
        slot_id="candidate-concise-evidence",
        ordinal=1,
        round=0,
        creative_core="煲仔饭中的腊肠食用场景",
        declared_fact_ids=[product_fact.fact_id, scenario_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="场景代入",
            scene="家庭厨房煲仔饭",
            persona="成年人手部",
            product_relation="广式腊肠用于煲仔饭",
            camera="近景跟随",
            emotion="温暖",
        ),
        content="家庭厨房里，成年人把熟制的广式腊肠铺在煲仔饭上，镜头近景跟随。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠"),
            FactEvidence(fact_id=scenario_fact.fact_id, evidence_text="煲仔饭"),
        ],
        realized_fact_ids=[product_fact.fact_id, scenario_fact.fact_id],
        scores=CreativeScores(
            product_relevance=94,
            creative_coherence=92,
            visual_executability=91,
            commercial_usefulness=90,
            visual_clarity=92,
        ),
        semantic_signature="ignored",
        visual_signature="ignored",
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert validated.realized_fact_ids == [product_fact.fact_id, scenario_fact.fact_id]
    assert "FACT_EVIDENCE_MISMATCH" not in validated.warnings


@pytest.mark.parametrize("vessel", ["蒸屉", "蒸笼", "蒸锅", "锅盖"])
def test_v11_rejects_impossible_cool_vapor_from_hot_food_vessel(vessel: str) -> None:
    application = map_insight({"productName": "广式腊肠"})
    candidate = _physical_logic_candidate(
        f"成年人打开{vessel}，{vessel}边缘冒出一缕凉气，广式腊肠保持居中。"
    )

    hard_issues, warnings = creative_execution_findings(
        candidate,
        target_duration_seconds=15,
        application=application,
    )

    assert hard_issues == ["FOOD_PHYSICS_CONFLICT"]
    assert warnings == []


def test_v11_rejects_cook_required_food_jumping_from_slicing_to_tasting() -> None:
    application = map_insight({"productName": "广式腊肠"})
    candidate = _physical_logic_candidate(
        "成年人拆开普通外袋，把广式腊肠切片，随后用筷子夹起一片送入口中。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=15,
        application=application,
    )

    assert "FOOD_STATE_CONFLICT" in hard_issues


def test_v11_rejects_uncooked_slice_placed_on_an_already_finished_dish() -> None:
    application = map_insight({"productName": "广式腊肠"})
    candidate = _physical_logic_candidate(
        "成年人把广式腊肠切片，随后铺在热气腾腾的煲仔饭上，镜头停留。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=15,
        application=application,
    )

    assert "FOOD_STATE_CONFLICT" in hard_issues


def test_v11_accepts_slice_added_to_rice_before_an_explicit_final_simmer() -> None:
    application = map_insight({"productName": "广式腊肠"})
    candidate = _physical_logic_candidate(
        "成年人把广式腊肠切片，随后铺在刚收完汁的煲仔饭上，加盖小火焖至熟制完成。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=15,
        application=application,
    )

    assert "FOOD_STATE_CONFLICT" not in hard_issues


def test_v11_accepts_cook_required_food_after_explicit_heating_completion() -> None:
    application = map_insight({"productName": "广式腊肠"})
    candidate = _physical_logic_candidate(
        "成年人把广式腊肠切片放入蒸笼，蒸制完成后用筷子夹起一片品尝。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=15,
        application=application,
    )

    assert "FOOD_STATE_CONFLICT" not in hard_issues


def test_v11_does_not_apply_cook_required_gate_to_confirmed_ready_to_eat_food() -> None:
    application = map_insight(
        {"productName": "即食鸡胸肉", "coreSellingPoints": ["开袋即食"]}
    )
    candidate = _physical_logic_candidate(
        "成年人拆开包装，将即食鸡胸肉切片后夹起一片品尝。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=15,
        application=application,
    )

    assert "FOOD_STATE_CONFLICT" not in hard_issues


def test_v11_rejects_clearly_overloaded_fifteen_second_action_chain() -> None:
    candidate = _physical_logic_candidate(
        "成年人拆开包装，切开产品，随后放入蒸笼蒸熟，然后夹起摆盘，"
        "接着端上餐桌并品尝，最后转动盘子观察切面。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=15,
    )

    assert "ACTION_CHAIN_OVERLOAD" in hard_issues


def test_current_five_second_multi_stage_action_is_a_soft_density_warning() -> None:
    candidate = _physical_logic_candidate(
        "成年人切开已经熟制的广式腊肠，随后放入锅中翻炒，然后夹起摆入餐盘。"
    )

    hard_issues, warnings = creative_execution_findings(
        candidate,
        target_duration_seconds=5,
    )

    assert "ACTION_CHAIN_OVERLOAD" not in hard_issues
    assert "DURATION_TOO_DENSE" in warnings


def test_v11_action_motifs_expose_repetition_hidden_by_broad_action_family() -> None:
    profile = CreativeSemanticProfile(
        narrative_family="场景代入",
        scene_family="家庭餐桌",
        persona_family="家庭成员",
        product_action_family="餐前互动",
        camera_family="稳定跟拍",
        emotion_family="温馨自然",
    )
    cut = _physical_logic_candidate(
        "家庭厨房里，成年人把广式腊肠切片并让镜头稳定停留在切面。"
    )
    serve = _physical_logic_candidate(
        "家庭餐桌旁，成年人把蒸熟的广式腊肠端上餐桌与家人自然分享。"
    )

    same_broad_family = semantic_cluster_novelty(profile, profile)
    motif_aware = semantic_cluster_novelty(
        profile,
        profile,
        left_action_motifs=action_motif_signature(cut),
        right_action_motifs=action_motif_signature(serve),
    )

    assert same_broad_family == 0
    assert motif_aware > same_broad_family


def test_current_selection_treats_any_shared_concrete_action_as_repetition() -> None:
    profile = CreativeSemanticProfile(
        narrative_family="场景代入",
        scene_family="家庭餐桌",
        persona_family="家庭成员",
        product_action_family="餐前互动",
        camera_family="稳定跟拍",
        emotion_family="温馨自然",
    )
    cut_and_plate = _physical_logic_candidate(
        "成年人把广式腊肠切片后摆入白瓷盘，镜头稳定跟随。"
    )
    cut_and_pick = _physical_logic_candidate(
        "成年人切开广式腊肠并用筷子夹起一片，镜头停留。"
    )
    serve_without_cut = _physical_logic_candidate(
        "成年人把蒸熟的整根广式腊肠端上餐桌，与家人自然分享。"
    )

    repeated_cut = semantic_cluster_novelty(
        profile,
        profile,
        left_action_motifs=action_motif_signature(cut_and_plate),
        right_action_motifs=action_motif_signature(cut_and_pick),
    )
    different_action = semantic_cluster_novelty(
        profile,
        profile,
        left_action_motifs=action_motif_signature(cut_and_plate),
        right_action_motifs=action_motif_signature(serve_without_cut),
    )

    assert repeated_cut == 0
    assert different_action > repeated_cut


def test_current_batch_detects_a_dominant_concrete_cutting_motif() -> None:
    candidates = [
        _physical_logic_candidate("家庭厨房里，成年人把广式腊肠切片后观察真实切面。"),
        _physical_logic_candidate("家庭餐桌旁，成年人切开广式腊肠并摆入白色餐盘。"),
        _physical_logic_candidate("自然光下，成年人缓慢下刀切出一片广式腊肠。"),
        _physical_logic_candidate("家庭餐桌旁，成年人把蒸熟的广式腊肠端上餐桌。"),
        _physical_logic_candidate("家庭聚餐时，成年人夹起一段广式腊肠与家人分享。"),
    ]

    assert dominant_action_motifs(candidates) == ["CUT"]


def test_current_cluster_novelty_collapses_cross_label_kitchen_scenes() -> None:
    profile_left = CreativeSemanticProfile(
        narrative_family="场景代入",
        scene_family="岭南厨房",
        persona_family="家庭成员",
        product_action_family="整根观察",
        camera_family="稳定跟拍",
        emotion_family="温馨自然",
    )
    profile_right = profile_left.model_copy(
        update={"scene_family": "砂锅台面备餐"}
    )
    kitchen_left = _physical_logic_candidate(
        "岭南厨房灶台旁，成年人观察蒸笼中的广式腊肠，镜头稳定停留。"
    )
    kitchen_left = kitchen_left.model_copy(
        update={
            "dimensions": kitchen_left.dimensions.model_copy(
                update={"scene": "岭南厨房灶台"}
            )
        }
    )
    kitchen_right = _physical_logic_candidate(
        "砂锅台面备餐区，成年人观察盘中的广式腊肠，镜头稳定停留。"
    )
    kitchen_right = kitchen_right.model_copy(
        update={
            "dimensions": kitchen_right.dimensions.model_copy(
                update={"scene": "砂锅台面备餐"}
            )
        }
    )
    dining = _physical_logic_candidate(
        "家庭餐桌旁，成年人把广式腊肠端给家人，镜头稳定跟随。"
    )
    dining = dining.model_copy(
        update={
            "dimensions": dining.dimensions.model_copy(
                update={"scene": "家庭餐桌"}
            )
        }
    )

    same_atom = semantic_cluster_novelty(
        profile_left,
        profile_right,
        left_scene_atom=scene_atom_signature(kitchen_left),
        right_scene_atom=scene_atom_signature(kitchen_right),
    )
    different_atom = semantic_cluster_novelty(
        profile_left,
        profile_right,
        left_scene_atom=scene_atom_signature(kitchen_left),
        right_scene_atom=scene_atom_signature(dining),
    )

    assert same_atom < different_atom


def test_current_rejects_real_minute_wait_inside_a_thirty_second_prompt() -> None:
    candidate = _physical_logic_candidate(
        "成年人把广式腊肠放入蒸笼，十几分钟后揭盖，再切段端上餐桌。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=30,
    )

    assert "REAL_TIME_EXCEEDS_TARGET" in hard_issues


def test_current_rejects_full_cooking_then_serving_inside_thirty_seconds() -> None:
    candidate = _physical_logic_candidate(
        "成年人切开广式腊肠，放入蒸笼蒸熟，随后切段并端上餐桌。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=30,
    )

    assert "REAL_TIME_EXCEEDS_TARGET" in hard_issues


def test_current_rejects_rapid_whole_product_cooking_compression_at_thirty_seconds() -> (
    None
):
    candidate = _physical_logic_candidate(
        "成年人把整根广式腊肠放入沸水，片刻后立即捞出已经熟透的成品。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=30,
    )

    assert "REAL_TIME_EXCEEDS_TARGET" in hard_issues


def test_current_rejects_product_rotating_without_physical_support() -> None:
    candidate = _physical_logic_candidate(
        "白瓷盘保持静止，整根广式腊肠无外力缓慢旋转，镜头固定观察。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=15,
    )

    assert "UNSUPPORTED_OBJECT_MOTION" in hard_issues


def test_current_warns_when_chopsticks_lift_a_whole_long_product() -> None:
    candidate = _physical_logic_candidate(
        "家庭餐桌旁，成年人用木筷夹起一整根广式腊肠并悬停展示。"
    )

    hard_issues, warnings = creative_execution_findings(
        candidate,
        target_duration_seconds=15,
    )

    assert "UNSUPPORTED_OBJECT_MOTION" not in hard_issues
    assert "IMPLAUSIBLE_PRODUCT_HANDLING" in warnings


def test_current_fact_evidence_normalization_ignores_punctuation_only() -> None:
    application = map_insight(
        {"productName": "广式腊肠", "coreSellingPoints": ["蒸熟后油润有光泽"]}
    )
    product_fact = next(item for item in application.usable if item.value == "广式腊肠")
    selling_fact = next(
        item for item in application.usable if item.value == "蒸熟后油润有光泽"
    )
    candidate = _physical_logic_candidate(
        "白瓷盘里摆着广式腊肠，蒸熟后，油润有光泽，镜头近距离观察。"
    ).model_copy(
        update={"declared_fact_ids": [product_fact.fact_id, selling_fact.fact_id]}
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠"),
            FactEvidence(
                fact_id=selling_fact.fact_id,
                evidence_text="蒸熟后油润有光泽",
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
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert validated.realized_fact_ids == [
        product_fact.fact_id,
        selling_fact.fact_id,
    ]
    assert "FACT_EVIDENCE_NOT_IN_CONTENT" not in validated.warnings
    assert "FACT_EVIDENCE_MISMATCH" not in validated.warnings


def test_current_short_generic_excerpt_cannot_bind_a_longer_business_fact() -> None:
    application = map_insight(
        {"productName": "广式腊肠", "usageScenarios": ["家庭厨房蒸制"]}
    )
    product_fact = next(item for item in application.usable if item.value == "广式腊肠")
    scenario_fact = next(
        item for item in application.usable if item.value == "家庭厨房蒸制"
    )
    candidate = _physical_logic_candidate(
        "家庭餐桌旁，成年人把广式腊肠放入白瓷盘，镜头保持稳定。"
    ).model_copy(
        update={"declared_fact_ids": [product_fact.fact_id, scenario_fact.fact_id]}
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠"),
            FactEvidence(fact_id=scenario_fact.fact_id, evidence_text="家庭"),
        ],
        realized_fact_ids=[product_fact.fact_id, scenario_fact.fact_id],
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

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert validated.realized_fact_ids == [product_fact.fact_id]
    assert "FACT_EVIDENCE_MISMATCH" in validated.warnings


@pytest.mark.parametrize("finished_rice", ["刚离火的米饭", "刚蒸好的米饭"])
def test_current_rejects_raw_slices_placed_on_finished_rice(
    finished_rice: str,
) -> None:
    application = map_insight({"productName": "广式腊肠"})
    candidate = _physical_logic_candidate(
        f"成年人拆开外袋，把广式腊肠切片铺在{finished_rice}上，镜头停留。"
    )

    hard_issues, _ = creative_execution_findings(
        candidate,
        target_duration_seconds=30,
        application=application,
    )

    assert "FOOD_STATE_CONFLICT" in hard_issues


def test_current_rejects_visual_packaging_proof_of_an_abstract_fact() -> None:
    application = map_insight(
        {"productName": "广式腊肠", "coreSellingPoints": ["真空锁鲜"]}
    )
    product_fact = next(item for item in application.usable if item.value == "广式腊肠")
    lock_fact = next(item for item in application.usable if item.value == "真空锁鲜")
    strategy = FactVisualStrategy(
        source_content_hash="source",
        prompt_version="current",
        strategy_hash="a" * 64,
        policies=[
            FactVisualPolicyDraft(
                fact_id=product_fact.fact_id,
                visual_usage=FactVisualUsage.IDENTITY_ANCHOR,
            ),
            FactVisualPolicyDraft(
                fact_id=lock_fact.fact_id,
                visual_usage=FactVisualUsage.FORBIDDEN_VISUAL_PROOF,
                forbidden_inferences=["不得用包装形态证明锁鲜效果"],
            ),
        ],
    )
    candidate = CreativeCandidate(
        slot_id="abstract-packaging-proof",
        ordinal=1,
        round=0,
        creative_core="包装细节观察",
        declared_fact_ids=[product_fact.fact_id, lock_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="近景观察",
            scene="家庭厨房",
            persona="成年人手部",
            product_relation="真空锁鲜的密封形态",
            camera="包装封口微距",
            emotion="可信自然",
        ),
        content="成年人拿起广式腊肠外袋，微距观察真空锁鲜的密封形态与封口。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠"),
            FactEvidence(fact_id=lock_fact.fact_id, evidence_text="真空锁鲜"),
        ],
        realized_fact_ids=[product_fact.fact_id, lock_fact.fact_id],
        scores=CreativeScores(
            product_relevance=94,
            creative_coherence=92,
            visual_executability=90,
            commercial_usefulness=90,
            visual_clarity=92,
        ),
        semantic_signature="ignored",
        visual_signature="ignored",
    )

    validated = validate_creative_evaluation(
        candidate,
        evaluation,
        application,
        target_duration_seconds=30,
        fact_visual_strategy=strategy,
    )

    assert "ABSTRACT_FACT_VISUAL_PROOF" in validated.hard_issues


def test_current_removes_unsupported_abstract_proof_model_false_positive() -> None:
    application = map_insight({"productName": "广式腊肠"})
    product_fact = next(item for item in application.usable if item.value == "广式腊肠")
    strategy = FactVisualStrategy(
        source_content_hash="source",
        prompt_version="current",
        strategy_hash="b" * 64,
        policies=[
            FactVisualPolicyDraft(
                fact_id=product_fact.fact_id,
                visual_usage=FactVisualUsage.IDENTITY_ANCHOR,
            )
        ],
    )
    candidate = _physical_logic_candidate(
        "家庭厨房里，成年人把蒸熟的广式腊肠放入锅中与青菜快速翻炒。"
    ).model_copy(update={"declared_fact_ids": [product_fact.fact_id]})
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠")
        ],
        realized_fact_ids=[product_fact.fact_id],
        scores=CreativeScores(
            product_relevance=92,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=88,
            visual_clarity=90,
        ),
        semantic_signature="ignored",
        visual_signature="ignored",
        hard_issues=["ABSTRACT_FACT_VISUAL_PROOF"],
    )

    validated = validate_creative_evaluation(
        candidate,
        evaluation,
        application,
        target_duration_seconds=30,
        fact_visual_strategy=strategy,
    )

    assert "ABSTRACT_FACT_VISUAL_PROOF" not in validated.hard_issues


def _physical_logic_candidate(content: str) -> CreativeCandidate:
    return CreativeCandidate(
        slot_id="physical-logic",
        ordinal=1,
        round=0,
        creative_core="食品连续动作",
        declared_fact_ids=["fact-product"],
        dimensions=CreativeDimensions(
            narrative="连续动作",
            scene="家庭厨房",
            persona="成年人手部",
            product_relation="产品作为动作主体",
            camera="稳定近景跟随",
            emotion="自然真实",
        ),
        content=content,
    )


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


def test_current_selection_prefers_duration_fit_candidate_without_blocking_count() -> None:
    def candidate(slot_id: str, content: str) -> CreativeCandidate:
        return CreativeCandidate(
            slot_id=slot_id,
            ordinal=1 if slot_id == "dense" else 2,
            round=0,
            creative_core=f"广式腊肠餐桌展示-{slot_id}",
            declared_fact_ids=["fact-product"],
            dimensions=CreativeDimensions(
                narrative=f"直接展示-{slot_id}",
                scene="家庭餐桌",
                persona="成年人手部",
                product_relation="广式腊肠作为画面主体",
                camera="稳定近景",
                emotion="自然温暖",
            ),
            content=content,
        )

    dense = candidate(
        "dense",
        "成年人切开熟制的广式腊肠，随后放入锅中翻炒，然后夹起摆入餐盘。",
    )
    focused = candidate(
        "focused",
        "成年人夹起一片熟制的广式腊肠，近景停留在清晰切面。",
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
            semantic_signature=item.slot_id,
            visual_signature=item.slot_id,
            warnings=["DURATION_TOO_DENSE"] if item is dense else [],
        )

    result = select_creatives(
        [dense, focused],
        [evaluation(dense, 92), evaluation(focused, 87)],
        target_count=1,
    )

    assert [item.candidate.slot_id for item in result.selected] == ["focused"]


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
