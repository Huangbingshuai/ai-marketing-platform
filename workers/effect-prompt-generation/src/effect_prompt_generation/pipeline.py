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
from typing import Any, Callable, Literal

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
    CreativeDirectionReviewProgress,
    CreativeDirectionAuditResponse,
    CreativeDirectionDiversityAudit,
    CreativeDirectionResponse,
    CreativeDiversityLandscape,
    CreativeDiversityLandscapeResponse,
    CreativeLandscapeAuditResponse,
    CreativeTerritory,
    CreativeTerritoryDraft,
    CreativeDimensions,
    CreativeEvaluation,
    ExecutionRepairCheckpoint,
    CreativeScores,
    CreativeShardPlan,
    CreativeTask,
    FailurePayload,
    FragmentType,
    FactVisualStrategy,
    FactVisualStrategyResponse,
    FactVisualUsage,
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
    AiCallResult,
    AiProvider,
    CREATIVE_DIRECTION_TEMPLATE_HASH,
    FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
    ProviderError,
    ProviderErrorType,
)
from .product_images import (
    PreparedProductImage,
    ProductImageProcessingError,
    ProductImageProcessor,
)
from .creative_directions import (
    apply_creative_landscape_audit,
    allocate_creative_directions,
    complete_semantic_profile,
    compile_creative_landscape_assignments,
    creative_direction_audit_revision_context,
    creative_fact_assignment_revision_context,
    creative_landscape_audit_revision_context,
    merge_creative_landscape_territory_revision,
    merge_creative_direction_revision,
    creative_direction_revision_context,
    creative_execution_route_target_count,
    creative_direction_target_count,
    creative_direction_source_hash,
    dominant_families,
    extend_creative_direction_plan,
    max_cluster_share,
    semantic_cluster_novelty,
    semantic_profile_distribution,
    validate_creative_direction_diversity_audit,
    validate_creative_direction_audit_batch,
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
from .direction_review import review_batches, review_hash, review_input_size
from .supplement_recovery import retain_valid_supplements
from .supplement_actions import supplement_review_landscape
from .execution_repair import (
    restore_execution_candidate,
    apply_execution_patch, candidate_hash, has_execution_diagnosis, repair_improves,
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
from .reliability import (
    creative_shard_size,
    evaluation_chunk_input_tokens,
    evaluation_chunks,
    evaluation_duration_max_size,
)

# Quantity recovery and business-fact recovery are separate concerns. Each may
# run once; repeatedly chasing an evaluator's unresolved fact finding only
# amplifies model variance and cost.
MAX_REPLENISHMENT_ROUNDS = 2
COVERAGE_SUPPLEMENT_RATIO = 0.20
SEMANTIC_DUPLICATE_RATE_LIMIT = 15.0
# Diversity recovery and the user-visible quality target use one boundary.
# A second, looser trigger allowed a 30% result to stop even though the page
# correctly reported that the 15% target was not met.
DIVERSITY_SUPPLEMENT_TRIGGER_RATE = SEMANTIC_DUPLICATE_RATE_LIMIT
MMR_HIGH_REDUNDANCY_THRESHOLD = 0.50
CONTENT_SIMILARITY_WEIGHT = 0.70
SEMANTIC_CLUSTER_SIMILARITY_WEIGHT = 0.30
DIRECTION_STRUCTURED_BATCH_SIZE = 4
# Each direction now includes up to five AI-authored execution routes and their
# event outlines. Eight directions can exhaust the 8192-token response budget
# even with valid JSON. Bound initial calls like targeted repairs; preserve all
# direction slots/routes and the global review rather than shorten the content.
DIRECTION_PLANNING_BATCH_SIZE = 4
# Keep ordinary calls economical. If a three-item strict response is malformed
# or truncated, the pipeline automatically isolates that shard into single-item
# calls instead of failing the entire batch.
CLASSIFICATION_SHARD_SIZE = 4
MAX_PROCESS_EMBEDDING_CACHE_ENTRIES = 4_096
LOGGER = logging.getLogger(__name__)
PENDING_CREATIVE_STRUCTURE_TEXT = "等待 AI 自动补齐"
PENDING_CREATIVE_STRUCTURE_TEXTS = {"等待 AI 分析", PENDING_CREATIVE_STRUCTURE_TEXT}


def _requires_creative_structure_inference(candidate: CreativeCandidate) -> bool:
    values = (
        candidate.creative_core,
        candidate.dimensions.narrative,
        candidate.dimensions.scene,
        candidate.dimensions.persona,
        candidate.dimensions.product_relation,
        candidate.dimensions.camera,
        candidate.dimensions.emotion,
    )
    return any(value.strip() in PENDING_CREATIVE_STRUCTURE_TEXTS for value in values)


@dataclass(frozen=True)
class DirectionPlanningBatch:
    territories: tuple[CreativeTerritory, ...]
    slots: tuple[dict[str, str], ...]
    required_fact_ids: tuple[str, ...]


def _creative_direction_planning_batches(
    landscape: CreativeDiversityLandscape,
    *,
    batch_size: int = DIRECTION_PLANNING_BATCH_SIZE,
) -> list[DirectionPlanningBatch]:
    """Pack stable direction slots without making any semantic decisions."""

    if batch_size < 1:
        raise ValueError("direction planning batch size must be positive")
    rows: list[tuple[CreativeTerritory, dict[str, str], list[str]]] = []
    next_direction_ordinal = 1
    for territory in landscape.territories:
        slot_fact_ids: list[list[str]] = [
            [] for _ in range(territory.target_slots)
        ]
        for fact_index, fact_id in enumerate(territory.required_fact_ids):
            slot_fact_ids[fact_index % territory.target_slots].append(fact_id)
        for slot_index in range(territory.target_slots):
            rows.append(
                (
                    territory,
                    {
                        "directionId": (
                            f"direction-{next_direction_ordinal + slot_index:02d}"
                        ),
                        "territoryId": territory.territory_id,
                        "primaryActionId": territory.actions[slot_index].action_id,
                    },
                    slot_fact_ids[slot_index],
                )
            )
        next_direction_ordinal += territory.target_slots

    batches: list[DirectionPlanningBatch] = []
    for start in range(0, len(rows), batch_size):
        batch_rows = rows[start : start + batch_size]
        scoped_rows: dict[str, list[tuple[dict[str, str], list[str]]]] = {}
        territory_by_id: dict[str, CreativeTerritory] = {}
        for territory, slot, fact_ids in batch_rows:
            territory_by_id[territory.territory_id] = territory
            scoped_rows.setdefault(territory.territory_id, []).append(
                (slot, fact_ids)
            )
        scoped_territories = tuple(
            territory_by_id[territory_id].model_copy(
                update={
                    "target_slots": len(territory_rows),
                    "required_fact_ids": [
                        fact_id
                        for _, fact_ids in territory_rows
                        for fact_id in fact_ids
                    ],
                }
            )
            for territory_id, territory_rows in scoped_rows.items()
        )
        batches.append(
            DirectionPlanningBatch(
                territories=scoped_territories,
                slots=tuple(slot for _, slot, _ in batch_rows),
                required_fact_ids=tuple(
                    fact_id
                    for _, _, fact_ids in batch_rows
                    for fact_id in fact_ids
                ),
            )
        )
    return batches


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
    execution_repair_records: dict[str, CreativeEvaluation] = field(default_factory=dict)
    total_shards: int = 0
    insight_application: InsightApplicationMap | None = None
    fact_visual_strategy: FactVisualStrategy | None = None
    shared_prompt: SharedPrompt | None = None
    creative_direction_plan: CreativeDirectionPlan | None = None
    creative_direction_call_metadata: dict[str, Any] = field(default_factory=dict)
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
    evaluation_call_count: int = 0
    evaluation_split_recovery_count: int = 0
    direction_repair_count: int = 0
    final_required_fact_ids: list[str] = field(default_factory=list)
    final_covered_fact_ids: list[str] = field(default_factory=list)
    final_missing_fact_ids: list[str] = field(default_factory=list)


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
        candidate_max_output_tokens: int = 8_192,
        evaluation_max_output_tokens: int = 6_144,
        evaluation_input_token_budget: int = 12_000,
        max_ai_calls_per_run: int = 256,
        direction_review_batch_size: int = 6,
        direction_review_input_budget: int = 12000,
        product_image_processor: ProductImageProcessor | None = None,
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
        self.candidate_max_output_tokens = candidate_max_output_tokens
        self.evaluation_max_output_tokens = evaluation_max_output_tokens
        self.evaluation_input_token_budget = evaluation_input_token_budget
        self.max_ai_calls_per_run = max_ai_calls_per_run
        self.direction_review_batch_size = direction_review_batch_size
        self.direction_review_input_budget = direction_review_input_budget
        self.product_image_processor = product_image_processor
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
        preflight = self._preflight_run(context)
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
        durations = {task.slot_id: task.target_duration_seconds
                     for shard in succeeded_creatives for task in shard.creative_plan}
        invalid_classification_keys: set[str] = set()
        for shard in shards:
            if shard.phase != ShardPhase.CLASSIFICATION:
                continue
            for evaluation in shard.evaluations:
                checkpoint = evaluation.execution_repair
                original = cache.creatives.get(evaluation.slot_id)
                if checkpoint is None or original is None:
                    continue
                restored = restore_execution_candidate(
                    original, evaluation, duration=durations.get(original.slot_id, 5),
                )
                if restored is None:
                    invalid_classification_keys.add(shard.key)
                    cache.creative_evaluations.pop(evaluation.slot_id, None)
                    continue
                cache.execution_repair_records[evaluation.slot_id] = evaluation
                cache.creatives[evaluation.slot_id] = restored
        cache.completed_creative_shard_keys = {item.key for item in succeeded_creatives}
        cache.completed_classification_shard_keys = {
            item.key for item in succeeded_classifications if item.key not in invalid_classification_keys
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
                item.key for item in succeeded_classifications if item.key not in invalid_classification_keys
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
                "resumedClassificationShardCount": len(cache.completed_classification_shard_keys),
                **preflight,
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

    def _preflight_run(self, context: RuntimeContext) -> dict[str, int | str]:
        snapshot = self.snapshot(context)
        if snapshot.operation != "BATCH_GENERATE":
            return {"preflightStatus": "PASSED"}
        settings = _current_settings(snapshot)
        generated_target = math.ceil(
            max(0, settings.target_count - len(snapshot.retained_manual_items)) * 1.4
        )
        generation_shard_size = _creative_shard_size_for_duration(
            settings.default_duration_seconds,
            configured_max_size=self.shard_size,
            max_output_tokens=self.candidate_max_output_tokens,
        )
        generation_calls = math.ceil(generated_target / generation_shard_size)
        planned_evaluation_shard_size = min(
            CLASSIFICATION_SHARD_SIZE,
            evaluation_duration_max_size(settings.default_duration_seconds),
        )
        evaluation_calls = math.ceil(
            generated_target / planned_evaluation_shard_size
        )
        # The deterministic check reserves a small allowance for visual strategy,
        # creative-space planning and direction audits. Supplements are protected
        # later by the same per-run call counter because they depend on real output.
        minimum_calls = generation_calls + evaluation_calls + 6
        if minimum_calls > self.max_ai_calls_per_run:
            raise PipelineError(
                "Prompt run configuration cannot fit the initial batch within the AI call budget"
            )
        return {
            "preflightStatus": "PASSED",
            "plannedInitialCandidateCount": generated_target,
            "plannedCreativeShardSize": generation_shard_size,
            "plannedEvaluationShardSize": planned_evaluation_shard_size,
            "plannedMinimumAiCallCount": minimum_calls,
        }

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
        snapshot = self.snapshot(context)
        source_content_hash = (
            snapshot.fact_visual_strategy_source_hash
            or snapshot.insight_artifact.content_hash
        )
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
            product_images = await self._prepare_product_images(context)
            for invalid_response_attempt in range(2):
                self._reserve_ai_call(context)
                try:
                    async with self._ai_semaphore:
                        if product_images:
                            call = await self.provider.compile_fact_visual_strategy(
                                application,
                                product_images=product_images,
                            )
                        else:
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
        metadata.update(
            {
                "referenceImageCount": len(snapshot.product_images),
                "referenceMode": (
                    "MULTIMODAL" if snapshot.product_images else "FACTS_ONLY"
                ),
            }
        )
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

    async def _prepare_product_images(
        self,
        context: RuntimeContext,
    ) -> list[PreparedProductImage]:
        references = self.snapshot(context).product_images
        if not references:
            return []
        if self.product_image_processor is None:
            raise PipelineError("商品参考图处理器未配置")

        prepared: list[PreparedProductImage] = []
        for reference in references:
            content = await self.api.download_product_image(
                context,
                reference.file_object_id,
            )
            if len(content) != reference.size_bytes:
                raise PipelineError("商品参考图内容长度与任务快照不一致")
            if hashlib.sha256(content).hexdigest().casefold() != reference.sha256.casefold():
                raise PipelineError("商品参考图内容校验失败")
            try:
                image = await asyncio.to_thread(
                    self.product_image_processor.process,
                    content,
                )
            except ProductImageProcessingError as exc:
                raise PipelineError(str(exc)) from exc
            prepared.append(image)
        return prepared

    async def compile_shared_prompt(self, context: RuntimeContext) -> SharedPrompt:
        await self._stage(
            context,
            NodeId.SHARED_PROMPT_COMPILATION,
            StageStatus.RUNNING,
            "正在编译批次共用提示词",
        )
        disabled = _normalized_disabled_elements(
            self.snapshot(context).settings.disabled_elements
        )
        prompt = _compile_shared_prompt(disabled)
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
                "hasUserAdditionalContent": False,
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
        full_application = self._require_application(context)
        full_visual_strategy = self._required_fact_visual_strategy(context)
        application, visual_strategy = _silent_material_planning_inputs(
            full_application,
            full_visual_strategy,
        )
        shared_prompt = self._required_shared_prompt(context)
        mandatory_fact_count = len(mandatory_business_facts(application))
        try:
            expected_direction_count = creative_direction_target_count(
                snapshot.settings.target_count,
                mandatory_fact_count,
            )
        except ValueError as exc:
            raise PipelineError(str(exc)) from exc
        expected_execution_route_count = creative_execution_route_target_count(
            math.ceil(snapshot.settings.target_count * 1.4),
            expected_direction_count,
        )
        validated_execution_route_count = (
            expected_execution_route_count
            if self.provider.execution_mode == "ARK"
            else None
        )
        source_hash = creative_direction_source_hash(
            insight_content_hash=snapshot.insight_artifact.content_hash,
            # Any upstream strategy change invalidates this Run checkpoint,
            # including a fact moving into or out of the deferred copy-only set.
            visual_strategy_hash=full_visual_strategy.strategy_hash,
            shared_prompt_hash=shared_prompt.content_hash,
            target_count=snapshot.settings.target_count,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        )
        checkpoint = cache.strategy_checkpoints.get(NodeId.COHERENT_CREATIVE_GENERATION)
        plan: CreativeDirectionPlan | None = None
        review_resume: CreativeDirectionPlan | None = None
        review_fingerprint = review_hash({
            "sourceHash": source_hash,
            "sourceFingerprint": context.source_fingerprint,
            "settings": snapshot.settings.model_dump(mode="json", by_alias=True),
            "templateHash": CREATIVE_DIRECTION_TEMPLATE_HASH,
        })
        restored_audit = None
        restored_diversity_audit = None
        reused = False
        if (
            checkpoint is not None
            and isinstance(checkpoint.plan, CreativeDirectionPlan)
            and checkpoint.plan.landscape is not None
            and checkpoint.plan.landscape.semantic_audit is not None
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
                    expected_execution_route_count=validated_execution_route_count,
                    landscape=restored_landscape,
                )
                if (
                    checkpoint.plan.semantic_audit is not None
                    and checkpoint.plan.diversity_audit is not None
                ):
                    restored_audit = validate_creative_direction_audit(
                        CreativeDirectionAuditResponse(
                            items=checkpoint.plan.semantic_audit.items,
                            requires_revision=checkpoint.plan.semantic_audit.requires_revision,
                            revision_direction_ids=checkpoint.plan.semantic_audit.revision_direction_ids,
                            summary=checkpoint.plan.semantic_audit.summary,
                        ),
                        restored,
                        restored_landscape,
                    )
                    restored_diversity_audit = validate_creative_direction_diversity_audit(
                        checkpoint.plan.diversity_audit,
                        restored.directions,
                    )
                progress = checkpoint.plan.review_progress
                if (
                    progress is not None
                    and progress.run_id == context.run_id
                    and progress.request_fingerprint == review_fingerprint
                    and restored.plan_hash == checkpoint.allocation_hash
                    and not restored_landscape_audit.requires_revision
                ):
                    review_resume = restored.model_copy(update={"review_progress": progress})
            except ValueError:
                restored = None
            if (
                restored is not None
                and restored_audit is not None
                and restored_diversity_audit is not None
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
        call_metadata: dict[str, Any] = {}
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
            planning_call_counts: Counter[str] = Counter()
            direction_planning_batch_count = 0
            direction_audit_batch_count = 0
            landscape = review_resume.landscape if review_resume is not None else None
            landscape_revision_context: Mapping[str, Any] | None = None
            landscape_revision_base: CreativeDiversityLandscapeResponse | None = None
            landscape_revision_ids: list[str] = []
            for landscape_attempt in range(0 if review_resume is not None else 4):
                landscape_call = None
                for structure_attempt in range(2):
                    self._reserve_ai_call(context)
                    planning_call_counts["CREATIVE_SPACE_PLANNING"] += 1
                    try:
                        async with self._ai_semaphore:
                            raw_landscape_call = (
                                await self.provider.plan_creative_landscape(
                                    application,
                                    fact_visual_strategy=visual_strategy,
                                    shared_prompt=shared_prompt,
                                    target_count=snapshot.settings.target_count,
                                    style_instruction=_style_instruction(
                                        snapshot.settings
                                    ),
                                    delivery_channel=snapshot.settings.delivery_channel,
                                    revision_context=landscape_revision_context,
                                    revision_territory_ids=landscape_revision_ids,
                                )
                            )
                            if landscape_revision_base is None:
                                landscape_call = raw_landscape_call
                            else:
                                landscape_call = AiCallResult(
                                    value=merge_creative_landscape_territory_revision(
                                        landscape_revision_base,
                                        raw_landscape_call.value,
                                        landscape_revision_ids,
                                    ),
                                    metadata=raw_landscape_call.metadata,
                                )
                    except ValueError as exc:
                        if structure_attempt == 0:
                            landscape_revision_context = {
                                **(landscape_revision_context or {}),
                                "validationError": str(exc),
                                "revisionInstruction": (
                                    "只重新输出 revisionTerritoryIds 点名的空间，"
                                    "每个稳定 territoryId 恰好一次。"
                                ),
                            }
                            continue
                        raise ProviderError(
                            "AI 创意空间局部修订结构无效",
                            retryable=False,
                            error_type=ProviderErrorType.RESPONSE_INVALID,
                            attempts=2,
                        ) from exc
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
                assignment_call = None
                assignment_revision_context: Mapping[str, Any] | None = None
                assignment_error: ValueError | None = None
                # Keep malformed JSON or one bad structural assignment local to
                # this small AI step. Retrying the whole RabbitMQ task would
                # discard a valid landscape and repeat every paid planning call.
                for assignment_attempt in range(3):
                    self._reserve_ai_call(context)
                    planning_call_counts["FACT_TERRITORY_ASSIGNMENT"] += 1
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
                            assignment_attempt < 2
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
                    # This is a whole-landscape capacity failure, not a semantic
                    # issue scoped to named territories. Start the next attempt
                    # from a complete response instead of merging a partial one.
                    landscape_revision_base = None
                    landscape_revision_ids = []
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

                async def audit_landscape(
                    current_landscape: CreativeDiversityLandscape,
                ) -> Any:
                    audit_call = None
                    validation_error: ValueError | None = None
                    for audit_attempt in range(2):
                        self._reserve_ai_call(context)
                        planning_call_counts["CREATIVE_SPACE_BATCH_REVIEW"] += 1
                        try:
                            async with self._ai_semaphore:
                                audit_call = (
                                    await self.provider.audit_creative_landscape(
                                        application,
                                        fact_visual_strategy=visual_strategy,
                                        landscape=current_landscape,
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
                        fact_issues = audit_call.value.fact_issues
                        blocking_issues = [
                            issue
                            for issue in fact_issues
                            if issue.verdict == "UNSUPPORTED"
                        ]
                        weak_issue_count = len(fact_issues) - len(blocking_issues)
                        normalized_response = CreativeLandscapeAuditResponse(
                            reviewed_territory_ids=(
                                audit_call.value.reviewed_territory_ids
                            ),
                            fact_issues=blocking_issues,
                            requires_revision=bool(blocking_issues),
                            revision_territory_ids=list(
                                dict.fromkeys(
                                    issue.territory_id for issue in blocking_issues
                                )
                            ),
                            summary=(
                                f"批量复核发现 {len(blocking_issues)} 项缺少事实条件的关系需调整"
                                if blocking_issues
                                else (
                                    f"创意空间通过安全复核，另有 {weak_issue_count} 项偏弱关系作为质量提醒"
                                    if weak_issue_count
                                    else "全部事实与产品专属创意空间自然相容"
                                )
                            ),
                        )
                        try:
                            return validate_creative_landscape_audit(
                                normalized_response,
                                current_landscape,
                            )
                        except ValueError as exc:
                            validation_error = exc
                            if audit_attempt == 0:
                                continue
                            break
                    # WEAK is an advisory quality finding. Replanning the whole
                    # landscape until every subjective weak-fit opinion
                    # disappears can loop for many paid calls without making
                    # the plan safer. Only UNSUPPORTED means the relationship
                    # relies on an unconfirmed condition and must block.
                    raise ProviderError(
                        "AI 创意空间批量复核结构无效",
                        retryable=False,
                        error_type=ProviderErrorType.RESPONSE_INVALID,
                        attempts=2,
                    ) from validation_error

                landscape_audit = await audit_landscape(draft_landscape)
                if landscape_audit.requires_revision:
                    repaired_landscape = apply_creative_landscape_audit(
                        draft_landscape,
                        landscape_audit,
                        application,
                    )
                    if repaired_landscape is not None:
                        landscape = repaired_landscape
                        break
                    # The space map can be sound while the separate AI fact
                    # assignment has placed a required fact in the wrong space.
                    # Ask that owning AI to move only the named relationships
                    # before paying to regenerate the entire landscape. Worker
                    # only forwards the AI audit and re-validates IDs/counts.
                    if assignment_call is None:
                        raise PipelineError("创意空间事实分配结果缺失")
                    previous_assignments = assignment_call.value
                    for reassignment_attempt in range(2):
                        self._reserve_ai_call(context)
                        planning_call_counts["FACT_TERRITORY_ASSIGNMENT"] += 1
                        reassignment_revision_context = {
                            "semanticAudit": landscape_audit.model_dump(
                                mode="json",
                                by_alias=True,
                            ),
                            "previousAssignments": previous_assignments.model_dump(
                                mode="json",
                                by_alias=True,
                            )["assignments"],
                            "revisionInstruction": (
                                "保持创意空间、场景边界和主动作不变。"
                                "只把独立复核点名的事实移到真正自然相容的"
                                "空间；全部业务事实仍须各输出一次，未点名"
                                "分配尽量保持稳定。"
                            ),
                        }
                        try:
                            async with self._ai_semaphore:
                                reassignment_call = await (
                                    self.provider.assign_creative_landscape_facts(
                                        application,
                                        fact_visual_strategy=visual_strategy,
                                        landscape=landscape_call.value,
                                        target_count=snapshot.settings.target_count,
                                        revision_context=(
                                            reassignment_revision_context
                                        ),
                                    )
                                )
                        except ProviderError as exc:
                            if reassignment_attempt == 0 and (
                                exc.error_type == ProviderErrorType.RESPONSE_INVALID
                            ):
                                continue
                            raise
                        call_rows.append(reassignment_call.metadata)
                        try:
                            reassigned_landscape = (
                                compile_creative_landscape_assignments(
                                    landscape_call.value,
                                    reassignment_call.value,
                                    application,
                                    source_hash=source_hash,
                                    template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
                                    expected_direction_count=expected_direction_count,
                                )
                            )
                        except ValueError:
                            previous_assignments = reassignment_call.value
                            continue
                        landscape_audit = await audit_landscape(
                            reassigned_landscape
                        )
                        if not landscape_audit.requires_revision:
                            landscape = reassigned_landscape.model_copy(
                                update={"semantic_audit": landscape_audit}
                            )
                            break
                        repaired_landscape = apply_creative_landscape_audit(
                            reassigned_landscape,
                            landscape_audit,
                            application,
                        )
                        if repaired_landscape is not None:
                            landscape = repaired_landscape
                            break
                        draft_landscape = reassigned_landscape
                        previous_assignments = reassignment_call.value
                    if landscape is not None:
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
                    landscape_revision_base = landscape_call.value
                    landscape_revision_ids = list(
                        landscape_audit.revision_territory_ids
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
            resume_progress = review_resume.review_progress if review_resume else None
            semantic_revision_count = (
                resume_progress.semantic_revision_count if resume_progress else 0
            )
            completed_review_batches = dict(
                resume_progress.completed_batches if resume_progress else {}
            )
            review_write_lock = asyncio.Lock()
            resume_direction_response = (
                CreativeDirectionResponse(directions=review_resume.directions)
                if review_resume is not None else None
            )
            business_fact_ids = {
                fact.fact_id for fact in mandatory_business_facts(application)
            }
            if len(business_fact_ids) >= expected_direction_count * 2:
                minimum_business_facts_per_direction = 2
            elif len(business_fact_ids) >= expected_direction_count:
                minimum_business_facts_per_direction = 1
            else:
                minimum_business_facts_per_direction = 0
            for invalid_response_attempt in range(
                resume_progress.planning_attempt if resume_progress else 0, 4
            ):
                try:
                    revision_ids = (
                        revision_context.get("revisionDirectionIds", [])
                        if revision_context is not None
                        else []
                    )
                    is_targeted_revision = bool(
                        isinstance(revision_ids, list) and revision_ids
                    )
                    if resume_direction_response is not None:
                        direction_response = resume_direction_response
                        resume_direction_response = None
                    elif previous_audited_response is None and not is_targeted_revision:
                        direction_planning_batches = (
                            _creative_direction_planning_batches(landscape)
                        )
                        direction_planning_batch_count = len(
                            direction_planning_batches
                        )

                        async def plan_direction_batch(
                            planning_batch: DirectionPlanningBatch,
                        ) -> Any:
                            scoped_landscape = landscape.model_copy(
                                update={
                                    "territories": list(
                                        planning_batch.territories
                                    )
                                }
                            )
                            required_slots = list(planning_batch.slots)
                            required_business_fact_ids = list(
                                planning_batch.required_fact_ids
                            )
                            slot_context: Mapping[str, Any] = {
                                "requiredDirectionSlots": required_slots,
                                "requiredBusinessFactIds": (
                                    required_business_fact_ids
                                ),
                            }
                            territory_by_id = scoped_landscape.by_id
                            allowed_fact_ids_by_direction = {
                                slot["directionId"]: list(
                                    territory_by_id[
                                        slot["territoryId"]
                                    ].compatible_fact_ids
                                )
                                for slot in required_slots
                            }
                            slot_context = {
                                **slot_context,
                                "allowedFactIdsByDirection": (
                                    allowed_fact_ids_by_direction
                                ),
                            }
                            scoped_compatible_fact_ids = {
                                fact_id
                                for territory in planning_batch.territories
                                for fact_id in territory.compatible_fact_ids
                            }
                            scoped_minimum_business_facts = min(
                                minimum_business_facts_per_direction,
                                len(
                                    business_fact_ids.intersection(
                                        scoped_compatible_fact_ids
                                    )
                                ),
                            )
                            last_error: Exception | None = None
                            local_validation_details: dict[str, Any] = {}
                            for territory_attempt in range(2):
                                local_validation_details = {}
                                self._reserve_ai_call(context)
                                planning_call_counts[
                                    "CREATIVE_DIRECTION_PLANNING"
                                ] += 1
                                try:
                                    async with self._ai_semaphore:
                                        territory_call = await self.provider.plan_creative_directions(
                                            application,
                                            fact_visual_strategy=visual_strategy,
                                            shared_prompt=shared_prompt,
                                            landscape=scoped_landscape,
                                            target_count=(
                                                snapshot.settings.target_count
                                            ),
                                            style_instruction=_style_instruction(
                                                snapshot.settings
                                            ),
                                            delivery_channel=snapshot.settings.delivery_channel,
                                            revision_context=slot_context,
                                        )
                                    expected_slots = {
                                        slot["directionId"]: (
                                            slot["territoryId"],
                                            slot["primaryActionId"],
                                        )
                                        for slot in required_slots
                                    }
                                    actual_directions = {
                                        direction.direction_id: direction
                                        for direction in territory_call.value.directions
                                    }
                                    if set(actual_directions) != set(expected_slots):
                                        raise ValueError(
                                            "direction batch did not fill the assigned slots"
                                        )
                                    if any(
                                        direction.territory_id
                                        != expected_slots[direction_id][0]
                                        or direction.primary_action_id
                                        != expected_slots[direction_id][1]
                                        for direction_id, direction in actual_directions.items()
                                    ):
                                        raise ValueError(
                                            "direction batch changed an assigned territory or action"
                                        )
                                    realized_required_fact_ids = {
                                        fact_id
                                        for direction in actual_directions.values()
                                        for fact_id in direction.fact_ids
                                    }
                                    missing_required_fact_ids = sorted(
                                        set(required_business_fact_ids)
                                        - realized_required_fact_ids
                                    )
                                    if missing_required_fact_ids:
                                        required_fact_id_set = set(
                                            required_business_fact_ids
                                        )
                                        preserved_by_direction = {
                                            direction.direction_id: [
                                                fact_id
                                                for fact_id in direction.fact_ids
                                                if fact_id in required_fact_id_set
                                            ]
                                            for direction in actual_directions.values()
                                        }
                                        eligible_direction_ids = [
                                            direction.direction_id
                                            for direction in actual_directions.values()
                                            if len(
                                                preserved_by_direction[
                                                    direction.direction_id
                                                ]
                                            )
                                            < 4
                                        ]
                                        local_validation_details = {
                                            "missingBusinessFactIds": (
                                                missing_required_fact_ids
                                            ),
                                            "revisionDirectionIds": list(
                                                actual_directions
                                            ),
                                            "revisionRequiredBusinessFactIds": list(
                                                required_business_fact_ids
                                            ),
                                            "revisionFactOptions": [
                                                {
                                                    "factId": fact_id,
                                                    "eligibleDirectionIds": (
                                                        eligible_direction_ids
                                                    ),
                                                }
                                                for fact_id in (
                                                    missing_required_fact_ids
                                                )
                                            ],
                                            "preservedBusinessFactIdsByDirection": (
                                                preserved_by_direction
                                            ),
                                            "allowedFactIdsByDirection": {
                                                direction_id: (
                                                    allowed_fact_ids_by_direction[
                                                        direction_id
                                                    ]
                                                )
                                                for direction_id in actual_directions
                                            },
                                            "previousDirections": [
                                                direction.model_dump(
                                                    mode="json",
                                                    by_alias=True,
                                                )
                                                for direction in actual_directions.values()
                                            ],
                                        }
                                        raise ValueError(
                                            "territory direction batch omitted assigned required facts"
                                        )
                                    underfilled_direction_ids = [
                                        direction.direction_id
                                        for direction in actual_directions.values()
                                        if len(
                                            business_fact_ids.intersection(
                                                direction.fact_ids
                                            )
                                        )
                                        < scoped_minimum_business_facts
                                    ]
                                    if underfilled_direction_ids:
                                        preserved_by_direction = {
                                            direction.direction_id: [
                                                fact_id
                                                for fact_id in direction.fact_ids
                                                if fact_id in business_fact_ids
                                            ]
                                            for direction in actual_directions.values()
                                        }
                                        local_validation_details = {
                                            "underfilledDirectionIds": (
                                                underfilled_direction_ids
                                            ),
                                            "revisionDirectionIds": list(
                                                actual_directions
                                            ),
                                            "preservedBusinessFactIdsByDirection": (
                                                preserved_by_direction
                                            ),
                                            "allowedFactIdsByDirection": {
                                                direction_id: (
                                                    allowed_fact_ids_by_direction[
                                                        direction_id
                                                    ]
                                                )
                                                for direction_id in actual_directions
                                            },
                                            "minimumBusinessFactsByDirection": {
                                                direction_id: (
                                                    scoped_minimum_business_facts
                                                )
                                                for direction_id in (
                                                    underfilled_direction_ids
                                                )
                                            },
                                            "additionalBusinessFactOptionsByDirection": {
                                                direction_id: sorted(
                                                    business_fact_ids.intersection(
                                                        allowed_fact_ids_by_direction[
                                                            direction_id
                                                        ]
                                                    )
                                                    - set(
                                                        actual_directions[
                                                            direction_id
                                                        ].fact_ids
                                                    )
                                                )
                                                for direction_id in (
                                                    underfilled_direction_ids
                                                )
                                            },
                                            "previousDirections": [
                                                direction.model_dump(
                                                    mode="json",
                                                    by_alias=True,
                                                )
                                                for direction in actual_directions.values()
                                            ],
                                        }
                                        raise ValueError(
                                            "territory direction batch underfilled business facts"
                                        )
                                    return territory_call
                                except ProviderError as exc:
                                    last_error = exc
                                    if territory_attempt < 1 and (
                                        exc.retryable
                                        or exc.error_type
                                        == ProviderErrorType.RESPONSE_INVALID
                                    ):
                                        cache.direction_repair_count += 1
                                        continue
                                    raise
                                except ValueError as exc:
                                    last_error = exc
                                    if territory_attempt < 1:
                                        cache.direction_repair_count += 1
                                        slot_context = {
                                            **slot_context,
                                            **local_validation_details,
                                            "validationError": str(exc),
                                            "revisionInstruction": (
                                                "根据 validationError、previousDirections、"
                                                "underfilledDirectionIds 与"
                                                "additionalBusinessFactOptionsByDirection"
                                                " 定向补全本分片。"
                                                "本次必须原样填写每个 directionId 与"
                                                "primaryActionId，并让 requiredBusinessFactIds"
                                                " 中每个事实至少出现在一个方向的"
                                                " factApplications 中；同时每个方向必须"
                                                f"自然使用至少 {scoped_minimum_business_facts} "
                                                "条业务事实。逐方向保留"
                                                " preservedBusinessFactIdsByDirection 中已"
                                                "正确承担的事实，不得为了补入一项又删除"
                                                "另一项；缺失事实只能进入 revisionFactOptions"
                                                " 点名且仍有容量的合法方向。"
                                            ),
                                        }
                                        continue
                                    raise ProviderError(
                                        "AI 创意方向未按分配动作生成",
                                        retryable=False,
                                        error_type=(ProviderErrorType.RESPONSE_INVALID),
                                        attempts=2,
                                    ) from exc
                            raise PipelineError(
                                "创意方向分空间规划未返回结果"
                            ) from last_error

                        direction_calls = await asyncio.gather(
                            *(
                                plan_direction_batch(planning_batch)
                                for planning_batch in direction_planning_batches
                            )
                        )
                        call_rows.extend(
                            direction_call.metadata
                            for direction_call in direction_calls
                        )
                        merged_directions = [
                            direction
                            for direction_call in direction_calls
                            for direction in direction_call.value.directions
                        ]
                        direction_response = CreativeDirectionResponse(
                            directions=merged_directions
                        )
                    else:
                        revision_call_context = dict(revision_context or {})
                        if (
                            previous_audited_response is not None
                            and isinstance(revision_ids, list)
                            and revision_ids
                        ):
                            previous_by_id = {
                                direction.direction_id: direction
                                for direction in previous_audited_response.directions
                            }
                            required_revision_slots = [
                                {
                                    "directionId": direction_id,
                                    "territoryId": previous_by_id[
                                        direction_id
                                    ].territory_id,
                                    "primaryActionId": previous_by_id[
                                        direction_id
                                    ].primary_action_id,
                                }
                                for direction_id in revision_ids
                                if direction_id in previous_by_id
                            ]
                            revision_batches = [
                                revision_ids[
                                    index : index + DIRECTION_STRUCTURED_BATCH_SIZE
                                ]
                                for index in range(
                                    0,
                                    len(revision_ids),
                                    DIRECTION_STRUCTURED_BATCH_SIZE,
                                )
                            ]
                            revision_fact_batch_by_id: dict[str, int] = {}
                            raw_revision_fact_options = revision_call_context.get(
                                "revisionFactOptions"
                            )
                            previous_revision_rows = revision_call_context.get(
                                "previousDirections"
                            )
                            previous_revision_rows = (
                                previous_revision_rows
                                if isinstance(previous_revision_rows, list)
                                else []
                            )
                            batch_index_by_direction = {
                                direction_id: batch_index
                                for batch_index, batch_ids in enumerate(
                                    revision_batches
                                )
                                for direction_id in batch_ids
                            }
                            batch_fact_loads = [0 for _ in revision_batches]
                            batch_fact_capacities = [
                                len(batch_ids) * 4 for batch_ids in revision_batches
                            ]
                            if isinstance(raw_revision_fact_options, list):
                                for option in raw_revision_fact_options:
                                    if not isinstance(option, dict):
                                        continue
                                    option_fact_id = option.get("factId")
                                    if not isinstance(option_fact_id, str):
                                        continue
                                    eligible_batch_indexes = sorted(
                                        {
                                            batch_index_by_direction[direction_id]
                                            for direction_id in option.get(
                                                "eligibleDirectionIds", []
                                            )
                                            if isinstance(direction_id, str)
                                            and direction_id
                                            in batch_index_by_direction
                                        }
                                    )
                                    if not eligible_batch_indexes:
                                        continue
                                    existing_holder_indexes = {
                                        batch_index_by_direction[
                                            row.get("directionId")
                                        ]
                                        for row in previous_revision_rows
                                        if isinstance(row, dict)
                                        and isinstance(row.get("directionId"), str)
                                        and row.get("directionId")
                                        in batch_index_by_direction
                                        and isinstance(
                                            row.get("factApplications"), list
                                        )
                                        and any(
                                            isinstance(application_row, dict)
                                            and application_row.get("factId")
                                            == option_fact_id
                                            for application_row in row[
                                                "factApplications"
                                            ]
                                        )
                                    }
                                    preferred_indexes = [
                                        batch_index
                                        for batch_index in eligible_batch_indexes
                                        if batch_index in existing_holder_indexes
                                    ]
                                    candidate_indexes = (
                                        preferred_indexes or eligible_batch_indexes
                                    )
                                    available_indexes = [
                                        batch_index
                                        for batch_index in candidate_indexes
                                        if batch_fact_loads[batch_index]
                                        < batch_fact_capacities[batch_index]
                                    ]
                                    if not available_indexes:
                                        available_indexes = candidate_indexes
                                    selected_batch_index = min(
                                        available_indexes,
                                        key=lambda batch_index: (
                                            batch_fact_loads[batch_index]
                                            / max(
                                                1,
                                                batch_fact_capacities[batch_index],
                                            ),
                                            batch_fact_loads[batch_index],
                                            batch_index,
                                        ),
                                    )
                                    revision_fact_batch_by_id[option_fact_id] = (
                                        selected_batch_index
                                    )
                                    batch_fact_loads[selected_batch_index] += 1

                            def scoped_revision_context(
                                batch_ids: list[str],
                                batch_index: int,
                            ) -> dict[str, Any]:
                                batch_id_set = set(batch_ids)
                                scoped = {
                                    **revision_call_context,
                                    "revisionDirectionIds": batch_ids,
                                    "requiredDirectionSlots": [
                                        slot
                                        for slot in required_revision_slots
                                        if slot["directionId"] in batch_id_set
                                    ],
                                }
                                semantic_audit = scoped.get("semanticAudit")
                                if isinstance(semantic_audit, dict):
                                    scoped["semanticAudit"] = {
                                        **semantic_audit,
                                        "revisionDirectionIds": batch_ids,
                                        "items": [
                                            item
                                            for item in semantic_audit.get("items", [])
                                            if isinstance(item, dict)
                                            and item.get("directionId") in batch_id_set
                                        ],
                                    }
                                previous_directions = scoped.get(
                                    "previousDirections"
                                )
                                if isinstance(previous_directions, list):
                                    scoped["previousDirections"] = [
                                        item
                                        for item in previous_directions
                                        if isinstance(item, dict)
                                        and item.get("directionId") in batch_id_set
                                    ]
                                # A targeted repair may be split into several
                                # small structured calls.  Never pass the global
                                # fact checklist to every call: a four-direction
                                # batch cannot satisfy facts that are only
                                # writable by another batch.  This assignment is
                                # deliberately structural.  It chooses an
                                # existing holder first, otherwise the first
                                # allowed stable direction; the model still owns
                                # the natural creative relationship and wording.
                                revision_fact_options = scoped.get(
                                    "revisionFactOptions"
                                )
                                if isinstance(revision_fact_options, list):
                                    scoped_fact_options: list[dict[str, Any]] = []
                                    for option in revision_fact_options:
                                        if not isinstance(option, dict):
                                            continue
                                        fact_id = option.get("factId")
                                        if (
                                            not isinstance(fact_id, str)
                                            or revision_fact_batch_by_id.get(fact_id)
                                            != batch_index
                                        ):
                                            continue
                                        local_eligible_ids = [
                                            direction_id
                                            for direction_id in option.get(
                                                "eligibleDirectionIds", []
                                            )
                                            if isinstance(direction_id, str)
                                            if direction_id in batch_id_set
                                        ]
                                        if not local_eligible_ids:
                                            continue
                                        scoped_fact_options.append(
                                            {
                                                **option,
                                                "eligibleDirectionIds": local_eligible_ids,
                                            }
                                        )
                                    scoped["revisionFactOptions"] = scoped_fact_options
                                    scoped_required_fact_ids = [
                                        option["factId"]
                                        for option in scoped_fact_options
                                        if isinstance(option.get("factId"), str)
                                    ]
                                    scoped["revisionRequiredBusinessFactIds"] = (
                                        scoped_required_fact_ids
                                    )
                                    scoped["missingBusinessFactIds"] = [
                                        fact_id
                                        for fact_id in scoped.get(
                                            "missingBusinessFactIds", []
                                        )
                                        if fact_id in scoped_required_fact_ids
                                    ]
                                    scoped["revisionFactApplicationCapacity"] = (
                                        len(batch_ids) * 4
                                    )
                                diversity_audit = scoped.get("diversityAudit")
                                if isinstance(diversity_audit, dict):
                                    scoped_groups = [
                                        group
                                        for group in diversity_audit.get("groups", [])
                                        if isinstance(group, dict)
                                        and batch_id_set.intersection(
                                            group.get("revisionDirectionIds", [])
                                        )
                                    ]
                                    scoped["diversityAudit"] = {
                                        **diversity_audit,
                                        "groups": scoped_groups,
                                        "revisionDirectionIds": batch_ids,
                                    }
                                for key, value in list(scoped.items()):
                                    if (
                                        key.endswith("ByDirection")
                                        and isinstance(value, dict)
                                    ):
                                        scoped[key] = {
                                            direction_id: row
                                            for direction_id, row in value.items()
                                            if direction_id in batch_id_set
                                        }
                                return scoped

                            revision_context_batches = [
                                scoped_revision_context(batch_ids, batch_index)
                                for batch_index, batch_ids in enumerate(
                                    revision_batches
                                )
                            ]
                        else:
                            revision_context_batches = [revision_call_context]

                        async def revise_direction_batch(
                            batch_context: Mapping[str, Any],
                        ) -> Any:
                            batch_slots = batch_context.get(
                                "requiredDirectionSlots", []
                            )
                            batch_territory_ids = {
                                slot.get("territoryId")
                                for slot in batch_slots
                                if isinstance(slot, dict)
                                and isinstance(slot.get("territoryId"), str)
                            }
                            scoped_landscape = (
                                landscape.model_copy(
                                    update={
                                        "territories": [
                                            territory
                                            for territory in landscape.territories
                                            if territory.territory_id
                                            in batch_territory_ids
                                        ]
                                    }
                                )
                                if batch_territory_ids
                                else landscape
                            )
                            async with self._ai_semaphore:
                                return await self.provider.plan_creative_directions(
                                    application,
                                    fact_visual_strategy=visual_strategy,
                                    shared_prompt=shared_prompt,
                                    landscape=scoped_landscape,
                                    target_count=snapshot.settings.target_count,
                                    style_instruction=_style_instruction(
                                        snapshot.settings
                                    ),
                                    delivery_channel=(
                                        snapshot.settings.delivery_channel
                                    ),
                                    revision_context=batch_context,
                                )

                        for _ in revision_context_batches:
                            self._reserve_ai_call(context)
                            planning_call_counts[
                                "CREATIVE_DIRECTION_REVISION"
                            ] += 1
                        revision_calls = await asyncio.gather(
                            *(
                                revise_direction_batch(batch_context)
                                for batch_context in revision_context_batches
                            )
                        )
                        call_rows.extend(
                            revision_call.metadata
                            for revision_call in revision_calls
                        )
                        direction_response = CreativeDirectionResponse(
                            directions=[
                                direction
                                for revision_call in revision_calls
                                for direction in revision_call.value.directions
                            ]
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
                        expected_execution_route_count=(
                            validated_execution_route_count
                        ),
                        landscape=landscape,
                    )
                except ValueError as exc:
                    LOGGER.warning(
                        "creative direction plan validation failed attempt=%s error=%s",
                        invalid_response_attempt + 1,
                        exc,
                    )
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
                direction_audit_batches = review_batches(
                    direction_response.directions, application, visual_strategy,
                    landscape, max_size=self.direction_review_batch_size,
                    input_budget=self.direction_review_input_budget,
                )
                direction_audit_batch_count = len(direction_audit_batches)

                def batch_key(batch: list[CreativeDirection]) -> str:
                    return review_hash({
                        "request": review_fingerprint,
                        "reviewRound": semantic_revision_count,
                        "landscape": landscape.model_dump(mode="json", by_alias=True),
                        "directions": [d.model_dump(mode="json", by_alias=True) for d in batch],
                    })

                active_batch_keys = {batch_key(batch) for batch in direction_audit_batches}
                completed_review_batches = {
                    key: value for key, value in completed_review_batches.items()
                    if key in active_batch_keys
                }
                # Revalidate IDs even for persisted results, never trust a checkpoint
                # merely because its hash matches. No AI/semantic decisions here.
                for batch in direction_audit_batches:
                    key = batch_key(batch)
                    if key in completed_review_batches:
                        try:
                            completed_review_batches[key] = validate_creative_direction_audit_batch(
                                completed_review_batches[key], batch, landscape,
                            )
                        except ValueError:
                            del completed_review_batches[key]
                reused_review_count = len(completed_review_batches)

                async def persist_review_progress() -> None:
                    progress = CreativeDirectionReviewProgress(
                        run_id=context.run_id,
                        request_fingerprint=review_fingerprint,
                        planning_attempt=invalid_response_attempt,
                        semantic_revision_count=semantic_revision_count,
                        completed_batches=dict(completed_review_batches),
                    )
                    partial_plan = draft_plan.model_copy(update={"review_progress": progress})
                    await self._stage(
                        context, NodeId.COHERENT_CREATIVE_GENERATION, StageStatus.RUNNING,
                        f"{len(draft_plan.directions)} 个创意方向已形成，正在复核创意关系，已完成 {len(completed_review_batches)}/{direction_audit_batch_count} 批",
                        metadata={
                            "perceptionPhase": "CREATIVE_DIRECTION_REVIEW",
                            "territoryCount": len(landscape.territories),
                            "directionCount": len(draft_plan.directions),
                            "candidateTargetCount": math.ceil(snapshot.settings.target_count * 1.4),
                            "directionReviewCompletedBatches": len(completed_review_batches),
                            "directionAuditBatchCount": direction_audit_batch_count,
                            "directionReviewReusedBatches": reused_review_count,
                            "checkpoint": {
                                "nodeId": NodeId.COHERENT_CREATIVE_GENERATION.value,
                                "sourceFingerprint": source_hash,
                                "allocationHash": draft_plan.plan_hash,
                                "templateHash": CREATIVE_DIRECTION_TEMPLATE_HASH,
                                "plan": partial_plan.model_dump(mode="json", by_alias=True),
                            },
                        },
                    )

                await persist_review_progress()

                async def audit_direction_batch(
                    batch: list[CreativeDirection],
                ) -> CreativeDirectionAuditResponse:
                    key = batch_key(batch)
                    if key in completed_review_batches:
                        LOGGER.info("direction review reused completed batch size=%s", len(batch))
                        return completed_review_batches[key]
                    estimated_size = review_input_size(batch, application, visual_strategy, landscape)
                    LOGGER.info(
                        "direction review batch size=%s estimated_input_units=%s budget=%s oversize=%s",
                        len(batch), estimated_size, self.direction_review_input_budget,
                        estimated_size > self.direction_review_input_budget,
                    )
                    audit_revision_context: Mapping[str, Any] | None = None
                    for audit_attempt in range(2):
                        self._reserve_ai_call(context)
                        planning_call_counts["CREATIVE_DIRECTION_REVIEW"] += 1
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
                                        revision_context=audit_revision_context,
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
                        try:
                            validated = validate_creative_direction_audit_batch(
                                audit_call.value,
                                batch,
                                landscape,
                            )
                        except ValueError as exc:
                            if audit_attempt == 0:
                                audit_revision_context = {
                                    "validationError": str(exc),
                                    "revisionInstruction": (
                                        "上一次复核返回了不存在或不匹配的 ID。"
                                        "本次必须逐字复用创意版图中的 territoryId、"
                                        "actionId 和待复核方向中的 directionId、factId。"
                                    ),
                                }
                                continue
                            raise ProviderError(
                                "AI 创意方向分批复核结构无效",
                                retryable=False,
                                error_type=ProviderErrorType.RESPONSE_INVALID,
                                attempts=2,
                            ) from exc
                        async with review_write_lock:
                            completed_review_batches[key] = validated
                            await persist_review_progress()
                        return validated
                    raise PipelineError("创意方向语义分批复核未返回结果")

                batch_results = await asyncio.gather(
                    *(audit_direction_batch(batch) for batch in direction_audit_batches),
                    return_exceptions=True,
                )
                # Finish sibling writes before propagating failure/unregistering Run.
                batch_audits = []
                for batch_result in batch_results:
                    if isinstance(batch_result, BaseException):
                        raise batch_result
                    batch_audits.append(batch_result)
                diversity_audit = None
                diversity_validation_error: str | None = None
                for diversity_audit_attempt in range(2):
                    self._reserve_ai_call(context)
                    planning_call_counts[
                        "CREATIVE_DIRECTION_DIVERSITY_REVIEW"
                    ] += 1
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
                            require_canonical_profiles=True,
                        )
                        break
                    except ValueError as exc:
                        diversity_validation_error = str(exc)
                        if diversity_audit_attempt == 0:
                            continue
                if diversity_audit is None:
                    raise ProviderError(
                        "AI 创意方向全批去重复核结构无效",
                        retryable=False,
                        error_type=ProviderErrorType.RESPONSE_INVALID,
                        attempts=2,
                    ) from ValueError(diversity_validation_error or "invalid audit")
                canonical_profiles = {
                    item.direction_id: item.semantic_profile
                    for item in diversity_audit.canonical_profiles
                }
                direction_response = CreativeDirectionResponse(
                    directions=[
                        direction.model_copy(
                            update={
                                "semantic_profile": canonical_profiles[
                                    direction.direction_id
                                ]
                            }
                        )
                        for direction in direction_response.directions
                    ]
                )
                draft_plan = validate_creative_direction_plan(
                    direction_response,
                    application,
                    visual_strategy,
                    source_hash=source_hash,
                    template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
                    expected_direction_count=expected_direction_count,
                    expected_execution_route_count=validated_execution_route_count,
                    landscape=landscape,
                )
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
                            application,
                            diversity_audit,
                        )
                        semantic_revision_count += 1
                        cache.direction_repair_count += 1
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
                "planningAiCallCount": sum(planning_call_counts.values()),
                "planningCallBreakdown": [
                    {"step": key, "count": count}
                    for key, count in sorted(planning_call_counts.items())
                ],
                "directionPlanningBatchCount": direction_planning_batch_count,
                "directionAuditBatchCount": direction_audit_batch_count,
            }
            cache.creative_direction_call_metadata = call_metadata
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
            max(2, math.ceil(requested_candidate_count / 2)),
            requested_candidate_count,
        )
        execution_route_count = creative_execution_route_target_count(
            requested_candidate_count,
            requested_direction_count,
        )
        crowded_examples = []
        for slot_id in sorted(cache.diversity_avoid_slot_ids)[:8]:
            candidate = cache.creatives.get(slot_id)
            task = cache.creative_tasks.get(slot_id)
            if candidate is None:
                continue
            crowded_examples.append(
                {
                    "directionId": (
                        task.creative_direction.direction_id
                        if task is not None and task.creative_direction is not None
                        else None
                    ),
                    "creativeCore": candidate.creative_core,
                    "dimensions": candidate.dimensions.model_dump(
                        mode="json", by_alias=True
                    ),
                }
            )
        base_revision_context: dict[str, Any] = {}
        if crowded_examples:
            base_revision_context = {
                "vectorCrowdedExamples": crowded_examples,
                "revisionInstruction": (
                    "向量比较确认这些已入选候选形成了实质近似组。补充方向应避开"
                    "这些样例已经反复使用的主场景、人物关系和产品主动作组合，"
                    "优先从当前产品仍然自然相容但画面关系不同的空间中规划；"
                    "不能只换时间、人物性别、形容词、光线或景别名称。"
                ),
            }
        revision_context: Mapping[str, Any] | None = base_revision_context or None
        proposed: list[CreativeDirection] | None = None
        diversity_audit: CreativeDirectionDiversityAudit | None = None
        retained: dict[str, CreativeDirection] = {}
        required_ids: list[str] = []
        existing_ids = {d.direction_id for d in plan.directions}
        suffix = 1
        while len(required_ids) < requested_direction_count:
            key = f"DIVERSITY_SUPPLEMENT_{suffix}"
            suffix += 1
            if key not in existing_ids:
                required_ids.append(key)
        pending_ids = list(required_ids)
        structure_recoveries = 0
        semantic_revisions = 0
        for attempt in range(4):
            try:
                if pending_ids:
                    self._reserve_ai_call(context)
                    async with self._ai_semaphore:
                        direction_call = await self.provider.plan_diversity_supplement_directions(
                            application,
                            fact_visual_strategy=visual_strategy,
                            shared_prompt=shared_prompt,
                            landscape=landscape,
                            existing_directions=CreativeDirectionResponse(
                                directions=[*plan.directions, *retained.values()]
                            ),
                            requested_direction_count=len(pending_ids),
                            execution_route_count=execution_route_count,
                            crowded_scene_families=sorted(
                                cache.diversity_avoid_scene_families
                            ),
                            crowded_action_families=sorted(
                                cache.diversity_avoid_action_families
                            ),
                            revision_context={
                                **(revision_context or {}),
                                "requiredDirectionIds": list(pending_ids),
                                "retainedDirectionIds": list(retained),
                            },
                        )
                    errors = retain_valid_supplements(
                        direction_call.value, pending_ids=pending_ids, retained=retained,
                        application=application, strategy=visual_strategy, landscape=landscape,
                        existing=plan.directions, route_count=execution_route_count,
                    )
                    pending_ids = [key for key in required_ids if key not in retained]
                    if pending_ids:
                        revision_context = {
                            **base_revision_context,
                            "directionErrors": errors,
                            "previousDirections": [
                                d.model_dump(mode="json", by_alias=True)
                                for d in direction_call.value.directions
                                if d.direction_id in pending_ids
                            ],
                        }
                        raise ValueError("supplement contains unresolved direction slots")
                proposed = validate_diversity_supplement_directions(
                    CreativeDirectionResponse(directions=[retained[key] for key in required_ids]),
                    application,
                    visual_strategy,
                    landscape=landscape,
                    existing_directions=plan.directions,
                    expected_direction_count=requested_direction_count,
                    expected_execution_route_count=execution_route_count,
                )
                combined = [*plan.directions, *proposed]
                review_landscape = supplement_review_landscape(landscape, proposed)
                relation_revision_ids: list[str] = []
                relation_diagnostics: list[dict[str, Any]] = []
                if any(item.proposed_action is not None for item in proposed):
                    # New action definitions are proposals, not trusted product
                    # facts. Reuse the independent AI relationship reviewer.
                    for start in range(0, len(proposed), 2):
                        group = proposed[start:start + 2]
                        self._reserve_ai_call(context)
                        async with self._ai_semaphore:
                            relation_call = await self.provider.audit_creative_directions(
                                application, fact_visual_strategy=visual_strategy,
                                landscape=review_landscape,
                                directions=CreativeDirectionResponse(directions=group),
                            )
                        relation = validate_creative_direction_audit_batch(
                            relation_call.value, group, review_landscape,
                        )
                        # The full validator derives the revision IDs exclusively
                        # from the model's aligned/fact-review/issue verdicts.
                        relation_audit = validate_creative_direction_audit(
                            relation, CreativeDirectionResponse(directions=group), review_landscape,
                        )
                        relation_revision_ids.extend(relation_audit.revision_direction_ids)
                        if relation_audit.requires_revision:
                            relation_diagnostics.append(relation.model_dump(mode="json", by_alias=True))
                self._reserve_ai_call(context)
                async with self._ai_semaphore:
                    audit_call = await self.provider.audit_creative_direction_diversity(
                        landscape=review_landscape,
                        directions=CreativeDirectionResponse(directions=combined),
                        proposed_direction_ids=[item.direction_id for item in proposed],
                    )
                diversity_audit = validate_creative_direction_diversity_audit(
                    audit_call.value,
                    combined,
                    proposed_direction_ids=[item.direction_id for item in proposed],
                )
                if relation_revision_ids:
                    diversity_audit = diversity_audit.model_copy(update={
                        "requires_revision": True,
                        "revision_direction_ids": list(dict.fromkeys([
                            *diversity_audit.revision_direction_ids, *relation_revision_ids,
                        ])),
                    })
            except (ProviderError, ValueError) as exc:
                # Pydantic error text can contain input values; keep those out
                # of logs and retry diagnostics passed to another AI call.
                safe_validation_error = (
                    "supplement structured fields failed validation"
                    if isinstance(exc, ValidationError)
                    else exc.error_type.value if isinstance(exc, ProviderError)
                    else str(exc)
                )
                LOGGER.warning(
                    "diversity supplement direction attempt rejected attempt=%s "
                    "error_type=%s error=%s",
                    attempt + 1,
                    type(exc).__name__,
                    safe_validation_error,
                )
                if structure_recoveries < 2 and attempt < 3:
                    structure_recoveries += 1
                    revision_context = {
                        **(revision_context or base_revision_context),
                        "validationError": safe_validation_error,
                        "revisionInstruction": (
                            f"{base_revision_context.get('revisionInstruction', '')} "
                            "只输出 requiredDirectionIds 指定的待修复方向。已保留方向无需重写；"
                            "先选空间，再从该空间的合法组合行选择事实和动作，不借用其他行的 ID。"
                        ).strip(),
                    }
                    continue
                cache.diversity_supplement_improved = False
                return []
            if not diversity_audit.requires_revision:
                break
            if semantic_revisions < 1 and attempt < 3:
                semantic_revisions += 1
                pending_ids = [key for key in required_ids if key in diversity_audit.revision_direction_ids]
                for key in pending_ids:
                    retained.pop(key, None)
                revision_context = {
                    **base_revision_context,
                    "previousDirections": [
                        item.model_dump(mode="json", by_alias=True) for item in proposed
                        if item.direction_id in pending_ids
                    ],
                    "revisionDirectionIds": diversity_audit.revision_direction_ids,
                    "diversityAudit": diversity_audit.model_dump(
                        mode="json", by_alias=True
                    ),
                    "relationAudits": relation_diagnostics,
                    "revisionInstruction": (
                        f"{base_revision_context.get('revisionInstruction', '')} "
                        "只修订 requiredDirectionIds 指定方向，保持其 ID，按全批视觉复核改变实质画面关系；"
                        "不能只换措辞、人物性别或景别名称。"
                    ).strip(),
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
        cache = self._cache(context)
        plan = cache.creative_direction_plan
        if plan is None:
            return {
                **cache.creative_direction_call_metadata,
                "directionCount": 0,
                "priorityDimensionDistribution": [],
            }
        counts = Counter(
            dimension.value
            for direction in plan.directions
            for dimension in direction.priority_dimensions
        )
        return {
            **cache.creative_direction_call_metadata,
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
        batch_required_fact_ids = _visually_required_business_fact_ids(
            application,
            cache.fact_visual_strategy,
        )
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
                allocate_creative_facts(
                    application,
                    count=requested,
                    ordinal_start=ordinal_start,
                    preferred_fact_ids=(),
                )
                if snapshot.regeneration_mode == "FULL_REGENERATE"
                else allocate_automatic_regeneration_facts(
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
        direction_totals = Counter(direction.direction_id for direction in directions)
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
        execution_routes = [
            (
                direction.execution_routes[
                    (sibling_positions[index][0] - 1)
                    % len(direction.execution_routes)
                ]
                if direction.execution_routes
                else None
            )
            for index, direction in enumerate(directions)
        ]
        tasks = [
            CreativeTask(
                slot_id=f"creative-r{round_number}-c{ordinal_start + index:04d}",
                ordinal=ordinal_start + index,
                round=round_number,
                supplement_kind=("INITIAL" if round_number == 0 else supplement_kind),
                target_duration_seconds=(
                    snapshot.regeneration_target_duration_seconds
                    or snapshot.target_item.target_duration_seconds
                    if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item
                    else settings.default_duration_seconds
                ),
                fact_assignment=fact_assignments[index],
                creative_direction=(directions[index] if directions else None),
                execution_route=(execution_routes[index] if directions else None),
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
        longest_duration = max(
            (task.target_duration_seconds for task in tasks),
            default=settings.default_duration_seconds,
        )
        duration_safe_shard_size = _creative_shard_size_for_duration(
            longest_duration,
            configured_max_size=self.shard_size,
            max_output_tokens=self.candidate_max_output_tokens,
        )
        creative_shard_size = min(duration_safe_shard_size, self.shard_size)
        task_chunks = _creative_task_chunks(
            tasks,
            max_size=creative_shard_size,
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
                "shardSize": creative_shard_size,
                "plannedOutputTokenLimit": self.candidate_max_output_tokens,
                "siblingCoordinatedShardCount": sum(
                    len(shard.tasks) > 1
                    and len(
                        [
                            task.creative_direction.direction_id
                            for task in shard.tasks
                            if task.creative_direction is not None
                        ]
                    )
                    > len(
                        {
                            task.creative_direction.direction_id
                            for task in shard.tasks
                            if task.creative_direction is not None
                        }
                    )
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
        regeneration_context: dict[str, Any] | None = None
        if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item:
            regeneration_context = {
                "instruction": snapshot.regeneration_instruction or "",
                "mode": snapshot.regeneration_mode or "FULL_REGENERATE",
                "reasons": snapshot.regeneration_reasons,
            }
            if snapshot.regeneration_mode != "FULL_REGENERATE":
                regeneration_context.update(
                    {
                        "originalPrompt": snapshot.target_item.content,
                        "originalDimensions": snapshot.target_item.dimensions.model_dump(
                            mode="json", by_alias=True
                        ),
                        "replacementDimensions": (
                            snapshot.replacement_dimensions.model_dump(
                                mode="json", by_alias=True
                            )
                            if snapshot.replacement_dimensions
                            else None
                        ),
                        "preservedDimensions": snapshot.preserved_dimensions,
                    }
                )
        try:
            call_kwargs: dict[str, Any] = {
                "application": self._require_application(context),
                "shared_prompt": self._required_shared_prompt(context),
                "regeneration_context": regeneration_context,
            }
            if _uses_fact_visual_strategy(snapshot):
                call_kwargs["fact_visual_strategy"] = (
                    self._required_fact_visual_strategy(context)
                )

            async def request_candidates(
                current_shard: CreativeShardPlan,
            ) -> list[CreativeCandidate]:
                for invalid_response_attempt in range(2):
                    self._reserve_ai_call(context)
                    try:
                        async with self._ai_semaphore:
                            call = await self.provider.generate_creatives(
                                current_shard,
                                **call_kwargs,
                            )
                        return call.value.items
                    except ProviderError as exc:
                        if (
                            exc.error_type == ProviderErrorType.RESPONSE_INVALID
                            and invalid_response_attempt == 0
                        ):
                            continue
                        if (
                            exc.error_type
                            in {
                                ProviderErrorType.OUTPUT_TRUNCATED,
                                ProviderErrorType.RESPONSE_INCOMPLETE,
                                ProviderErrorType.RESPONSE_INVALID,
                            }
                            and len(current_shard.tasks) > 1
                        ):
                            midpoint = math.ceil(len(current_shard.tasks) / 2)
                            split_shards = [
                                current_shard.model_copy(
                                    update={"tasks": current_shard.tasks[:midpoint]}
                                ),
                                current_shard.model_copy(
                                    update={"tasks": current_shard.tasks[midpoint:]}
                                ),
                            ]
                            LOGGER.warning(
                                "splitting invalid creative shard round=%s "
                                "shard=%s task_count=%s",
                                current_shard.round,
                                current_shard.shard_index,
                                len(current_shard.tasks),
                            )
                            split_results = await asyncio.gather(
                                *(request_candidates(part) for part in split_shards)
                            )
                            return [
                                item
                                for split_result in split_results
                                for item in split_result
                            ]
                        raise
                raise PipelineError("creative generation retry loop exhausted")

            generated_items = await request_candidates(shard)
            generated_at = utc_now()
            items = [
                item.model_copy(update={"generated_at": generated_at})
                for item in generated_items
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
        round_candidates = [cache.creatives[item_id] for item_id in round_candidate_ids]
        candidate_chunks = evaluation_chunks(
            round_candidates,
            configured_max_size=CLASSIFICATION_SHARD_SIZE,
            max_output_tokens=self.evaluation_max_output_tokens,
            target_durations=cache.creative_target_durations,
            max_input_tokens=self.evaluation_input_token_budget,
        )
        shards = [
            ClassificationShardPlan(
                round=round_number,
                shard_index=index,
                candidate_ids=[item.slot_id for item in chunk],
            )
            for index, chunk in enumerate(candidate_chunks)
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
                "shardSize": max((len(item.candidate_ids) for item in shards), default=0),
                "plannedShardCount": len(shards),
                "plannedInputTokenBudget": self.evaluation_input_token_budget,
                "plannedLargestInputTokens": max(
                    (
                        evaluation_chunk_input_tokens(chunk)
                        for chunk in candidate_chunks
                    ),
                    default=0,
                ),
                "plannedOutputTokenLimit": self.evaluation_max_output_tokens,
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
            evaluations=[cache.execution_repair_records[item_id] for item_id in shard.candidate_ids
                         if item_id in cache.execution_repair_records],
        )
        await self.api.put_shard(context, running)
        try:
            application = self._require_application(context)
            infer_creative_structure = self.snapshot(
                context
            ).operation == "ITEM_EVALUATE" and any(
                _requires_creative_structure_inference(candidate)
                for candidate in candidates
            )
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
                *, attempts_override: int | None = None,
                prepaid_repair_review: bool = False,
            ) -> list[CreativeEvaluation]:
                attempts = attempts_override or (2 if len(group) == 1 else 1)
                for invalid_response_attempt in range(attempts):
                    if not prepaid_repair_review:
                        self._reserve_ai_call(context)
                    cache.evaluation_call_count += 1
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
                            evaluation_kwargs["infer_creative_structure"] = (
                                infer_creative_structure
                            )
                        if _uses_fact_visual_strategy(self.snapshot(context)):
                            evaluation_kwargs["fact_visual_strategy"] = (
                                self._required_fact_visual_strategy(context)
                            )
                        try:
                            call = await self.provider.evaluate_creatives(
                                group,
                                **evaluation_kwargs,
                            )
                            if infer_creative_structure and any(
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

            async def request_evaluations_with_split(
                group: list[CreativeCandidate],
            ) -> list[CreativeEvaluation]:
                try:
                    return await request_evaluations(group)
                except ProviderError as exc:
                    recoverable_structure_error = exc.error_type in {
                        ProviderErrorType.RESPONSE_INVALID,
                        ProviderErrorType.OUTPUT_TRUNCATED,
                        ProviderErrorType.RESPONSE_INCOMPLETE,
                    }
                    if len(group) == 1 or not recoverable_structure_error:
                        raise
                    midpoint = max(1, len(group) // 2)
                    cache.evaluation_split_recovery_count += 1
                    LOGGER.warning(
                        "splitting invalid creative evaluation shard round=%s "
                        "shard=%s candidate_count=%s error_type=%s",
                        shard.round,
                        shard.shard_index,
                        len(group),
                        exc.error_type.value,
                    )
                    evaluated: list[CreativeEvaluation] = []
                    for subgroup in (group[:midpoint], group[midpoint:]):
                        if subgroup:
                            evaluated.extend(
                                await request_evaluations_with_split(subgroup)
                            )
                    return evaluated

            pending_candidates = [item for item in candidates if item.slot_id not in cache.execution_repair_records]
            evaluated_items = (
                await request_evaluations_with_split(pending_candidates)
                if pending_candidates else []
            )
            evaluated_items.extend(
                cache.execution_repair_records[item.slot_id] for item in candidates
                if item.slot_id in cache.execution_repair_records
            )

            candidate_by_id = {item.slot_id: item for item in candidates}
            items = []
            for item in evaluated_items:
                candidate = candidate_by_id[item.slot_id]
                if infer_creative_structure:
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
            # AI diagnoses and patches; Worker only selects by explicit verdicts,
            # numeric scores and source IDs. Persist before paying for each repair.
            if self.snapshot(context).operation != "ITEM_EVALUATE":
                for index, original_evaluation in enumerate(items):
                    original = candidate_by_id[original_evaluation.slot_id]
                    task = cache.creative_tasks.get(original.slot_id)
                    # Keep headroom for unfinished mandatory classifications.
                    # One call per remaining candidate is deliberately conservative.
                    pending_core_calls = sum(
                        item_id not in cache.creative_evaluations
                        and item_id not in cache.execution_repair_records
                        and item_id not in candidate_by_id
                        for item_id in cache.creatives
                    )
                    if (task is None or original_evaluation.execution_repair is not None
                            or not has_execution_diagnosis(original, original_evaluation)
                            or cache.ai_call_count + 2 + pending_core_calls > self.max_ai_calls_per_run):
                        continue
                    # Reserve both calls before yielding so concurrent optional
                    # repairs cannot spend each other's mandatory review budget.
                    self._reserve_ai_call(context)
                    self._reserve_ai_call(context)
                    checkpoint = ExecutionRepairCheckpoint(
                        original_hash=candidate_hash(original), status="STARTED",
                    )
                    original_evaluation = original_evaluation.model_copy(update={"execution_repair": checkpoint})
                    items[index] = original_evaluation
                    cache.execution_repair_records[original.slot_id] = original_evaluation
                    await self.api.put_shard(context, running.model_copy(update={"evaluations": list(items)}))
                    accepted = False
                    unused_review_reservation = True
                    try:
                        async with self._ai_semaphore:
                            repair_call = await self.provider.repair_creative_execution(
                                original, task=task, findings=original_evaluation.execution_findings,
                                application=application, shared_prompt=self._required_shared_prompt(context),
                                fact_visual_strategy=self._required_fact_visual_strategy(context),
                            )
                        repaired = apply_execution_patch(original, repair_call.value,
                            duration=cache.creative_target_durations[original.slot_id])
                        unused_review_reservation = False
                        review_items = await request_evaluations(
                            [repaired], attempts_override=1, prepaid_repair_review=True,
                        )
                        if len(review_items) != 1:
                            raise ValueError("repair review returned wrong item count")
                        reviewed = review_items[0]
                        if reviewed.slot_id != original.slot_id:
                            raise ValueError("repair review returned wrong candidate")
                        if cache.creative_direction_plan is not None:
                            reviewed = complete_semantic_profile(reviewed, repaired, cache.creative_direction_plan)
                            validate_semantic_profile(reviewed, cache.creative_direction_plan)
                        reviewed = validate_creative_evaluation(
                            repaired, reviewed, application,
                            target_duration_seconds=cache.creative_target_durations[original.slot_id],
                            contextual_fact_ids=assigned_context_fact_ids.get(original.slot_id, []),
                        )
                        if repair_improves(original_evaluation, reviewed):
                            items[index] = reviewed.model_copy(update={"execution_repair": checkpoint.model_copy(
                                update={"status": "ACCEPTED", "candidate": repaired})})
                            candidate_by_id[original.slot_id] = repaired
                            cache.creatives[original.slot_id] = repaired
                            accepted = True
                    except (ProviderError, ValueError, PipelineError) as repair_error:
                        LOGGER.warning("execution repair kept original error_type=%s", type(repair_error).__name__)
                    finally:
                        if unused_review_reservation:
                            cache.ai_call_count -= 1
                    if not accepted:
                        items[index] = original_evaluation.model_copy(update={"execution_repair": checkpoint.model_copy(
                            update={"status": "KEPT_ORIGINAL"})})
                    cache.execution_repair_records[original.slot_id] = items[index]
                    await self.api.put_shard(context, running.model_copy(update={"evaluations": list(items)}))
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
                        "evaluations": [cache.execution_repair_records[item_id] for item_id in shard.candidate_ids
                                        if item_id in cache.execution_repair_records],
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
            evaluation_by_slot = {
                evaluation.slot_id: evaluation
                for evaluation in cache.creative_evaluations.values()
            }
            preliminary_similarity = _semantic_aware_similarity_resolver(
                content_index,
                evaluation_by_slot,
            )
            preliminary = content_index.redundancy_summary(
                [candidate.slot_id for candidate in eligible_candidates],
                similarity_resolver=preliminary_similarity,
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
                "semanticAffectedCandidateCount": (
                    preliminary.affected_candidate_count
                ),
                "semanticDirectHighRiskPairCount": (
                    preliminary.high_risk_pair_count
                ),
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
            (
                "创意主线与六维信息自动补齐完成"
                if snapshot.operation == "ITEM_EVALUATE"
                else "创意质量评估与用途分类完成"
            ),
            metadata={
                "round": round_number,
                "candidateCount": len(cache.creatives),
                "evaluatedCount": len(evaluations),
                "acceptedCount": len(accepted),
                "rejectedCount": len(evaluations) - len(accepted),
                "completedShardCount": len(cache.completed_classification_shard_keys),
                "evaluationCallCount": cache.evaluation_call_count,
                "executionRepairAttemptedCount": len(cache.execution_repair_records),
                "executionRepairAcceptedCount": sum(
                    item.execution_repair is not None and item.execution_repair.status == "ACCEPTED"
                    for item in cache.execution_repair_records.values()
                ),
                "executionRepairKeptOriginalCount": sum(
                    item.execution_repair is not None and item.execution_repair.status != "ACCEPTED"
                    for item in cache.execution_repair_records.values()
                ),
                "splitRecoveryCount": cache.evaluation_split_recovery_count,
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
                        "classificationStatus": "VERIFIED"
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
        preferred_item_fact_ids = _visually_required_business_fact_ids(
            application,
            cache.fact_visual_strategy,
        )
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
                    candidate_pool_content_redundancy = content_index.redundancy_summary(
                        [item.slot_id for item in eligible_candidates]
                    )
                    candidate_pool_content_redundancy_rate = round(
                        candidate_pool_content_redundancy.redundant_candidate_count
                        / max(1, len(eligible_candidates)),
                        4,
                    )
                    evaluation_by_slot = {
                        evaluation.slot_id: evaluation
                        for evaluation in cache.creative_evaluations.values()
                    }
                    semantic_aware_similarity = _semantic_aware_similarity_resolver(
                        content_index,
                        evaluation_by_slot,
                    )
                    candidate_pool_redundancy = content_index.redundancy_summary(
                        [item.slot_id for item in eligible_candidates],
                        similarity_resolver=semantic_aware_similarity,
                    )
                    candidate_pool_redundancy_rate = round(
                        candidate_pool_redundancy.redundant_candidate_count
                        / max(1, len(eligible_candidates)),
                        4,
                    )
                    mmr_quality_weight = _adaptive_mmr_quality_weight(
                        candidate_pool_content_redundancy_rate
                    )
                    mmr_diversity_weight = round(1.0 - mmr_quality_weight, 2)
                    content_group_by_slot = content_index.semantic_group_map(
                        [item.slot_id for item in eligible_candidates],
                        similarity_resolver=semantic_aware_similarity,
                    )

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

                        def content_risk_group(item: RankedCreative) -> str:
                            return content_group_by_slot.get(
                                item.candidate.slot_id,
                                item.candidate.slot_id,
                            )

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
                            semantic_group_resolver=content_risk_group,
                            minimum_distinct_semantic_groups=max(
                                0,
                                selection_target
                                - _maximum_semantic_duplicates(selection_target),
                            ),
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
                        semantic_aware_similarity,
                    )
                    mmr_summary = _selection_content_summary(
                        mmr_result,
                        content_index,
                        semantic_aware_similarity,
                    )
                    reduction_applicable, reduction = _near_duplicate_reduction(
                        baseline_summary,
                        mmr_summary,
                    )
                    mmr_redundancy = content_index.redundancy_summary(
                        [item.candidate.slot_id for item in mmr_result.selected],
                        similarity_resolver=semantic_aware_similarity,
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
                        "adaptiveMmrApplied": mmr_quality_weight < 0.70,
                        "adaptiveMmrBasis": "CONTENT_VECTOR_REDUNDANCY",
                        "adaptiveMmrTier": (
                            "HIGH"
                            if candidate_pool_content_redundancy_rate
                            > MMR_HIGH_REDUNDANCY_THRESHOLD
                            else "STANDARD"
                        ),
                        "candidatePoolRedundancyRate": (candidate_pool_redundancy_rate),
                        "candidatePoolContentRedundancyRate": (
                            candidate_pool_content_redundancy_rate
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
                        "highRiskPairs": _safe_high_risk_pairs(
                            mmr_redundancy,
                            semantic_aware_similarity,
                            cache.creatives,
                        ),
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
                snapshot.regeneration_target_duration_seconds
                or snapshot.target_item.target_duration_seconds
                if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item
                else settings.default_duration_seconds
            ),
            fact_visual_strategy=(
                self._required_fact_visual_strategy(context)
                if _uses_fact_visual_strategy(snapshot)
                else None
            ),
        )
        if (
            snapshot.operation == "ITEM_EVALUATE"
            and snapshot.target_item is not None
            and items
        ):
            # This operation is the asynchronous transport used by the editor's
            # “AI 自动补齐” action. AI supplies only the missing creative core,
            # dimensions and traceable fact bindings. The user's Prompt,
            # duration and selected fragment type remain authoritative and the
            # evaluator's quality/classification opinion must not overwrite them.
            target = snapshot.target_item
            items = [
                items[0].model_copy(
                    update={
                        "id": target.id,
                        "code": target.code,
                        "origin": target.origin,
                        "fragment_type": target.primary_purpose,
                        "primary_purpose": target.primary_purpose,
                        "compatible_purposes": [target.primary_purpose],
                        "classification_status": "VERIFIED",
                        "target_duration_seconds": (
                            target.target_duration_seconds
                        ),
                        "content": target.content,
                        "review_issues": [],
                        "manual_edited": True,
                        "created_at": target.created_at,
                    }
                )
            ]
        cache.accepted_items = (
            items
            if item_operation
            else [*_retained_items(snapshot.retained_manual_items), *items]
        )
        missing = max(0, selection_target - len(items))
        selected_covered_fact_ids = {
            binding.fact_id
            for item in cache.accepted_items
            for binding in item.insight_bindings
        }
        selected_covered_fact_ids.update(fixed_covered_fact_ids)
        missing_coverage_fact_ids = [
            fact_id
            for fact_id in required_fact_ids
            if fact_id not in selected_covered_fact_ids
        ]
        cache.final_required_fact_ids = list(required_fact_ids)
        cache.final_covered_fact_ids = [
            fact_id
            for fact_id in required_fact_ids
            if fact_id in selected_covered_fact_ids
        ]
        cache.final_missing_fact_ids = list(missing_coverage_fact_ids)
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
        allowed_redundant_count = _maximum_semantic_duplicates(
            semantic_evaluated_count
        )
        required_independent_group_count = max(
            0,
            semantic_evaluated_count - allowed_redundant_count,
        )
        current_independent_group_count = max(
            0,
            semantic_evaluated_count
            - (
                current_redundancy.redundant_candidate_count
                if current_redundancy is not None
                else 0
            ),
        )
        independent_group_gap = max(
            0,
            required_independent_group_count - current_independent_group_count,
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
            current_redundancy is not None and independent_group_gap > 0
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
        if (
            should_quantity_supplement
            or should_coverage_supplement
            or should_diversity_supplement
        ):
            # Planning may await several model calls. Publish this node before
            # the await, rather than leaving the completed evaluator on screen.
            await self._stage(
                context,
                NodeId.EXACT_SELECTION_AND_SUPPLEMENT,
                StageStatus.RUNNING,
                (
                    "正在规划数量补充"
                    if should_quantity_supplement
                    else "正在规划缺失事实的定向补充"
                    if should_coverage_supplement
                    else "正在规划并复核多样性补充方向"
                ),
                metadata={
                    "round": round_number,
                    "targetCount": 1 if item_operation else settings.target_count,
                    "acceptedCount": len(cache.accepted_items),
                    "missingCount": missing,
                    "missingRequiredFactCount": len(missing_coverage_fact_ids),
                    "supplementPlanning": True,
                },
            )
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
            diversity_supplement_count = _diversity_supplement_count(
                selection_target=selection_target,
                independent_group_gap=independent_group_gap,
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
                    "requiredIndependentGroupCount": (
                        required_independent_group_count
                    ),
                    "currentIndependentGroupCount": (
                        current_independent_group_count
                    ),
                    "independentGroupGap": independent_group_gap,
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
        if snapshot.operation == "ITEM_EVALUATE":
            return pending, should_supplement
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
                "requiredIndependentGroupCount": required_independent_group_count,
                "currentIndependentGroupCount": current_independent_group_count,
                "independentGroupGap": independent_group_gap,
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
            required_fact_ids=_visually_required_business_fact_ids(
                self._require_application(context),
                cache.fact_visual_strategy,
            ),
        )
        final_required_fact_ids = [fact.fact_id for fact in coverage.required]
        deep_business_fact_ids = set(final_required_fact_ids)
        final_covered_fact_ids = [fact.fact_id for fact in coverage.covered]
        final_missing_fact_ids = [fact.fact_id for fact in coverage.missing]
        quality_status: Literal["PASS", "NEEDS_REVIEW"] = (
            "PASS"
            if len(items) == expected
            and all(item.classification_status == "VERIFIED" for item in items)
            and (
                snapshot.operation == "ITEM_EVALUATE"
                or not any(row.evaluation.hard_issues for row in selected)
            )
            and (item_operation or not final_missing_fact_ids)
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
            render_profile=_render_profile(snapshot.settings),
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
                "diversitySupplementTriggerRateLimit": (
                    DIVERSITY_SUPPLEMENT_TRIGGER_RATE
                ),
                "requiredFactCount": len(final_required_fact_ids),
                "coveredRequiredFactCount": len(final_covered_fact_ids),
                "missingRequiredFactCount": len(final_missing_fact_ids),
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
                    {
                        "field": self._require_application(context).by_id[fact_id].field.value,
                        "value": self._require_application(context).by_id[fact_id].value,
                    }
                    for fact_id in final_missing_fact_ids
                    if fact_id in self._require_application(context).by_id
                ],
                "evaluationCallCount": cache.evaluation_call_count,
                "splitRecoveryCount": cache.evaluation_split_recovery_count,
                "directionRepairCount": cache.direction_repair_count,
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
    """Keep siblings together so the model can make their differences explicit.

    Sibling variants generated in isolated requests cannot see one another and
    repeatedly converge on the same obvious scene/action implementation.  A
    grouped request gives the model the complete local comparison set.  This is
    scheduling only; no product or free-text semantics are interpreted here.
    """

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
    residual_groups: list[list[CreativeTask]] = []
    for group in direction_groups.values():
        ordered_group = sorted(group, key=lambda item: item.ordinal)
        while len(ordered_group) >= size:
            chunks.append(ordered_group[:size])
            ordered_group = ordered_group[size:]
        if ordered_group:
            residual_groups.append(ordered_group)

    # Pack only the small remainders together. A sibling group is never split
    # merely to fill a request, so variants that fit still see each other while
    # sparse plans keep the same economical call count.
    residual_chunk: list[CreativeTask] = []
    for group in residual_groups:
        if residual_chunk and len(residual_chunk) + len(group) > size:
            chunks.append(residual_chunk)
            residual_chunk = []
        residual_chunk.extend(group)
    if residual_chunk:
        chunks.append(residual_chunk)
    return chunks


def _creative_shard_size_for_duration(
    target_duration_seconds: int,
    *,
    configured_max_size: int = 5,
    max_output_tokens: int = 8_192,
) -> int:
    """Bound structured output size without changing creative instructions."""

    return creative_shard_size(
        target_duration_seconds,
        configured_max_size=configured_max_size,
        max_output_tokens=max_output_tokens,
    )


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
    similarity_resolver: Callable[[str, str], float] | None = None,
) -> dict[str, Any]:
    selected = selection.selected
    selected_ids = [item.candidate.slot_id for item in selected]
    resolve_similarity = similarity_resolver or vector_index.similarity
    redundancy = vector_index.redundancy_summary(
        selected_ids,
        similarity_resolver=resolve_similarity,
    )
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
        resolve_similarity(left_id, right_id)
        for left_id, right_id in combinations(selected_ids, 2)
    ]
    pair_risks.extend(
        resolve_similarity(selected_id, anchor_id)
        for selected_id in selected_ids
        for anchor_id in vector_index.anchor_ids
    )
    return {
        "selectedCount": len(selected),
        "averageQualityScore": round(average_quality, 4),
        "nearDuplicatePairCount": redundancy.high_risk_pair_count,
        "redundantCandidateCount": redundancy.redundant_candidate_count,
        "affectedCandidateCount": redundancy.affected_candidate_count,
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


def _semantic_aware_similarity_resolver(
    vector_index: ContentVectorIndex,
    evaluations_by_slot: Mapping[str, CreativeEvaluation],
) -> Callable[[str, str], float]:
    """Combine content vectors with AI-owned six-axis categories.

    The Worker only compares category identifiers returned by the evaluator. It
    never infers scene or action meaning from product words or free text.
    """

    def resolve(left_id: str, right_id: str) -> float:
        content_similarity = vector_index.similarity(left_id, right_id)
        left = evaluations_by_slot.get(left_id)
        right = evaluations_by_slot.get(right_id)
        if (
            left is None
            or right is None
            or left.semantic_profile is None
            or right.semantic_profile is None
        ):
            return content_similarity
        cluster_similarity = 1.0 - (
            semantic_cluster_novelty(
                left.semantic_profile,
                right.semantic_profile,
            )
            / 100.0
        )
        blended_similarity = (
            CONTENT_SIMILARITY_WEIGHT * content_similarity
            + SEMANTIC_CLUSTER_SIMILARITY_WEIGHT * cluster_similarity
        )
        # AI-owned semantic families may legitimately be more specific than the
        # underlying picture (for example, morning/evening/family bathroom).
        # They may reveal an overlap missed by the text vector, but must never
        # dilute an already high content-vector match below the risk threshold.
        return round(max(content_similarity, blended_similarity), 6)

    return resolve


def _safe_high_risk_pairs(
    redundancy: RedundancySummary,
    similarity_resolver: Callable[[str, str], float],
    candidates_by_slot: Mapping[str, CreativeCandidate],
) -> list[dict[str, int | float | bool]]:
    ranked: list[tuple[float, str, str]] = [
        (similarity_resolver(left_id, right_id), left_id, right_id)
        for left_id, right_id in redundancy.high_risk_pairs
    ]
    result: list[dict[str, int | float | bool]] = []
    for similarity, left_id, right_id in sorted(ranked, reverse=True)[:3]:
        left = candidates_by_slot.get(left_id)
        right = candidates_by_slot.get(right_id)
        if left is None:
            continue
        result.append(
            {
                "leftOrdinal": left.ordinal,
                "rightOrdinal": right.ordinal if right is not None else 0,
                "rightIsAnchor": right is None,
                "similarity": round(similarity, 4),
            }
        )
    return result


def _adaptive_mmr_quality_weight(candidate_pool_redundancy_rate: float) -> float:
    """Shift ranking weight before a redundant pool leaks into final results.

    The decision is product-agnostic and uses only vector redundancy measured
    across the current candidate pool. Quality remains the majority signal in
    every tier; diversity receives more influence as the pool gets denser.
    """
    if candidate_pool_redundancy_rate > MMR_HIGH_REDUNDANCY_THRESHOLD:
        return 0.60
    return 0.70


def _maximum_semantic_duplicates(evaluated_count: int) -> int:
    if evaluated_count <= 0:
        return 0
    return max(
        0,
        math.ceil(evaluated_count * SEMANTIC_DUPLICATE_RATE_LIMIT / 100.0) - 1,
    )


def _diversity_supplement_count(
    *,
    selection_target: int,
    independent_group_gap: int,
) -> int:
    """Oversample the measured group-capacity gap once, not a fixed batch share."""

    if selection_target <= 0 or independent_group_gap <= 0:
        return 0
    return max(
        math.ceil(selection_target * 0.20),
        independent_group_gap * 2,
    )


def _maximum_diversity_supplement_duplicates(evaluated_count: int) -> int:
    """Compatibility helper; recovery now uses the same strict 15% boundary."""

    return _maximum_semantic_duplicates(evaluated_count)


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


def _visually_required_business_fact_ids(
    application: InsightApplicationMap,
    strategy: FactVisualStrategy | None,
) -> list[str]:
    """Return business facts that a silent material clip can genuinely realize.

    TEXT_ONLY and FORBIDDEN_VISUAL_PROOF facts remain available to the creative
    planner as context, but later copy/voiceover composition owns their final
    expression. This prevents coverage accounting from forcing speech or a
    fabricated visual proof into the material pool.
    """

    business_facts = mandatory_business_facts(application)
    if strategy is None:
        return [fact.fact_id for fact in business_facts]
    deferred_usages = {
        FactVisualUsage.TEXT_ONLY,
        FactVisualUsage.FORBIDDEN_VISUAL_PROOF,
    }
    return [
        fact.fact_id
        for fact in business_facts
        if strategy.by_id.get(fact.fact_id) is not None
        and strategy.by_id[fact.fact_id].visual_usage not in deferred_usages
    ]


def _silent_material_planning_inputs(
    application: InsightApplicationMap,
    strategy: FactVisualStrategy,
) -> tuple[InsightApplicationMap, FactVisualStrategy]:
    """Remove copy-only business facts from silent-material creative planning.

    The full application and strategy remain cached for auditing, item evaluation
    and downstream copy composition. This projection only prevents the landscape,
    direction and candidate planners from treating an unfilmable statement as a
    visual coverage obligation.
    """

    visual_business_ids = set(
        _visually_required_business_fact_ids(application, strategy)
    )
    all_business_ids = {
        fact.fact_id for fact in mandatory_business_facts(application)
    }
    deferred_business_ids = all_business_ids - visual_business_ids
    if not deferred_business_ids:
        return application, strategy

    projected_application = application.model_copy(
        update={
            "required": [
                fact
                for fact in application.required
                if fact.fact_id not in deferred_business_ids
            ],
            "adaptive": [
                fact
                for fact in application.adaptive
                if fact.fact_id not in deferred_business_ids
            ],
        }
    )
    projected_ids = set(projected_application.by_id)
    projected_strategy = strategy.model_copy(
        update={
            "policies": [
                policy.model_copy(
                    update={
                        "compatible_fact_ids": [
                            fact_id
                            for fact_id in policy.compatible_fact_ids
                            if fact_id in projected_ids
                        ]
                    }
                )
                for policy in strategy.policies
                if policy.fact_id in projected_ids
            ]
        }
    )
    return projected_application, projected_strategy


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
    persisted_group_pairs = summary.group_pairs or summary.high_risk_pairs
    for left_entity_id, right_entity_id in persisted_group_pairs:
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
    material_audio_boundary = (
        "这是供后续混剪的无口播广告素材。禁止人物讲话、旁白、人声解说、歌词、"
        "字幕文案和可辨识说话口型；只保留与画面同步的自然环境声和产品动作声。"
    )
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
            key="MATERIAL_AUDIO_BOUNDARY",
            title="素材声音边界",
            source="SYSTEM",
            content=material_audio_boundary,
            editable=False,
            source_hash=_sha256_text(material_audio_boundary),
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


def _render_profile(settings: PromptBatchSettings) -> RenderProfile:
    # Kept only as a compatibility snapshot for existing Prompt results. The
    # render node owns the effective Seedance ratio and resolution.
    disabled = _normalized_disabled_elements(settings.disabled_elements)
    digest = _sha256_json(disabled)
    return RenderProfile(
        ratio="9:16",
        resolution="720p",
        capability_key="SEEDANCE_2_0",
        shared_constraints=SharedRenderConstraints(
            disabled_elements=disabled,
            content_hash=digest,
        ),
    )


def _style_instruction(settings: PromptBatchSettings) -> str:
    if settings.style_mode == "FIXED" and settings.style_tone:
        return f"整批采用{settings.style_tone}作为共享视觉基调"
    # Auto mode intentionally adds no batch-level style requirement. Each
    # candidate may use light, colour or texture only when its own coherent
    # creative needs them, so common scene-to-style stereotypes do not become
    # another source of batch repetition.
    return ""


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
