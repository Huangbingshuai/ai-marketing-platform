from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import re
import unicodedata
import uuid
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from itertools import combinations
from typing import Any, Literal, cast

from pydantic import ValidationError

from .api_client import InternalApi, InternalApiError
from .insight_mapping import (
    insight_coverage,
    mandatory_business_facts,
    map_insight,
)
from .embeddings import (
    ContentVectorIndex,
    CreativeVectorIndex,
    EmbeddingProvider,
    EmbeddingProviderError,
    MockEmbeddingProvider,
    RedundancySummary,
    VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD,
    build_content_vector_index,
    build_creative_vector_index,
)
from .models import (
    ClassificationShardPlan,
    CountMetric,
    CreativeAverageScores,
    CreativeCandidate,
    CreativeDirection,
    CreativeDirectionPlan,
    CreativeDirectionAuditResponse,
    CreativeDirectionDiversityAudit,
    CreativeDirectionResponse,
    CreativeDiversityLandscapeResponse,
    CreativeLandscapeAuditResponse,
    CreativeTerritoryDraft,
    CreativeDimensions,
    CreativeEvaluation,
    CreativeScores,
    CreativeShardPlan,
    CreativeTask,
    FailurePayload,
    FragmentType,
    FactVisualStrategy,
    FactVisualStrategyResponse,
    InsightApplicationMap,
    InsightBinding,
    InsightField,
    NodeId,
    ProgressPayload,
    PromptBatchResult,
    PromptBatchSettings,
    PromptGenerationSnapshot,
    PromptItem,
    PromptMetrics,
    PurposeDistribution,
    RenderProfile,
    RuntimeContext,
    SemanticEvaluation,
    SharedPrompt,
    SharedPromptSection,
    ShardPhase,
    ShardRecord,
    SharedRenderConstraints,
    StageOutput,
    StageStatus,
    StrategyCheckpoint,
    utc_now,
)
from .providers import (
    AiProvider,
    ProviderError,
    ProviderErrorType,
    FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
    CREATIVE_DIRECTION_TEMPLATE_HASH,
)
from .creative_directions import (
    apply_creative_landscape_audit,
    allocate_creative_directions,
    complete_semantic_profile,
    compile_creative_landscape_assignments,
    creative_direction_audit_revision_context,
    creative_fact_assignment_revision_context,
    creative_landscape_audit_revision_context,
    merge_creative_direction_revision,
    creative_direction_revision_context,
    creative_direction_target_count,
    creative_direction_source_hash,
    dominant_families,
    extend_creative_direction_plan,
    max_cluster_share,
    semantic_cluster_novelty,
    semantic_profile_distribution,
    validate_creative_direction_diversity_audit,
    validate_creative_direction_audit,
    validate_creative_landscape_audit,
    validate_creative_diversity_landscape,
    validate_creative_direction_plan,
    validate_diversity_supplement_directions,
    validate_semantic_profile,
)
from .fact_allocation import (
    allocate_automatic_regeneration_facts,
    allocate_creative_facts,
    allocate_regeneration_facts,
    assignment_for_direction,
)
from .visual_strategy import (
    strategy_stage_metadata,
    validate_fact_visual_strategy,
)
from .quality import (
    CreativeSelectionResult,
    RankedCreative,
    normalize_creative_signature,
    select_creatives,
    validate_creative_evaluation,
)

# Quantity recovery and business-fact recovery are separate concerns. Each may
# run once; repeatedly chasing an evaluator's unresolved fact finding only
# amplifies model variance and cost.
MAX_REPLENISHMENT_ROUNDS = 2
COVERAGE_SUPPLEMENT_RATIO = 0.20
SEMANTIC_DUPLICATE_RATE_LIMIT = 15.0
# Keep ordinary calls economical. If a three-item strict response is malformed
# or truncated, the pipeline automatically isolates that shard into single-item
# calls instead of failing the entire batch.
CLASSIFICATION_SHARD_SIZE = 3
MAX_PROCESS_EMBEDDING_CACHE_ENTRIES = 4_096
LOGGER = logging.getLogger(__name__)


class PipelineError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class LoadedRun:
    snapshot: PromptGenerationSnapshot
    completed_creative_shard_keys: list[str] = field(default_factory=list)
    completed_classification_shard_keys: list[str] = field(default_factory=list)


@dataclass(slots=True)
class RunCache:
    ai_call_count: int = 0
    total_shards: int = 0
    insight_application: InsightApplicationMap | None = None
    fact_visual_strategy: FactVisualStrategy | None = None
    shared_prompt: SharedPrompt | None = None
    creative_direction_plan: CreativeDirectionPlan | None = None
    strategy_checkpoints: dict[NodeId, StrategyCheckpoint] = field(default_factory=dict)
    creatives: dict[str, CreativeCandidate] = field(default_factory=dict)
    creative_tasks: dict[str, CreativeTask] = field(default_factory=dict)
    creative_target_durations: dict[str, int] = field(default_factory=dict)
    creative_evaluations: dict[str, CreativeEvaluation] = field(default_factory=dict)
    completed_creative_shard_keys: set[str] = field(default_factory=set)
    completed_classification_shard_keys: set[str] = field(default_factory=set)
    selected_creatives: CreativeSelectionResult | None = None
    accepted_items: list[PromptItem] = field(default_factory=list)
    candidate_target_count: int = 0
    exact_duplicate_count: int = 0
    supplemented: bool = False
    replenishment_rounds: int = 0
    quantity_supplemented: bool = False
    quantity_supplement_count: int = 0
    coverage_supplemented: bool = False
    coverage_supplement_count: int = 0
    diversity_supplemented: bool = False
    diversity_supplement_count: int = 0
    diversity_supplement_slot_ids: set[str] = field(default_factory=set)
    diversity_avoid_slot_ids: set[str] = field(default_factory=set)
    diversity_avoid_action_families: set[str] = field(default_factory=set)
    diversity_avoid_scene_families: set[str] = field(default_factory=set)
    diversity_supplement_reasons: list[str] = field(default_factory=list)
    diversity_supplement_attempted: bool = False
    diversity_supplement_direction_count: int = 0
    diversity_supplement_improved: bool | None = None
    initial_redundancy_summary: RedundancySummary | None = None
    redundancy_summary: RedundancySummary | None = None
    content_vector_index: ContentVectorIndex | None = None
    embedding_vectors: dict[str, tuple[float, ...]] = field(default_factory=dict)
    embedding_remote_input_count: int = 0
    embedding_request_count: int = 0
    embedding_input_tokens: int = 0
    embedding_retry_count: int = 0
    embedding_duration_ms: float = 0.0
    embedding_local_comparison_ms: float = 0.0
    embedding_stage_metadata: dict[str, Any] = field(default_factory=dict)
    embedding_warning: str | None = None


class PromptGenerationPipeline:
    def __init__(
        self,
        *,
        api: InternalApi,
        provider: AiProvider,
        embedding_provider: EmbeddingProvider | None = None,
        similarity_mode: Literal["shadow", "vector"] = "vector",
        embedding_batch_size: int = 64,
        embedding_max_concurrency: int = 2,
        ai_max_concurrency: int = 6,
        shard_size: int = 8,
        max_ai_calls_per_run: int = 256,
    ) -> None:
        self.api = api
        self.provider = provider
        self.embedding_provider = (
            embedding_provider
            if embedding_provider is not None
            else MockEmbeddingProvider()
            if provider.execution_mode == "MOCK" and similarity_mode == "vector"
            else None
        )
        self.similarity_mode = similarity_mode
        self.embedding_batch_size = embedding_batch_size
        self.embedding_max_concurrency = embedding_max_concurrency
        self.ai_max_concurrency = max(1, ai_max_concurrency)
        self._ai_semaphore = asyncio.Semaphore(self.ai_max_concurrency)
        self.shard_size = shard_size
        self.max_ai_calls_per_run = max_ai_calls_per_run
        self._snapshots: dict[str, PromptGenerationSnapshot] = {}
        self._runs: dict[str, RunCache] = {}
        # The worker process is long lived. Sharing the content-addressed vector cache
        # lets item evaluation reuse unchanged batch vectors without persisting model
        # vectors in public results or database records.
        self._embedding_vectors: dict[str, tuple[float, ...]] = {}

    def register_snapshot(
        self,
        context: RuntimeContext,
        snapshot: PromptGenerationSnapshot,
        strategy_checkpoints: list[StrategyCheckpoint] | None = None,
    ) -> None:
        self._snapshots[context.run_id] = snapshot
        self._runs[context.run_id] = RunCache(
            strategy_checkpoints={
                item.node_id: item for item in strategy_checkpoints or []
            },
            embedding_vectors=self._embedding_vectors,
        )

    def unregister(self, context: RuntimeContext) -> None:
        self._snapshots.pop(context.run_id, None)
        self._runs.pop(context.run_id, None)

    def snapshot(self, context: RuntimeContext) -> PromptGenerationSnapshot:
        try:
            return self._snapshots[context.run_id]
        except KeyError as exc:
            raise PipelineError("run input snapshot is not registered") from exc

    def _cache(self, context: RuntimeContext) -> RunCache:
        try:
            return self._runs[context.run_id]
        except KeyError as exc:
            raise PipelineError("run cache is not registered") from exc

    async def load_and_snapshot(self, context: RuntimeContext) -> LoadedRun:
        await self._stage(
            context,
            NodeId.LOAD_AND_SNAPSHOT,
            StageStatus.RUNNING,
            "正在读取不可变输入快照",
        )
        snapshot = self.snapshot(context)
        shards = await self.api.get_shards(context)
        succeeded_creatives = [
            item
            for item in shards
            if item.status == StageStatus.SUCCEEDED
            and item.phase == ShardPhase.CREATIVE
        ]
        succeeded_classifications = [
            item
            for item in shards
            if item.status == StageStatus.SUCCEEDED
            and item.phase == ShardPhase.CLASSIFICATION
        ]
        cache = self._cache(context)
        cache.creatives = {
            item.slot_id: item
            for shard in succeeded_creatives
            for item in shard.creative_items
        }
        cache.creative_evaluations = {
            item.slot_id: item
            for shard in succeeded_classifications
            for item in shard.evaluations
        }
        cache.completed_creative_shard_keys = {item.key for item in succeeded_creatives}
        cache.completed_classification_shard_keys = {
            item.key for item in succeeded_classifications
        }
        restored_creative_tasks = [
            task for shard in succeeded_creatives for task in shard.creative_plan
        ]
        cache.creative_tasks = {task.slot_id: task for task in restored_creative_tasks}
        cache.creative_target_durations = {
            task.slot_id: task.target_duration_seconds
            for task in restored_creative_tasks
        }
        replenishment_tasks = [
            task
            for task in restored_creative_tasks
            if task.supplement_kind in {"QUANTITY", "COVERAGE"}
        ]
        quantity_tasks = [
            task
            for task in restored_creative_tasks
            if task.supplement_kind == "QUANTITY"
        ]
        coverage_tasks = [
            task
            for task in restored_creative_tasks
            if task.supplement_kind == "COVERAGE"
        ]
        diversity_tasks = [
            task
            for task in restored_creative_tasks
            if task.supplement_kind == "DIVERSITY"
        ]
        cache.replenishment_rounds = len({task.round for task in replenishment_tasks})
        cache.supplemented = cache.replenishment_rounds > 0
        cache.quantity_supplemented = bool(quantity_tasks)
        cache.quantity_supplement_count = len(quantity_tasks)
        cache.coverage_supplemented = bool(coverage_tasks)
        cache.coverage_supplement_count = len(coverage_tasks)
        cache.diversity_supplemented = bool(diversity_tasks)
        cache.diversity_supplement_count = len(diversity_tasks)
        cache.diversity_supplement_attempted = bool(diversity_tasks)
        loaded = LoadedRun(
            snapshot=snapshot,
            completed_creative_shard_keys=[item.key for item in succeeded_creatives],
            completed_classification_shard_keys=[
                item.key for item in succeeded_classifications
            ],
        )
        await self._stage(
            context,
            NodeId.LOAD_AND_SNAPSHOT,
            StageStatus.SUCCEEDED,
            "输入快照已锁定",
            metadata={
                "batchSize": snapshot.settings.target_count,
                "retainedCount": len(snapshot.retained_manual_items),
                "resumedCreativeShardCount": len(succeeded_creatives),
                "resumedClassificationShardCount": len(succeeded_classifications),
                "snapshotSummary": _short(
                    " / ".join(
                        filter(
                            None,
                            [
                                _insight_text(
                                    snapshot.insight_artifact.result,
                                    "productName",
                                    "product_name",
                                )
                                or "该产品",
                                _insight_text(
                                    snapshot.insight_artifact.result,
                                    "productCategory",
                                    "product_category",
                                ),
                            ],
                        )
                    )
                ),
            },
        )
        await self.progress(context, 8, NodeId.LOAD_AND_SNAPSHOT)
        return loaded

    async def map_insight(self, context: RuntimeContext) -> InsightApplicationMap:
        await self._stage(
            context, NodeId.INSIGHT_MAPPING, StageStatus.RUNNING, "正在映射提炼信息用途"
        )
        application = map_insight(self.snapshot(context).insight_artifact.result)
        if not application.required:
            raise PipelineError("产品素材制作信息卡缺少可用于 Prompt 生成的核心事实")
        self._cache(context).insight_application = application
        await self._stage(
            context,
            NodeId.INSIGHT_MAPPING,
            StageStatus.SUCCEEDED,
            "提炼信息用途映射完成",
            metadata={
                "requiredCount": len(application.required),
                "adaptiveCount": len(application.adaptive),
                "excludedCount": len(application.excluded),
                "appliedConstraintCount": len(application.constraints),
                "requiredFacts": [
                    {"field": fact.field.value, "value": fact.value}
                    for fact in application.required
                ],
                "adaptiveFacts": [
                    {"field": fact.field.value, "value": fact.value}
                    for fact in application.adaptive
                ],
                "excludedFacts": [
                    {
                        "field": fact.field.value,
                        "value": fact.value,
                        "reason": fact.exclusion_reason,
                    }
                    for fact in application.excluded
                ],
                "appliedConstraints": [
                    {"field": fact.field.value, "value": fact.value}
                    for fact in application.constraints
                ],
            },
        )
        await self.progress(context, 11, NodeId.INSIGHT_MAPPING)
        return application

    async def compile_fact_visual_strategy(
        self,
        context: RuntimeContext,
    ) -> FactVisualStrategy:
        node = NodeId.FACT_VISUAL_STRATEGY_COMPILATION
        await self._stage(
            context,
            node,
            StageStatus.RUNNING,
            "正在编译事实视觉使用策略",
        )
        application = self._require_application(context)
        source_content_hash = self.snapshot(context).insight_artifact.content_hash
        checkpoint = self._cache(context).strategy_checkpoints.get(node)
        strategy: FactVisualStrategy | None = None
        reused = False
        if (
            checkpoint is not None
            and isinstance(checkpoint.plan, FactVisualStrategy)
            and checkpoint.source_fingerprint == source_content_hash
            and checkpoint.template_hash == FACT_VISUAL_STRATEGY_TEMPLATE_HASH
        ):
            try:
                restored = validate_fact_visual_strategy(
                    FactVisualStrategyResponse(policies=checkpoint.plan.policies),
                    application,
                    source_content_hash=source_content_hash,
                    template_hash=FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
                )
            except ValueError:
                restored = None
            if (
                restored is not None
                and restored.strategy_hash == checkpoint.allocation_hash
            ):
                strategy = restored
                reused = True

        call_metadata: dict[str, int | None] = {}
        if strategy is None:
            for invalid_response_attempt in range(2):
                self._reserve_ai_call(context)
                try:
                    async with self._ai_semaphore:
                        call = await self.provider.compile_fact_visual_strategy(
                            application
                        )
                except ProviderError as exc:
                    if (
                        invalid_response_attempt < 2
                        and exc.error_type == ProviderErrorType.RESPONSE_INVALID
                    ):
                        continue
                    raise
                try:
                    strategy = validate_fact_visual_strategy(
                        call.value,
                        application,
                        source_content_hash=source_content_hash,
                        template_hash=FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
                    )
                    break
                except ValueError as exc:
                    if invalid_response_attempt == 1:
                        raise ProviderError(
                            "AI 事实视觉使用策略结构或事实引用无效",
                            retryable=False,
                            error_type=ProviderErrorType.RESPONSE_INVALID,
                            attempts=2,
                        ) from exc
            if strategy is None:
                raise PipelineError("事实视觉使用策略未能形成有效结果")
            call_metadata = {
                "inputTokens": call.metadata.input_tokens,
                "outputTokens": call.metadata.output_tokens,
                "totalTokens": call.metadata.total_tokens,
                "latencyMs": call.metadata.latency_ms,
            }

        self._cache(context).fact_visual_strategy = strategy
        metadata = strategy_stage_metadata(strategy, application, reused=reused)
        metadata.update(call_metadata)
        await self._stage(
            context,
            node,
            StageStatus.SUCCEEDED,
            "事实视觉使用策略已复用" if reused else "事实视觉使用策略已编译",
            metadata=metadata,
        )
        await self.progress(context, 13, node)
        return strategy

    async def compile_shared_prompt(self, context: RuntimeContext) -> SharedPrompt:
        await self._stage(
            context,
            NodeId.SHARED_PROMPT_COMPILATION,
            StageStatus.RUNNING,
            "正在编译批次共用提示词",
        )
        disabled = _normalized_disabled_elements(
            _insight_list(
                self.snapshot(context).insight_artifact.result,
                "disabledElements",
                "disabled_elements",
            )
        )
        existing = self.snapshot(context).shared_prompt
        additional = _shared_prompt_section_content(existing, "USER_ADDITIONAL")
        prompt = _compile_shared_prompt(disabled, additional)
        self._cache(context).shared_prompt = prompt
        await self._stage(
            context,
            NodeId.SHARED_PROMPT_COMPILATION,
            StageStatus.SUCCEEDED,
            "批次共用提示词已编译",
            metadata={
                "disabledElementCount": len(disabled),
                "sectionCount": len(prompt.sections),
                "sharedPromptGenerated": bool(prompt.compiled_content),
                "hasUserAdditionalContent": bool(additional),
                "compiledContent": prompt.compiled_content,
                "sections": [
                    {
                        "title": section.title,
                        "source": section.source,
                        "content": section.content,
                    }
                    for section in prompt.sections
                ],
            },
        )
        await self.progress(context, 13, NodeId.SHARED_PROMPT_COMPILATION)
        return prompt

    async def _ensure_creative_direction_plan(
        self,
        context: RuntimeContext,
    ) -> CreativeDirectionPlan | None:
        snapshot = self.snapshot(context)
        if snapshot.operation != "BATCH_GENERATE":
            return None
        cache = self._cache(context)
        if cache.creative_direction_plan is not None:
            return cache.creative_direction_plan
        application = self._require_application(context)
        visual_strategy = self._required_fact_visual_strategy(context)
        shared_prompt = self._required_shared_prompt(context)
        mandatory_fact_count = len(mandatory_business_facts(application))
        try:
            expected_direction_count = creative_direction_target_count(
                snapshot.settings.target_count,
                mandatory_fact_count,
            )
        except ValueError as exc:
            raise PipelineError(str(exc)) from exc
        source_hash = creative_direction_source_hash(
            insight_content_hash=snapshot.insight_artifact.content_hash,
            visual_strategy_hash=visual_strategy.strategy_hash,
            shared_prompt_hash=shared_prompt.content_hash,
            target_count=snapshot.settings.target_count,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        )
        checkpoint = cache.strategy_checkpoints.get(NodeId.COHERENT_CREATIVE_GENERATION)
        plan: CreativeDirectionPlan | None = None
        reused = False
        if (
            checkpoint is not None
            and isinstance(checkpoint.plan, CreativeDirectionPlan)
            and checkpoint.plan.landscape is not None
            and checkpoint.plan.landscape.semantic_audit is not None
            and checkpoint.plan.semantic_audit is not None
            and checkpoint.plan.diversity_audit is not None
            and checkpoint.source_fingerprint == source_hash
            and checkpoint.template_hash == CREATIVE_DIRECTION_TEMPLATE_HASH
        ):
            try:
                restored_landscape = validate_creative_diversity_landscape(
                    CreativeDiversityLandscapeResponse(
                        territories=[
                            CreativeTerritoryDraft.model_validate(
                                territory.model_dump(
                                    mode="python",
                                    exclude={"target_slots"},
                                )
                            )
                            for territory in checkpoint.plan.landscape.territories
                        ]
                    ),
                    application,
                    source_hash=source_hash,
                    template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
                    expected_direction_count=expected_direction_count,
                )
                restored_landscape_audit = validate_creative_landscape_audit(
                    CreativeLandscapeAuditResponse(
                        reviewed_territory_ids=(
                            checkpoint.plan.landscape.semantic_audit.reviewed_territory_ids
                        ),
                        fact_issues=(
                            checkpoint.plan.landscape.semantic_audit.fact_issues
                        ),
                        requires_revision=(
                            checkpoint.plan.landscape.semantic_audit.requires_revision
                        ),
                        revision_territory_ids=(
                            checkpoint.plan.landscape.semantic_audit.revision_territory_ids
                        ),
                        summary=checkpoint.plan.landscape.semantic_audit.summary,
                    ),
                    restored_landscape,
                )
                restored_landscape = restored_landscape.model_copy(
                    update={"semantic_audit": restored_landscape_audit}
                )
                restored = validate_creative_direction_plan(
                    CreativeDirectionResponse(directions=checkpoint.plan.directions),
                    application,
                    visual_strategy,
                    source_hash=source_hash,
                    template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
                    expected_direction_count=expected_direction_count,
                    landscape=restored_landscape,
                )
                restored_audit = validate_creative_direction_audit(
                    CreativeDirectionAuditResponse(
                        items=checkpoint.plan.semantic_audit.items,
                        requires_revision=(
                            checkpoint.plan.semantic_audit.requires_revision
                        ),
                        revision_direction_ids=(
                            checkpoint.plan.semantic_audit.revision_direction_ids
                        ),
                        summary=checkpoint.plan.semantic_audit.summary,
                    ),
                    restored,
                    restored_landscape,
                )
                restored_diversity_audit = (
                    validate_creative_direction_diversity_audit(
                        checkpoint.plan.diversity_audit,
                        restored.directions,
                    )
                )
            except ValueError:
                restored = None
            if (
                restored is not None
                and not restored_landscape_audit.requires_revision
                and restored.plan_hash == checkpoint.allocation_hash
            ):
                plan = restored.model_copy(
                    update={
                        "semantic_audit": restored_audit,
                        "diversity_audit": restored_diversity_audit,
                        "reused_checkpoint": True,
                    }
                )
                reused = True
        call_metadata: dict[str, int | None] = {}
        if plan is None:
            await self._stage(
                context,
                NodeId.COHERENT_CREATIVE_GENERATION,
                StageStatus.RUNNING,
                "正在规划产品专属创意空间",
                metadata={
                    "perceptionPhase": "CREATIVE_SPACE_PLANNING",
                    "directionCount": expected_direction_count,
                    "mandatoryBusinessFactCount": mandatory_fact_count,
                    "businessFactCapacity": expected_direction_count * 4,
                    "priorityDimensionDistribution": [],
                    "candidateTargetCount": math.ceil(
                        snapshot.settings.target_count * 1.4
                    ),
                },
            )
            call_rows = []
            landscape = None
            landscape_revision_context: Mapping[str, Any] | None = None
            for landscape_attempt in range(4):
                landscape_call = None
                for structure_attempt in range(2):
                    self._reserve_ai_call(context)
                    try:
                        async with self._ai_semaphore:
                            landscape_call = (
                                await self.provider.plan_creative_landscape(
                                    application,
                                    fact_visual_strategy=visual_strategy,
                                    shared_prompt=shared_prompt,
                                    target_count=snapshot.settings.target_count,
                                    revision_context=landscape_revision_context,
                                )
                            )
                    except ProviderError as exc:
                        if (
                            structure_attempt == 0
                            and exc.error_type == ProviderErrorType.RESPONSE_INVALID
                        ):
                            landscape_revision_context = {
                                **(landscape_revision_context or {}),
                                "validationError": "上一版结构化 JSON 不完整",
                                "revisionInstruction": "重新输出完整的创意版图 JSON。",
                            }
                            continue
                        raise
                    break
                if landscape_call is None:
                    raise PipelineError("创意版图结构化响应未返回结果")
                call_rows.append(landscape_call.metadata)
                draft_landscape = None
                assignment_revision_context: Mapping[str, Any] | None = None
                assignment_error: ValueError | None = None
                for assignment_attempt in range(2):
                    self._reserve_ai_call(context)
                    try:
                        async with self._ai_semaphore:
                            assignment_call = (
                                await self.provider.assign_creative_landscape_facts(
                                    application,
                                    fact_visual_strategy=visual_strategy,
                                    landscape=landscape_call.value,
                                    target_count=snapshot.settings.target_count,
                                    revision_context=assignment_revision_context,
                                )
                            )
                    except ProviderError as exc:
                        if (
                            assignment_attempt == 0
                            and exc.error_type == ProviderErrorType.RESPONSE_INVALID
                        ):
                            assignment_revision_context = {
                                "validationError": "上一版结构化 JSON 不完整",
                                "revisionInstruction": (
                                    "重新输出全部业务事实的完整唯一分配。"
                                ),
                            }
                            continue
                        raise
                    call_rows.append(assignment_call.metadata)
                    try:
                        draft_landscape = compile_creative_landscape_assignments(
                            landscape_call.value,
                            assignment_call.value,
                            application,
                            source_hash=source_hash,
                            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
                            expected_direction_count=expected_direction_count,
                        )
                    except ValueError as exc:
                        assignment_error = exc
                        assignment_revision_context = (
                            creative_fact_assignment_revision_context(
                                assignment_call.value,
                                application,
                                landscape_call.value,
                                validation_error=str(exc),
                                expected_direction_count=expected_direction_count,
                            )
                        )
                        continue
                    break
                if draft_landscape is None:
                    if landscape_attempt == 3:
                        raise ProviderError(
                            "AI 事实主承载分配经修订后仍不完整或容量无效",
                            retryable=False,
                            error_type=ProviderErrorType.RESPONSE_INVALID,
                            attempts=2,
                        ) from assignment_error
                    landscape_revision_context = {
                        "validationError": str(
                            assignment_error or "事实分配结构化响应无效"
                        ),
                        "revisionInstruction": (
                            "重新规划一套能自然承载全部业务事实且容量充足的创意空间；"
                            "不要在本阶段逐条分配事实。"
                        ),
                    }
                    continue
                await self._stage(
                    context,
                    NodeId.COHERENT_CREATIVE_GENERATION,
                    StageStatus.RUNNING,
                    f"正在复核 {len(draft_landscape.territories)} 个产品创意空间",
                    metadata={
                        "perceptionPhase": "CREATIVE_SPACE_REVIEW",
                        "territoryCount": len(draft_landscape.territories),
                        "directionCount": expected_direction_count,
                        "candidateTargetCount": math.ceil(
                            snapshot.settings.target_count * 1.4
                        ),
                    },
                )

                async def audit_one_territory(territory: Any) -> Any:
                    for territory_audit_attempt in range(2):
                        self._reserve_ai_call(context)
                        try:
                            async with self._ai_semaphore:
                                territory_audit_call = (
                                    await self.provider.audit_creative_territory(
                                        application,
                                        fact_visual_strategy=visual_strategy,
                                        territory=territory,
                                    )
                                )
                        except ProviderError as exc:
                            if territory_audit_attempt == 0 and (
                                exc.retryable
                                or exc.error_type == ProviderErrorType.RESPONSE_INVALID
                            ):
                                continue
                            raise
                        call_rows.append(territory_audit_call.metadata)
                        value = territory_audit_call.value
                        if value.territory_id == territory.territory_id and all(
                            issue.territory_id == territory.territory_id
                            and issue.fact_id in territory.compatible_fact_ids
                            for issue in value.fact_issues
                        ):
                            return value
                        if territory_audit_attempt == 1:
                            raise ProviderError(
                                "AI 单个创意空间语义复核结构无效",
                                retryable=False,
                                error_type=ProviderErrorType.RESPONSE_INVALID,
                                attempts=2,
                            )
                    raise PipelineError("单个创意空间语义复核未返回结果")

                territory_audits = await asyncio.gather(
                    *(
                        audit_one_territory(territory)
                        for territory in draft_landscape.territories
                    )
                )
                fact_issues = [
                    issue
                    for territory_audit in territory_audits
                    for issue in territory_audit.fact_issues
                ]
                revision_territory_ids = [
                    territory_audit.territory_id
                    for territory_audit in territory_audits
                    if territory_audit.fact_issues
                ]
                landscape_audit = validate_creative_landscape_audit(
                    CreativeLandscapeAuditResponse(
                        reviewed_territory_ids=[
                            item.territory_id for item in territory_audits
                        ],
                        fact_issues=fact_issues,
                        requires_revision=bool(fact_issues),
                        revision_territory_ids=revision_territory_ids,
                        summary=(
                            f"独立复核发现 {len(fact_issues)} 项事实与创意空间关系需调整"
                            if fact_issues
                            else "全部事实与产品专属创意空间自然相容"
                        ),
                    ),
                    draft_landscape,
                )
                if landscape_audit.requires_revision:
                    repaired_landscape = apply_creative_landscape_audit(
                        draft_landscape,
                        landscape_audit,
                        application,
                    )
                    if repaired_landscape is not None:
                        landscape = repaired_landscape
                        break
                    if landscape_attempt == 3:
                        raise ProviderError(
                            "AI 创意版图经四次规划后仍未通过语义复核",
                            retryable=False,
                            error_type=ProviderErrorType.RESPONSE_INVALID,
                            attempts=4,
                        )
                    landscape_revision_context = (
                        creative_landscape_audit_revision_context(
                            draft_landscape,
                            landscape_audit,
                        )
                    )
                    continue
                landscape = draft_landscape.model_copy(
                    update={"semantic_audit": landscape_audit}
                )
                break
            if landscape is None:
                raise PipelineError("创意版图未能形成有效结果")
            await self._stage(
                context,
                NodeId.COHERENT_CREATIVE_GENERATION,
                StageStatus.RUNNING,
                (
                    f"已形成 {len(landscape.territories)} 个创意空间，"
                    f"正在规划 {expected_direction_count} 个创意方向"
                ),
                metadata={
                    "perceptionPhase": "CREATIVE_DIRECTION_PLANNING",
                    "territoryCount": len(landscape.territories),
                    "directionCount": expected_direction_count,
                    "candidateTargetCount": math.ceil(
                        snapshot.settings.target_count * 1.4
                    ),
                },
            )
            revision_context: Mapping[str, Any] | None = None
            previous_audited_response: CreativeDirectionResponse | None = None
            audit_revision_direction_ids: list[str] = []
            semantic_revision_count = 0
            for invalid_response_attempt in range(4):
                self._reserve_ai_call(context)
                try:
                    async with self._ai_semaphore:
                        call = await self.provider.plan_creative_directions(
                            application,
                            fact_visual_strategy=visual_strategy,
                            shared_prompt=shared_prompt,
                            landscape=landscape,
                            target_count=snapshot.settings.target_count,
                            revision_context=revision_context,
                        )
                except ProviderError as exc:
                    if (
                        invalid_response_attempt < 3
                        and exc.error_type == ProviderErrorType.RESPONSE_INVALID
                    ):
                        revision_context = {
                            **(revision_context or {}),
                            "validationError": "上一版结构化 JSON 不完整",
                            "revisionInstruction": (
                                f"{(revision_context or {}).get('revisionInstruction', '')}"
                                " 同时重新输出完整的创意方向 JSON。"
                            ).strip(),
                        }
                        continue
                    raise
                call_rows.append(call.metadata)
                direction_response = call.value
                if previous_audited_response is not None:
                    try:
                        direction_response = merge_creative_direction_revision(
                            previous_audited_response,
                            direction_response,
                            audit_revision_direction_ids,
                        )
                    except ValueError as exc:
                        if invalid_response_attempt == 3:
                            raise ProviderError(
                                "AI 创意方向修订改变了未点名方向",
                                retryable=False,
                                error_type=ProviderErrorType.RESPONSE_INVALID,
                                attempts=4,
                            ) from exc
                        revision_context = {
                            **(revision_context or {}),
                            "validationError": str(exc),
                        }
                        continue
                try:
                    draft_plan = validate_creative_direction_plan(
                        direction_response,
                        application,
                        visual_strategy,
                        source_hash=source_hash,
                        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
                        expected_direction_count=expected_direction_count,
                        landscape=landscape,
                    )
                except ValueError as exc:
                    revision_context = creative_direction_revision_context(
                        direction_response,
                        application,
                        validation_error=str(exc),
                        landscape=landscape,
                    )
                    revision_ids = revision_context.get("revisionDirectionIds")
                    if (
                        invalid_response_attempt < 3
                        and isinstance(revision_ids, list)
                        and revision_ids
                        and all(isinstance(item, str) for item in revision_ids)
                    ):
                        previous_audited_response = direction_response
                        audit_revision_direction_ids = revision_ids
                    if invalid_response_attempt == 3:
                        raise ProviderError(
                            "AI 创意方向规划结构或事实引用无效",
                            retryable=False,
                            error_type=ProviderErrorType.RESPONSE_INVALID,
                            attempts=4,
                        ) from exc
                    continue
                await self._stage(
                    context,
                    NodeId.COHERENT_CREATIVE_GENERATION,
                    StageStatus.RUNNING,
                    (
                        f"{len(draft_plan.directions)} 个创意方向已形成，"
                        "正在复核创意关系"
                    ),
                    metadata={
                        "perceptionPhase": "CREATIVE_DIRECTION_REVIEW",
                        "territoryCount": len(landscape.territories),
                        "directionCount": len(draft_plan.directions),
                        "candidateTargetCount": math.ceil(
                            snapshot.settings.target_count * 1.4
                        ),
                    },
                )

                async def audit_direction_batch(
                    batch: list[Any],
                ) -> CreativeDirectionAuditResponse:
                    for audit_attempt in range(2):
                        self._reserve_ai_call(context)
                        try:
                            async with self._ai_semaphore:
                                audit_call = (
                                    await self.provider.audit_creative_directions(
                                        application,
                                        fact_visual_strategy=visual_strategy,
                                        landscape=landscape,
                                        directions=CreativeDirectionResponse(
                                            directions=batch
                                        ),
                                    )
                                )
                        except ProviderError as exc:
                            if audit_attempt == 0 and (
                                exc.retryable
                                or exc.error_type == ProviderErrorType.RESPONSE_INVALID
                            ):
                                continue
                            raise
                        call_rows.append(audit_call.metadata)
                        return audit_call.value
                    raise PipelineError("创意方向语义分批复核未返回结果")

                direction_audit_batches = [
                    list(direction_response.directions[index : index + 7])
                    for index in range(0, len(direction_response.directions), 7)
                ]
                batch_audits = await asyncio.gather(
                    *(audit_direction_batch(batch) for batch in direction_audit_batches)
                )
                self._reserve_ai_call(context)
                async with self._ai_semaphore:
                    diversity_audit_call = (
                        await self.provider.audit_creative_direction_diversity(
                            landscape=landscape,
                            directions=direction_response,
                        )
                    )
                call_rows.append(diversity_audit_call.metadata)
                try:
                    diversity_audit = validate_creative_direction_diversity_audit(
                        diversity_audit_call.value,
                        direction_response.directions,
                    )
                except ValueError as exc:
                    raise ProviderError(
                        "AI 创意方向全批去重复核结构无效",
                        retryable=False,
                        error_type=ProviderErrorType.RESPONSE_INVALID,
                        attempts=1,
                    ) from exc
                combined_revision_ids = list(
                    dict.fromkeys(
                        [
                            *[
                                direction_id
                                for batch_audit in batch_audits
                                for direction_id in batch_audit.revision_direction_ids
                            ],
                            *diversity_audit.revision_direction_ids,
                        ]
                    )
                )
                combined_audit_response = CreativeDirectionAuditResponse(
                    items=[
                        item
                        for batch_audit in batch_audits
                        for item in batch_audit.items
                    ],
                    requires_revision=bool(combined_revision_ids),
                    revision_direction_ids=combined_revision_ids,
                    summary="；".join(
                        [
                            *(batch_audit.summary for batch_audit in batch_audits),
                            diversity_audit.summary,
                        ]
                    )[:240],
                )
                try:
                    audit = validate_creative_direction_audit(
                        combined_audit_response,
                        draft_plan,
                        landscape,
                    )
                except ValueError as exc:
                    raise ProviderError(
                        "AI 创意方向语义复核结构无效",
                        retryable=False,
                        error_type=ProviderErrorType.RESPONSE_INVALID,
                        attempts=2,
                    ) from exc
                if audit is None:
                    raise PipelineError("创意方向语义复核未能形成有效结果")
                draft_plan = draft_plan.model_copy(
                    update={"diversity_audit": diversity_audit}
                )
                if audit.requires_revision:
                    if semantic_revision_count == 0 and invalid_response_attempt < 3:
                        previous_audited_response = direction_response
                        audit_revision_direction_ids = list(
                            audit.revision_direction_ids
                        )
                        revision_context = creative_direction_audit_revision_context(
                            draft_plan,
                            audit,
                            diversity_audit,
                        )
                        semantic_revision_count += 1
                        continue
                    # The AI audit remains available to downstream evaluation,
                    # but repeated subjective disagreement is advisory. Worker
                    # does not reinterpret the findings or alter directions.
                    plan = draft_plan.model_copy(update={"semantic_audit": audit})
                    break
                plan = draft_plan.model_copy(update={"semantic_audit": audit})
                break
            if plan is None:
                raise PipelineError("创意方向规划未能形成有效结果")
            call_metadata = {
                "inputTokens": sum(item.input_tokens or 0 for item in call_rows),
                "outputTokens": sum(item.output_tokens or 0 for item in call_rows),
                "totalTokens": sum(item.total_tokens or 0 for item in call_rows),
                "latencyMs": sum(item.latency_ms for item in call_rows),
            }
        cache.creative_direction_plan = plan
        priority_counts = Counter(
            dimension.value
            for direction in plan.directions
            for dimension in direction.priority_dimensions
        )
        await self._stage(
            context,
            NodeId.COHERENT_CREATIVE_GENERATION,
            StageStatus.RUNNING,
            "创意方案已复用，正在生成候选"
            if reused
            else "创意方案已完成，正在生成候选",
            metadata={
                "perceptionPhase": "CANDIDATE_GENERATION",
                "directionCount": len(plan.directions),
                "territoryCount": (
                    len(plan.landscape.territories) if plan.landscape is not None else 0
                ),
                "semanticReviewPassed": bool(
                    plan.semantic_audit is not None
                    and not plan.semantic_audit.requires_revision
                ),
                "globalDiversityReviewPassed": bool(
                    plan.diversity_audit is not None
                    and not plan.diversity_audit.requires_revision
                ),
                "directionOverlapGroupCount": (
                    len(plan.diversity_audit.groups)
                    if plan.diversity_audit is not None
                    else 0
                ),
                "priorityDimensionDistribution": [
                    {"dimension": key, "count": count}
                    for key, count in sorted(priority_counts.items())
                ],
                "checkpoint": {
                    "nodeId": NodeId.COHERENT_CREATIVE_GENERATION.value,
                    "sourceFingerprint": source_hash,
                    "allocationHash": plan.plan_hash,
                    "templateHash": CREATIVE_DIRECTION_TEMPLATE_HASH,
                    "plan": plan.model_dump(mode="json", by_alias=True),
                },
                **call_metadata,
            },
        )
        return plan

    async def _plan_diversity_supplement_directions(
        self,
        context: RuntimeContext,
        plan: CreativeDirectionPlan,
        *,
        requested_candidate_count: int,
    ) -> list[CreativeDirection]:
        cache = self._cache(context)
        cache.diversity_supplement_attempted = True
        landscape = plan.landscape
        if landscape is None:
            cache.diversity_supplement_improved = False
            return []
        application = self._require_application(context)
        visual_strategy = self._required_fact_visual_strategy(context)
        shared_prompt = self._required_shared_prompt(context)
        requested_direction_count = min(
            4,
            max(2, math.ceil(requested_candidate_count / 3)),
        )
        revision_context: Mapping[str, Any] | None = None
        proposed: list[CreativeDirection] | None = None
        diversity_audit: CreativeDirectionDiversityAudit | None = None
        for attempt in range(2):
            try:
                self._reserve_ai_call(context)
                async with self._ai_semaphore:
                    direction_call = (
                        await self.provider.plan_diversity_supplement_directions(
                            application,
                            fact_visual_strategy=visual_strategy,
                            shared_prompt=shared_prompt,
                            landscape=landscape,
                            existing_directions=CreativeDirectionResponse(
                                directions=plan.directions
                            ),
                            requested_direction_count=requested_direction_count,
                            crowded_scene_families=sorted(
                                cache.diversity_avoid_scene_families
                            ),
                            crowded_action_families=sorted(
                                cache.diversity_avoid_action_families
                            ),
                            revision_context=revision_context,
                        )
                    )
                proposed = validate_diversity_supplement_directions(
                    direction_call.value,
                    application,
                    visual_strategy,
                    landscape=landscape,
                    existing_directions=plan.directions,
                    expected_direction_count=requested_direction_count,
                )
                combined = [*plan.directions, *proposed]
                self._reserve_ai_call(context)
                async with self._ai_semaphore:
                    audit_call = (
                        await self.provider.audit_creative_direction_diversity(
                            landscape=landscape,
                            directions=CreativeDirectionResponse(
                                directions=combined
                            ),
                            proposed_direction_ids=[
                                item.direction_id for item in proposed
                            ],
                        )
                    )
                diversity_audit = validate_creative_direction_diversity_audit(
                    audit_call.value,
                    combined,
                    proposed_direction_ids=[item.direction_id for item in proposed],
                )
            except (ProviderError, ValueError) as exc:
                if attempt == 0:
                    revision_context = {
                        "validationError": str(exc),
                        "revisionInstruction": (
                            "重新输出完整的补充方向结构，并保持数量、事实与版图引用合法。"
                        ),
                    }
                    continue
                cache.diversity_supplement_improved = False
                return []
            if not diversity_audit.requires_revision:
                break
            if attempt == 0:
                revision_context = {
                    "previousDirections": [
                        item.model_dump(mode="json", by_alias=True) for item in proposed
                    ],
                    "revisionDirectionIds": diversity_audit.revision_direction_ids,
                    "diversityAudit": diversity_audit.model_dump(
                        mode="json", by_alias=True
                    ),
                    "revisionInstruction": (
                        "保持补充方向 ID 和数量，按全批视觉复核改变实质画面关系；"
                        "不能只换措辞、人物性别或景别名称。"
                    ),
                }
                continue
            cache.diversity_supplement_improved = False
            return []
        if proposed is None or diversity_audit is None:
            cache.diversity_supplement_improved = False
            return []
        cache.diversity_supplement_direction_count = len(proposed)
        cache.diversity_supplement_improved = True
        cache.creative_direction_plan = extend_creative_direction_plan(
            plan,
            proposed,
            diversity_audit=diversity_audit,
        )
        return proposed

    def _creative_direction_metadata(self, context: RuntimeContext) -> dict[str, Any]:
        plan = self._cache(context).creative_direction_plan
        if plan is None:
            return {"directionCount": 0, "priorityDimensionDistribution": []}
        counts = Counter(
            dimension.value
            for direction in plan.directions
            for dimension in direction.priority_dimensions
        )
        return {
            "directionCount": len(plan.directions),
            "territoryCount": (
                len(plan.landscape.territories) if plan.landscape is not None else 0
            ),
            "semanticReviewPassed": bool(
                plan.semantic_audit is not None
                and not plan.semantic_audit.requires_revision
            ),
            "globalDiversityReviewPassed": bool(
                plan.diversity_audit is not None
                and not plan.diversity_audit.requires_revision
            ),
            "directionOverlapGroupCount": (
                len(plan.diversity_audit.groups)
                if plan.diversity_audit is not None
                else 0
            ),
            "priorityDimensionDistribution": [
                {"dimension": key, "count": count}
                for key, count in sorted(counts.items())
            ],
        }

    async def plan_creatives(
        self,
        context: RuntimeContext,
        *,
        round_number: int,
        missing_count: int | None = None,
        requested_count: int | None = None,
        supplement_kind: Literal["QUANTITY", "COVERAGE", "DIVERSITY"] = "QUANTITY",
        coverage_fact_ids: Sequence[str] = (),
    ) -> list[CreativeShardPlan]:
        settings = _current_settings(self.snapshot(context))
        snapshot = self.snapshot(context)
        cache = self._cache(context)
        if snapshot.operation == "ITEM_EVALUATE":
            if round_number != 0:
                return []
            target = snapshot.target_item
            if not isinstance(target, PromptItem):
                raise PipelineError("item evaluation requires a current target item")
            application = self._require_application(context)
            declared_ids = list(
                dict.fromkeys(
                    [binding.fact_id for binding in target.insight_bindings]
                    + [fact.fact_id for fact in application.usable]
                )
            )[:12]
            if not declared_ids:
                raise PipelineError("item evaluation requires confirmed insight facts")
            candidate = CreativeCandidate(
                slot_id=target.id,
                ordinal=(snapshot.target_item_index or 0) + 1,
                round=0,
                creative_core=target.creative_core,
                declared_fact_ids=declared_ids,
                dimensions=target.dimensions,
                content=target.content,
                generated_at=utc_now(),
            )
            cache.creatives[candidate.slot_id] = candidate
            cache.creative_target_durations[candidate.slot_id] = (
                target.target_duration_seconds
            )
            cache.candidate_target_count = 1
            return []
        direction_plan = await self._ensure_creative_direction_plan(context)
        selection_target = (
            3
            if snapshot.operation == "ITEM_REGENERATE"
            else max(0, settings.target_count - len(snapshot.retained_manual_items))
        )
        if round_number == 0:
            requested = (
                3
                if snapshot.operation == "ITEM_REGENERATE"
                else math.ceil(selection_target * 1.4)
            )
            cache.candidate_target_count = requested
        elif supplement_kind in {"COVERAGE", "DIVERSITY"}:
            requested = max(1, requested_count or 1)
        else:
            deficit = max(1, missing_count or selection_target)
            requested = max(deficit + 1, math.ceil(deficit * 1.2))
        if snapshot.operation == "BATCH_GENERATE" and round_number > 0:
            remaining_capacity = max(
                0,
                math.ceil(selection_target * 1.8) - len(cache.creatives),
            )
            requested = min(requested, remaining_capacity)
            if requested <= 0:
                return []
        if round_number > 0 and supplement_kind in {"QUANTITY", "COVERAGE"}:
            cache.supplemented = True
            cache.replenishment_rounds = len(
                {
                    task.round
                    for task in cache.creative_tasks.values()
                    if task.supplement_kind in {"QUANTITY", "COVERAGE"}
                }
                | {round_number}
            )
            if supplement_kind == "QUANTITY":
                cache.quantity_supplemented = True
                cache.quantity_supplement_count += requested
            else:
                cache.coverage_supplemented = True
                cache.coverage_supplement_count += requested
        application = self._require_application(context)
        supplement_direction_ids: list[str] = []
        if supplement_kind == "DIVERSITY" and direction_plan is not None:
            supplemental_directions = await self._plan_diversity_supplement_directions(
                context,
                direction_plan,
                requested_candidate_count=requested,
            )
            if not supplemental_directions:
                return []
            supplement_direction_ids = [
                item.direction_id for item in supplemental_directions
            ]
            direction_plan = self._cache(context).creative_direction_plan
        preferred_item_fact_ids = (
            [binding.fact_id for binding in snapshot.target_item.insight_bindings]
            if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item
            else []
        )
        already_covered_fact_ids = {
            fact_id
            for evaluation in cache.creative_evaluations.values()
            for fact_id in evaluation.realized_fact_ids
        }
        already_covered_fact_ids.update(
            binding.fact_id
            for item in snapshot.retained_manual_items
            for binding in item.insight_bindings
        )
        batch_required_fact_ids = [fact.fact_id for fact in application.required]
        missing_required_fact_ids = [
            fact_id
            for fact_id in batch_required_fact_ids
            if fact_id not in already_covered_fact_ids
        ]
        ordinal_start = (
            1
            if round_number == 0
            else max((item.ordinal for item in cache.creatives.values()), default=0) + 1
        )
        directions = (
            allocate_creative_directions(
                direction_plan,
                count=requested,
                ordinal_start=ordinal_start,
                preferred_direction_ids=(
                    [
                        direction.direction_id
                        for direction in direction_plan.directions
                        if set(direction.fact_ids).intersection(coverage_fact_ids)
                    ]
                    if supplement_kind == "COVERAGE" and coverage_fact_ids
                    else supplement_direction_ids
                    if supplement_kind == "DIVERSITY"
                    else ()
                ),
                avoid_scene_families=(
                    cache.diversity_avoid_scene_families
                    if supplement_kind == "DIVERSITY"
                    else ()
                ),
                avoid_action_families=(
                    cache.diversity_avoid_action_families
                    if supplement_kind == "DIVERSITY"
                    else ()
                ),
            )
            if direction_plan is not None
            else []
        )
        if supplement_kind == "DIVERSITY":
            crowded_families = [
                *sorted(cache.diversity_avoid_scene_families),
                *sorted(cache.diversity_avoid_action_families),
            ]
            directions = [
                direction.model_copy(
                    update={
                        "avoid_families": list(
                            dict.fromkeys(
                                [*direction.avoid_families, *crowded_families]
                            )
                        )[:2]
                    }
                )
                for direction in directions
            ]
        if directions:
            fact_assignments = [
                assignment_for_direction(
                    direction,
                    ordinal=ordinal_start + index,
                )
                for index, direction in enumerate(directions)
            ]
        elif snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item:
            fact_assignments = (
                allocate_automatic_regeneration_facts(
                    application,
                    ordinal_start=ordinal_start,
                    original_fact_ids=preferred_item_fact_ids,
                )
                if snapshot.regeneration_mode == "AUTO_DIVERSE" and requested == 3
                else allocate_regeneration_facts(
                    application,
                    count=requested,
                    ordinal_start=ordinal_start,
                    original_fact_ids=preferred_item_fact_ids,
                    preserve_product_relation=(
                        snapshot.regeneration_mode != "NEW_CREATIVE"
                        or "productRelation" in snapshot.preserved_dimensions
                    ),
                )
            )
        else:
            fact_assignments = allocate_creative_facts(
                application,
                count=requested,
                ordinal_start=ordinal_start,
                preferred_fact_ids=preferred_item_fact_ids,
            )
        coverage_focus_set = set(coverage_fact_ids)
        direction_totals = Counter(
            direction.direction_id for direction in directions
        )
        direction_seen: Counter[str] = Counter()
        sibling_positions: list[tuple[int, int]] = []
        for direction in directions:
            direction_seen[direction.direction_id] += 1
            sibling_positions.append(
                (
                    direction_seen[direction.direction_id],
                    direction_totals[direction.direction_id],
                )
            )
        tasks = [
            CreativeTask(
                slot_id=f"creative-r{round_number}-c{ordinal_start + index:04d}",
                ordinal=ordinal_start + index,
                round=round_number,
                supplement_kind=("INITIAL" if round_number == 0 else supplement_kind),
                target_duration_seconds=(
                    snapshot.target_item.target_duration_seconds
                    if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item
                    else settings.default_duration_seconds
                ),
                fact_assignment=fact_assignments[index],
                creative_direction=(directions[index] if directions else None),
                sibling_variant_index=(
                    sibling_positions[index][0] if directions else 1
                ),
                sibling_variant_total=(
                    sibling_positions[index][1] if directions else 1
                ),
                regeneration_variant_role=(
                    (
                        "PRESENTATION_VARIATION",
                        "PRODUCT_FOCUS_VARIATION",
                        "FEEDBACK_OPTIMIZATION",
                    )[index]
                    if snapshot.operation == "ITEM_REGENERATE"
                    and snapshot.regeneration_mode == "AUTO_DIVERSE"
                    and requested == 3
                    else None
                ),
                coverage_focus_fact_ids=(
                    [
                        fact_id
                        for fact_id in fact_assignments[index].fact_ids
                        if fact_id in coverage_focus_set
                    ]
                    if supplement_kind == "COVERAGE"
                    else []
                ),
            )
            for index in range(requested)
        ]
        if supplement_kind == "DIVERSITY" and tasks:
            cache.diversity_supplemented = True
            cache.diversity_supplement_count += len(tasks)
        cache.creative_target_durations.update(
            {task.slot_id: task.target_duration_seconds for task in tasks}
        )
        cache.creative_tasks.update({task.slot_id: task for task in tasks})
        if supplement_kind == "DIVERSITY":
            cache.diversity_supplement_slot_ids.update(task.slot_id for task in tasks)
        selected = cache.selected_creatives.selected if cache.selected_creatives else []
        if supplement_kind == "DIVERSITY" and cache.diversity_avoid_slot_ids:
            selected = [
                item
                for item in selected
                if item.candidate.slot_id in cache.diversity_avoid_slot_ids
            ]
        rejection_reasons = sorted(
            {
                issue
                for evaluation in cache.creative_evaluations.values()
                for issue in evaluation.hard_issues
            }
        )[:20]
        task_chunks = _creative_task_chunks(
            tasks,
            max_size=min(4, self.shard_size),
        )
        shards = [
            CreativeShardPlan(
                round=round_number,
                shard_index=index,
                tasks=task_chunk,
                avoid_semantic_signatures=[
                    item.evaluation.semantic_signature for item in selected
                ],
                avoid_visual_signatures=[
                    item.evaluation.visual_signature for item in selected
                ],
                rejection_reasons=rejection_reasons,
            )
            for index, task_chunk in enumerate(task_chunks)
        ]
        pending = [
            item
            for item in shards
            if item.key not in cache.completed_creative_shard_keys
        ]
        await self._stage(
            context,
            NodeId.COHERENT_CREATIVE_GENERATION,
            StageStatus.RUNNING if pending else StageStatus.SUCCEEDED,
            "创意方案已完成，正在生成候选 Prompt" if pending else "候选 Prompt 已恢复",
            metadata={
                "perceptionPhase": "CANDIDATE_GENERATION",
                "round": round_number,
                "supplementKind": supplement_kind,
                "candidateTargetCount": requested,
                "totalShardCount": len(shards),
                "completedShardCount": len(shards) - len(pending),
                "pendingShardCount": len(pending),
                "generatedCandidateCount": len(cache.creatives),
                "shardSize": min(4, self.shard_size),
                "siblingCoordinatedShardCount": sum(
                    len(shard.tasks) > 1
                    and len(
                        {
                            task.creative_direction.direction_id
                            for task in shard.tasks
                            if task.creative_direction is not None
                        }
                    )
                    == 1
                    for shard in shards
                ),
                "factSelectionMode": "DIRECTION_FACT_APPLICATIONS",
                "requiredFactCount": len(batch_required_fact_ids),
                "missingRequiredFactCountBeforeRound": len(
                    coverage_fact_ids or missing_required_fact_ids
                ),
                "plannedFactCount": len(
                    {
                        fact_id
                        for assignment in fact_assignments
                        for fact_id in assignment.fact_ids
                    }
                ),
                **self._creative_direction_metadata(context),
            },
        )
        return pending

    async def generate_creative_shard(
        self,
        context: RuntimeContext,
        shard: CreativeShardPlan,
    ) -> list[CreativeCandidate]:
        running = ShardRecord(
            phase=ShardPhase.CREATIVE,
            round=shard.round,
            shard_index=shard.shard_index,
            status=StageStatus.RUNNING,
            creative_plan=shard.tasks,
        )
        await self.api.put_shard(context, running)
        snapshot = self.snapshot(context)
        try:
            for invalid_response_attempt in range(2):
                self._reserve_ai_call(context)
                try:
                    async with self._ai_semaphore:
                        call_kwargs: dict[str, Any] = {
                            "application": self._require_application(context),
                            "shared_prompt": self._required_shared_prompt(context),
                            "regeneration_context": (
                                {
                                    "originalPrompt": snapshot.target_item.content,
                                    "originalDimensions": (
                                        snapshot.target_item.dimensions.model_dump(
                                            mode="json", by_alias=True
                                        )
                                    ),
                                    "instruction": snapshot.regeneration_instruction
                                    or "",
                                    "replacementDimensions": (
                                        snapshot.replacement_dimensions.model_dump(
                                            mode="json", by_alias=True
                                        )
                                        if snapshot.replacement_dimensions
                                        else None
                                    ),
                                    "mode": snapshot.regeneration_mode
                                    or "AUTO_DIVERSE",
                                    "reasons": snapshot.regeneration_reasons,
                                    "preservedDimensions": snapshot.preserved_dimensions,
                                }
                                if snapshot.operation == "ITEM_REGENERATE"
                                and snapshot.target_item
                                else None
                            ),
                        }
                        if _uses_fact_visual_strategy(snapshot):
                            call_kwargs["fact_visual_strategy"] = (
                                self._required_fact_visual_strategy(context)
                            )
                        call = await self.provider.generate_creatives(
                            shard,
                            **call_kwargs,
                        )
                    break
                except ProviderError as exc:
                    if (
                        exc.error_type != ProviderErrorType.RESPONSE_INVALID
                        or invalid_response_attempt == 1
                    ):
                        raise
            generated_at = utc_now()
            items = [
                item.model_copy(update={"generated_at": generated_at})
                for item in call.value.items
            ]
            await self.api.put_shard(
                context,
                running.model_copy(
                    update={"status": StageStatus.SUCCEEDED, "creative_items": items}
                ),
            )
            cache = self._cache(context)
            cache.creatives.update({item.slot_id: item for item in items})
            cache.completed_creative_shard_keys.add(shard.key)
            return items
        except Exception as exc:
            node_id = (
                NodeId.ITEM_EVALUATE
                if snapshot.operation == "ITEM_EVALUATE"
                else NodeId.COHERENT_CREATIVE_GENERATION
            )
            setattr(exc, "node_id", node_id)
            if (
                snapshot.operation == "BATCH_GENERATE"
                and isinstance(exc, ProviderError)
                and exc.error_type == ProviderErrorType.RESPONSE_INVALID
            ):
                LOGGER.warning(
                    "discarding invalid creative shard round=%s shard=%s task_count=%s",
                    shard.round,
                    shard.shard_index,
                    len(shard.tasks),
                )
                await self.api.put_shard(
                    context,
                    running.model_copy(
                        update={
                            "status": StageStatus.SUCCEEDED,
                            "creative_items": [],
                            "warnings": [
                                "该分片候选结构异常，已跳过并交由后续数量补充"
                            ],
                            "error_code": None,
                            "error_message": None,
                        }
                    ),
                )
                self._cache(context).completed_creative_shard_keys.add(shard.key)
                return []
            await self.api.put_shard(
                context,
                running.model_copy(
                    update={
                        "status": StageStatus.FAILED,
                        "warnings": [_safe_error(exc)],
                        "error_code": _error_code(exc),
                        "error_message": _safe_error(exc),
                    }
                ),
            )
            raise

    async def complete_creative_generation(
        self,
        context: RuntimeContext,
        *,
        round_number: int,
    ) -> None:
        cache = self._cache(context)
        snapshot = self.snapshot(context)
        node = (
            NodeId.ITEM_EVALUATE
            if snapshot.operation == "ITEM_EVALUATE"
            else NodeId.COHERENT_CREATIVE_GENERATION
        )
        round_items = [
            item for item in cache.creatives.values() if item.round == round_number
        ]
        await self._stage(
            context,
            node,
            StageStatus.SUCCEEDED,
            "连贯六维创意生成完成",
            metadata={
                "perceptionPhase": "CANDIDATE_GENERATION_COMPLETE",
                "round": round_number,
                "targetCount": (
                    1
                    if snapshot.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"}
                    else _current_settings(snapshot).target_count
                ),
                "candidateTargetCount": cache.candidate_target_count,
                "candidateCount": len(cache.creatives),
                "roundCandidateCount": len(round_items),
                "completedShardCount": len(cache.completed_creative_shard_keys),
                "supplemented": cache.supplemented,
                "factSelectionMode": "DIRECTION_FACT_APPLICATIONS",
                **self._creative_direction_metadata(context),
            },
        )

    async def plan_classification(
        self,
        context: RuntimeContext,
        *,
        round_number: int,
    ) -> list[ClassificationShardPlan]:
        cache = self._cache(context)
        round_candidate_ids = [
            item.slot_id
            for item in sorted(cache.creatives.values(), key=lambda row: row.ordinal)
            if item.round == round_number
        ]
        shards = [
            ClassificationShardPlan(
                round=round_number,
                shard_index=index,
                candidate_ids=round_candidate_ids[
                    start : start + CLASSIFICATION_SHARD_SIZE
                ],
            )
            for index, start in enumerate(
                range(
                    0,
                    len(round_candidate_ids),
                    CLASSIFICATION_SHARD_SIZE,
                )
            )
        ]
        missing_ids = {
            candidate_id
            for candidate_id in round_candidate_ids
            if candidate_id not in cache.creative_evaluations
        }
        pending = [
            item
            for item in shards
            if any(candidate_id in missing_ids for candidate_id in item.candidate_ids)
        ]
        node = (
            NodeId.ITEM_EVALUATE
            if self.snapshot(context).operation == "ITEM_EVALUATE"
            else NodeId.CREATIVE_EVALUATION_CLASSIFICATION
        )
        await self._stage(
            context,
            node,
            StageStatus.RUNNING if pending else StageStatus.SUCCEEDED,
            "正在评估创意并标注素材用途" if pending else "创意评估与用途分类已恢复",
            metadata={
                "round": round_number,
                "candidateCount": len(round_candidate_ids),
                "missingCandidateCount": len(missing_ids),
                "pendingShardCount": len(pending),
                "shardSize": CLASSIFICATION_SHARD_SIZE,
            },
        )
        return pending

    async def evaluate_classification_shard(
        self,
        context: RuntimeContext,
        shard: ClassificationShardPlan,
    ) -> list[CreativeEvaluation]:
        cache = self._cache(context)
        candidates = [cache.creatives[item_id] for item_id in shard.candidate_ids]
        node = (
            NodeId.ITEM_EVALUATE
            if self.snapshot(context).operation == "ITEM_EVALUATE"
            else NodeId.CREATIVE_EVALUATION_CLASSIFICATION
        )
        running = ShardRecord(
            phase=ShardPhase.CLASSIFICATION,
            round=shard.round,
            shard_index=shard.shard_index,
            status=StageStatus.RUNNING,
            classification_plan=shard.candidate_ids,
        )
        await self.api.put_shard(context, running)
        try:
            application = self._require_application(context)
            assigned_context_fact_ids = {
                candidate.slot_id: _evaluation_context_fact_ids(
                    candidate,
                    cache.creative_tasks.get(candidate.slot_id),
                    application,
                    item_evaluation=(
                        self.snapshot(context).operation == "ITEM_EVALUATE"
                    ),
                )
                for candidate in candidates
            }

            async def request_evaluations(
                group: list[CreativeCandidate],
            ) -> list[CreativeEvaluation]:
                attempts = 2 if len(group) == 1 else 1
                for invalid_response_attempt in range(attempts):
                    self._reserve_ai_call(context)
                    async with self._ai_semaphore:
                        evaluation_kwargs: dict[str, Any] = {
                            "application": application,
                            "assigned_context_fact_ids": (
                                {
                                    candidate.slot_id: assigned_context_fact_ids[
                                        candidate.slot_id
                                    ]
                                    for candidate in group
                                }
                            ),
                            "target_durations": {
                                candidate.slot_id: (
                                    cache.creative_target_durations[candidate.slot_id]
                                )
                                for candidate in group
                            },
                            "direction_plan": cache.creative_direction_plan,
                        }
                        if self.snapshot(context).operation == "ITEM_EVALUATE":
                            evaluation_kwargs["infer_creative_structure"] = True
                        if _uses_fact_visual_strategy(self.snapshot(context)):
                            evaluation_kwargs["fact_visual_strategy"] = (
                                self._required_fact_visual_strategy(context)
                            )
                        try:
                            call = await self.provider.evaluate_creatives(
                                group,
                                **evaluation_kwargs,
                            )
                            if self.snapshot(
                                context
                            ).operation == "ITEM_EVALUATE" and any(
                                item.inferred_creative_core is None
                                or item.inferred_dimensions is None
                                for item in call.value.items
                            ):
                                raise ProviderError(
                                    "item evaluation did not infer creative structure",
                                    retryable=False,
                                    error_type=ProviderErrorType.RESPONSE_INVALID,
                                )
                            return call.value.items
                        except ProviderError as exc:
                            if (
                                exc.error_type != ProviderErrorType.RESPONSE_INVALID
                                or invalid_response_attempt == attempts - 1
                            ):
                                raise
                raise PipelineError("creative evaluation retry loop exhausted")

            try:
                evaluated_items = await request_evaluations(candidates)
            except ProviderError as exc:
                recoverable_structure_error = exc.error_type in {
                    ProviderErrorType.RESPONSE_INVALID,
                    ProviderErrorType.OUTPUT_TRUNCATED,
                    ProviderErrorType.RESPONSE_INCOMPLETE,
                }
                if len(candidates) == 1 or not recoverable_structure_error:
                    raise
                LOGGER.warning(
                    "splitting invalid creative evaluation shard round=%s "
                    "shard=%s candidate_count=%s error_type=%s",
                    shard.round,
                    shard.shard_index,
                    len(candidates),
                    exc.error_type.value,
                )
                evaluated_items = []
                for candidate in candidates:
                    evaluated_items.extend(await request_evaluations([candidate]))

            candidate_by_id = {item.slot_id: item for item in candidates}
            items = []
            for item in evaluated_items:
                candidate = candidate_by_id[item.slot_id]
                if self.snapshot(context).operation == "ITEM_EVALUATE":
                    if (
                        item.inferred_creative_core is None
                        or item.inferred_dimensions is None
                    ):
                        raise PipelineError(
                            "item evaluation creative structure is incomplete"
                        )
                    candidate = candidate.model_copy(
                        update={
                            "creative_core": item.inferred_creative_core,
                            "dimensions": item.inferred_dimensions,
                        }
                    )
                    candidate_by_id[item.slot_id] = candidate
                    cache.creatives[item.slot_id] = candidate
                if cache.creative_direction_plan is not None:
                    item = complete_semantic_profile(
                        item,
                        candidate,
                        cache.creative_direction_plan,
                    )
                    validate_semantic_profile(item, cache.creative_direction_plan)
                items.append(
                    validate_creative_evaluation(
                        candidate,
                        item,
                        application,
                        target_duration_seconds=cache.creative_target_durations[
                            item.slot_id
                        ],
                        contextual_fact_ids=assigned_context_fact_ids.get(
                            item.slot_id,
                            [],
                        ),
                    )
                )
            await self.api.put_shard(
                context,
                running.model_copy(
                    update={"status": StageStatus.SUCCEEDED, "evaluations": items}
                ),
            )
            cache.creative_evaluations.update({item.slot_id: item for item in items})
            cache.completed_classification_shard_keys.add(shard.key)
            return items
        except Exception as exc:
            setattr(exc, "node_id", node)
            await self.api.put_shard(
                context,
                running.model_copy(
                    update={
                        "status": StageStatus.FAILED,
                        "warnings": [_safe_error(exc)],
                        "error_code": _error_code(exc),
                        "error_message": _safe_error(exc),
                    }
                ),
            )
            raise

    async def complete_classification(
        self,
        context: RuntimeContext,
        *,
        round_number: int,
    ) -> None:
        cache = self._cache(context)
        snapshot = self.snapshot(context)
        node = (
            NodeId.ITEM_EVALUATE
            if snapshot.operation == "ITEM_EVALUATE"
            else NodeId.CREATIVE_EVALUATION_CLASSIFICATION
        )
        evaluations = list(cache.creative_evaluations.values())
        accepted = [item for item in evaluations if not item.hard_issues]
        hard_counts = Counter(
            issue for item in evaluations for issue in item.hard_issues
        )
        warning_counts = Counter(
            warning for item in evaluations for warning in item.warnings
        )
        purpose_counts = Counter(item.primary_purpose for item in evaluations)
        semantic_metadata: dict[str, Any] = {
            "semanticEvaluationStatus": "PENDING",
            "semanticSimilarityThreshold": VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD,
            "semanticDuplicateRateLimit": SEMANTIC_DUPLICATE_RATE_LIMIT,
        }
        eligible_candidates = [
            candidate
            for candidate in cache.creatives.values()
            if (
                (evaluation := cache.creative_evaluations.get(candidate.slot_id))
                is not None
                and not evaluation.hard_issues
            )
        ]
        if eligible_candidates:
            if self.embedding_provider is None:
                raise PipelineError(
                    "embedding provider is required for semantic evaluation"
                )
            anchors = [
                item
                for item in snapshot.similarity_anchors
                if isinstance(item, PromptItem)
            ]
            try:
                insight = snapshot.insight_artifact.result
                content_index = await build_content_vector_index(
                    eligible_candidates,
                    anchors,
                    provider=self.embedding_provider,
                    vector_cache=cache.embedding_vectors,
                    product_name=_insight_text(
                        insight,
                        "productName",
                        "product_name",
                    ),
                    product_category=_insight_text(
                        insight,
                        "productCategory",
                        "product_category",
                    ),
                    shared_prompt=self._required_shared_prompt(context),
                    batch_size=self.embedding_batch_size,
                    max_concurrency=self.embedding_max_concurrency,
                )
                _trim_embedding_cache(cache.embedding_vectors)
            except EmbeddingProviderError as exc:
                setattr(exc, "node_id", node)
                raise
            cache.content_vector_index = content_index
            preliminary = content_index.redundancy_summary(
                [candidate.slot_id for candidate in eligible_candidates]
            )
            cache.redundancy_summary = preliminary
            content_stats = content_index.stats
            cache.embedding_remote_input_count += (
                content_stats.input_count - content_stats.cache_hit_count
            )
            cache.embedding_request_count += content_stats.request_count
            cache.embedding_input_tokens += content_stats.input_tokens
            cache.embedding_retry_count += content_stats.retry_count
            cache.embedding_duration_ms += content_stats.duration_ms
            cache.embedding_local_comparison_ms += content_stats.local_comparison_ms
            preliminary_evaluation = _semantic_evaluation(
                preliminary,
                len(eligible_candidates) + len(anchors),
            )
            semantic_metadata = {
                "semanticEvaluationStatus": preliminary_evaluation.status,
                "semanticEvaluatedCount": preliminary_evaluation.evaluated_count,
                "semanticDuplicateGroupCount": (
                    preliminary_evaluation.duplicate_group_count
                ),
                "semanticDuplicateCount": preliminary_evaluation.duplicate_count,
                "semanticDuplicateRate": preliminary_evaluation.duplicate_rate,
                "semanticSimilarityThreshold": VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD,
                "semanticDuplicateRateLimit": SEMANTIC_DUPLICATE_RATE_LIMIT,
                "embeddingInputCount": cache.embedding_remote_input_count,
                "embeddingRequestCount": cache.embedding_request_count,
                "embeddingCacheHitCount": content_stats.cache_hit_count,
                "embeddingDurationMs": round(cache.embedding_duration_ms, 3),
                "localComparisonMs": round(
                    cache.embedding_local_comparison_ms,
                    3,
                ),
            }
        await self._stage(
            context,
            node,
            StageStatus.SUCCEEDED,
            "创意质量评估与用途分类完成",
            metadata={
                "round": round_number,
                "candidateCount": len(cache.creatives),
                "evaluatedCount": len(evaluations),
                "acceptedCount": len(accepted),
                "rejectedCount": len(evaluations) - len(accepted),
                "completedShardCount": len(cache.completed_classification_shard_keys),
                "averageScores": _average_scores(
                    [item.scores for item in evaluations]
                ).model_dump(mode="json", by_alias=True),
                "purposeDistribution": [
                    {"purpose": purpose.value, "count": purpose_counts[purpose]}
                    for purpose in FragmentType
                ],
                "hardIssueCounts": [
                    {"code": code, "count": count}
                    for code, count in sorted(hard_counts.items())
                ],
                "warningCounts": [
                    {"code": code, "count": count}
                    for code, count in sorted(warning_counts.items())
                ],
                **(
                    {
                        "classificationStatus": (
                            "NEEDS_REVISION"
                            if evaluations and evaluations[0].hard_issues
                            else "VERIFIED"
                        )
                    }
                    if snapshot.operation == "ITEM_EVALUATE"
                    else {}
                ),
                **semantic_metadata,
            },
        )

    async def select_creatives(
        self,
        context: RuntimeContext,
        *,
        round_number: int,
    ) -> tuple[list[CreativeShardPlan], bool]:
        cache = self._cache(context)
        snapshot = self.snapshot(context)
        settings = _current_settings(snapshot)
        item_operation = snapshot.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"}
        selection_target = (
            3
            if snapshot.operation == "ITEM_REGENERATE"
            else 1
            if snapshot.operation == "ITEM_EVALUATE"
            else max(0, settings.target_count - len(snapshot.retained_manual_items))
        )
        application = self._require_application(context)
        preferred_item_fact_ids = [
            fact.fact_id for fact in mandatory_business_facts(application)
        ]
        required_fact_ids = [] if item_operation else preferred_item_fact_ids
        fixed_covered_fact_ids = [
            binding.fact_id
            for item in snapshot.retained_manual_items
            for binding in item.insight_bindings
        ]
        if snapshot.operation == "ITEM_EVALUATE":
            candidate = next(iter(cache.creatives.values()), None)
            evaluation = (
                cache.creative_evaluations.get(candidate.slot_id) if candidate else None
            )
            if candidate is None or evaluation is None:
                raise PipelineError("item evaluation result is incomplete")
            result = CreativeSelectionResult(
                selected=[
                    RankedCreative(
                        candidate=candidate,
                        evaluation=evaluation,
                        quality_score=evaluation.scores.overall_quality,
                        novelty_score=100.0,
                        selection_score=evaluation.scores.overall_quality,
                    )
                ],
                rejected=[],
                exact_duplicate_count=0,
            )
        else:
            baseline_result = select_creatives(
                list(cache.creatives.values()),
                list(cache.creative_evaluations.values()),
                target_count=selection_target,
                required_fact_ids=required_fact_ids,
                preferred_item_fact_ids=preferred_item_fact_ids,
                fixed_covered_fact_ids=fixed_covered_fact_ids,
            )
            result = baseline_result
            cache.embedding_stage_metadata = {
                "similarityMode": self.similarity_mode,
                "selectionMethod": "AI_CLUSTER_BASELINE",
            }
            cache.embedding_warning = None
            eligible_candidates = [
                candidate
                for candidate in cache.creatives.values()
                if (
                    (evaluation := cache.creative_evaluations.get(candidate.slot_id))
                    is not None
                    and not evaluation.hard_issues
                )
            ]
            content_mmr_policy = snapshot.selection_policy == "MMR_CONTENT"
            if len(eligible_candidates) > 1 and content_mmr_policy:
                if self.embedding_provider is None:
                    raise PipelineError(
                        "embedding provider is required for Prompt vector similarity"
                    )
                anchors = [
                    item
                    for item in snapshot.similarity_anchors
                    if isinstance(item, PromptItem)
                ]
                try:
                    content_index = cache.content_vector_index
                    if content_index is None:
                        raise PipelineError("semantic evaluation index is unavailable")
                    candidate_pool_redundancy = content_index.redundancy_summary(
                        [item.slot_id for item in eligible_candidates]
                    )
                    candidate_pool_redundancy_rate = round(
                        candidate_pool_redundancy.redundant_candidate_count
                        / max(1, len(eligible_candidates)),
                        4,
                    )
                    mmr_quality_weight = (
                        0.60 if candidate_pool_redundancy_rate > 0.50 else 0.70
                    )
                    mmr_diversity_weight = round(1.0 - mmr_quality_weight, 2)

                    def select_content_mmr(
                        candidate_ids: set[str] | None = None,
                    ) -> CreativeSelectionResult:
                        candidates = [
                            item
                            for item in cache.creatives.values()
                            if candidate_ids is None or item.slot_id in candidate_ids
                        ]
                        evaluations = [
                            item
                            for item in cache.creative_evaluations.values()
                            if candidate_ids is None or item.slot_id in candidate_ids
                        ]
                        return select_creatives(
                            candidates,
                            evaluations,
                            target_count=selection_target,
                            novelty_resolver=lambda left, right: round(
                                0.70
                                * content_index.novelty(
                                    left.candidate.slot_id,
                                    right.candidate.slot_id,
                                )
                                + 0.30
                                * semantic_cluster_novelty(
                                    left.evaluation.semantic_profile,
                                    right.evaluation.semantic_profile,
                                ),
                                4,
                            ),
                            fixed_novelty_resolver=(
                                lambda item: content_index.novelty_to_anchors(
                                    item.candidate.slot_id
                                )
                            )
                            if anchors
                            else None,
                            dimension_gain_resolver=lambda item, selected: (
                                _dimension_unique_gain(item, selected, anchors)
                            ),
                            required_fact_ids=required_fact_ids,
                            preferred_item_fact_ids=preferred_item_fact_ids,
                            fixed_covered_fact_ids=fixed_covered_fact_ids,
                            quality_weight=mmr_quality_weight,
                            novelty_weight=mmr_diversity_weight,
                        )

                    quality_baseline_result = select_creatives(
                        list(cache.creatives.values()),
                        list(cache.creative_evaluations.values()),
                        target_count=selection_target,
                        required_fact_ids=required_fact_ids,
                        preferred_item_fact_ids=preferred_item_fact_ids,
                        fixed_covered_fact_ids=fixed_covered_fact_ids,
                        quality_weight=1.0,
                        novelty_weight=0.0,
                    )
                    mmr_result = select_content_mmr()
                    baseline_ids = {
                        item.candidate.slot_id
                        for item in quality_baseline_result.selected
                    }
                    mmr_ids = {item.candidate.slot_id for item in mmr_result.selected}
                    denominator = max(1, len(baseline_ids))
                    baseline_summary = _selection_content_summary(
                        quality_baseline_result,
                        content_index,
                    )
                    mmr_summary = _selection_content_summary(
                        mmr_result,
                        content_index,
                    )
                    reduction_applicable, reduction = _near_duplicate_reduction(
                        baseline_summary,
                        mmr_summary,
                    )
                    mmr_redundancy = content_index.redundancy_summary(
                        [item.candidate.slot_id for item in mmr_result.selected]
                    )
                    if cache.initial_redundancy_summary is None:
                        cache.initial_redundancy_summary = mmr_redundancy
                    elif cache.diversity_supplemented:
                        cache.diversity_supplement_improved = (
                            mmr_redundancy.redundant_candidate_count
                            < cache.initial_redundancy_summary.redundant_candidate_count
                        )
                    cache.redundancy_summary = mmr_redundancy
                    cache.diversity_avoid_slot_ids = set(
                        mmr_redundancy.high_risk_candidate_ids
                    )
                    content_stats = content_index.stats
                    evaluated_count = len(mmr_result.selected) + len(anchors)
                    semantic_limit_count = _maximum_semantic_duplicates(evaluated_count)
                    semantic_evaluation = _semantic_evaluation(
                        mmr_redundancy,
                        evaluated_count,
                    )
                    cache.embedding_stage_metadata = {
                        "similarityMode": self.similarity_mode,
                        "selectionMethod": (
                            "CONTENT_CLUSTER_VECTOR_MMR"
                            if self.similarity_mode == "vector"
                            else "VECTOR_SHADOW"
                        ),
                        "mmrQualityWeight": mmr_quality_weight,
                        "mmrDiversityWeight": mmr_diversity_weight,
                        "adaptiveMmrApplied": mmr_quality_weight == 0.60,
                        "candidatePoolRedundancyRate": (
                            candidate_pool_redundancy_rate
                        ),
                        "contentNoveltyWeight": 0.70,
                        "clusterAwareNoveltyWeight": 0.30,
                        "fixedAnchorCount": len(anchors),
                        "embeddingInputCount": cache.embedding_remote_input_count,
                        "embeddingRequestCount": cache.embedding_request_count,
                        "embeddingInputTokens": cache.embedding_input_tokens,
                        "embeddingRetryCount": cache.embedding_retry_count,
                        "embeddingCacheHitCount": content_stats.cache_hit_count,
                        "comparisonCount": content_stats.comparison_count,
                        "embeddingDurationMs": round(cache.embedding_duration_ms, 3),
                        "localComparisonMs": round(
                            cache.embedding_local_comparison_ms, 3
                        ),
                        "contentSimilarityP50": content_stats.similarity_p50,
                        "contentSimilarityP95": content_stats.similarity_p95,
                        "vectorSelectionOverlapPercent": round(
                            100.0 * len(baseline_ids & mmr_ids) / denominator,
                            2,
                        ),
                        "vectorChangedItemCount": len(mmr_ids - baseline_ids),
                        "nearDuplicateRiskThreshold": (
                            VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD
                        ),
                        "semanticDuplicateLimitCount": semantic_limit_count,
                        "semanticEvaluationStatus": semantic_evaluation.status,
                        "semanticEvaluatedCount": semantic_evaluation.evaluated_count,
                        "semanticDuplicateGroupCount": (
                            semantic_evaluation.duplicate_group_count
                        ),
                        "semanticDuplicateCount": semantic_evaluation.duplicate_count,
                        "semanticDuplicateRate": semantic_evaluation.duplicate_rate,
                        "semanticDuplicateRateLimit": SEMANTIC_DUPLICATE_RATE_LIMIT,
                        "baselineSelection": baseline_summary,
                        "contentMmrSelection": mmr_summary,
                        "nearDuplicateReductionApplicable": reduction_applicable,
                        "nearDuplicateReductionPercent": reduction,
                        "nearDuplicateReductionBasis": ("PURE_QUALITY_BASELINE_TO_MMR"),
                        "finalGuardApplied": False,
                        "averageQualityDelta": round(
                            float(mmr_summary["averageQualityScore"])
                            - float(baseline_summary["averageQualityScore"]),
                            4,
                        ),
                        "initialHighRiskGroupCount": (
                            cache.initial_redundancy_summary.high_risk_group_count
                        ),
                        "initialRedundantCandidateCount": (
                            cache.initial_redundancy_summary.redundant_candidate_count
                        ),
                        "finalHighRiskGroupCount": (
                            mmr_redundancy.high_risk_group_count
                        ),
                        "finalHighRiskPairCount": mmr_redundancy.high_risk_pair_count,
                        "finalRedundantCandidateCount": (
                            mmr_redundancy.redundant_candidate_count
                        ),
                        "diversitySupplementTriggered": (cache.diversity_supplemented),
                        "diversitySupplementAttempted": (
                            cache.diversity_supplement_attempted
                        ),
                        "diversitySupplementCount": (cache.diversity_supplement_count),
                        "diversitySupplementDirectionCount": (
                            cache.diversity_supplement_direction_count
                        ),
                        "diversitySupplementImproved": (
                            cache.diversity_supplement_improved
                        ),
                        "highRiskPairs": content_stats.high_risk_pairs,
                    }
                    if self.similarity_mode == "vector":
                        result = mmr_result
                except EmbeddingProviderError as exc:
                    if self.similarity_mode == "vector":
                        setattr(exc, "node_id", NodeId.EXACT_SELECTION_AND_SUPPLEMENT)
                        raise
                    cache.embedding_warning = str(exc)
                    cache.embedding_stage_metadata = {
                        "similarityMode": "shadow",
                        "selectionMethod": "VECTOR_SHADOW_UNAVAILABLE",
                        "embeddingWarning": str(exc),
                    }
            elif len(eligible_candidates) > 1:
                if self.embedding_provider is None:
                    raise PipelineError(
                        "embedding provider is required for Prompt vector similarity"
                    )
                try:
                    insight = snapshot.insight_artifact.result
                    vector_index = await build_creative_vector_index(
                        eligible_candidates,
                        provider=self.embedding_provider,
                        vector_cache=cache.embedding_vectors,
                        product_name=_insight_text(
                            insight,
                            "productName",
                            "product_name",
                        ),
                        product_category=_insight_text(
                            insight,
                            "productCategory",
                            "product_category",
                        ),
                        shared_prompt=self._required_shared_prompt(context),
                        batch_size=self.embedding_batch_size,
                        max_concurrency=self.embedding_max_concurrency,
                    )
                    _trim_embedding_cache(cache.embedding_vectors)
                    vector_result = select_creatives(
                        list(cache.creatives.values()),
                        list(cache.creative_evaluations.values()),
                        target_count=selection_target,
                        required_fact_ids=required_fact_ids,
                        preferred_item_fact_ids=preferred_item_fact_ids,
                        fixed_covered_fact_ids=fixed_covered_fact_ids,
                        novelty_resolver=lambda left, right: vector_index.dual_novelty(
                            left.candidate.slot_id,
                            right.candidate.slot_id,
                        ),
                    )
                    content_result = select_creatives(
                        list(cache.creatives.values()),
                        list(cache.creative_evaluations.values()),
                        target_count=selection_target,
                        required_fact_ids=required_fact_ids,
                        preferred_item_fact_ids=preferred_item_fact_ids,
                        fixed_covered_fact_ids=fixed_covered_fact_ids,
                        novelty_resolver=lambda left, right: (
                            vector_index.content_novelty(
                                left.candidate.slot_id,
                                right.candidate.slot_id,
                            )
                        ),
                    )
                    baseline_ids = {
                        item.candidate.slot_id for item in baseline_result.selected
                    }
                    vector_ids = {
                        item.candidate.slot_id for item in vector_result.selected
                    }
                    content_ids = {
                        item.candidate.slot_id for item in content_result.selected
                    }
                    denominator = max(1, len(baseline_ids))
                    baseline_stats = vector_index.stats
                    baseline_summary = _selection_vector_summary(
                        baseline_result,
                        vector_index,
                    )
                    content_summary = _selection_vector_summary(
                        content_result,
                        vector_index,
                    )
                    vector_summary = _selection_vector_summary(
                        vector_result,
                        vector_index,
                    )
                    content_reduction_applicable, content_reduction = (
                        _near_duplicate_reduction(
                            baseline_summary,
                            content_summary,
                        )
                    )
                    vector_reduction_applicable, vector_reduction = (
                        _near_duplicate_reduction(
                            baseline_summary,
                            vector_summary,
                        )
                    )
                    cache.embedding_stage_metadata = {
                        "similarityMode": self.similarity_mode,
                        "selectionMethod": (
                            "VECTOR"
                            if self.similarity_mode == "vector"
                            else "VECTOR_SHADOW"
                        ),
                        "embeddingInputCount": baseline_stats.input_count,
                        "embeddingRequestCount": baseline_stats.request_count,
                        "embeddingInputTokens": baseline_stats.input_tokens,
                        "embeddingRetryCount": baseline_stats.retry_count,
                        "embeddingCacheHitCount": baseline_stats.cache_hit_count,
                        "comparisonCount": baseline_stats.comparison_count,
                        "embeddingDurationMs": baseline_stats.duration_ms,
                        "localComparisonMs": baseline_stats.local_comparison_ms,
                        "contentSimilarityP50": baseline_stats.content_p50,
                        "contentSimilarityP95": baseline_stats.content_p95,
                        "creativeSimilarityP50": baseline_stats.creative_p50,
                        "creativeSimilarityP95": baseline_stats.creative_p95,
                        "vectorSelectionOverlapPercent": round(
                            100.0 * len(baseline_ids & vector_ids) / denominator,
                            2,
                        ),
                        "contentSelectionOverlapPercent": round(
                            100.0 * len(baseline_ids & content_ids) / denominator,
                            2,
                        ),
                        "contentChangedItemCount": len(content_ids - baseline_ids),
                        "vectorChangedItemCount": len(vector_ids - baseline_ids),
                        "nearDuplicateRiskThreshold": (
                            VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD
                        ),
                        "baselineSelection": baseline_summary,
                        "contentVectorSelection": content_summary,
                        "dualVectorSelection": vector_summary,
                        "contentNearDuplicateReductionApplicable": (
                            content_reduction_applicable
                        ),
                        "contentNearDuplicateReductionPercent": content_reduction,
                        "vectorNearDuplicateReductionApplicable": (
                            vector_reduction_applicable
                        ),
                        "vectorNearDuplicateReductionPercent": vector_reduction,
                        "contentAverageQualityDelta": round(
                            float(content_summary["averageQualityScore"])
                            - float(baseline_summary["averageQualityScore"]),
                            4,
                        ),
                        "vectorAverageQualityDelta": round(
                            float(vector_summary["averageQualityScore"])
                            - float(baseline_summary["averageQualityScore"]),
                            4,
                        ),
                        "highRiskPairs": baseline_stats.high_risk_pairs,
                    }
                    if self.similarity_mode == "vector":
                        result = vector_result
                except EmbeddingProviderError as exc:
                    if self.similarity_mode == "vector":
                        setattr(exc, "node_id", NodeId.EXACT_SELECTION_AND_SUPPLEMENT)
                        raise
                    cache.embedding_warning = str(exc)
                    cache.embedding_stage_metadata = {
                        "similarityMode": "shadow",
                        "selectionMethod": "VECTOR_SHADOW_UNAVAILABLE",
                        "embeddingWarning": str(exc),
                    }
            else:
                cache.embedding_stage_metadata = {
                    "similarityMode": self.similarity_mode,
                    "selectionMethod": "SKIPPED_SINGLE_CANDIDATE",
                    "comparisonCount": 0,
                }
        eligible_evaluations = [
            evaluation
            for evaluation in cache.creative_evaluations.values()
            if not evaluation.hard_issues
        ]
        selected_evaluations = [item.evaluation for item in result.selected]
        pre_scene_share = max_cluster_share(eligible_evaluations, "scene_family")
        post_scene_share = max_cluster_share(selected_evaluations, "scene_family")
        pre_action_share = max_cluster_share(
            eligible_evaluations,
            "product_action_family",
        )
        post_action_share = max_cluster_share(
            selected_evaluations,
            "product_action_family",
        )
        dominant_scenes = dominant_families(selected_evaluations, "scene_family")
        cache.embedding_stage_metadata.update(
            {
                "selectedSemanticProfileDistribution": (
                    semantic_profile_distribution(selected_evaluations)
                ),
                "preSelectionMaxSceneShare": pre_scene_share,
                "postSelectionMaxSceneShare": post_scene_share,
                "preSelectionMaxActionShare": pre_action_share,
                "postSelectionMaxActionShare": post_action_share,
                "contentNoveltyWeight": 0.70,
                "clusterAwareNoveltyWeight": 0.30,
            }
        )
        cache.selected_creatives = result
        cache.exact_duplicate_count = result.exact_duplicate_count
        items = _prompt_items(
            context,
            result,
            self._require_application(context),
            (
                snapshot.target_item.target_duration_seconds
                if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item
                else settings.default_duration_seconds
            ),
            fact_visual_strategy=(
                self._required_fact_visual_strategy(context)
                if _uses_fact_visual_strategy(snapshot)
                else None
            ),
        )
        cache.accepted_items = (
            items
            if item_operation
            else [*_retained_items(snapshot.retained_manual_items), *items]
        )
        missing = max(0, selection_target - len(items))
        selected_covered_fact_ids = {
            fact_id
            for row in result.selected
            for fact_id in row.evaluation.realized_fact_ids
        }
        selected_covered_fact_ids.update(fixed_covered_fact_ids)
        missing_coverage_fact_ids = [
            fact_id
            for fact_id in required_fact_ids
            if fact_id not in selected_covered_fact_ids
        ]
        eligible_covered_fact_ids = {
            fact_id
            for evaluation in eligible_evaluations
            for fact_id in evaluation.realized_fact_ids
        }
        eligible_covered_fact_ids.update(fixed_covered_fact_ids)
        pool_missing_coverage_fact_ids = [
            fact_id
            for fact_id in required_fact_ids
            if fact_id not in eligible_covered_fact_ids
        ]
        should_quantity_supplement = (
            missing > 0
            and not cache.quantity_supplemented
            and cache.replenishment_rounds < MAX_REPLENISHMENT_ROUNDS
            and snapshot.operation != "ITEM_EVALUATE"
        )
        should_coverage_supplement = (
            not should_quantity_supplement
            and missing == 0
            and bool(pool_missing_coverage_fact_ids)
            and not cache.coverage_supplemented
            and cache.replenishment_rounds < MAX_REPLENISHMENT_ROUNDS
            and snapshot.operation == "BATCH_GENERATE"
        )
        current_redundancy = cache.redundancy_summary
        semantic_evaluated_count = len(cache.accepted_items)
        semantic_duplicate_limit_count = _maximum_semantic_duplicates(
            semantic_evaluated_count
        )
        dominant_actions = dominant_families(
            selected_evaluations,
            "product_action_family",
        )
        plan = cache.creative_direction_plan
        alternative_scene_exists = bool(
            plan
            and dominant_scenes
            and any(
                direction.semantic_profile.scene_family not in dominant_scenes
                for direction in plan.directions
            )
        )
        alternative_action_exists = bool(
            plan
            and dominant_actions
            and any(
                direction.semantic_profile.product_action_family not in dominant_actions
                for direction in plan.directions
            )
        )
        cluster_reasons = [
            *(
                [f"SCENE_CLUSTER_OVER_40_PERCENT:{','.join(dominant_scenes)}"]
                if alternative_scene_exists and post_scene_share > 0.40
                else []
            ),
            *(
                [f"ACTION_CLUSTER_OVER_40_PERCENT:{','.join(dominant_actions)}"]
                if alternative_action_exists and post_action_share > 0.40
                else []
            ),
        ]
        vector_diversity_needed = bool(
            current_redundancy is not None
            and current_redundancy.redundant_candidate_count
            > semantic_duplicate_limit_count
        )
        diversity_findings = [
            *(["VECTOR_NEAR_DUPLICATE_EXCESS"] if vector_diversity_needed else []),
            *cluster_reasons,
        ]
        should_diversity_supplement = (
            not should_quantity_supplement
            and not should_coverage_supplement
            and missing == 0
            and bool(diversity_findings)
            and not cache.diversity_supplemented
            and round_number < MAX_REPLENISHMENT_ROUNDS
            and snapshot.operation == "BATCH_GENERATE"
        )
        pending = []
        if should_quantity_supplement:
            pending = await self.plan_creatives(
                context,
                round_number=round_number + 1,
                missing_count=missing,
            )
        elif should_coverage_supplement:
            coverage_supplement_count = _coverage_supplement_count(
                selection_target,
                len(pool_missing_coverage_fact_ids),
            )
            pending = await self.plan_creatives(
                context,
                round_number=round_number + 1,
                requested_count=coverage_supplement_count,
                supplement_kind="COVERAGE",
                coverage_fact_ids=pool_missing_coverage_fact_ids,
            )
        elif should_diversity_supplement:
            if post_scene_share > 0.40:
                cache.diversity_avoid_scene_families.update(dominant_scenes)
            if post_action_share > 0.40:
                cache.diversity_avoid_action_families.update(dominant_actions)
            cache.diversity_supplement_reasons = diversity_findings
            diversity_supplement_count = max(
                1,
                math.ceil(selection_target * 0.20),
            )
            pending = await self.plan_creatives(
                context,
                round_number=round_number + 1,
                requested_count=diversity_supplement_count,
                supplement_kind="DIVERSITY",
            )
        # Capacity exhaustion may turn an intended supplement into an empty
        # plan. Only report PARTIAL when there is real work to execute; the
        # final coverage gate will otherwise retain the draft as NEEDS_REVIEW.
        should_supplement = bool(pending)
        selection_failed = missing > 0 and not should_supplement
        coverage_needs_review = (
            missing == 0 and bool(missing_coverage_fact_ids) and not should_supplement
        )
        if cache.embedding_stage_metadata:
            cache.embedding_stage_metadata.update(
                {
                    "initialCandidateCount": cache.candidate_target_count,
                    "finalCandidateCount": len(cache.creatives),
                    "diversitySupplementTriggered": (cache.diversity_supplemented),
                    "diversitySupplementAttempted": (
                        cache.diversity_supplement_attempted
                    ),
                    "diversitySupplementCount": (cache.diversity_supplement_count),
                    "diversitySupplementDirectionCount": (
                        cache.diversity_supplement_direction_count
                    ),
                    "diversitySupplementImproved": (
                        cache.diversity_supplement_improved
                    ),
                    "diversitySupplementReasons": cache.diversity_supplement_reasons,
                    "finalAccurateCount": len(cache.accepted_items),
                }
            )
        diversity_soft_warning = (
            "SEMANTIC_DIVERSITY_CAN_BE_IMPROVED"
            if missing == 0 and diversity_findings
            else None
        )
        stage_warnings = [
            warning
            for warning in (
                cache.embedding_warning,
                diversity_soft_warning,
                (
                    "REQUIRED_FACT_COVERAGE_NEEDS_REVIEW"
                    if coverage_needs_review
                    else None
                ),
                (
                    "DIVERSITY_SUPPLEMENT_NO_IMPROVEMENT"
                    if cache.diversity_supplemented
                    and cache.diversity_supplement_improved is False
                    else None
                ),
                (
                    "DIVERSITY_SUPPLEMENT_NOT_GENERATED"
                    if cache.diversity_supplement_attempted
                    and not cache.diversity_supplemented
                    else None
                ),
            )
            if warning
        ]
        await self._stage(
            context,
            NodeId.EXACT_SELECTION_AND_SUPPLEMENT,
            (
                StageStatus.PARTIAL
                if should_supplement
                else StageStatus.FAILED
                if selection_failed
                else StageStatus.SUCCEEDED
            ),
            (
                f"安全候选仍缺少 {missing} 条，已停止保存短批次"
                if selection_failed
                else "必用提炼事实尚未正确实现，正在定向补充"
                if should_coverage_supplement and should_supplement
                else "语义近似内容较集中，正在执行一次多样性补充"
                if should_diversity_supplement and should_supplement
                else "合格候选不足，正在执行数量补充"
                if should_quantity_supplement and should_supplement
                else "已选满目标数量，仍有必用事实待人工复核"
                if coverage_needs_review
                else "已按质量与语义多样性选满目标数量"
            ),
            metadata={
                "round": round_number,
                "acceptedCount": len(cache.accepted_items),
                "targetCount": 1 if item_operation else settings.target_count,
                "missingCount": missing,
                "missingRequiredFactCount": len(missing_coverage_fact_ids),
                "poolMissingRequiredFactCount": len(pool_missing_coverage_fact_ids),
                "coverageSupplementTriggered": cache.coverage_supplemented,
                "coverageSupplementCount": cache.coverage_supplement_count,
                "quantitySupplementTriggered": cache.quantity_supplemented,
                "quantitySupplementCount": cache.quantity_supplement_count,
                "coverageNeedsReview": coverage_needs_review,
                "initialCandidateCount": cache.candidate_target_count,
                "cumulativeCandidateCount": len(cache.creatives),
                "safeCandidateCount": len(eligible_evaluations),
                "selectedCandidateCount": len(result.selected),
                "hardRejectedCount": sum(
                    bool(item.hard_issues)
                    for item in cache.creative_evaluations.values()
                ),
                "eligibleNotSelectedCount": max(
                    0,
                    len(
                        [
                            item
                            for item in cache.creative_evaluations.values()
                            if not item.hard_issues
                        ]
                    )
                    - len(result.selected)
                    - result.exact_duplicate_count,
                ),
                "exactDuplicateCount": result.exact_duplicate_count,
                "supplemented": cache.supplemented,
                **cache.embedding_stage_metadata,
            },
            warnings=stage_warnings or None,
        )
        return pending, should_supplement

    async def save_result(self, context: RuntimeContext) -> str | None:
        cache = self._cache(context)
        snapshot = self.snapshot(context)
        settings = _current_settings(snapshot)
        items = cache.accepted_items
        item_operation = snapshot.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"}
        expected = (
            3
            if snapshot.operation == "ITEM_REGENERATE"
            else 1
            if snapshot.operation == "ITEM_EVALUATE"
            else settings.target_count
        )
        if snapshot.operation != "ITEM_EVALUATE" and len(items) != expected:
            exc = PipelineError(
                f"安全候选数量不足：目标 {expected} 条，实际 {len(items)} 条"
            )
            setattr(exc, "node_id", NodeId.EXACT_SELECTION_AND_SUPPLEMENT)
            raise exc
        selected = cache.selected_creatives.selected if cache.selected_creatives else []
        score_rows = [item.evaluation.scores for item in selected]
        hard_counts = Counter(
            issue for item in selected for issue in item.evaluation.hard_issues
        )
        warning_counts = Counter(
            warning for item in selected for warning in item.evaluation.warnings
        )
        average = _average_scores(score_rows)
        primary_distribution = Counter(item.primary_purpose for item in items)
        compatible_distribution = Counter(
            purpose for item in items for purpose in item.compatible_purposes
        )
        semantic_evaluated_count = (
            len(items) + len(snapshot.similarity_anchors)
            if item_operation
            else len(items)
        )
        semantic_evaluation = (
            _semantic_evaluation(
                cache.redundancy_summary,
                semantic_evaluated_count,
            )
            if cache.redundancy_summary is not None
            else _pending_semantic_evaluation()
        )
        if (
            semantic_evaluation.duplicate_rate is not None
            and semantic_evaluation.duplicate_rate >= SEMANTIC_DUPLICATE_RATE_LIMIT
        ):
            warning_counts["SEMANTIC_DIVERSITY_CAN_BE_IMPROVED"] += 1
        coverage = insight_coverage(
            self._require_application(context),
            items,
        )
        deep_business_fact_ids = {
            fact.fact_id
            for fact in mandatory_business_facts(self._require_application(context))
        }
        covered_fact_ids = {
            binding.fact_id for item in items for binding in item.insight_bindings
        }
        missing_business_fact_ids = deep_business_fact_ids - covered_fact_ids
        quality_status: Literal["PASS", "NEEDS_REVIEW"] = (
            "PASS"
            if len(items) == expected
            and all(item.classification_status == "VERIFIED" for item in items)
            and not any(row.evaluation.hard_issues for row in selected)
            and (item_operation or not missing_business_fact_ids)
            else "NEEDS_REVIEW"
        )
        metrics = PromptMetrics(
            target_count=settings.target_count,
            candidate_target_count=max(10, cache.candidate_target_count),
            generated_candidate_count=len(cache.creatives),
            accepted_count=len(items),
            rejected_count=max(0, len(cache.creatives) - len(selected)),
            replenishment_rounds=cache.replenishment_rounds,
            exact_duplicate_count=cache.exact_duplicate_count,
            semantic_evaluation=semantic_evaluation,
            purpose_distribution=[
                PurposeDistribution(
                    purpose=purpose,
                    primary_count=primary_distribution[purpose],
                    compatible_count=compatible_distribution[purpose],
                )
                for purpose in FragmentType
            ],
            average_scores=average,
            hard_issue_counts=[
                CountMetric(code=code, count=count)
                for code, count in sorted(hard_counts.items())
            ],
            warning_counts=[
                CountMetric(code=code, count=count)
                for code, count in sorted(warning_counts.items())
            ],
            insight_coverage=coverage,
        )
        result = PromptBatchResult(
            settings=settings,
            render_profile=_render_profile(snapshot.insight_artifact.result),
            shared_prompt=self._required_shared_prompt(context),
            items=[
                item.model_copy(update={"code": f"P{index:03d}"})
                for index, item in enumerate(items, 1)
            ],
            metrics=metrics,
            quality_status=quality_status,
        )
        semantic_audit = _semantic_audit(
            context,
            result.items,
            selected,
            cache.redundancy_summary,
            snapshot,
        )
        await self._stage(
            context,
            NodeId.RESULT_SAVE,
            StageStatus.RUNNING,
            "正在保存 Prompt 草稿",
            metadata={
                "batchSize": len(items),
                "qualityStatus": quality_status,
                "executionMode": self.provider.execution_mode,
                "semanticEvaluationStatus": semantic_evaluation.status,
                "semanticEvaluatedCount": semantic_evaluation.evaluated_count,
                "semanticDuplicateGroupCount": semantic_evaluation.duplicate_group_count,
                "semanticDuplicateCount": semantic_evaluation.duplicate_count,
                "semanticDuplicateRate": semantic_evaluation.duplicate_rate,
                "semanticDuplicateRateLimit": SEMANTIC_DUPLICATE_RATE_LIMIT,
                "requiredFactCount": len(coverage.required),
                "coveredRequiredFactCount": len(coverage.covered),
                "missingRequiredFactCount": len(coverage.missing),
                "hardRejectedCount": sum(
                    bool(item.hard_issues)
                    for item in cache.creative_evaluations.values()
                ),
                "exactDuplicateDroppedCount": cache.exact_duplicate_count,
                "eligibleNotSelectedCount": max(
                    0,
                    len(
                        [
                            item
                            for item in cache.creative_evaluations.values()
                            if not item.hard_issues
                        ]
                    )
                    - len(selected)
                    - cache.exact_duplicate_count,
                ),
                "itemsMissingDeepBusinessFact": sum(
                    not any(
                        binding.fact_id in deep_business_fact_ids
                        for binding in item.insight_bindings
                    )
                    for item in items
                ),
                "missingRequiredFacts": [
                    {"field": item.field.value, "value": item.value}
                    for item in coverage.missing
                ],
                "semanticAudit": semantic_audit,
            },
        )
        return await self.api.complete(
            context,
            result,
            execution_mode=self.provider.execution_mode,
        )

    def _reserve_ai_call(self, context: RuntimeContext) -> None:
        cache = self._cache(context)
        if cache.ai_call_count >= self.max_ai_calls_per_run:
            raise PipelineError("Prompt 子工作流 AI 调用次数超过安全上限")
        cache.ai_call_count += 1

    def _require_application(self, context: RuntimeContext) -> InsightApplicationMap:
        application = self._cache(context).insight_application
        if application is None:
            raise PipelineError("提炼信息用途映射尚未完成")
        return application

    def _required_fact_visual_strategy(
        self, context: RuntimeContext
    ) -> FactVisualStrategy:
        strategy = self._cache(context).fact_visual_strategy
        if strategy is None:
            raise PipelineError("事实视觉使用策略编译尚未完成")
        return strategy

    def _required_shared_prompt(self, context: RuntimeContext) -> SharedPrompt:
        prompt = self._cache(context).shared_prompt
        if prompt is None:
            raise PipelineError("共用提示词编译尚未完成")
        return prompt

    async def mark_failed(self, context: RuntimeContext, exc: Exception) -> None:
        retryable = (
            isinstance(
                exc,
                (InternalApiError, ProviderError, EmbeddingProviderError),
            )
            and exc.retryable
        )
        await self.api.fail(
            context,
            FailurePayload(
                error_code=_error_code(exc),
                error_message=_safe_error(exc),
                retryable=retryable,
                current_node=getattr(exc, "node_id", None),
            ),
        )

    async def progress(self, context: RuntimeContext, value: int, node: NodeId) -> None:
        await self.api.heartbeat(
            context, ProgressPayload(progress=value, current_node=node)
        )

    async def heartbeat(self, context: RuntimeContext) -> None:
        await self.api.heartbeat(context, ProgressPayload())

    async def _stage(
        self,
        context: RuntimeContext,
        node: NodeId,
        status: StageStatus,
        summary: str,
        *,
        metadata: dict[str, Any] | None = None,
        warnings: list[str] | None = None,
    ) -> None:
        await self.api.put_stage(
            context,
            StageOutput(
                node_id=node,
                status=status,
                summary=summary,
                warnings=warnings or [],
                metadata=metadata or {},
            ),
        )


def _creative_task_chunks(
    tasks: Sequence[CreativeTask],
    *,
    max_size: int,
) -> list[list[CreativeTask]]:
    """Pack sibling direction tasks together without interpreting their semantics."""

    if not tasks:
        return []
    size = max(1, min(5, max_size))
    direction_groups: dict[str, list[CreativeTask]] = {}
    for task in tasks:
        direction_id = (
            task.creative_direction.direction_id
            if task.creative_direction is not None
            else task.slot_id
        )
        direction_groups.setdefault(direction_id, []).append(task)

    chunks: list[list[CreativeTask]] = []
    for group in direction_groups.values():
        ordered = sorted(group, key=lambda item: item.ordinal)
        chunks.extend(
            ordered[start : start + size] for start in range(0, len(ordered), size)
        )
    return chunks


def _uses_fact_visual_strategy(snapshot: PromptGenerationSnapshot) -> bool:
    del snapshot
    return True


def _current_settings(snapshot: PromptGenerationSnapshot) -> PromptBatchSettings:
    if not isinstance(snapshot.settings, PromptBatchSettings):
        raise PipelineError("current run requires current Prompt settings")
    return snapshot.settings


def _selection_vector_summary(
    selection: CreativeSelectionResult,
    vector_index: CreativeVectorIndex,
) -> dict[str, Any]:
    selected = selection.selected
    selected_ids = [item.candidate.slot_id for item in selected]
    pair_risks = [
        vector_index.pair_similarity(left_id, right_id).risk
        for left_id, right_id in combinations(selected_ids, 2)
    ]
    dimensions = [item.candidate.dimensions for item in selected]
    dimension_unique_counts = {
        field_name: len(
            {
                normalize_creative_signature(getattr(item, field_name))
                for item in dimensions
            }
        )
        for field_name in (
            "narrative",
            "scene",
            "persona",
            "product_relation",
            "camera",
            "emotion",
        )
    }
    average_quality = (
        sum(item.quality_score for item in selected) / len(selected)
        if selected
        else 0.0
    )
    return {
        "selectedCount": len(selected),
        "averageQualityScore": round(average_quality, 4),
        "nearDuplicatePairCount": sum(
            risk >= VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD for risk in pair_risks
        ),
        "highestPairRisk": round(max(pair_risks), 4) if pair_risks else 0.0,
        "dimensionUniqueCounts": dimension_unique_counts,
        "dimensionUniqueTotal": sum(dimension_unique_counts.values()),
        "realizedFactCount": len(
            {
                fact_id
                for item in selected
                for fact_id in item.evaluation.realized_fact_ids
            }
        ),
    }


def _selection_content_summary(
    selection: CreativeSelectionResult,
    vector_index: ContentVectorIndex,
) -> dict[str, Any]:
    selected = selection.selected
    selected_ids = [item.candidate.slot_id for item in selected]
    redundancy = vector_index.redundancy_summary(selected_ids)
    fields = (
        "narrative",
        "scene",
        "persona",
        "product_relation",
        "camera",
        "emotion",
    )
    dimension_unique_counts = {
        field_name: len(
            {
                normalize_creative_signature(
                    getattr(item.candidate.dimensions, field_name)
                )
                for item in selected
            }
        )
        for field_name in fields
    }
    average_quality = (
        sum(item.quality_score for item in selected) / len(selected)
        if selected
        else 0.0
    )
    pair_risks = [
        vector_index.similarity(left_id, right_id)
        for left_id, right_id in combinations(selected_ids, 2)
    ]
    pair_risks.extend(
        vector_index.similarity(selected_id, anchor_id)
        for selected_id in selected_ids
        for anchor_id in vector_index.anchor_ids
    )
    return {
        "selectedCount": len(selected),
        "averageQualityScore": round(average_quality, 4),
        "nearDuplicatePairCount": redundancy.high_risk_pair_count,
        "redundantCandidateCount": redundancy.redundant_candidate_count,
        "highestPairRisk": round(max(pair_risks), 4) if pair_risks else 0.0,
        "dimensionUniqueCounts": dimension_unique_counts,
        "dimensionUniqueTotal": sum(dimension_unique_counts.values()),
        "realizedFactCount": len(
            {
                fact_id
                for item in selected
                for fact_id in item.evaluation.realized_fact_ids
            }
        ),
    }


def _maximum_semantic_duplicates(evaluated_count: int) -> int:
    if evaluated_count <= 0:
        return 0
    return max(
        0,
        math.ceil(evaluated_count * SEMANTIC_DUPLICATE_RATE_LIMIT / 100.0) - 1,
    )


def _coverage_supplement_count(
    selection_target: int,
    missing_fact_count: int,
) -> int:
    """Keep one coverage retry useful without letting it become another batch."""
    if selection_target <= 0 or missing_fact_count <= 0:
        return 0
    supplement_limit = max(
        1,
        math.ceil(selection_target * COVERAGE_SUPPLEMENT_RATIO),
    )
    desired = max(missing_fact_count + 1, missing_fact_count * 2)
    return min(supplement_limit, desired)


def _pending_semantic_evaluation() -> SemanticEvaluation:
    return SemanticEvaluation(
        status="PENDING",
        evaluated_count=0,
        duplicate_group_count=None,
        duplicate_count=None,
        duplicate_rate=None,
    )


def _semantic_evaluation(
    redundancy: RedundancySummary,
    evaluated_count: int,
) -> SemanticEvaluation:
    duplicate_rate = (
        round(100.0 * redundancy.redundant_candidate_count / evaluated_count, 2)
        if evaluated_count > 0
        else 0.0
    )
    return SemanticEvaluation(
        status="VERIFIED",
        evaluated_count=evaluated_count,
        duplicate_group_count=redundancy.high_risk_group_count,
        duplicate_count=redundancy.redundant_candidate_count,
        duplicate_rate=duplicate_rate,
    )


def _dimension_unique_gain(
    item: RankedCreative,
    selected: list[RankedCreative],
    anchors: list[PromptItem],
) -> int:
    fields = (
        "narrative",
        "scene",
        "persona",
        "product_relation",
        "camera",
        "emotion",
    )
    existing_dimensions = [
        *[row.candidate.dimensions for row in selected],
        *[anchor.dimensions for anchor in anchors],
    ]
    return sum(
        normalize_creative_signature(getattr(item.candidate.dimensions, field_name))
        not in {
            normalize_creative_signature(getattr(dimensions, field_name))
            for dimensions in existing_dimensions
        }
        for field_name in fields
    )


def _near_duplicate_reduction(
    baseline_summary: Mapping[str, Any],
    compared_summary: Mapping[str, Any],
) -> tuple[bool, float]:
    baseline_count = int(baseline_summary["nearDuplicatePairCount"])
    compared_count = int(compared_summary["nearDuplicatePairCount"])
    if baseline_count <= 0:
        return False, 0.0
    reduction = 100.0 * (baseline_count - compared_count) / baseline_count
    return True, round(reduction, 2)


_SEMANTIC_CONTEXT_FIELDS = {
    InsightField.TARGET_AUDIENCE,
    InsightField.CORE_PAIN_POINT,
    InsightField.DECISION_DRIVER,
    InsightField.MARKETING_GOAL,
    InsightField.CORE_SELLING_POINT,
    InsightField.SECONDARY_SELLING_POINT,
    InsightField.USAGE_SCENARIO,
    InsightField.PURCHASE_SCENARIO,
    InsightField.EMOTIONAL_SCENARIO,
}

_PRODUCT_CONTEXT_FIELDS = {
    InsightField.PRODUCT_NAME,
    InsightField.PRODUCT_CATEGORY,
    InsightField.CORE_SPECIFICATION,
    InsightField.VISUAL_FEATURES,
}


def _evaluation_context_fact_ids(
    candidate: CreativeCandidate,
    task: CreativeTask | None,
    application: InsightApplicationMap,
    *,
    item_evaluation: bool,
) -> list[str]:
    product_context_ids = [
        fact.fact_id
        for fact in application.usable
        if fact.field in _PRODUCT_CONTEXT_FIELDS
    ]
    if item_evaluation:
        return list(
            dict.fromkeys(
                [
                    *[fact.fact_id for fact in application.usable],
                ]
            )
        )
    if task is None or task.fact_assignment is None:
        return []
    assignment = task.fact_assignment
    return list(
        dict.fromkeys(
            [
                *[
                    fact_id
                    for fact_id in assignment.fact_ids
                    if fact_id in application.by_id
                    and application.by_id[fact_id].field in _SEMANTIC_CONTEXT_FIELDS
                ],
                *product_context_ids,
            ]
        )
    )


def _prompt_items(
    context: RuntimeContext,
    selection: CreativeSelectionResult,
    application: InsightApplicationMap,
    default_duration_seconds: int,
    *,
    fact_visual_strategy: FactVisualStrategy | None,
) -> list[PromptItem]:
    del fact_visual_strategy
    result: list[PromptItem] = []
    mandatory_business_ids = {
        fact.fact_id for fact in mandatory_business_facts(application)
    }
    for row in selection.selected:
        candidate = row.candidate
        evaluation = row.evaluation
        bindings: list[InsightBinding] = []
        ordered_fact_ids = sorted(
            evaluation.realized_fact_ids,
            key=lambda fact_id: (
                0
                if fact_id in mandatory_business_ids
                else 1
                if application.by_id.get(fact_id) is not None
                and application.by_id[fact_id].field
                in {InsightField.PRODUCT_NAME, InsightField.PRODUCT_CATEGORY}
                else 2,
                evaluation.realized_fact_ids.index(fact_id),
            ),
        )[:5]
        for fact_id in ordered_fact_ids:
            fact = application.by_id.get(fact_id)
            if fact is None:
                continue
            bindings.append(
                InsightBinding(
                    fact_id=fact.fact_id,
                    field=fact.field,
                    value=fact.value,
                    value_hash=fact.value_hash,
                    role=fact.preferred_role,
                )
            )
        timestamp = candidate.generated_at or utc_now()
        result.append(
            PromptItem(
                id=_stable_item_id(context.source_fingerprint, candidate.slot_id),
                code=f"P{candidate.ordinal:03d}",
                origin="AI",
                fragment_type=evaluation.primary_purpose,
                primary_purpose=evaluation.primary_purpose,
                compatible_purposes=evaluation.compatible_purposes,
                classification_status=(
                    "NEEDS_REVISION" if evaluation.hard_issues else "VERIFIED"
                ),
                product_relevance=round(evaluation.scores.product_relevance),
                target_duration_seconds=default_duration_seconds,
                creative_core=candidate.creative_core,
                dimensions=candidate.dimensions,
                content=candidate.content,
                insight_bindings=bindings,
                review_issues=list(evaluation.hard_issues)[:10],
                manual_edited=False,
                created_at=timestamp,
                updated_at=timestamp,
            )
        )
    return result


def _retained_items(
    retained: list[PromptItem],
) -> list[PromptItem]:
    result: list[PromptItem] = []
    for item in retained:
        if isinstance(item, PromptItem):
            result.append(item)
            continue
        result.append(
            PromptItem(
                id=item.id,
                code=item.code,
                origin=item.origin,
                fragment_type=item.fragment_type,
                primary_purpose=item.fragment_type,
                compatible_purposes=[item.fragment_type],
                classification_status="PENDING",
                product_relevance=0,
                target_duration_seconds=item.target_duration_seconds,
                creative_core=item.dimensions.narrative,
                dimensions=CreativeDimensions(
                    narrative=item.dimensions.narrative,
                    scene=item.dimensions.scene,
                    persona=item.dimensions.persona,
                    product_relation=item.dimensions.selling_point,
                    camera=item.dimensions.camera,
                    emotion=item.dimensions.emotion,
                ),
                content=item.content,
                insight_bindings=item.insight_bindings,
                manual_edited=item.manual_edited,
                created_at=item.created_at,
                updated_at=item.updated_at,
            )
        )
    return result


def _average_scores(rows: list[CreativeScores]) -> CreativeAverageScores:
    if not rows:
        return CreativeAverageScores(
            product_relevance=0,
            creative_coherence=0,
            visual_executability=0,
            commercial_usefulness=0,
            visual_clarity=0,
        )

    def average(values: list[float]) -> float:
        return round(sum(values) / len(values), 2)

    return CreativeAverageScores(
        product_relevance=average([item.product_relevance for item in rows]),
        creative_coherence=average([item.creative_coherence for item in rows]),
        visual_executability=average([item.visual_executability for item in rows]),
        commercial_usefulness=average([item.commercial_usefulness for item in rows]),
        visual_clarity=average([item.visual_clarity for item in rows]),
    )


def _stable_item_id(source_fingerprint: str, slot_id: str) -> str:
    digest = hashlib.sha256(f"{source_fingerprint}:{slot_id}".encode()).digest()[:16]
    # Set RFC 4122 version/variant bits while retaining deterministic replay identity.
    return str(uuid.UUID(bytes=digest, version=4))


def _semantic_audit(
    context: RuntimeContext,
    items: list[PromptItem],
    selected: list[RankedCreative],
    summary: RedundancySummary | None,
    snapshot: PromptGenerationSnapshot,
) -> dict[str, Any] | None:
    """Persist only hashes and duplicate edges needed for safe delete recalculation."""
    if summary is None:
        return None

    item_operation = snapshot.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"}
    candidate_item_ids: dict[str, str] = {}
    if item_operation and snapshot.target_item is not None:
        candidate_item_ids.update(
            {row.candidate.slot_id: snapshot.target_item.id for row in selected}
        )
    else:
        candidate_item_ids.update(
            {
                row.candidate.slot_id: _stable_item_id(
                    context.source_fingerprint,
                    row.candidate.slot_id,
                )
                for row in selected
            }
        )

    all_items = (
        {snapshot.target_item.id: items[0]}
        if item_operation and snapshot.target_item is not None and len(items) == 1
        else {item.id: item for item in items}
    )
    for anchor in snapshot.similarity_anchors:
        if isinstance(anchor, PromptItem):
            all_items[anchor.id] = anchor

    def public_id(entity_id: str) -> str | None:
        if entity_id.startswith("anchor:"):
            return entity_id.removeprefix("anchor:")
        return candidate_item_ids.get(entity_id)

    duplicate_pairs: list[dict[str, str]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for left_entity_id, right_entity_id in summary.high_risk_pairs:
        left_id = public_id(left_entity_id)
        right_id = public_id(right_entity_id)
        if (
            left_id is None
            or right_id is None
            or left_id == right_id
            or left_id not in all_items
            or right_id not in all_items
        ):
            continue
        ordered_ids = sorted((left_id, right_id))
        pair = (ordered_ids[0], ordered_ids[1])
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        duplicate_pairs.append({"leftItemId": pair[0], "rightItemId": pair[1]})

    evaluated_items = [
        {
            "itemId": item_id,
            "contentHash": _semantic_content_hash(item.content),
        }
        for item_id, item in sorted(all_items.items())
    ]
    fingerprint = _sha256_json(evaluated_items)
    return {
        "schemaVersion": 1,
        "similarityThreshold": VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD,
        "evaluatedItems": evaluated_items,
        "duplicatePairs": duplicate_pairs,
        "contentFingerprint": fingerprint,
    }


def _semantic_content_hash(content: str) -> str:
    return _sha256_text(unicodedata.normalize("NFKC", content).strip())


def _trim_embedding_cache(cache: dict[str, tuple[float, ...]]) -> None:
    overflow = len(cache) - MAX_PROCESS_EMBEDDING_CACHE_ENTRIES
    for key in list(cache)[: max(0, overflow)]:
        cache.pop(key, None)


def _normalized_disabled_elements(values: list[str]) -> list[str]:
    unique: dict[str, str] = {}
    for value in values:
        cleaned = re.sub(r"[。；;，,]+$", "", " ".join(value.split())).strip()
        if not cleaned:
            continue
        key = unicodedata.normalize("NFKC", cleaned).casefold()
        unique.setdefault(key, cleaned)
    return list(unique.values())


def _compile_disabled_elements_prompt(disabled_elements: list[str]) -> str:
    if not disabled_elements:
        return ""
    return f"画面中不得出现以下内容：{'；'.join(disabled_elements)}。"


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _sha256_json(value: object) -> str:
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return _sha256_text(serialized)


def _shared_prompt_section_content(prompt: SharedPrompt | None, key: str) -> str:
    if prompt is None:
        return ""
    return next(
        (section.content.strip() for section in prompt.sections if section.key == key),
        "",
    )


def _compile_shared_prompt(
    disabled_elements: list[str], additional_content: str = ""
) -> SharedPrompt:
    additional = additional_content.strip()
    sections = [
        SharedPromptSection(
            key="DISABLED_ELEMENTS",
            title="禁用元素",
            source="SYSTEM",
            content=_compile_disabled_elements_prompt(disabled_elements),
            editable=False,
            source_hash=_sha256_json(disabled_elements),
        ),
        SharedPromptSection(
            key="USER_ADDITIONAL",
            title="补充共用内容",
            source="USER",
            content=additional,
            editable=True,
            source_hash=_sha256_text(additional),
        ),
    ]
    compiled = "\n".join(section.content for section in sections if section.content)
    return SharedPrompt(
        sections=sections,
        compiled_content=compiled,
        content_hash=_sha256_text(compiled),
    )


def _render_profile(insight: Mapping[str, object]) -> RenderProfile:
    ratio_raw = (
        _insight_text(insight, "aspectRatio", "aspect_ratio") or "9:16"
    ).replace("：", ":")
    if ratio_raw not in {"16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"}:
        raise PipelineError(f"Seedance 不支持当前画幅：{ratio_raw}")
    resolution_raw = (_insight_text(insight, "resolution") or "720p").lower()
    if resolution_raw not in {"480p", "720p", "1080p"}:
        raise PipelineError(f"Seedance 不支持当前分辨率：{resolution_raw}")
    disabled = _normalized_disabled_elements(
        _insight_list(insight, "disabledElements", "disabled_elements")
    )
    digest = _sha256_json(disabled)
    return RenderProfile(
        ratio=cast(
            Literal["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
            ratio_raw,
        ),
        resolution=cast(Literal["480p", "720p", "1080p"], resolution_raw),
        capability_key="SEEDANCE_2_0",
        shared_constraints=SharedRenderConstraints(
            disabled_elements=disabled,
            content_hash=digest,
        ),
    )


def _safe_error(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "Prompt 子工作流数据结构校验失败"
    if isinstance(exc, ProviderError):
        return {
            "AI_TIMEOUT": "Prompt AI 生成超时",
            "AI_NETWORK": "Prompt AI 连接失败",
            "AI_RATE_LIMIT": "Prompt AI 服务繁忙，请稍后重试",
            "AI_SERVICE": "Prompt AI 服务暂时不可用",
            "AI_OUTPUT_TRUNCATED": "Prompt AI 输出超过长度限制，任务已停止",
            "AI_RESPONSE_INCOMPLETE": "Prompt AI 响应未完整返回，任务已停止",
            "AI_RESPONSE_INVALID": "Prompt AI 返回格式异常",
            "AI_REQUEST_REJECTED": "Prompt AI 请求被拒绝",
            "AI_UNKNOWN": "Prompt AI 生成失败",
        }.get(exc.error_type.value, "Prompt AI 生成失败")
    if isinstance(exc, EmbeddingProviderError):
        return str(exc)
    if isinstance(exc, InternalApiError):
        return "内部服务暂时不可用" if exc.retryable else "内部服务拒绝了任务更新"
    message = " ".join(str(exc).split())
    return (message or type(exc).__name__)[:500]


def _error_code(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "VALIDATION_ERROR"
    if isinstance(exc, ProviderError):
        return exc.error_type.value
    if isinstance(exc, EmbeddingProviderError):
        return (
            "EMBEDDING_SERVICE_UNAVAILABLE"
            if exc.retryable
            else "EMBEDDING_RESPONSE_INVALID"
        )
    if isinstance(exc, InternalApiError):
        return "INTERNAL_API_UNAVAILABLE" if exc.retryable else "INTERNAL_API_REJECTED"
    return type(exc).__name__.upper()[:100]


def _core_selling_points(insight: Mapping[str, object]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for key in ("coreSellingPoints", "core_selling_points"):
        raw = insight.get(key)
        values = raw if isinstance(raw, list) else []
        for item in values:
            if isinstance(item, str) and (value := " ".join(item.split())):
                normalized = _normalized(value)
                if normalized not in seen:
                    seen.add(normalized)
                    result.append(value)
    return result


def _normalized(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value).strip().casefold())


def _insight_text(insight: Mapping[str, object], *keys: str) -> str | None:
    for key in keys:
        value = insight.get(key)
        if isinstance(value, str) and (cleaned := " ".join(value.split())):
            return cleaned
    return None


def _insight_list(insight: Mapping[str, object], *keys: str) -> list[str]:
    result: list[str] = []
    for key in keys:
        value = insight.get(key)
        if isinstance(value, list):
            result.extend(
                cleaned
                for item in value
                if isinstance(item, str) and (cleaned := " ".join(item.split()))
            )
    return list(dict.fromkeys(result))


def _source_fact_texts(insight: Mapping[str, object]) -> list[str]:
    result: list[str] = []
    for value in insight.values():
        if isinstance(value, (str, int, float, bool)):
            result.append(str(value))
        elif isinstance(value, list):
            result.extend(
                str(item) for item in value if isinstance(item, (str, int, float, bool))
            )
    return result


def _short(value: str, limit: int = 180) -> str:
    return " ".join(value.split())[:limit]
