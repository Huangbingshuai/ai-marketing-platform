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
    CreativeFactAssignment,
    CreativeScores,
    CreativeTask,
    FactEvidence,
    FactVisualStrategy,
    FragmentType,
    InsightField,
    ProgressPayload,
    PromptBatchResult,
    PromptBatchSettings,
    PromptGenerationSnapshot,
    PromptItem,
    RuntimeContext,
    ShardRecord,
    StageOutput,
)
from effect_prompt_generation.pipeline import (
    PipelineError,
    PromptGenerationPipeline,
    _evaluation_context_fact_ids,
    _maximum_semantic_duplicates,
    _semantic_evaluation,
)
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


class PromptApi:
    def __init__(self) -> None:
        self.stages: list[StageOutput] = []
        self.shards: dict[str, ShardRecord] = {}
        self.result: PromptBatchResult | None = None
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
        self.result = PromptBatchResult.model_validate(result)
        self.execution_mode = execution_mode
        return "prompt-result-current"

    async def fail(self, context: RuntimeContext, payload: Any) -> None:
        del context
        self.failure = payload


def test_semantic_duplicate_limit_is_strictly_below_fifteen_percent() -> None:
    assert _maximum_semantic_duplicates(50) == 7
    seven = _semantic_evaluation(
        RedundancySummary(1, 7, 7, (), ()),
        50,
    )
    eight = _semantic_evaluation(
        RedundancySummary(1, 8, 8, (), ()),
        50,
    )
    assert seven.duplicate_rate == 14
    assert eight.duplicate_rate == 16


class FirstRoundRejectingProvider(MockAiProvider):
    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        application: Any,
        fact_visual_strategy: FactVisualStrategy | None = None,
        **kwargs: Any,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            application=application,
            fact_visual_strategy=fact_visual_strategy,
            **kwargs,
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
        **kwargs: Any,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            application=application,
            fact_visual_strategy=fact_visual_strategy,
            **kwargs,
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
        **kwargs: Any,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            application=application,
            fact_visual_strategy=fact_visual_strategy,
            **kwargs,
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


class DistinctEmbeddingProvider(MockEmbeddingProvider):
    cache_namespace = "distinct-vector-test-provider"

    def __init__(self) -> None:
        self._index_by_text: dict[str, int] = {}

    async def embed(self, texts: list[str]) -> EmbeddingBatchResult:
        vectors: list[tuple[float, ...]] = []
        for text in texts:
            index = self._index_by_text.setdefault(text, len(self._index_by_text))
            vector = [0.0] * 256
            vector[index % len(vector)] = 1.0
            vectors.append(tuple(vector))
        return EmbeddingBatchResult(
            vectors=vectors,
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


class DirectionStageTrackingProvider(MockAiProvider):
    def __init__(self, api: PromptApi) -> None:
        self.api = api
        self.saw_running_stage_before_call = False

    async def plan_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        stage = next(
            (
                item
                for item in reversed(self.api.stages)
                if item.node_id.value == "COHERENT_CREATIVE_GENERATION"
            ),
            None,
        )
        self.saw_running_stage_before_call = (
            stage is not None
            and stage.status.value == "RUNNING"
            and stage.summary == "正在规划批次创意方向"
        )
        return await super().plan_creative_directions(*args, **kwargs)


class OneClassificationFailureProvider(MockAiProvider):
    def __init__(self) -> None:
        # One batch response plus both isolated retries fail in the first run;
        # the next run can then recover the same persisted shard assignment.
        self.failures_remaining = 4

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


class BatchTruncatedClassificationProvider(MockAiProvider):
    def __init__(self) -> None:
        self.batch_calls = 0
        self.single_calls = 0

    async def evaluate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        candidates = args[0]
        if len(candidates) > 1:
            self.batch_calls += 1
            raise ProviderError(
                "test classification output truncated",
                retryable=False,
                error_type=ProviderErrorType.OUTPUT_TRUNCATED,
            )
        self.single_calls += 1
        return await super().evaluate_creatives(*args, **kwargs)


class InvalidCreativeShardProvider(MockAiProvider):
    def __init__(self) -> None:
        self.invalid_calls = 0

    async def generate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        shard = args[0]
        if shard.round == 0 and shard.shard_index == 0:
            self.invalid_calls += 1
            raise ProviderError(
                "test creative response invalid",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        return await super().generate_creatives(*args, **kwargs)


def _snapshot() -> PromptGenerationSnapshot:
    return PromptGenerationSnapshot(
        project_id="project-current",
        workflow_run_id="workflow-current",
        product_id="sausage",
        operation="BATCH_GENERATE",
        settings=PromptBatchSettings(
            target_count=10,
            default_duration_seconds=5,
        ),
        selection_policy="MMR_CONTENT",
        insight_artifact={
            "id": "insight-current",
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
        run_id="run-current",
        project_id="project-current",
        workflow_run_id="workflow-current",
        product_id="sausage",
        request_id="request-current",
        attempt_token="attempt-current",
        source_fingerprint="source-current",
    )


@pytest.mark.asyncio
async def test_graph_generates_140_percent_then_selects_exact_count() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=DistinctEmbeddingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    result = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert result["prompt_result_id"] == "prompt-result-current"
    assert api.result is not None
    assert api.result.metrics.candidate_target_count == 14
    assert api.result.metrics.generated_candidate_count == 14
    assert len(api.result.items) == 10
    assert all(item.creative_core for item in api.result.items)
    assert api.result.quality_status == "PASS", [
        item.field.value for item in api.result.metrics.insight_coverage.missing
    ]
    assert api.execution_mode == "MOCK"
    assert all(item.target_duration_seconds == 5 for item in api.result.items)
    assert all(item.fragment_type == item.primary_purpose for item in api.result.items)
    assert all(
        item.primary_purpose in item.compatible_purposes for item in api.result.items
    )
    assert all("广式腊肠" in item.content for item in api.result.items)
    assert all("虚构医疗功效" not in item.content for item in api.result.items)
    assert any(
        binding.role.value == "CONTEXT"
        for item in api.result.items
        for binding in item.insight_bindings
    )
    assert all(
        not (
            binding.field.value == "PRODUCT_NAME"
            and binding.role.value == "CONTEXT"
        )
        for item in api.result.items
        for binding in item.insight_bindings
    )
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CREATIVE": 4,
        "CLASSIFICATION": 5,
    }

    creative_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
    ]
    assert len(creative_tasks) == 14
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
    result_stage = next(
        stage for stage in reversed(api.stages) if stage.node_id == "RESULT_SAVE"
    )
    assert mapping_stage.metadata["requiredFacts"]
    assert all("factId" not in item for item in mapping_stage.metadata["requiredFacts"])
    assert shared_stage.metadata["compiledContent"]
    assert creative_stage.status == "SUCCEEDED"
    assert creative_stage.metadata["candidateCount"] == 14
    assert (
        creative_stage.metadata["factSelectionMode"]
        == "VISUAL_TASK_AND_BUSINESS_CONTEXT"
    )
    assert classification_stage.status == "SUCCEEDED"
    assert classification_stage.metadata["evaluatedCount"] == 14
    assert classification_stage.metadata["averageScores"]["productRelevance"] >= 0
    semantic_audit = result_stage.metadata["semanticAudit"]
    assert semantic_audit["schemaVersion"] == 1
    assert semantic_audit["similarityThreshold"] == 0.82
    assert len(semantic_audit["evaluatedItems"]) == 10
    assert len(semantic_audit["contentFingerprint"]) == 64


@pytest.mark.asyncio
async def test_invalid_creative_shard_does_not_fail_paid_batch() -> None:
    api = PromptApi()
    provider = InvalidCreativeShardProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=DistinctEmbeddingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert provider.invalid_calls == 2
    assert api.result is not None
    assert len(api.result.items) == 10
    failed_source_shard = api.shards["CREATIVE:0:0"]
    assert failed_source_shard.status.value == "SUCCEEDED"
    assert failed_source_shard.creative_items == []
    assert failed_source_shard.warnings


@pytest.mark.asyncio
async def test_visual_strategy_graph_compiles_roles_before_creative_generation() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _snapshot()
    pipeline.register_snapshot(runtime, snapshot)

    result = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert result["prompt_result_id"] == "prompt-result-current"
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
        == "VISUAL_TASK_AND_BUSINESS_CONTEXT"
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
async def test_ai_shards_use_one_sliding_concurrency_limit() -> None:
    api = PromptApi()
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
async def test_reports_creative_direction_stage_before_slow_ai_call() -> None:
    api = PromptApi()
    provider = DirectionStageTrackingProvider(api)
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=DistinctEmbeddingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert provider.saw_running_stage_before_call is True


@pytest.mark.asyncio
async def test_retries_one_invalid_classification_response_inside_its_shard() -> (
    None
):
    api = PromptApi()
    provider = OneTransientClassificationFailureProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=DistinctEmbeddingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert provider.calls == 8
    assert api.result is not None
    assert api.result.metrics.generated_candidate_count == 14


@pytest.mark.asyncio
async def test_splits_truncated_classification_shard_without_failing_batch() -> None:
    api = PromptApi()
    provider = BatchTruncatedClassificationProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=DistinctEmbeddingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert provider.batch_calls == 5
    assert provider.single_calls == 14
    assert api.result is not None
    assert api.result.metrics.generated_candidate_count == 14


def test_product_anchor_omission_is_deferred_to_evidence_validation() -> None:
    application = map_insight(
        {
            "productName": "便携杯",
            "coreSellingPoints": ["单手开合"],
        }
    )
    product_fact = next(item for item in application.usable if item.value == "便携杯")
    primary_fact = next(item for item in application.usable if item.value == "单手开合")
    candidate = CreativeCandidate(
        slot_id="creative-anchor",
        ordinal=1,
        round=0,
        creative_core="通勤者单手打开便携杯",
        declared_fact_ids=[primary_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="动作展示",
            scene="地铁站台",
            persona="成年通勤者",
            product_relation="单手打开便携杯",
            camera="中近景跟随",
            emotion="从容利落",
        ),
        content="地铁站台上，成年通勤者单手打开便携杯，镜头跟随杯盖动作。",
    )
    task = CreativeTask(
        slot_id=candidate.slot_id,
        ordinal=1,
        round=0,
        target_duration_seconds=5,
        fact_assignment=CreativeFactAssignment(
            primary_fact_id=primary_fact.fact_id,
            product_anchor_fact_ids=[product_fact.fact_id],
            assignment_hash="a" * 64,
        ),
    )
    contextual_ids = _evaluation_context_fact_ids(
        candidate,
        task,
        application,
        item_evaluation=False,
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="便携杯")
        ],
        realized_fact_ids=[product_fact.fact_id],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=85,
            visual_clarity=90,
        ),
        semantic_signature="通勤单手开杯",
        visual_signature="站台跟随杯盖",
        hard_issues=[],
        warnings=[],
    )

    validated = validate_creative_evaluation(
        candidate,
        evaluation,
        application,
        contextual_fact_ids=contextual_ids,
        target_duration_seconds=5,
    )

    assert product_fact.fact_id in contextual_ids
    assert validated.realized_fact_ids == [product_fact.fact_id]
    assert "MISSING_PRODUCT_RELATION" not in validated.hard_issues


@pytest.mark.asyncio
async def test_classification_retry_keeps_stable_shard_assignments() -> None:
    api = PromptApi()
    provider = OneClassificationFailureProvider()
    runtime = _runtime()
    first = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        embedding_provider=DistinctEmbeddingProvider(),
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
        embedding_provider=DistinctEmbeddingProvider(),
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
    assert {shard.shard_index for shard in classification_shards} == {0, 1, 2, 3, 4}
    assert all(shard.status == "SUCCEEDED" for shard in classification_shards)
    assert sum(len(shard.evaluations) for shard in classification_shards) == 14
    assert api.result is not None
    assert api.result.metrics.generated_candidate_count == 14


@pytest.mark.asyncio
async def test_vector_selection_keeps_exact_count_and_reports_safe_metrics() -> (
    None
):
    api = PromptApi()
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
    assert selection_stage.metadata["selectionMethod"] == "CONTENT_CLUSTER_VECTOR_MMR"
    assert 10 <= selection_stage.metadata["embeddingInputCount"] <= 18
    assert selection_stage.metadata["embeddingRequestCount"] == 1
    assert selection_stage.metadata["comparisonCount"] > 0
    assert "model" not in selection_stage.metadata


@pytest.mark.asyncio
async def test_content_mmr_shadow_uses_one_vector_per_candidate() -> None:
    api = PromptApi()
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
    assert selection_stage.metadata["selectionMethod"] == "TRIGRAM_SHADOW"
    assert 10 <= selection_stage.metadata["embeddingInputCount"] <= (
        api.result.metrics.candidate_target_count
    )
    assert selection_stage.metadata["embeddingRequestCount"] == 1
    assert selection_stage.metadata["mmrQualityWeight"] == 0.70
    assert selection_stage.metadata["mmrDiversityWeight"] == 0.30
    assert "semanticGroupFirst" not in selection_stage.metadata
    assert selection_stage.metadata["contentMmrSelection"]["selectedCount"] == 10
    assert "dualVectorSelection" not in selection_stage.metadata


@pytest.mark.asyncio
async def test_content_mmr_reports_similarity_without_diversity_regeneration() -> (
    None
):
    api = PromptApi()
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
    assert final_selection_stage.metadata["diversitySupplementTriggered"] is False
    assert final_selection_stage.metadata["diversitySupplementCount"] == 0
    assert final_selection_stage.metadata["embeddingInputCount"] == 14
    assert final_selection_stage.metadata["embeddingRequestCount"] == 1
    assert final_selection_stage.metadata["finalAccurateCount"] == 10
    assert final_selection_stage.warnings == ["SEMANTIC_DIVERSITY_CAN_BE_IMPROVED"]

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
    assert restored_cache.diversity_supplemented is False
    assert restored_cache.diversity_supplement_count == 0
    assert restored_cache.replenishment_rounds == 0


@pytest.mark.asyncio
async def test_shadow_selection_reports_comparison_without_changing_result() -> (
    None
):
    baseline_api = PromptApi()
    shadow_api = PromptApi()
    baseline = PromptGenerationPipeline(
        api=baseline_api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        similarity_mode="trigram",
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
    shadow_runtime = replace(_runtime(), run_id="run-current-shadow")
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
    assert selection_stage.metadata["contentMmrSelection"]["selectedCount"] == 10
    assert selection_stage.metadata["vectorChangedItemCount"] >= 0
    assert isinstance(
        selection_stage.metadata["averageQualityDelta"],
        float,
    )
    assert set(
        selection_stage.metadata["contentMmrSelection"]["dimensionUniqueCounts"]
    ) == {
        "narrative",
        "scene",
        "persona",
        "product_relation",
        "camera",
        "emotion",
    }


@pytest.mark.asyncio
async def test_shadow_embedding_failure_does_not_publish_fake_semantic_result() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=FailingEmbeddingProvider(),
        similarity_mode="shadow",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    with pytest.raises(EmbeddingProviderError, match="向量服务测试不可用"):
        await build_graph(pipeline).ainvoke(
            {"project_id": runtime.project_id},
            context=runtime,
        )

    assert api.result is None


@pytest.mark.asyncio
async def test_vector_embedding_failure_is_retryable_and_safely_coded() -> None:
    api = PromptApi()
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
async def test_item_evaluate_preserves_content_and_only_runs_classification() -> (
    None
):
    snapshot = _snapshot()
    now = "2026-08-27T10:00:00Z"
    target = PromptItem(
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
        creative_core="从成品摆盘推进到切面细节",
        dimensions=CreativeDimensions(
            narrative="从成品摆盘推进到切面细节",
            scene="节日家宴餐桌",
            persona="仅一双成年人手部",
            product_relation="蒸熟后油润有光泽",
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
    api = PromptApi()
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
    assert api.result.items[0].creative_core == target.creative_core
    assert api.result.items[0].classification_status == "VERIFIED"
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CLASSIFICATION": 1
    }
    assert not any(
        stage.node_id.value == "COHERENT_CREATIVE_GENERATION" for stage in api.stages
    )
    assert any(stage.node_id.value == "ITEM_EVALUATE" for stage in api.stages)
    result_stage = next(
        stage for stage in reversed(api.stages) if stage.node_id.value == "RESULT_SAVE"
    )
    assert result_stage.metadata["semanticAudit"]["evaluatedItems"][0]["itemId"] == target.id


@pytest.mark.asyncio
async def test_does_not_replenish_when_initial_selection_already_covers_facts() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=FirstRoundRejectingProvider(),
        embedding_provider=DistinctEmbeddingProvider(),
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
    assert api.result.metrics.candidate_target_count == 14
    assert api.result.metrics.generated_candidate_count == 14
    assert api.result.metrics.replenishment_rounds == 0
    assert api.result.metrics.rejected_count > 0
    assert api.result.metrics.hard_issue_counts == []
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CREATIVE": 4,
        "CLASSIFICATION": 5,
    }


@pytest.mark.asyncio
async def test_candidate_ceiling_stops_repeated_low_quality_supplements() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=FirstTwoRoundsRejectingProvider(),
        embedding_provider=DistinctEmbeddingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    with pytest.raises(PipelineError, match="安全候选数量不足"):
        await build_graph(pipeline).ainvoke(
            {"project_id": runtime.project_id},
            context=runtime,
        )

    assert api.result is None
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CREATIVE": 5,
        "CLASSIFICATION": 7,
    }


@pytest.mark.asyncio
async def test_stops_after_three_rounds_when_real_safety_issues_remain() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=AlwaysRejectingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    with pytest.raises(PipelineError, match="安全候选数量不足"):
        await build_graph(pipeline).ainvoke(
            {"project_id": runtime.project_id},
            context=runtime,
        )

    assert api.result is None


def test_evaluation_requires_real_text_evidence() -> None:
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


def test_assigned_business_context_accepts_real_semantic_evidence() -> None:
    application = map_insight(
        {
            "productName": "广式腊肠",
            "purchaseScenarios": ["年货送礼"],
        }
    )
    product_fact = next(
        item for item in application.usable if item.value == "广式腊肠"
    )
    gift_fact = next(
        item for item in application.usable if item.value == "年货送礼"
    )
    candidate = CreativeCandidate(
        slot_id="candidate-gift-context",
        ordinal=1,
        round=0,
        creative_core="春节玄关递送产品",
        declared_fact_ids=[product_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="场景代入",
            scene="春节玄关向亲友递送实用食材礼物",
            persona="登门拜访的成年人",
            product_relation="双手递送广式腊肠",
            camera="中近景稳定跟随",
            emotion="喜庆温暖",
        ),
        content=(
            "春节家庭玄关挂着福字，一位成年人从普通提袋中取出广式腊肠，"
            "双手递给前来迎接的家人，镜头停在自然接过产品的动作上。"
        ),
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.CTA,
        compatible_purposes=[FragmentType.CTA],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠"),
            FactEvidence(
                fact_id=gift_fact.fact_id,
                evidence_text=candidate.dimensions.scene,
                evidence_source="SCENE",
                support_level="SEMANTIC_FULL",
            ),
        ],
        realized_fact_ids=[product_fact.fact_id, gift_fact.fact_id],
        scores=CreativeScores(
            product_relevance=92,
            creative_coherence=91,
            visual_executability=90,
            commercial_usefulness=88,
            visual_clarity=90,
        ),
        semantic_signature="ignored",
        visual_signature="ignored",
    )

    validated = validate_creative_evaluation(
        candidate,
        evaluation,
        application,
        contextual_fact_ids=[gift_fact.fact_id],
    )

    assert validated.realized_fact_ids == [
        product_fact.fact_id,
        gift_fact.fact_id,
    ]
    assert "UNKNOWN_OR_UNDECLARED_FACT" not in validated.warnings
    assert validated.fact_evidence[1].evidence_text == candidate.dimensions.scene


def test_selling_point_binding_accepts_full_semantic_support_without_character_overlap() -> None:
    application = map_insight(
        {
            "productName": "广式腊肠",
            "coreSellingPoints": ["广府糖酒腌制工艺"],
        }
    )
    product_fact = next(
        fact for fact in application.usable if fact.field == InsightField.PRODUCT_NAME
    )
    selling_fact = next(
        fact
        for fact in application.usable
        if fact.field == InsightField.CORE_SELLING_POINT
    )
    candidate = CreativeCandidate(
        slot_id="candidate-semantic-selling-point",
        ordinal=1,
        round=0,
        creative_core="呈现岭南传统糖酒入味方式",
        declared_fact_ids=[product_fact.fact_id, selling_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="风味工艺讲解",
            scene="家庭备餐台",
            persona="成年人手部",
            product_relation="沿用岭南做法，以蔗糖配米酒慢慢入味",
            camera="产品近景",
            emotion="真实克制",
        ),
        content="家庭备餐台上，镜头围绕广式腊肠呈现沿用岭南做法、以蔗糖配米酒慢慢入味的特色。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.SELLING_POINT_EXPLANATION,
        compatible_purposes=[FragmentType.SELLING_POINT_EXPLANATION],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠"),
            FactEvidence(
                fact_id=selling_fact.fact_id,
                evidence_text="沿用岭南做法，以蔗糖配米酒慢慢入味",
                evidence_source="PRODUCT_RELATION",
                support_level="SEMANTIC_FULL",
            ),
        ],
        realized_fact_ids=[product_fact.fact_id, selling_fact.fact_id],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=88,
            visual_executability=86,
            commercial_usefulness=90,
            visual_clarity=85,
        ),
        semantic_signature="ignored",
        visual_signature="ignored",
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert selling_fact.fact_id in validated.realized_fact_ids
    assert "FACT_EVIDENCE_MISMATCH" not in validated.warnings


def test_partial_business_fact_and_low_scores_only_create_soft_warnings() -> None:
    application = map_insight(
        {
            "productName": "旅行箱",
            "coreSellingPoints": ["航空级铝合金框架与静音万向轮"],
        }
    )
    product_fact = next(
        fact for fact in application.usable if fact.field == InsightField.PRODUCT_NAME
    )
    selling_fact = next(
        fact
        for fact in application.usable
        if fact.field == InsightField.CORE_SELLING_POINT
    )
    candidate = CreativeCandidate(
        slot_id="candidate-partial-selling-point",
        ordinal=1,
        round=0,
        creative_core="机场大厅推行旅行箱",
        declared_fact_ids=[product_fact.fact_id, selling_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="场景体验",
            scene="机场出发大厅",
            persona="成年旅客",
            product_relation="平稳推行旅行箱",
            camera="侧后方跟拍",
            emotion="从容",
        ),
        content="成年旅客在机场出发大厅平稳推行旅行箱，镜头跟随箱体移动。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="旅行箱"),
            FactEvidence(
                fact_id=selling_fact.fact_id,
                evidence_text="平稳推行旅行箱",
                evidence_source="PRODUCT_RELATION",
                support_level="PARTIAL",
            ),
        ],
        realized_fact_ids=[product_fact.fact_id],
        scores=CreativeScores(
            product_relevance=55,
            creative_coherence=45,
            visual_executability=45,
            commercial_usefulness=55,
            visual_clarity=55,
        ),
        semantic_signature="ignored",
        visual_signature="ignored",
        hard_issues=["DIMENSION_CONTENT_CONFLICT"],
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert validated.hard_issues == []
    assert selling_fact.fact_id not in validated.realized_fact_ids
    assert "FACT_EVIDENCE_PARTIAL" in validated.warnings
    assert "LOW_PRODUCT_RELEVANCE_SCORE" in validated.warnings
    assert "LOW_CREATIVE_COHERENCE_SCORE" in validated.warnings
    assert "LOW_VISUAL_EXECUTABILITY_SCORE" in validated.warnings
    assert "DIMENSION_CONTENT_CONFLICT" in validated.warnings


def test_context_binding_is_removed_when_excerpt_describes_another_fact() -> None:
    application = map_insight(
        {
            "productName": "广式腊肠",
            "coreSpecification": "500g真空袋装",
            "coreSellingPoints": ["三七肥瘦黄金配比"],
        }
    )
    product_fact = next(
        fact for fact in application.usable if fact.field == InsightField.PRODUCT_NAME
    )
    selling_fact = next(
        fact
        for fact in application.usable
        if fact.field == InsightField.CORE_SELLING_POINT
    )
    candidate = CreativeCandidate(
        slot_id="candidate-mismatched-context",
        ordinal=1,
        round=0,
        creative_core="包装规格展示",
        declared_fact_ids=[product_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="包装展示",
            scene="家庭餐桌",
            persona="成年人手部",
            product_relation="500g真空袋装",
            camera="近景固定",
            emotion="清楚克制",
        ),
        content="成年人把500g真空袋装广式腊肠平稳放在家庭餐桌中央。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[
            FactEvidence(fact_id=product_fact.fact_id, evidence_text="广式腊肠"),
            FactEvidence(
                fact_id=selling_fact.fact_id,
                evidence_text="500g真空袋装",
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

    validated = validate_creative_evaluation(
        candidate,
        evaluation,
        application,
        contextual_fact_ids=[selling_fact.fact_id],
    )

    assert validated.realized_fact_ids == [product_fact.fact_id]
    assert "FACT_EVIDENCE_MISMATCH" in validated.warnings
    assert "MISSING_DEEP_BUSINESS_FACT" not in validated.hard_issues
    assert "MISSING_DEEP_BUSINESS_FACT" in validated.warnings


def test_selection_prioritizes_an_uncovered_required_fact() -> None:
    def candidate(slot_id: str, ordinal: int) -> CreativeCandidate:
        return CreativeCandidate(
            slot_id=slot_id,
            ordinal=ordinal,
            round=0,
            creative_core=slot_id,
            declared_fact_ids=["fact-product"],
            dimensions=CreativeDimensions(
                narrative="连续展示",
                scene=f"场景{ordinal}",
                persona="成年人手部",
                product_relation="产品动作",
                camera="稳定跟拍",
                emotion="自然",
            ),
            content=f"产品在场景{ordinal}中完成一个清晰连续动作并稳定停留。",
        )

    def evaluation(
        slot_id: str,
        score: float,
        realized_fact_ids: list[str],
    ) -> CreativeEvaluation:
        evidence = [
            FactEvidence(fact_id=fact_id, evidence_text="产品")
            for fact_id in realized_fact_ids
        ]
        return CreativeEvaluation(
            slot_id=slot_id,
            primary_purpose=FragmentType.PRODUCT_DISPLAY,
            compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
            fact_evidence=evidence,
            realized_fact_ids=realized_fact_ids,
            scores=CreativeScores(
                product_relevance=score,
                creative_coherence=score,
                visual_executability=score,
                commercial_usefulness=score,
                visual_clarity=score,
            ),
            semantic_signature=slot_id,
            visual_signature=slot_id,
        )

    result = select_creatives(
        [candidate("high", 1), candidate("coverage", 2)],
        [
            evaluation("high", 95, ["fact-product"]),
            evaluation("coverage", 80, ["fact-product", "fact-pain"]),
        ],
        target_count=1,
        required_fact_ids=["fact-pain"],
    )

    assert [item.candidate.slot_id for item in result.selected] == ["coverage"]


def test_selection_prefers_deep_bound_candidates_without_dropping_quantity() -> None:
    candidates: list[CreativeCandidate] = []
    evaluations: list[CreativeEvaluation] = []
    for index in range(60):
        slot_id = f"candidate-{index:02d}"
        candidates.append(
            CreativeCandidate(
                slot_id=slot_id,
                ordinal=index + 1,
                round=0,
                creative_core=f"创意主线{index}",
                declared_fact_ids=["fact-product"],
                dimensions=CreativeDimensions(
                    narrative=f"叙事{index}",
                    scene=f"场景{index}",
                    persona="成年人手部",
                    product_relation="广式腊肠",
                    camera=f"镜头{index}",
                    emotion="自然",
                ),
                content=f"场景{index}中展示广式腊肠并完成一个连续动作。",
            )
        )
        deep_bound = index < 50
        evaluations.append(
            CreativeEvaluation(
                slot_id=slot_id,
                primary_purpose=FragmentType.PRODUCT_DISPLAY,
                compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
                fact_evidence=(
                    [FactEvidence(fact_id="fact-deep", evidence_text="场景")]
                    if deep_bound
                    else []
                ),
                realized_fact_ids=["fact-deep"] if deep_bound else [],
                scores=CreativeScores(
                    product_relevance=85 if deep_bound else 99,
                    creative_coherence=85 if deep_bound else 99,
                    visual_executability=85 if deep_bound else 99,
                    commercial_usefulness=85 if deep_bound else 99,
                    visual_clarity=85 if deep_bound else 99,
                ),
                semantic_signature=slot_id,
                visual_signature=slot_id,
                warnings=[] if deep_bound else ["MISSING_DEEP_BUSINESS_FACT"],
            )
        )

    result = select_creatives(
        candidates,
        evaluations,
        target_count=50,
        preferred_item_fact_ids=["fact-deep"],
    )

    assert len(result.selected) == 50
    assert all(
        "fact-deep" in item.evaluation.realized_fact_ids for item in result.selected
    )


def test_missing_deep_fact_warning_does_not_repeat_real_batch_mass_rejection() -> None:
    candidates: list[CreativeCandidate] = []
    evaluations: list[CreativeEvaluation] = []
    for index in range(90):
        slot_id = f"real-batch-{index:02d}"
        candidates.append(
            CreativeCandidate(
                slot_id=slot_id,
                ordinal=index + 1,
                round=0,
                creative_core=f"业务创意{index}",
                declared_fact_ids=["fact-product"],
                dimensions=CreativeDimensions(
                    narrative=f"叙事{index}",
                    scene=f"场景{index}",
                    persona=f"人物{index}",
                    product_relation="广式腊肠",
                    camera=f"镜头{index}",
                    emotion=f"情绪{index}",
                ),
                content=f"场景{index}中围绕广式腊肠完成一个连续可见动作。",
            )
        )
        if index < 5:
            realized = ["fact-deep"]
            hard_issues: list[str] = []
            warnings: list[str] = []
        elif index < 78:
            realized = []
            hard_issues = []
            warnings = ["MISSING_DEEP_BUSINESS_FACT"]
        else:
            realized = []
            hard_issues = ["FABRICATED_FACT"]
            warnings = []
        evaluations.append(
            CreativeEvaluation(
                slot_id=slot_id,
                primary_purpose=FragmentType.PRODUCT_DISPLAY,
                compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
                fact_evidence=(
                    [FactEvidence(fact_id="fact-deep", evidence_text="业务创意")]
                    if realized
                    else []
                ),
                realized_fact_ids=realized,
                scores=CreativeScores(
                    product_relevance=90,
                    creative_coherence=90,
                    visual_executability=90,
                    commercial_usefulness=90,
                    visual_clarity=90,
                ),
                semantic_signature=slot_id,
                visual_signature=slot_id,
                hard_issues=hard_issues,
                warnings=warnings,
            )
        )

    result = select_creatives(
        candidates,
        evaluations,
        target_count=50,
        preferred_item_fact_ids=["fact-deep"],
    )

    assert len(result.selected) == 50
    assert all(not item.evaluation.hard_issues for item in result.selected)
    assert sum(
        "MISSING_DEEP_BUSINESS_FACT" in item.evaluation.warnings
        for item in result.selected
    ) == 45


def test_generic_visual_language_is_a_soft_warning_only() -> None:
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


def test_novelty_uses_narrative_and_emotion_as_soft_dimensions() -> None:
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


def test_discards_bad_evidence_and_rejects_identity_only_prompt() -> None:
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
    assert validated.warnings == [
        "FACT_EVIDENCE_NOT_IN_CONTENT",
        "MISSING_DEEP_BUSINESS_FACT",
    ]
    assert validated.realized_fact_ids == [product_fact.fact_id]


def test_evidence_excerpt_noise_cannot_fake_deep_fact_coverage() -> None:
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
    assert all(
        item.hard_issues == []
        and item.warnings
        == ["FACT_EVIDENCE_NOT_IN_CONTENT", "MISSING_DEEP_BUSINESS_FACT"]
        for item in evaluations
    )


def test_selection_uses_quality_80_and_novelty_20() -> None:
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


def test_content_mmr_uses_70_30_and_fixed_anchor_from_first_choice() -> None:
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


def test_semantic_group_first_selects_a_distinct_group_before_repeating() -> None:
    def candidate(slot_id: str, ordinal: int) -> CreativeCandidate:
        return CreativeCandidate(
            slot_id=slot_id,
            ordinal=ordinal,
            round=0,
            creative_core=f"{slot_id}创意主线",
            declared_fact_ids=["fact-product"],
            dimensions=CreativeDimensions(
                narrative=f"{slot_id}叙事",
                scene=f"{slot_id}场景",
                persona="成年人手部",
                product_relation="产品主体动作",
                camera="稳定近景",
                emotion="自然真实",
            ),
            content=f"{slot_id}场景中，成年人围绕产品完成一条清晰连续的主体动作。",
        )

    def evaluation(item: CreativeCandidate, quality: int) -> CreativeEvaluation:
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
        )

    candidates = [candidate("a1", 1), candidate("a2", 2), candidate("b1", 3)]
    groups = {"a1": "group-a", "a2": "group-a", "b1": "group-b"}
    result = select_creatives(
        candidates,
        [
            evaluation(candidates[0], 98),
            evaluation(candidates[1], 96),
            evaluation(candidates[2], 80),
        ],
        target_count=2,
        quality_weight=1.0,
        novelty_weight=0.0,
        semantic_group_resolver=lambda row: groups[row.candidate.slot_id],
        semantic_group_repeat_penalty=12.0,
    )

    assert [row.candidate.slot_id for row in result.selected] == ["a1", "b1"]
