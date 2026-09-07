from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import replace
from types import SimpleNamespace
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
    AbstractVisualProofFinding,
    CreativeCandidate,
    CreativeDimensions,
    CreativeDirectionDiversityAuditResponse,
    CreativeDirectionOverlapGroup,
    CreativeDirectionResponse,
    CreativeEvaluation,
    CreativeFactAssignment,
    CreativeScores,
    CreativeTask,
    FactVisualPolicyDraft,
    FactEvidence,
    FactVisualStrategy,
    FactVisualUsage,
    FragmentType,
    InsightApplicationMap,
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
    PENDING_CREATIVE_STRUCTURE_TEXT,
    PipelineError,
    PromptGenerationPipeline,
    _adaptive_mmr_quality_weight,
    _coverage_supplement_count,
    _creative_shard_size_for_duration,
    _evaluation_context_fact_ids,
    _maximum_diversity_supplement_duplicates,
    _maximum_semantic_duplicates,
    _semantic_evaluation,
    _semantic_aware_similarity_resolver,
    _silent_material_planning_inputs,
)
from effect_prompt_generation.providers import (
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)
from effect_prompt_generation.quality import (
    RankedCreative,
    _creative_novelty,
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


def test_semantic_families_cannot_dilute_high_content_similarity() -> None:
    index = SimpleNamespace(similarity=lambda _left, _right: 0.90)
    left_profile = SimpleNamespace(
        narrative_family="使用演示",
        scene_family="晨间浴室",
        persona_family="独居女性",
        product_action_family="按压起泡",
        camera_family="手部跟拍",
        emotion_family="清新",
    )
    right_profile = SimpleNamespace(
        narrative_family="体验分享",
        scene_family="晚间浴室",
        persona_family="家庭成员",
        product_action_family="冲洗泡沫",
        camera_family="固定近景",
        emotion_family="放松",
    )
    resolver = _semantic_aware_similarity_resolver(
        index,
        {
            "left": SimpleNamespace(semantic_profile=left_profile),
            "right": SimpleNamespace(semantic_profile=right_profile),
        },
    )

    assert resolver("left", "right") == 0.90


def test_structured_creative_shards_shrink_for_longer_durations() -> None:
    assert _creative_shard_size_for_duration(8) == 4
    assert _creative_shard_size_for_duration(9) == 4
    assert _creative_shard_size_for_duration(15) == 4


def test_structured_creative_shards_follow_configured_token_limit() -> None:
    assert (
        _creative_shard_size_for_duration(
            8,
            configured_max_size=5,
            max_output_tokens=3_000,
        )
        == 2
    )
    assert (
        _creative_shard_size_for_duration(
            15,
            configured_max_size=2,
            max_output_tokens=8_192,
        )
        == 2
    )


@pytest.mark.asyncio
async def test_run_preflight_rejects_an_impossible_ai_call_budget_before_shards() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        max_ai_calls_per_run=20,
    )
    runtime = _runtime()
    snapshot = _snapshot().model_copy(
        update={
            "settings": PromptBatchSettings(
                target_count=100,
                default_duration_seconds=15,
            )
        }
    )
    pipeline.register_snapshot(runtime, snapshot)

    with pytest.raises(PipelineError, match="cannot fit the initial batch"):
        await pipeline.load_and_snapshot(runtime)

    assert api.shards == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("duration_seconds", [4, 5, 8, 12, 15])
async def test_mock_end_to_end_keeps_exact_count_across_duration_bands(
    duration_seconds: int,
) -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=DistinctEmbeddingProvider(),
        shard_size=8,
    )
    runtime = _runtime()
    snapshot = _snapshot().model_copy(
        update={
            "settings": PromptBatchSettings(
                target_count=10,
                default_duration_seconds=duration_seconds,
            )
        }
    )
    pipeline.register_snapshot(runtime, snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert len(api.result.items) == 10
    assert all(
        item.target_duration_seconds == duration_seconds for item in api.result.items
    )


def test_mmr_weights_rebalance_only_after_pool_redundancy_exceeds_half() -> None:
    assert _adaptive_mmr_quality_weight(0.49) == 0.70
    assert _adaptive_mmr_quality_weight(0.50) == 0.70
    assert _adaptive_mmr_quality_weight(0.51) == 0.60
    assert _adaptive_mmr_quality_weight(0.75) == 0.60


def test_coverage_supplement_is_capped_at_twenty_percent() -> None:
    assert _coverage_supplement_count(10, 1) == 2
    assert _coverage_supplement_count(50, 20) == 10
    assert _coverage_supplement_count(100, 20) == 20
    assert _coverage_supplement_count(50, 0) == 0


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
            item.model_copy(update={"hard_issues": ["FABRICATED_FACT"]})
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
            item.model_copy(update={"hard_issues": ["FABRICATED_FACT"]})
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
            item.model_copy(update={"hard_issues": ["FABRICATED_FACT"]})
            for item in call.value.items
        ]
        return replace(call, value=call.value.model_copy(update={"items": items}))


class MissingPainCoverageProvider(MockAiProvider):
    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        application: InsightApplicationMap,
        fact_visual_strategy: FactVisualStrategy | None = None,
        **kwargs: Any,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            application=application,
            fact_visual_strategy=fact_visual_strategy,
            **kwargs,
        )
        pain_fact_ids = {
            fact.fact_id
            for fact in application.usable
            if fact.field == InsightField.CORE_PAIN_POINT
        }
        items = [
            item.model_copy(
                update={
                    "fact_evidence": [
                        evidence
                        for evidence in item.fact_evidence
                        if evidence.fact_id not in pain_fact_ids
                    ],
                    "realized_fact_ids": [
                        fact_id
                        for fact_id in item.realized_fact_ids
                        if fact_id not in pain_fact_ids
                    ],
                }
            )
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


class RejectingDiversitySupplementProvider(MockAiProvider):
    async def audit_creative_direction_diversity(
        self,
        *,
        landscape: Any,
        directions: CreativeDirectionResponse,
        proposed_direction_ids: Any = (),
    ) -> Any:
        call = await super().audit_creative_direction_diversity(
            landscape=landscape,
            directions=directions,
            proposed_direction_ids=proposed_direction_ids,
        )
        proposed_ids = list(proposed_direction_ids)
        if not proposed_ids:
            return call
        retained_id = next(
            item.direction_id
            for item in directions.directions
            if item.direction_id not in proposed_ids
        )
        return replace(
            call,
            value=CreativeDirectionDiversityAuditResponse(
                groups=[
                    CreativeDirectionOverlapGroup(
                        group_id="SUPPLEMENT_OVERLAP",
                        direction_ids=[retained_id, proposed_ids[0]],
                        repeated_visual_core="补充方向仍与既有方向形成相同画面关系",
                        revision_direction_ids=[proposed_ids[0]],
                        diversification_goal="改变主要场景、产品动作或镜头构成",
                    )
                ],
                requires_revision=True,
                revision_direction_ids=[proposed_ids[0]],
                summary="补充方向未形成实质视觉差异",
            ),
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


class RegenerationContextCapturingProvider(MockAiProvider):
    def __init__(self) -> None:
        self.regeneration_contexts: list[dict[str, Any] | None] = []

    async def generate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        self.regeneration_contexts.append(kwargs.get("regeneration_context"))
        return await super().generate_creatives(*args, **kwargs)


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
            and "正在规划" in stage.summary
            and "创意方向" in stage.summary
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
        self.batch_sizes: list[int] = []
        self.single_calls = 0

    async def evaluate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        candidates = args[0]
        if len(candidates) > 1:
            self.batch_calls += 1
            self.batch_sizes.append(len(candidates))
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


class TruncatedCreativeBatchProvider(MockAiProvider):
    def __init__(self) -> None:
        self.batch_sizes: list[int] = []

    async def generate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        shard = args[0]
        self.batch_sizes.append(len(shard.tasks))
        if len(shard.tasks) > 2:
            raise ProviderError(
                "test creative output truncated",
                retryable=False,
                error_type=ProviderErrorType.OUTPUT_TRUNCATED,
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
        not (binding.field.value == "PRODUCT_NAME" and binding.role.value == "CONTEXT")
        for item in api.result.items
        for binding in item.insight_bindings
    )
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CREATIVE": 4,
        "CLASSIFICATION": 4,
    }

    creative_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
    ]
    assert len(creative_tasks) == 14
    assert (
        sum(task.supplement_kind == "INITIAL" for task in creative_tasks) == 14
    )
    assert all(task.supplement_kind == "INITIAL" for task in creative_tasks)
    assert all(task.fact_assignment is not None for task in creative_tasks)
    assert all(
        1 <= len(task.fact_assignment.fact_ids) <= 4
        for task in creative_tasks
        if task.fact_assignment is not None
    )
    assert all(
        not fact_id.startswith("CORE_SELLING_POINT:")
        for task in creative_tasks
        if task.fact_assignment is not None
        for fact_id in task.fact_assignment.fact_ids
    )
    assert (
        len(
            {
                fact_id
                for task in creative_tasks
                if task.fact_assignment is not None
                for fact_id in task.fact_assignment.fact_ids
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
    assert "无口播广告素材" in shared_stage.metadata["compiledContent"]
    assert "人物讲话" in shared_stage.metadata["compiledContent"]
    assert creative_stage.status == "SUCCEEDED"
    assert creative_stage.metadata["candidateCount"] == 14
    assert (
        creative_stage.metadata["factSelectionMode"]
        == "DIRECTION_FACT_APPLICATIONS"
    )
    assert classification_stage.status == "SUCCEEDED"
    assert classification_stage.metadata["evaluatedCount"] == 14
    assert classification_stage.metadata["averageScores"]["productRelevance"] >= 0
    semantic_audit = result_stage.metadata["semanticAudit"]
    assert semantic_audit["schemaVersion"] == 1
    assert semantic_audit["similarityThreshold"] == 0.82
    assert len(semantic_audit["evaluatedItems"]) == 10
    assert len(semantic_audit["contentFingerprint"]) == 64


def test_paid_diversity_supplement_only_starts_above_thirty_percent() -> None:
    assert _maximum_diversity_supplement_duplicates(100) == 30
    assert _maximum_diversity_supplement_duplicates(50) == 15


@pytest.mark.asyncio
async def test_truncated_multi_candidate_shard_splits_without_failing_the_run() -> None:
    api = PromptApi()
    provider = TruncatedCreativeBatchProvider()
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

    assert api.result is not None
    assert len(api.result.items) == 10
    assert 4 in provider.batch_sizes
    assert provider.batch_sizes.count(2) >= 6


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

    assert provider.invalid_calls == 10
    assert api.result is not None
    assert len(api.result.items) == 10
    failed_source_shard = api.shards["CREATIVE:0:0"]
    assert failed_source_shard.status.value == "SUCCEEDED"
    assert failed_source_shard.creative_items == []
    assert failed_source_shard.warnings


@pytest.mark.asyncio
async def test_visual_strategy_graph_compiles_direction_fact_plan_before_generation() -> None:
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
        == "DIRECTION_FACT_APPLICATIONS"
    )
    assignments = [
        task.fact_assignment
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
        if task.fact_assignment is not None
    ]
    assert assignments
    assert all(1 <= len(assignment.fact_ids) <= 4 for assignment in assignments)


def test_silent_material_projection_removes_deferred_compatible_fact_references() -> None:
    application = map_insight(
        {
            "productName": "紫苏梅子酱",
            "productCategory": "复合调味酱",
            "coreSellingPoints": ["酸甜咸鲜复合口感", "传统配方工艺"],
        }
    )
    facts = {fact.value: fact for fact in application.usable}
    visible = facts["酸甜咸鲜复合口感"]
    deferred = facts["传统配方工艺"]
    policies = []
    for fact in application.usable:
        usage = FactVisualUsage.IDENTITY_ANCHOR
        compatible_fact_ids: list[str] = []
        if fact.fact_id == visible.fact_id:
            usage = FactVisualUsage.DIRECTLY_VISIBLE
            compatible_fact_ids = [deferred.fact_id]
        elif fact.fact_id == deferred.fact_id:
            usage = FactVisualUsage.FORBIDDEN_VISUAL_PROOF
        policies.append(
            FactVisualPolicyDraft(
                fact_id=fact.fact_id,
                visual_usage=usage,
                compatible_fact_ids=compatible_fact_ids,
            )
        )
    strategy = FactVisualStrategy(
        source_content_hash="source",
        template_hash="a" * 64,
        strategy_hash="b" * 64,
        policies=policies,
    )

    projected_application, projected_strategy = _silent_material_planning_inputs(
        application,
        strategy,
    )

    assert deferred.fact_id not in projected_application.by_id
    assert deferred.fact_id not in projected_strategy.by_id
    assert all(
        deferred.fact_id not in policy.compatible_fact_ids
        for policy in projected_strategy.policies
    )


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
    summaries = [
        stage.summary
        for stage in api.stages
        if stage.node_id.value == "COHERENT_CREATIVE_GENERATION"
    ]
    assert any("产品专属创意空间" in summary for summary in summaries)
    assert any("正在复核" in summary and "产品创意空间" in summary for summary in summaries)
    assert any("创意方向已形成" in summary for summary in summaries)
    assert any("正在生成候选 Prompt" in summary for summary in summaries)


@pytest.mark.asyncio
async def test_retries_one_invalid_classification_response_inside_its_shard() -> None:
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

    assert provider.calls == 6
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

    assert provider.batch_calls == 10
    assert 4 in provider.batch_sizes
    assert 2 in provider.batch_sizes
    assert provider.single_calls == 14
    assert api.result is not None
    assert api.result.metrics.generated_candidate_count == 14
    classification_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "CREATIVE_EVALUATION_CLASSIFICATION"
    )
    assert classification_stage.metadata["evaluationCallCount"] == 24
    assert classification_stage.metadata["splitRecoveryCount"] == 10


def test_planned_business_facts_are_evaluated_without_product_snapshot_competing() -> None:
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
        fact_evidence=[
            {
                "factId": primary_fact.fact_id,
                "evidenceText": "单手打开便携杯",
                "evidenceSource": "PRODUCT_RELATION",
            }
        ],
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
            fact_ids=[primary_fact.fact_id],
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
            FactEvidence(
                fact_id=primary_fact.fact_id,
                evidence_text="单手打开便携杯",
                evidence_source="PRODUCT_RELATION",
                support_level="SEMANTIC_FULL",
            )
        ],
        realized_fact_ids=[primary_fact.fact_id],
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

    assert primary_fact.fact_id in contextual_ids
    assert product_fact.fact_id in contextual_ids
    assert validated.realized_fact_ids == [primary_fact.fact_id]
    assert "SECONDARY_FACT_NOT_USED" not in validated.warnings


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
    assert {shard.shard_index for shard in classification_shards} == {0, 1, 2, 3}
    assert all(shard.status == "SUCCEEDED" for shard in classification_shards)
    assert sum(len(shard.evaluations) for shard in classification_shards) == 14
    assert api.result is not None
    assert api.result.metrics.generated_candidate_count == 14


@pytest.mark.asyncio
async def test_vector_selection_keeps_exact_count_and_reports_safe_metrics() -> None:
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
    assert selection_stage.metadata["embeddingRequestCount"] == 2
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
    assert selection_stage.metadata["selectionMethod"] == "VECTOR_SHADOW"
    assert (
        10
        <= selection_stage.metadata["embeddingInputCount"]
        <= (api.result.metrics.generated_candidate_count)
    )
    assert selection_stage.metadata["embeddingRequestCount"] == 2
    expected_quality_weight = _adaptive_mmr_quality_weight(
        selection_stage.metadata["candidatePoolContentRedundancyRate"]
    )
    assert selection_stage.metadata["mmrQualityWeight"] == expected_quality_weight
    assert selection_stage.metadata["adaptiveMmrBasis"] == (
        "CONTENT_VECTOR_REDUNDANCY"
    )
    assert selection_stage.metadata["mmrDiversityWeight"] == round(
        1.0 - expected_quality_weight,
        2,
    )
    assert "semanticGroupFirst" not in selection_stage.metadata
    assert selection_stage.metadata["contentMmrSelection"]["selectedCount"] == 10
    assert "dualVectorSelection" not in selection_stage.metadata


@pytest.mark.asyncio
async def test_content_mmr_runs_one_soft_diversity_supplement() -> None:
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
    assert api.result.metrics.generated_candidate_count == 16
    # Structurally identical visible stories share one embedding document even
    # when they came from different compiler-formatted Prompt candidates.
    assert 0 < embedding_provider.input_count <= 16
    final_selection_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert final_selection_stage.metadata["diversitySupplementAttempted"] is True
    assert final_selection_stage.metadata["diversitySupplementTriggered"] is True
    assert final_selection_stage.metadata["diversitySupplementCount"] == 2
    assert final_selection_stage.metadata["embeddingInputCount"] == (
        embedding_provider.input_count
    )
    assert final_selection_stage.metadata["embeddingRequestCount"] == 2
    assert final_selection_stage.metadata["mmrQualityWeight"] == 0.60
    assert final_selection_stage.metadata["mmrDiversityWeight"] == 0.40
    assert final_selection_stage.metadata["adaptiveMmrApplied"] is True
    assert final_selection_stage.metadata["adaptiveMmrTier"] == "HIGH"
    assert final_selection_stage.metadata["diversitySupplementDirectionCount"] == 2
    assert final_selection_stage.metadata["diversitySupplementImproved"] is False
    assert final_selection_stage.metadata["finalAccurateCount"] == 10
    assert final_selection_stage.warnings == [
        "SEMANTIC_DIVERSITY_CAN_BE_IMPROVED",
        "DIVERSITY_SUPPLEMENT_NO_IMPROVEMENT",
    ]
    diversity_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
        if task.supplement_kind == "DIVERSITY"
    ]
    assert len(diversity_tasks) == 2
    assert {task.round for task in diversity_tasks} == {1}
    assert {
        task.creative_direction.direction_id
        for task in diversity_tasks
        if task.creative_direction is not None
    } == {"DIVERSITY_SUPPLEMENT_1", "DIVERSITY_SUPPLEMENT_2"}
    assert all(task.sibling_variant_total == 1 for task in diversity_tasks)

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
    assert restored_cache.diversity_supplement_attempted is True
    assert restored_cache.diversity_supplemented is True
    assert restored_cache.diversity_supplement_count == 2
    assert restored_cache.replenishment_rounds == 0


@pytest.mark.asyncio
async def test_rejected_diversity_directions_are_not_reported_as_generated() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=RejectingDiversitySupplementProvider(),
        embedding_provider=IdenticalEmbeddingProvider(),
        similarity_mode="vector",
        embedding_batch_size=64,
        embedding_max_concurrency=2,
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _snapshot().model_copy(update={"similarity_anchors": []})
    pipeline.register_snapshot(runtime, snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert len(api.result.items) == 10
    assert api.result.metrics.generated_candidate_count == 14
    final_selection_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert final_selection_stage.metadata["diversitySupplementAttempted"] is True
    assert final_selection_stage.metadata["diversitySupplementTriggered"] is False
    assert final_selection_stage.metadata["diversitySupplementCount"] == 0
    assert final_selection_stage.metadata["diversitySupplementDirectionCount"] == 0
    assert final_selection_stage.warnings == [
        "SEMANTIC_DIVERSITY_CAN_BE_IMPROVED",
        "DIVERSITY_SUPPLEMENT_NOT_GENERATED",
    ]


@pytest.mark.asyncio
async def test_shadow_selection_reports_comparison_without_changing_result() -> None:
    baseline_api = PromptApi()
    shadow_api = PromptApi()
    baseline = PromptGenerationPipeline(
        api=baseline_api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="shadow",
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
    assert selection_stage.metadata["selectionMethod"] == "VECTOR_SHADOW"
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
async def test_item_evaluate_preserves_user_authored_content_and_structure() -> (
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
    assert api.result.items[0].dimensions == target.dimensions
    assert api.result.items[0].classification_status == "VERIFIED"
    assert api.result.items[0].review_issues == []
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CLASSIFICATION": 1
    }
    assert not any(
        stage.node_id.value == "COHERENT_CREATIVE_GENERATION" for stage in api.stages
    )
    assert any(stage.node_id.value == "ITEM_EVALUATE" for stage in api.stages)
    assert not any(
        stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
        for stage in api.stages
    )
    result_stage = next(
        stage for stage in reversed(api.stages) if stage.node_id.value == "RESULT_SAVE"
    )
    assert (
        result_stage.metadata["semanticAudit"]["evaluatedItems"][0]["itemId"]
        == target.id
    )


def test_item_evaluation_receives_all_confirmed_facts() -> None:
    application = map_insight(
        {
            "productName": "广式腊肠",
            "coreSellingPoints": [f"已确认卖点 {index}" for index in range(1, 18)],
        }
    )
    candidate = CreativeCandidate(
        slot_id="manual-prompt-all-facts",
        ordinal=1,
        round=0,
        creative_core="等待 AI 分析",
        declared_fact_ids=[application.usable[0].fact_id],
        dimensions=CreativeDimensions(
            narrative="等待 AI 分析",
            scene="等待 AI 分析",
            persona="等待 AI 分析",
            product_relation="等待 AI 分析",
            camera="等待 AI 分析",
            emotion="等待 AI 分析",
        ),
        content="家庭厨房中，一双手把广式腊肠放入蒸锅，固定近景停在锅盖合上的瞬间。",
    )

    context_ids = _evaluation_context_fact_ids(
        candidate,
        None,
        application,
        item_evaluation=True,
    )

    assert context_ids == [fact.fact_id for fact in application.usable]
    assert len(context_ids) > 12


@pytest.mark.asyncio
async def test_item_autofill_does_not_override_user_content_or_fragment_type() -> None:
    snapshot = _snapshot()
    now = "2026-09-03T10:00:00Z"
    target = PromptItem(
        id="manual-prompt-hard-issue",
        code="P011",
        origin="MANUAL",
        fragment_type=FragmentType.PRODUCT_DISPLAY,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        classification_status="PENDING",
        product_relevance=0,
        target_duration_seconds=5,
        creative_core="等待 AI 分析",
        dimensions=CreativeDimensions(
            narrative="等待 AI 分析",
            scene="等待 AI 分析",
            persona="等待 AI 分析",
            product_relation="等待 AI 分析",
            camera="等待 AI 分析",
            emotion="等待 AI 分析",
        ),
        content="门店展示台上，一双手把资料中没有确认的获奖礼盒包装转向镜头并停住。",
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
            "target_item_index": 0,
        }
    )
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=AlwaysRejectingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, item_snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert api.result.items[0].content == target.content
    assert api.result.items[0].creative_core != PENDING_CREATIVE_STRUCTURE_TEXT
    assert (
        api.result.items[0].dimensions.narrative
        != PENDING_CREATIVE_STRUCTURE_TEXT
    )
    assert api.result.items[0].primary_purpose == target.primary_purpose
    assert api.result.items[0].classification_status == "VERIFIED"
    assert api.result.items[0].review_issues == []
    assert api.result.quality_status == "PASS"
    evaluation_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "ITEM_EVALUATE"
    )
    assert evaluation_stage.metadata["classificationStatus"] == "VERIFIED"


@pytest.mark.asyncio
async def test_item_regenerate_rebuilds_full_creative_with_requested_duration() -> None:
    snapshot = _snapshot()
    now = "2026-09-03T10:00:00Z"
    target = PromptItem(
        id="prompt-to-regenerate",
        code="P021",
        origin="AI",
        fragment_type=FragmentType.PRODUCT_DISPLAY,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        classification_status="VERIFIED",
        product_relevance=90,
        target_duration_seconds=15,
        creative_core="家庭餐桌上展示产品",
        dimensions=CreativeDimensions(
            narrative="场景代入",
            scene="家庭餐桌",
            persona="成年家庭成员",
            product_relation="家庭用餐搭配",
            camera="中近景跟随",
            emotion="温暖自然",
        ),
        content="家庭餐桌上，成年人把广式腊肠端到桌面中央，镜头跟随盘子停稳。",
        insight_bindings=[],
        manual_edited=False,
        created_at=now,
        updated_at=now,
    )
    item_snapshot = snapshot.model_copy(
        update={
            "operation": "ITEM_REGENERATE",
            "target_item_id": target.id,
            "target_item": target,
            "target_item_index": 0,
            "regeneration_mode": "FULL_REGENERATE",
            "regeneration_target_duration_seconds": 12,
            "regeneration_reasons": ["SCENE_UNSUITABLE"],
            "regeneration_instruction": "只保留一个连续动作",
            "similarity_anchors": [],
        }
    )
    api = PromptApi()
    provider = RegenerationContextCapturingProvider()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, item_snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    creative_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
    ]
    assert len(creative_tasks) == 3
    assert all(task.regeneration_variant_role is None for task in creative_tasks)
    assert all(task.target_duration_seconds == 12 for task in creative_tasks)
    assert all(task.fact_assignment.fact_ids for task in creative_tasks)
    expected_context = {
        "instruction": "只保留一个连续动作",
        "mode": "FULL_REGENERATE",
        "reasons": ["SCENE_UNSUITABLE"],
    }
    assert provider.regeneration_contexts
    assert all(context == expected_context for context in provider.regeneration_contexts)
    assert api.result is not None
    assert len(api.result.items) == 3
    assert all(item.target_duration_seconds == 12 for item in api.result.items)
    assert all(item.creative_core.strip() for item in api.result.items)
    assert all(item.insight_bindings for item in api.result.items)
    assert all(
        all(value.strip() for value in item.dimensions.model_dump().values())
        for item in api.result.items
    )


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
        "CLASSIFICATION": 4,
    }
    selection_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert selection_stage.metadata["initialCandidateCount"] == 14
    assert selection_stage.metadata["cumulativeCandidateCount"] == 14
    assert selection_stage.metadata["safeCandidateCount"] == 11
    assert selection_stage.metadata["selectedCandidateCount"] == 10
    assert selection_stage.metadata["quantitySupplementTriggered"] is False
    assert selection_stage.metadata["coverageSupplementTriggered"] is False


@pytest.mark.asyncio
async def test_unresolved_fact_coverage_supplements_once_then_keeps_exact_draft() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MissingPainCoverageProvider(),
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
    assert len(api.result.items) == 10
    assert api.result.quality_status == "NEEDS_REVIEW"
    assert api.result.metrics.generated_candidate_count >= 16
    assert api.result.metrics.replenishment_rounds == 1
    creative_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
    ]
    coverage_tasks = [
        task for task in creative_tasks if task.supplement_kind == "COVERAGE"
    ]
    assert len(coverage_tasks) == 2
    assert {task.round for task in coverage_tasks} == {1}
    selection_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert selection_stage.status.value == "SUCCEEDED"
    assert selection_stage.metadata["coverageSupplementTriggered"] is True
    assert selection_stage.metadata["coverageSupplementCount"] == 2
    assert selection_stage.metadata["coverageNeedsReview"] is True
    assert selection_stage.metadata["initialCandidateCount"] == 14
    assert selection_stage.metadata["cumulativeCandidateCount"] >= 16
    assert "REQUIRED_FACT_COVERAGE_NEEDS_REVIEW" in selection_stage.warnings
    result_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "RESULT_SAVE"
    )
    assert (
        result_stage.metadata["requiredFactCount"]
        == selection_stage.metadata["missingRequiredFactCount"]
        + result_stage.metadata["coveredRequiredFactCount"]
    )
    assert (
        result_stage.metadata["missingRequiredFactCount"]
        == selection_stage.metadata["missingRequiredFactCount"]
    )

    resumed = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MissingPainCoverageProvider(),
        embedding_provider=DistinctEmbeddingProvider(),
        shard_size=5,
    )
    resumed.register_snapshot(runtime, _snapshot())
    await resumed.load_and_snapshot(runtime)
    resumed_cache = resumed._cache(runtime)
    assert resumed_cache.coverage_supplemented is True
    assert resumed_cache.coverage_supplement_count == 2
    assert resumed_cache.quantity_supplemented is False
    assert resumed_cache.replenishment_rounds == 1


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
        "CLASSIFICATION": 5,
    }
    supplement_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
        if task.round > 0
    ]
    assert {task.supplement_kind for task in supplement_tasks} == {"QUANTITY"}
    assert {task.round for task in supplement_tasks} == {1}


@pytest.mark.asyncio
async def test_stops_after_one_quantity_supplement_when_safety_issues_remain() -> None:
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
    creative_rounds = {
        task.round
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
    }
    assert creative_rounds == {0, 1}


def test_worker_does_not_require_literal_overlap_for_semantic_evidence() -> None:
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

    assert validated.hard_issues == []
    assert validated.warnings == []
    assert validated.realized_fact_ids == [fact.fact_id]


def test_worker_preserves_ai_speech_dependency_issue_without_semantic_recheck() -> None:
    application = map_insight({"productName": "便携杯"})
    product_fact = next(
        fact for fact in application.usable if fact.field == InsightField.PRODUCT_NAME
    )
    candidate = CreativeCandidate(
        slot_id="candidate-speech-dependent",
        ordinal=1,
        round=0,
        creative_core="人物对镜讲解便携杯",
        declared_fact_ids=[product_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="人物讲解",
            scene="通勤休息区",
            persona="成年通勤者",
            product_relation="手持便携杯",
            camera="中近景固定",
            emotion="自然",
        ),
        content="通勤休息区内，成年通勤者手持便携杯面对镜头连续讲话，商品价值完全依赖人物说明。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[FactEvidence(fact_id=product_fact.fact_id)],
        realized_fact_ids=[product_fact.fact_id],
        scores=CreativeScores(
            product_relevance=80,
            creative_coherence=75,
            visual_executability=80,
            commercial_usefulness=60,
            visual_clarity=80,
        ),
        semantic_signature="由评估模型生成",
        visual_signature="由评估模型生成",
        hard_issues=["SPEECH_DEPENDENT_MATERIAL"],
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert validated.hard_issues == ["SPEECH_DEPENDENT_MATERIAL"]


def _abstract_visual_proof_case() -> tuple[
    InsightApplicationMap,
    CreativeCandidate,
    CreativeEvaluation,
    str,
]:
    application = map_insight(
        {
            "productName": "谷物营养棒",
            "coreSellingPoints": ["低糖配方"],
        }
    )
    product_fact = next(
        item for item in application.usable if item.value == "谷物营养棒"
    )
    formula_fact = next(item for item in application.usable if item.value == "低糖配方")
    proof_text = "镜头放大谷物颗粒，并以颗粒状态证明产品采用低糖配方"
    candidate = CreativeCandidate(
        slot_id="candidate-visual-proof",
        ordinal=1,
        round=0,
        creative_core="用谷物颗粒直接证明低糖配方",
        declared_fact_ids=[product_fact.fact_id, formula_fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="产品证明",
            scene="明亮餐桌",
            persona="成年消费者",
            product_relation="展示谷物营养棒并证明低糖配方",
            camera="微距推进",
            emotion="理性可信",
        ),
        content=f"明亮餐桌上摆放谷物营养棒，{proof_text}。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.EFFECT,
        compatible_purposes=[FragmentType.EFFECT],
        fact_evidence=[
            FactEvidence(
                fact_id=product_fact.fact_id,
                evidence_text="谷物营养棒",
            )
        ],
        realized_fact_ids=[product_fact.fact_id],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=80,
            commercial_usefulness=80,
            visual_clarity=90,
        ),
        semantic_signature="谷物颗粒证明低糖",
        visual_signature="餐桌微距谷物棒",
        hard_issues=["ABSTRACT_FACT_VISUAL_PROOF"],
    )
    return application, candidate, evaluation, formula_fact.fact_id


def test_abstract_visual_proof_requires_model_owned_fact_and_text_evidence() -> None:
    application, candidate, evaluation, formula_fact_id = _abstract_visual_proof_case()
    proof_text = "镜头放大谷物颗粒，并以颗粒状态证明产品采用低糖配方"
    evaluation = evaluation.model_copy(
        update={
            "abstract_visual_proof_findings": [
                AbstractVisualProofFinding(
                    fact_id=formula_fact_id,
                    evidence_text=proof_text,
                    evidence_source="CONTENT",
                    violated_policy="FORBIDDEN_VISUAL_PROOF",
                )
            ]
        }
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert "ABSTRACT_FACT_VISUAL_PROOF" in validated.hard_issues
    assert len(validated.abstract_visual_proof_findings) == 1


def test_unverified_abstract_visual_proof_is_only_a_warning() -> None:
    application, candidate, evaluation, _ = _abstract_visual_proof_case()

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert "ABSTRACT_FACT_VISUAL_PROOF" not in validated.hard_issues
    assert "ABSTRACT_FACT_VISUAL_PROOF_REPORT_INVALID" in validated.warnings


def test_worker_trusts_ai_abstract_visual_proof_without_literal_matching() -> None:
    application, candidate, evaluation, formula_fact_id = _abstract_visual_proof_case()
    evaluation = evaluation.model_copy(
        update={
            "abstract_visual_proof_findings": [
                AbstractVisualProofFinding(
                    fact_id=formula_fact_id,
                    evidence_text="正文中不存在的证明句",
                    evidence_source="CONTENT",
                    violated_policy="FORBIDDEN_VISUAL_PROOF",
                )
            ]
        }
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert "ABSTRACT_FACT_VISUAL_PROOF" in validated.hard_issues
    assert validated.warnings == []


def test_assigned_business_context_accepts_real_semantic_evidence() -> None:
    application = map_insight(
        {
            "productName": "广式腊肠",
            "purchaseScenarios": ["年货送礼"],
        }
    )
    product_fact = next(item for item in application.usable if item.value == "广式腊肠")
    gift_fact = next(item for item in application.usable if item.value == "年货送礼")
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


def test_selling_point_binding_accepts_full_semantic_support_without_character_overlap() -> (
    None
):
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
        primary_purpose=FragmentType.EFFECT,
        compatible_purposes=[FragmentType.EFFECT],
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
    assert validated.warnings == ["DIMENSION_CONTENT_CONFLICT"]


def test_worker_does_not_reinterpret_ai_context_fact_semantics() -> None:
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

    assert validated.realized_fact_ids == [
        product_fact.fact_id,
        selling_fact.fact_id,
    ]
    assert validated.warnings == []


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
    assert (
        sum(
            "MISSING_DEEP_BUSINESS_FACT" in item.evaluation.warnings
            for item in result.selected
        )
        == 45
    )


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

    validated = validate_creative_evaluation(candidate, evaluation, application)
    assert validated.hard_issues == []
    assert validated.warnings == []


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


def test_worker_downgrades_unknown_ai_issue_without_rechecking_evidence_text() -> None:
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
        hard_issues=["MODEL_UNKNOWN_ISSUE"],
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert validated.hard_issues == []
    assert validated.warnings == ["MODEL_UNKNOWN_ISSUE"]
    assert validated.realized_fact_ids == [
        product_fact.fact_id,
        selling_fact.fact_id,
    ]


def test_worker_uses_ai_support_level_instead_of_excerpt_character_matching() -> None:
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
            hard_issues=["MODEL_UNKNOWN_ISSUE"],
        )
        candidates.append(candidate)
        evaluations.append(
            validate_creative_evaluation(candidate, raw_evaluation, application)
        )

    result = select_creatives(candidates, evaluations, target_count=50)

    assert len(result.selected) == 50
    assert all(
        item.hard_issues == []
        and item.warnings == ["MODEL_UNKNOWN_ISSUE"]
        and selling_fact.fact_id in item.realized_fact_ids
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
