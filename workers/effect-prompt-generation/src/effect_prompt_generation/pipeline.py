from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import unicodedata
import uuid
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field
from itertools import combinations
from typing import Any, Literal, cast

from pydantic import ValidationError

from .api_client import InternalApi, InternalApiError
from .assembly import (
    assemble_fragment_prompt,
    assemble_safe_fallback_prompt,
    hard_execution_reasons,
)
from .combinations import (
    expression_bindings,
    fragment_type_deficits,
    fragment_type_targets,
    make_shards,
    plan_combinations,
)
from .insight_mapping import bindings_for_fact_ids, map_insight
from .embeddings import (
    ContentVectorIndex,
    CreativeVectorIndex,
    EmbeddingProvider,
    EmbeddingProviderError,
    RedundancySummary,
    VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD,
    build_content_vector_index,
    build_creative_vector_index,
)
from .models import (
    BlueprintBundleQuota,
    BlueprintShardPlan,
    BlueprintTask,
    ClassificationShardPlan,
    CountMetric,
    CreativeAverageScores,
    CreativeCandidate,
    CreativeDimensions,
    CreativeEvaluation,
    CreativeScores,
    CreativeShardPlan,
    CreativeTask,
    EvidenceMode,
    FailurePayload,
    FragmentType,
    FRAGMENT_TYPE_LABELS,
    FragmentFactAllocation,
    FragmentDimensionCoordinatePlan,
    FragmentMarketingPlan,
    FragmentRelationshipPlan,
    GeneratedBlueprint,
    GeneratedCandidate,
    InsightApplicationMap,
    InsightField,
    InsightBinding,
    NodeId,
    PairViolation,
    PlannedCombination,
    ProgressPayload,
    PromptBatchResult,
    PromptBatchSettings,
    PromptBatchResultV6,
    PromptBatchSettingsV6,
    PromptGenerationSnapshot,
    PromptDimensions,
    PromptItem,
    PromptItemV6,
    PromptMetrics,
    PromptMetricsV6,
    PurposeDistribution,
    RenderProfile,
    RuntimeContext,
    SharedPrompt,
    SharedPromptSection,
    ShardPlan,
    ShardPhase,
    ShardRecord,
    SharedRenderConstraints,
    StageOutput,
    StageStatus,
    StrategyPlan,
    StrategyCheckpoint,
    utc_now,
)
from .providers import (
    BLUEPRINT_STAGE_BY_TYPE,
    COORDINATE_STAGE_BY_TYPE,
    FRAGMENT_STRATEGY_STAGE_BY_TYPE,
    FRAGMENT_STRATEGY_VERSION,
    AiProvider,
    ProviderError,
    ProviderErrorType,
    RELATIONSHIP_STAGE_BY_TYPE,
    V10_COORDINATE_VERSION,
    V10_RELATIONSHIP_VERSION,
    merge_fragment_marketing_plans,
)
from .strategy_planning import allocate_fragment_facts, validate_fragment_marketing_plan
from .v10_blueprints import (
    allocate_blueprint_quotas,
    blueprint_signature,
    make_blueprint_shards,
    make_blueprint_tasks,
    materialize_blueprint,
    select_orthogonal_blueprints,
    validate_coordinate_plan,
    validate_generated_blueprints,
    validate_relationship_plan,
)
from .v11_fact_allocation import allocate_v11_creative_facts
from .quality import (
    EvaluationResult,
    CreativeSelectionResult,
    RankedCreative,
    evaluate_candidates,
    pair_rate,
    semantic_violations,
    visual_violations,
    normalize_creative_signature,
    select_creatives,
    validate_creative_evaluation,
)

MAX_REPLENISHMENT_ROUNDS = 3
# Five detailed V11 evaluations can still produce a status=completed response whose
# JSON ends early. Three candidates keep each strict response comfortably bounded;
# the pipeline-level sliding concurrency retains throughput while avoiding paid
# whole-batch failures caused by one oversized classification response.
V11_CLASSIFICATION_SHARD_SIZE = 3

GENERATION_NODE_BY_FRAGMENT: dict[FragmentType, NodeId] = {
    FragmentType.HOOK: NodeId.GENERATE_HOOK,
    FragmentType.PAIN: NodeId.GENERATE_PAIN,
    FragmentType.PRODUCT_DISPLAY: NodeId.GENERATE_PRODUCT_DISPLAY,
    FragmentType.SELLING_POINT_EXPLANATION: NodeId.GENERATE_SELLING_POINT_EXPLANATION,
    FragmentType.CTA: NodeId.GENERATE_CTA,
    FragmentType.OUTRO: NodeId.GENERATE_OUTRO,
}
BLUEPRINT_NODE_BY_FRAGMENT: dict[FragmentType, NodeId] = {
    fragment_type: NodeId(node_id)
    for fragment_type, node_id in BLUEPRINT_STAGE_BY_TYPE.items()
}


class PipelineError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class LoadedRun:
    snapshot: PromptGenerationSnapshot
    candidates: list[GeneratedCandidate]
    completed_shard_keys: list[str]
    highest_round: int
    completed_blueprint_shard_keys: list[str] = field(default_factory=list)
    completed_creative_shard_keys: list[str] = field(default_factory=list)
    completed_classification_shard_keys: list[str] = field(default_factory=list)


@dataclass(slots=True)
class RunCache:
    candidates: dict[str, GeneratedCandidate] = field(default_factory=dict)
    normalized_items: list[PromptItem] = field(default_factory=list)
    accepted_items: list[PromptItem] = field(default_factory=list)
    ai_call_count: int = 0
    total_shards: int = 0
    execution_invalid_reasons: Counter[str] = field(default_factory=Counter)
    insight_application: InsightApplicationMap | None = None
    strategy_plan: StrategyPlan | None = None
    evaluation: EvaluationResult | None = None
    fallback_count: int = 0
    shared_prompt: SharedPrompt | None = None
    strategy_checkpoints: dict[NodeId, StrategyCheckpoint] = field(default_factory=dict)
    relationship_plans: dict[FragmentType, FragmentRelationshipPlan] = field(default_factory=dict)
    coordinate_plans: dict[FragmentType, FragmentDimensionCoordinatePlan] = field(default_factory=dict)
    blueprint_quotas: list[BlueprintBundleQuota] = field(default_factory=list)
    blueprint_tasks: dict[str, BlueprintTask] = field(default_factory=dict)
    blueprints: dict[str, GeneratedBlueprint] = field(default_factory=dict)
    selected_blueprints: dict[str, GeneratedBlueprint] = field(default_factory=dict)
    completed_blueprint_shard_keys: set[str] = field(default_factory=set)
    creatives: dict[str, CreativeCandidate] = field(default_factory=dict)
    creative_evaluations: dict[str, CreativeEvaluation] = field(default_factory=dict)
    completed_creative_shard_keys: set[str] = field(default_factory=set)
    completed_classification_shard_keys: set[str] = field(default_factory=set)
    selected_creatives: CreativeSelectionResult | None = None
    accepted_v11_items: list[PromptItemV6] = field(default_factory=list)
    v11_candidate_target_count: int = 0
    v11_exact_duplicate_count: int = 0
    v11_supplemented: bool = False
    v11_replenishment_rounds: int = 0
    v11_diversity_supplemented: bool = False
    v11_diversity_supplement_count: int = 0
    v11_diversity_avoid_slot_ids: set[str] = field(default_factory=set)
    v11_initial_redundancy_summary: RedundancySummary | None = None
    v11_redundancy_summary: RedundancySummary | None = None
    embedding_vectors: dict[str, tuple[float, ...]] = field(default_factory=dict)
    embedding_stage_metadata: dict[str, Any] = field(default_factory=dict)
    embedding_warning: str | None = None


class PromptGenerationPipeline:
    def __init__(
        self,
        *,
        api: InternalApi,
        provider: AiProvider,
        embedding_provider: EmbeddingProvider | None = None,
        similarity_mode: Literal["trigram", "shadow", "vector"] = "trigram",
        embedding_batch_size: int = 64,
        embedding_max_concurrency: int = 2,
        ai_max_concurrency: int = 6,
        shard_size: int = 8,
        max_ai_calls_per_run: int = 256,
    ) -> None:
        self.api = api
        self.provider = provider
        self.embedding_provider = embedding_provider
        self.similarity_mode = similarity_mode
        self.embedding_batch_size = embedding_batch_size
        self.embedding_max_concurrency = embedding_max_concurrency
        self.ai_max_concurrency = max(1, ai_max_concurrency)
        self._ai_semaphore = asyncio.Semaphore(self.ai_max_concurrency)
        self.shard_size = shard_size
        self.max_ai_calls_per_run = max_ai_calls_per_run
        self._snapshots: dict[str, PromptGenerationSnapshot] = {}
        self._runs: dict[str, RunCache] = {}

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
            }
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
        succeeded = [
            item
            for item in shards
            if item.status == StageStatus.SUCCEEDED and item.phase == ShardPhase.PROMPT
        ]
        succeeded_blueprints = [
            item
            for item in shards
            if item.status == StageStatus.SUCCEEDED and item.phase == ShardPhase.BLUEPRINT
        ]
        succeeded_creatives = [
            item
            for item in shards
            if item.status == StageStatus.SUCCEEDED and item.phase == ShardPhase.CREATIVE
        ]
        succeeded_classifications = [
            item
            for item in shards
            if item.status == StageStatus.SUCCEEDED
            and item.phase == ShardPhase.CLASSIFICATION
        ]
        if any(
            combination.planning_version
            not in {
                "six-branch-v1",
                "six-ai-branch-v2",
                "v10-coordinate-blueprint",
            }
            for shard in succeeded
            for combination in shard.combination_plan
        ):
            raise PipelineError("生成规则已升级，请重新生成当前 Prompt 批次")
        candidates = [candidate for shard in succeeded for candidate in shard.items]
        unique_candidates = _unique_candidates(candidates)
        self._cache(context).candidates = {
            item.slot_id: item for item in unique_candidates
        }
        self._cache(context).execution_invalid_reasons = Counter(
            reason
            for item in unique_candidates
            for reason in item.execution_invalid_reasons
        )
        cache = self._cache(context)
        cache.blueprints = {
            item.slot_id: item for shard in succeeded_blueprints for item in shard.blueprints
        }
        cache.blueprint_tasks = {
            item.slot_id: item for shard in succeeded_blueprints for item in shard.blueprint_plan
        }
        cache.completed_blueprint_shard_keys = {
            item.key for item in succeeded_blueprints
        }
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
        cache.v11_replenishment_rounds = max(
            (
                item.round
                for item in [*succeeded_creatives, *succeeded_classifications]
            ),
            default=0,
        )
        cache.v11_supplemented = cache.v11_replenishment_rounds > 0
        loaded = LoadedRun(
            snapshot=snapshot,
            candidates=unique_candidates,
            completed_shard_keys=[item.key for item in succeeded],
            highest_round=max((item.round for item in succeeded), default=0),
            completed_blueprint_shard_keys=[item.key for item in succeeded_blueprints],
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
                "resumedShardCount": len(succeeded),
                "resumedBlueprintShardCount": len(succeeded_blueprints),
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

    async def plan_strategy(
        self,
        context: RuntimeContext,
        *,
        application: InsightApplicationMap,
        target_count: int,
    ) -> StrategyPlan:
        await self._stage(
            context, NodeId.STRATEGY_PLANNING, StageStatus.RUNNING, "正在规划营销关系"
        )
        self._reserve_ai_call(context)
        call = await self.provider.plan_strategy(application, target_count=target_count)
        plan = call.value
        pools = plan.dimension_pools
        fragment_pools = plan.fragment_strategy_pools
        self._cache(context).strategy_plan = plan
        await self._stage(
            context,
            NodeId.STRATEGY_PLANNING,
            StageStatus.SUCCEEDED,
            "营销关系规划完成",
            metadata={
                "sceneCount": len(pools.scenes),
                "personaCount": len(pools.personas),
                "sellingPointCount": len(pools.selling_points),
                "emotionCount": sum(len(item.emotions) for item in fragment_pools),
                "fragmentStrategyCount": len(fragment_pools),
                "openingStateCount": sum(
                    len(item.opening_states) for item in fragment_pools
                ),
                "actionArcCount": sum(len(item.action_arcs) for item in fragment_pools),
                "cameraPlanCount": sum(len(item.cameras) for item in fragment_pools),
                "endingStateCount": sum(
                    len(item.ending_states) for item in fragment_pools
                ),
                "evidencePlanCount": len(pools.evidence_plans),
                "relationshipBundleCount": len(plan.relationship_bundles),
                "plannedFactCount": len(
                    {
                        fact_id
                        for bundle in plan.relationship_bundles
                        for fact_id in bundle.fact_ids
                    }
                ),
                "modelRelationshipBundleCount": (
                    call.metadata.model_relationship_bundle_count
                ),
                "workerCompletedRelationshipBundleCount": (
                    call.metadata.worker_completed_relationship_bundle_count
                ),
                "dimensionExample": _short(
                    f"{fragment_pools[0].opening_states[0]} / {pools.scenes[0]} / {pools.selling_points[0]}"
                ),
            },
        )
        await self.progress(context, 15, NodeId.STRATEGY_PLANNING)
        return plan

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

    async def plan_v11_creatives(
        self,
        context: RuntimeContext,
        *,
        round_number: int,
        missing_count: int | None = None,
        requested_count: int | None = None,
        supplement_kind: Literal["QUANTITY", "DIVERSITY"] = "QUANTITY",
    ) -> list[CreativeShardPlan]:
        settings = _v11_settings(self.snapshot(context))
        snapshot = self.snapshot(context)
        cache = self._cache(context)
        if snapshot.operation == "ITEM_EVALUATE":
            if round_number != 0:
                return []
            target = snapshot.target_item
            if not isinstance(target, PromptItemV6):
                raise PipelineError("V11 item evaluation requires a V6 target item")
            application = self._require_application(context)
            declared_ids = list(
                dict.fromkeys(
                    [binding.fact_id for binding in target.insight_bindings]
                    + [fact.fact_id for fact in application.usable]
                )
            )[:12]
            if not declared_ids:
                raise PipelineError("V11 item evaluation requires confirmed insight facts")
            candidate = CreativeCandidate(
                slot_id=target.id,
                ordinal=(snapshot.target_item_index or 0) + 1,
                round=0,
                creative_core=target.dimensions.narrative,
                declared_fact_ids=declared_ids,
                dimensions=target.dimensions,
                content=target.content,
                generated_at=utc_now(),
            )
            cache.creatives[candidate.slot_id] = candidate
            cache.v11_candidate_target_count = 1
            return []
        selection_target = 1 if snapshot.operation == "ITEM_REGENERATE" else max(
            0, settings.target_count - len(snapshot.retained_manual_items)
        )
        if round_number == 0:
            requested = 3 if snapshot.operation == "ITEM_REGENERATE" else math.ceil(
                selection_target * 1.2
            )
            cache.v11_candidate_target_count = requested
        elif supplement_kind == "DIVERSITY":
            requested = max(1, requested_count or 1)
            cache.v11_diversity_supplemented = True
            cache.v11_diversity_supplement_count += requested
        else:
            deficit = max(1, missing_count or selection_target)
            requested = max(deficit + 1, math.ceil(deficit * 1.2))
            cache.v11_supplemented = True
            cache.v11_replenishment_rounds = max(
                cache.v11_replenishment_rounds,
                round_number,
            )
        application = self._require_application(context)
        preferred_primary_ids = (
            [binding.fact_id for binding in snapshot.target_item.insight_bindings]
            if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item
            else []
        )
        ordinal_start = (
            1
            if round_number == 0
            else max((item.ordinal for item in cache.creatives.values()), default=0) + 1
        )
        fact_assignments = allocate_v11_creative_facts(
            application,
            count=requested,
            ordinal_start=ordinal_start,
            preferred_primary_fact_ids=preferred_primary_ids,
        )
        tasks = [
            CreativeTask(
                slot_id=f"v11-r{round_number}-c{ordinal_start + index:04d}",
                ordinal=ordinal_start + index,
                round=round_number,
                target_duration_seconds=(
                    snapshot.target_item.target_duration_seconds
                    if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item
                    else settings.default_duration_seconds
                ),
                fact_assignment=fact_assignments[index],
                preferred_fact_ids=[fact_assignments[index].primary_fact_id],
            )
            for index in range(requested)
        ]
        selected = cache.selected_creatives.selected if cache.selected_creatives else []
        if supplement_kind == "DIVERSITY" and cache.v11_diversity_avoid_slot_ids:
            selected = [
                item
                for item in selected
                if item.candidate.slot_id in cache.v11_diversity_avoid_slot_ids
            ]
        rejection_reasons = sorted(
            {
                issue
                for evaluation in cache.creative_evaluations.values()
                for issue in evaluation.hard_issues
            }
        )[:20]
        shards = [
            CreativeShardPlan(
                round=round_number,
                shard_index=index,
                tasks=tasks[start : start + min(4, self.shard_size)],
                avoid_semantic_signatures=[
                    item.evaluation.semantic_signature for item in selected
                ],
                avoid_visual_signatures=[
                    item.evaluation.visual_signature for item in selected
                ],
                rejection_reasons=rejection_reasons,
            )
            for index, start in enumerate(range(0, len(tasks), min(4, self.shard_size)))
        ]
        pending = [
            item for item in shards if item.key not in cache.completed_creative_shard_keys
        ]
        await self._stage(
            context,
            NodeId.COHERENT_CREATIVE_GENERATION,
            StageStatus.RUNNING if pending else StageStatus.SUCCEEDED,
            "正在生成连贯六维创意" if pending else "连贯六维创意已恢复",
            metadata={
                "round": round_number,
                "supplementKind": supplement_kind,
                "candidateTargetCount": requested,
                "pendingShardCount": len(pending),
                "shardSize": min(4, self.shard_size),
                "factSelectionMode": "WORKER_ASSIGNMENT_V1",
                "primaryFactCount": len(
                    {
                        assignment.primary_fact_id
                        for assignment in fact_assignments
                    }
                ),
                "productAnchorFactCount": len(
                    {
                        fact_id
                        for assignment in fact_assignments
                        for fact_id in assignment.product_anchor_fact_ids
                    }
                ),
            },
        )
        return pending

    async def generate_v11_creative_shard(
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
                        call = await self.provider.generate_creatives(
                            shard,
                            application=self._require_application(context),
                            shared_prompt=self._required_shared_prompt(context),
                            regeneration_context=(
                                {
                                    "originalPrompt": snapshot.target_item.content,
                                    "instruction": snapshot.regeneration_instruction or "",
                                    "replacementDimensions": (
                                        snapshot.replacement_dimensions.model_dump(
                                            mode="json", by_alias=True
                                        )
                                        if snapshot.replacement_dimensions
                                        else None
                                    ),
                                }
                                if snapshot.operation == "ITEM_REGENERATE"
                                and snapshot.target_item
                                else None
                            ),
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
            setattr(
                exc,
                "node_id",
                NodeId.ITEM_EVALUATE
                if snapshot.operation == "ITEM_EVALUATE"
                else NodeId.COHERENT_CREATIVE_GENERATION,
            )
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

    async def complete_v11_creative_generation(
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
                "round": round_number,
                "targetCount": (
                    1
                    if snapshot.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"}
                    else _v11_settings(snapshot).target_count
                ),
                "candidateTargetCount": cache.v11_candidate_target_count,
                "candidateCount": len(cache.creatives),
                "roundCandidateCount": len(round_items),
                "completedShardCount": len(cache.completed_creative_shard_keys),
                "supplemented": cache.v11_supplemented,
                "factSelectionMode": "WORKER_ASSIGNMENT_V1",
            },
        )

    async def plan_v11_classification(
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
                    start : start + V11_CLASSIFICATION_SHARD_SIZE
                ],
            )
            for index, start in enumerate(
                range(
                    0,
                    len(round_candidate_ids),
                    V11_CLASSIFICATION_SHARD_SIZE,
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
                "shardSize": V11_CLASSIFICATION_SHARD_SIZE,
            },
        )
        return pending

    async def evaluate_v11_classification_shard(
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
            for invalid_response_attempt in range(2):
                self._reserve_ai_call(context)
                try:
                    async with self._ai_semaphore:
                        call = await self.provider.evaluate_creatives(
                            candidates,
                            application=self._require_application(context),
                        )
                    break
                except ProviderError as exc:
                    if (
                        exc.error_type != ProviderErrorType.RESPONSE_INVALID
                        or invalid_response_attempt == 1
                    ):
                        raise
            candidate_by_id = {item.slot_id: item for item in candidates}
            items = [
                validate_creative_evaluation(
                    candidate_by_id[item.slot_id],
                    item,
                    self._require_application(context),
                )
                for item in call.value.items
            ]
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

    async def complete_v11_classification(
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
        hard_counts = Counter(issue for item in evaluations for issue in item.hard_issues)
        warning_counts = Counter(warning for item in evaluations for warning in item.warnings)
        purpose_counts = Counter(item.primary_purpose for item in evaluations)
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
                "completedShardCount": len(
                    cache.completed_classification_shard_keys
                ),
                "averageScores": _average_v11_scores(
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
            },
        )

    async def select_v11_creatives(
        self,
        context: RuntimeContext,
        *,
        round_number: int,
    ) -> tuple[list[CreativeShardPlan], bool]:
        cache = self._cache(context)
        snapshot = self.snapshot(context)
        settings = _v11_settings(snapshot)
        item_operation = snapshot.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"}
        selection_target = 1 if item_operation else max(
            0, settings.target_count - len(snapshot.retained_manual_items)
        )
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
            )
            result = baseline_result
            cache.embedding_stage_metadata = {
                "similarityMode": self.similarity_mode,
                "selectionMethod": "TRIGRAM",
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
            content_mmr_policy = (
                snapshot.selection_policy_version == "MMR_CONTENT_V2"
            )
            if (
                self.similarity_mode != "trigram"
                and len(eligible_candidates) > 1
                and content_mmr_policy
            ):
                if self.embedding_provider is None:
                    raise PipelineError(
                        "embedding provider is required for shadow or vector similarity"
                    )
                anchors = [
                    item
                    for item in snapshot.similarity_anchors
                    if isinstance(item, PromptItemV6)
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
                    mmr_result = select_creatives(
                        list(cache.creatives.values()),
                        list(cache.creative_evaluations.values()),
                        target_count=selection_target,
                        novelty_resolver=lambda left, right: content_index.novelty(
                            left.candidate.slot_id,
                            right.candidate.slot_id,
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
                        quality_weight=0.70,
                        novelty_weight=0.30,
                    )
                    baseline_ids = {
                        item.candidate.slot_id for item in baseline_result.selected
                    }
                    mmr_ids = {
                        item.candidate.slot_id for item in mmr_result.selected
                    }
                    denominator = max(1, len(baseline_ids))
                    baseline_summary = _selection_content_summary(
                        baseline_result,
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
                    redundancy = content_index.redundancy_summary(
                        [item.candidate.slot_id for item in mmr_result.selected]
                    )
                    if cache.v11_initial_redundancy_summary is None:
                        cache.v11_initial_redundancy_summary = redundancy
                    cache.v11_redundancy_summary = redundancy
                    cache.v11_diversity_avoid_slot_ids = set(
                        redundancy.high_risk_candidate_ids
                    )
                    stats = content_index.stats
                    soft_excess_limit = max(2, math.ceil(selection_target * 0.10))
                    cache.embedding_stage_metadata = {
                        "similarityMode": self.similarity_mode,
                        "selectionPolicyVersion": "MMR_CONTENT_V2",
                        "selectionMethod": (
                            "CONTENT_VECTOR_MMR"
                            if self.similarity_mode == "vector"
                            else "TRIGRAM_SHADOW"
                        ),
                        "mmrQualityWeight": 0.70,
                        "mmrDiversityWeight": 0.30,
                        "fixedAnchorCount": len(anchors),
                        "embeddingInputCount": stats.input_count,
                        "embeddingRequestCount": stats.request_count,
                        "embeddingInputTokens": stats.input_tokens,
                        "embeddingRetryCount": stats.retry_count,
                        "embeddingCacheHitCount": stats.cache_hit_count,
                        "comparisonCount": stats.comparison_count,
                        "embeddingDurationMs": stats.duration_ms,
                        "localComparisonMs": stats.local_comparison_ms,
                        "contentSimilarityP50": stats.similarity_p50,
                        "contentSimilarityP95": stats.similarity_p95,
                        "vectorSelectionOverlapPercent": round(
                            100.0 * len(baseline_ids & mmr_ids) / denominator,
                            2,
                        ),
                        "vectorChangedItemCount": len(mmr_ids - baseline_ids),
                        "nearDuplicateRiskThreshold": (
                            VECTOR_NEAR_DUPLICATE_RISK_THRESHOLD
                        ),
                        "softExcessLimit": soft_excess_limit,
                        "baselineSelection": baseline_summary,
                        "contentMmrSelection": mmr_summary,
                        "nearDuplicateReductionApplicable": reduction_applicable,
                        "nearDuplicateReductionPercent": reduction,
                        "averageQualityDelta": round(
                            float(mmr_summary["averageQualityScore"])
                            - float(baseline_summary["averageQualityScore"]),
                            4,
                        ),
                        "initialHighRiskGroupCount": (
                            cache.v11_initial_redundancy_summary.high_risk_group_count
                        ),
                        "initialRedundantCandidateCount": (
                            cache.v11_initial_redundancy_summary.redundant_candidate_count
                        ),
                        "finalHighRiskGroupCount": redundancy.high_risk_group_count,
                        "finalHighRiskPairCount": redundancy.high_risk_pair_count,
                        "finalRedundantCandidateCount": (
                            redundancy.redundant_candidate_count
                        ),
                        "diversitySupplementTriggered": (
                            cache.v11_diversity_supplemented
                        ),
                        "diversitySupplementCount": (
                            cache.v11_diversity_supplement_count
                        ),
                        "highRiskPairs": stats.high_risk_pairs,
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
                        "selectionPolicyVersion": "MMR_CONTENT_V2",
                        "selectionMethod": "TRIGRAM_SHADOW_UNAVAILABLE",
                        "embeddingWarning": str(exc),
                    }
            elif self.similarity_mode != "trigram" and len(eligible_candidates) > 1:
                if self.embedding_provider is None:
                    raise PipelineError(
                        "embedding provider is required for shadow or vector similarity"
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
                    vector_result = select_creatives(
                        list(cache.creatives.values()),
                        list(cache.creative_evaluations.values()),
                        target_count=selection_target,
                        novelty_resolver=lambda left, right: vector_index.dual_novelty(
                            left.candidate.slot_id,
                            right.candidate.slot_id,
                        ),
                    )
                    content_result = select_creatives(
                        list(cache.creatives.values()),
                        list(cache.creative_evaluations.values()),
                        target_count=selection_target,
                        novelty_resolver=lambda left, right: vector_index.content_novelty(
                            left.candidate.slot_id,
                            right.candidate.slot_id,
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
                    stats = vector_index.stats
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
                            "VECTOR" if self.similarity_mode == "vector" else "TRIGRAM_SHADOW"
                        ),
                        "embeddingInputCount": stats.input_count,
                        "embeddingRequestCount": stats.request_count,
                        "embeddingInputTokens": stats.input_tokens,
                        "embeddingRetryCount": stats.retry_count,
                        "embeddingCacheHitCount": stats.cache_hit_count,
                        "comparisonCount": stats.comparison_count,
                        "embeddingDurationMs": stats.duration_ms,
                        "localComparisonMs": stats.local_comparison_ms,
                        "contentSimilarityP50": stats.content_p50,
                        "contentSimilarityP95": stats.content_p95,
                        "creativeSimilarityP50": stats.creative_p50,
                        "creativeSimilarityP95": stats.creative_p95,
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
                        "highRiskPairs": stats.high_risk_pairs,
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
                        "selectionMethod": "TRIGRAM_SHADOW_UNAVAILABLE",
                        "embeddingWarning": str(exc),
                    }
            elif self.similarity_mode != "trigram":
                cache.embedding_stage_metadata = {
                    "similarityMode": self.similarity_mode,
                    "selectionMethod": "SKIPPED_SINGLE_CANDIDATE",
                    "comparisonCount": 0,
                }
        cache.selected_creatives = result
        cache.v11_exact_duplicate_count = result.exact_duplicate_count
        items = _v11_prompt_items(
            context,
            result,
            self._require_application(context),
            settings.default_duration_seconds,
        )
        cache.accepted_v11_items = (
            items
            if item_operation
            else [*_retained_v11_items(snapshot.retained_manual_items), *items]
        )
        missing = max(0, selection_target - len(items))
        should_quantity_supplement = (
            missing > 0
            and cache.v11_replenishment_rounds < MAX_REPLENISHMENT_ROUNDS
            and snapshot.operation != "ITEM_EVALUATE"
        )
        redundancy = cache.v11_redundancy_summary
        soft_excess_limit = max(2, math.ceil(selection_target * 0.10))
        should_diversity_supplement = (
            not should_quantity_supplement
            and missing == 0
            and selection_target > 1
            and snapshot.operation == "BATCH_GENERATE"
            and snapshot.selection_policy_version == "MMR_CONTENT_V2"
            and self.similarity_mode == "vector"
            and not cache.v11_diversity_supplemented
            and redundancy is not None
            and redundancy.redundant_candidate_count > soft_excess_limit
        )
        diversity_supplement_count = 0
        if should_diversity_supplement and redundancy is not None:
            diversity_supplement_count = min(
                max(
                    2,
                    math.ceil(
                        (
                            redundancy.redundant_candidate_count
                            - soft_excess_limit
                        )
                        * 1.25
                    ),
                ),
                math.ceil(selection_target * 0.20),
            )
        pending = []
        if should_quantity_supplement:
            pending = await self.plan_v11_creatives(
                context,
                round_number=round_number + 1,
                missing_count=missing,
            )
        elif should_diversity_supplement:
            pending = await self.plan_v11_creatives(
                context,
                round_number=round_number + 1,
                requested_count=diversity_supplement_count,
                supplement_kind="DIVERSITY",
            )
        should_supplement = should_quantity_supplement or should_diversity_supplement
        if cache.embedding_stage_metadata:
            cache.embedding_stage_metadata.update(
                {
                    "initialCandidateCount": cache.v11_candidate_target_count,
                    "finalCandidateCount": len(cache.creatives),
                    "diversitySupplementTriggered": (
                        cache.v11_diversity_supplemented
                    ),
                    "diversitySupplementCount": (
                        cache.v11_diversity_supplement_count
                    ),
                    "finalAccurateCount": len(cache.accepted_v11_items),
                }
            )
        diversity_soft_warning = (
            "SEMANTIC_DIVERSITY_SOFT_TARGET_NOT_MET"
            if (
                not should_supplement
                and missing == 0
                and cache.v11_diversity_supplemented
                and redundancy is not None
                and redundancy.redundant_candidate_count > soft_excess_limit
            )
            else None
        )
        stage_warnings = [
            warning
            for warning in (cache.embedding_warning, diversity_soft_warning)
            if warning
        ]
        await self._stage(
            context,
            NodeId.EXACT_SELECTION_AND_SUPPLEMENT,
            StageStatus.PARTIAL if should_supplement else StageStatus.SUCCEEDED,
            (
                "合格候选不足，正在执行数量补充"
                if should_quantity_supplement
                else "语义相似候选偏多，正在执行一次多样性补充"
                if should_diversity_supplement
                else "已按质量与语义多样性选满目标数量"
            ),
            metadata={
                "round": round_number,
                "acceptedCount": len(cache.accepted_v11_items),
                "targetCount": 1
                if item_operation
                else settings.target_count,
                "missingCount": missing,
                "exactDuplicateCount": result.exact_duplicate_count,
                "supplemented": cache.v11_supplemented,
                **cache.embedding_stage_metadata,
            },
            warnings=stage_warnings or None,
        )
        return pending, should_supplement

    async def save_v11_result(self, context: RuntimeContext) -> str:
        cache = self._cache(context)
        snapshot = self.snapshot(context)
        settings = _v11_settings(snapshot)
        items = cache.accepted_v11_items
        item_operation = snapshot.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"}
        expected = 1 if item_operation else settings.target_count
        selected = cache.selected_creatives.selected if cache.selected_creatives else []
        score_rows = [item.evaluation.scores for item in selected]
        hard_counts = Counter(
            issue for item in selected for issue in item.evaluation.hard_issues
        )
        warning_counts = Counter(
            warning for item in selected for warning in item.evaluation.warnings
        )
        average = _average_v11_scores(score_rows)
        primary_distribution = Counter(item.primary_purpose for item in items)
        compatible_distribution = Counter(
            purpose for item in items for purpose in item.compatible_purposes
        )
        quality_status: Literal["PASS", "NEEDS_REVIEW"] = (
            "PASS"
            if len(items) == expected
            and all(item.classification_status == "VERIFIED" for item in items)
            and not any(row.evaluation.hard_issues for row in selected)
            else "NEEDS_REVIEW"
        )
        metrics = PromptMetricsV6(
            target_count=settings.target_count,
            candidate_target_count=max(10, cache.v11_candidate_target_count),
            generated_candidate_count=len(cache.creatives),
            accepted_count=len(items),
            rejected_count=max(0, len(cache.creatives) - len(selected)),
            replenishment_rounds=cache.v11_replenishment_rounds,
            exact_duplicate_count=cache.v11_exact_duplicate_count,
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
        )
        result = PromptBatchResultV6(
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
        await self._stage(
            context,
            NodeId.RESULT_SAVE,
            StageStatus.RUNNING,
            "正在保存 V11 Prompt 草稿",
            metadata={
                "batchSize": len(items),
                "qualityStatus": quality_status,
                "executionMode": self.provider.execution_mode,
            },
        )
        return await self.api.complete(
            context,
            result,
            execution_mode=self.provider.execution_mode,
        )

    async def allocate_strategy_facts(
        self, context: RuntimeContext, application: InsightApplicationMap
    ) -> dict[FragmentType, FragmentFactAllocation]:
        await self._stage(
            context,
            NodeId.GLOBAL_FACT_ALLOCATION,
            StageStatus.RUNNING,
            "正在分配六类片段事实",
        )
        settings = self.snapshot(context).settings
        counts = {
            fragment_type: settings.fragment_configs[fragment_type].count
            for fragment_type in FragmentType
        }
        allocations = allocate_fragment_facts(application, counts)
        await self._stage(
            context,
            NodeId.GLOBAL_FACT_ALLOCATION,
            StageStatus.SUCCEEDED,
            "全局事实分配完成",
            metadata={
                "fragmentTypeCount": len(allocations),
                "mandatoryFactCount": len(
                    {fact_id for row in allocations.values() for fact_id in row.mandatory_fact_ids}
                ),
                "bundleTargetCount": sum(row.bundle_target for row in allocations.values()),
            },
        )
        await self.progress(context, 15, NodeId.GLOBAL_FACT_ALLOCATION)
        return allocations

    async def prepare_strategy_router(
        self,
        context: RuntimeContext,
        allocations: Mapping[FragmentType, FragmentFactAllocation],
    ) -> list[FragmentMarketingPlan]:
        await self._stage(
            context,
            NodeId.STRATEGY_FRAGMENT_ROUTER,
            StageStatus.RUNNING,
            "正在路由六类营销规划",
        )
        reusable: list[FragmentMarketingPlan] = []
        cache = self._cache(context)
        for allocation in allocations.values():
            node = NodeId(FRAGMENT_STRATEGY_STAGE_BY_TYPE[allocation.fragment_type])
            checkpoint = cache.strategy_checkpoints.get(node)
            if not checkpoint:
                continue
            if not isinstance(checkpoint.plan, FragmentMarketingPlan):
                continue
            if (
                checkpoint.source_fingerprint != context.source_fingerprint
                or checkpoint.allocation_hash != allocation.allocation_hash
                or checkpoint.prompt_version != FRAGMENT_STRATEGY_VERSION
            ):
                continue
            try:
                validate_fragment_marketing_plan(checkpoint.plan, allocation, cache.insight_application or self._require_application(context))
            except ValueError:
                continue
            reusable.append(checkpoint.plan.model_copy(update={"reused_checkpoint": True}))
            await self._stage(
                context,
                node,
                StageStatus.SUCCEEDED,
                "已复用上一次成功的营销规划",
                metadata=self._plan_stage_metadata(checkpoint.plan, allocation, reused=True),
            )
        await self._stage(
            context,
            NodeId.STRATEGY_FRAGMENT_ROUTER,
            StageStatus.SUCCEEDED,
            "营销规划分支已路由",
            metadata={"branchCount": len(allocations), "reusedCheckpointCount": len(reusable)},
        )
        return reusable

    async def skip_fragment_strategy(
        self, context: RuntimeContext, allocation: FragmentFactAllocation, summary: str
    ) -> None:
        node = NodeId(FRAGMENT_STRATEGY_STAGE_BY_TYPE[allocation.fragment_type])
        await self._stage(
            context,
            node,
            StageStatus.SKIPPED,
            summary,
            metadata={
                "targetBundleCount": allocation.bundle_target,
                "actualBundleCount": 0,
                "mandatoryFactCount": len(allocation.mandatory_fact_ids),
                "coveredMandatoryFactCount": 0,
                "reusedCheckpoint": summary.startswith("已复用"),
            },
        )

    async def plan_fragment_strategy(
        self,
        context: RuntimeContext,
        allocation: FragmentFactAllocation,
    ) -> FragmentMarketingPlan:
        node = NodeId(FRAGMENT_STRATEGY_STAGE_BY_TYPE[allocation.fragment_type])
        await self._stage(context, node, StageStatus.RUNNING, "正在生成本类营销创意母版")
        try:
            self._reserve_ai_call(context)
            shared_prompt = self._cache(context).shared_prompt
            if shared_prompt is None:
                raise PipelineError("批次共用提示词尚未编译")
            call = await self.provider.plan_fragment_strategy(
                allocation,
                application=self._require_application(context),
                shared_prompt=shared_prompt,
            )
            plan = call.value
            validate_fragment_marketing_plan(plan, allocation, self._require_application(context))
        except Exception as exc:
            setattr(exc, "node_id", node)
            await self._stage(context, node, StageStatus.FAILED, _safe_error(exc))
            raise
        await self._stage(
            context,
            node,
            StageStatus.SUCCEEDED,
            "本类营销创意母版已完成",
            metadata={
                **self._plan_stage_metadata(plan, allocation, reused=False),
                "checkpoint": {
                    "nodeId": node.value,
                    "sourceFingerprint": context.source_fingerprint,
                    "allocationHash": allocation.allocation_hash,
                    "promptVersion": plan.prompt_version,
                    "plan": plan.model_dump(mode="json", by_alias=True),
                },
                "latencyMs": call.metadata.latency_ms,
                "outputTokens": call.metadata.output_tokens,
            },
        )
        return plan

    async def merge_strategy_plans(
        self,
        context: RuntimeContext,
        plans: list[FragmentMarketingPlan],
    ) -> StrategyPlan:
        await self._stage(
            context,
            NodeId.STRATEGY_MERGE_VALIDATION,
            StageStatus.RUNNING,
            "正在合并校验六类营销规划",
        )
        expected = self._expected_strategy_fragments(context)
        plan = merge_fragment_marketing_plans(
            self._require_application(context), plans, required_fragment_types=expected
        )
        self._cache(context).strategy_plan = plan
        await self._stage(
            context,
            NodeId.STRATEGY_MERGE_VALIDATION,
            StageStatus.SUCCEEDED,
            "营销规划合并校验完成",
            metadata={
                "completedBranchCount": len({item.fragment_type for item in plans}),
                "relationshipBundleCount": len(plan.relationship_bundles),
                "plannedFactCount": len({fact_id for row in plan.relationship_bundles for fact_id in row.fact_ids}),
            },
        )
        await self.progress(context, 24, NodeId.STRATEGY_MERGE_VALIDATION)
        return plan

    async def prepare_relationship_router(
        self,
        context: RuntimeContext,
        allocations: Mapping[FragmentType, FragmentFactAllocation],
    ) -> list[FragmentRelationshipPlan]:
        await self._stage(
            context,
            NodeId.RELATIONSHIP_FRAGMENT_ROUTER,
            StageStatus.RUNNING,
            "正在路由六类营销事实关系",
        )
        reusable: list[FragmentRelationshipPlan] = []
        cache = self._cache(context)
        for allocation in allocations.values():
            node = NodeId(RELATIONSHIP_STAGE_BY_TYPE[allocation.fragment_type])
            checkpoint = cache.strategy_checkpoints.get(node)
            if not checkpoint or not isinstance(checkpoint.plan, FragmentRelationshipPlan):
                continue
            if (
                checkpoint.source_fingerprint != context.source_fingerprint
                or checkpoint.allocation_hash != allocation.allocation_hash
                or checkpoint.prompt_version != V10_RELATIONSHIP_VERSION
            ):
                continue
            try:
                validate_relationship_plan(checkpoint.plan, allocation, self._require_application(context))
            except ValueError:
                continue
            plan = checkpoint.plan.model_copy(update={"reused_checkpoint": True})
            reusable.append(plan)
            cache.relationship_plans[plan.fragment_type] = plan
        await self._stage(
            context,
            NodeId.RELATIONSHIP_FRAGMENT_ROUTER,
            StageStatus.SUCCEEDED,
            "营销事实关系分支已路由",
            metadata={"branchCount": len(allocations), "reusedCheckpointCount": len(reusable)},
        )
        return reusable

    async def plan_fragment_relationships(
        self,
        context: RuntimeContext,
        allocation: FragmentFactAllocation,
    ) -> FragmentRelationshipPlan:
        node = NodeId(RELATIONSHIP_STAGE_BY_TYPE[allocation.fragment_type])
        await self._stage(context, node, StageStatus.RUNNING, "正在生成本类营销事实关系")
        try:
            self._reserve_ai_call(context)
            call = await self.provider.plan_fragment_relationships(
                allocation,
                application=self._require_application(context),
                shared_prompt=self._required_shared_prompt(context),
            )
            validate_relationship_plan(call.value, allocation, self._require_application(context))
        except Exception as exc:
            setattr(exc, "node_id", node)
            await self._stage(context, node, StageStatus.FAILED, _safe_error(exc))
            raise
        plan = call.value
        self._cache(context).relationship_plans[plan.fragment_type] = plan
        await self._stage(
            context,
            node,
            StageStatus.SUCCEEDED,
            "本类营销事实关系已完成",
            metadata={
                "targetBundleCount": allocation.bundle_target,
                "actualBundleCount": len(plan.bundles),
                "plannedFactCount": len({fact_id for row in plan.bundles for fact_id in row.fact_ids}),
                "checkpoint": {
                    "nodeId": node.value,
                    "sourceFingerprint": context.source_fingerprint,
                    "allocationHash": allocation.allocation_hash,
                    "promptVersion": plan.prompt_version,
                    "plan": plan.model_dump(mode="json", by_alias=True),
                },
            },
        )
        return plan

    async def merge_relationship_plans(
        self,
        context: RuntimeContext,
        plans: list[FragmentRelationshipPlan],
    ) -> list[FragmentRelationshipPlan]:
        await self._stage(
            context,
            NodeId.RELATIONSHIP_MERGE_VALIDATION,
            StageStatus.RUNNING,
            "正在合并校验六类营销事实关系",
        )
        expected = self._expected_strategy_fragments(context)
        by_type = {item.fragment_type: item for item in plans}
        if len(by_type) != len(plans) or set(by_type) != expected:
            raise PipelineError("六类营销事实关系缺失或重复")
        self._cache(context).relationship_plans = by_type
        await self._stage(
            context,
            NodeId.RELATIONSHIP_MERGE_VALIDATION,
            StageStatus.SUCCEEDED,
            "营销事实关系合并校验完成",
            metadata={
                "completedBranchCount": len(plans),
                "relationshipBundleCount": sum(len(item.bundles) for item in plans),
            },
        )
        return plans

    async def prepare_coordinate_router(
        self,
        context: RuntimeContext,
        relationships: list[FragmentRelationshipPlan],
    ) -> list[FragmentDimensionCoordinatePlan]:
        await self._stage(
            context,
            NodeId.DIMENSION_COORDINATE_ROUTER,
            StageStatus.RUNNING,
            "正在路由六类产品专属六维坐标规划",
        )
        reusable: list[FragmentDimensionCoordinatePlan] = []
        cache = self._cache(context)
        for relationship in relationships:
            node = NodeId(COORDINATE_STAGE_BY_TYPE[relationship.fragment_type])
            checkpoint = cache.strategy_checkpoints.get(node)
            if not checkpoint or not isinstance(checkpoint.plan, FragmentDimensionCoordinatePlan):
                continue
            if (
                checkpoint.source_fingerprint != context.source_fingerprint
                or checkpoint.prompt_version != V10_COORDINATE_VERSION
            ):
                continue
            try:
                validate_coordinate_plan(
                    checkpoint.plan,
                    relationship,
                    self._require_application(context),
                )
            except ValueError:
                continue
            plan = checkpoint.plan.model_copy(update={"reused_checkpoint": True})
            reusable.append(plan)
            cache.coordinate_plans[plan.fragment_type] = plan
        await self._stage(
            context,
            NodeId.DIMENSION_COORDINATE_ROUTER,
            StageStatus.SUCCEEDED,
            "六维坐标规划分支已路由",
            metadata={"branchCount": len(relationships), "reusedCheckpointCount": len(reusable)},
        )
        return reusable

    async def plan_dimension_coordinates(
        self,
        context: RuntimeContext,
        relationship: FragmentRelationshipPlan,
    ) -> FragmentDimensionCoordinatePlan:
        node = NodeId(COORDINATE_STAGE_BY_TYPE[relationship.fragment_type])
        await self._stage(context, node, StageStatus.RUNNING, "正在规划本类产品专属六维坐标")
        try:
            self._reserve_ai_call(context)
            call = await self.provider.plan_dimension_coordinates(
                relationship,
                application=self._require_application(context),
                shared_prompt=self._required_shared_prompt(context),
                target_count=self.snapshot(context).settings.fragment_configs[
                    relationship.fragment_type
                ].count,
            )
            validate_coordinate_plan(
                call.value,
                relationship,
                self._require_application(context),
            )
        except Exception as exc:
            setattr(exc, "node_id", node)
            await self._stage(context, node, StageStatus.FAILED, _safe_error(exc))
            raise
        plan = call.value
        self._cache(context).coordinate_plans[plan.fragment_type] = plan
        coordinate_count = sum(
            len(values)
            for values in (
                plan.narratives,
                plan.scenes,
                plan.personas,
                plan.selling_points,
                plan.cameras,
                plan.emotions,
            )
        )
        await self._stage(
            context,
            node,
            StageStatus.SUCCEEDED,
            "本类产品专属六维坐标已完成",
            metadata={
                "coordinateCount": coordinate_count,
                "bundleCount": len(relationship.bundles),
                "checkpoint": {
                    "nodeId": node.value,
                    "sourceFingerprint": context.source_fingerprint,
                    "allocationHash": plan.relationship_allocation_hash,
                    "promptVersion": plan.prompt_version,
                    "plan": plan.model_dump(mode="json", by_alias=True),
                },
            },
        )
        return plan

    async def merge_coordinate_plans(
        self,
        context: RuntimeContext,
        plans: list[FragmentDimensionCoordinatePlan],
    ) -> list[FragmentDimensionCoordinatePlan]:
        await self._stage(
            context,
            NodeId.COORDINATE_MERGE_VALIDATION,
            StageStatus.RUNNING,
            "正在合并校验六类六维坐标计划",
        )
        expected = self._expected_strategy_fragments(context)
        by_type = {item.fragment_type: item for item in plans}
        if len(by_type) != len(plans) or set(by_type) != expected:
            raise PipelineError("六类六维坐标计划缺失或重复")
        self._cache(context).coordinate_plans = by_type
        await self._stage(
            context,
            NodeId.COORDINATE_MERGE_VALIDATION,
            StageStatus.SUCCEEDED,
            "六维坐标计划合并校验完成",
            metadata={
                "completedBranchCount": len(plans),
                "coordinateCount": sum(
                    len(item.narratives)
                    + len(item.scenes)
                    + len(item.personas)
                    + len(item.selling_points)
                    + len(item.cameras)
                    + len(item.emotions)
                    for item in plans
                ),
            },
        )
        return plans

    async def allocate_and_plan_blueprints(
        self,
        context: RuntimeContext,
        *,
        relationships: list[FragmentRelationshipPlan],
        round_number: int,
        ordinal_start: int,
        deficits: Mapping[str, int] | None = None,
    ) -> list[BlueprintShardPlan]:
        await self._stage(
            context,
            NodeId.BLUEPRINT_QUOTA_ALLOCATION,
            StageStatus.RUNNING,
            "正在分配营销组合蓝图配额",
        )
        settings = self.snapshot(context).settings
        targets = {
            fragment_type: settings.fragment_configs[fragment_type].count
            for fragment_type in FragmentType
        }
        snapshot = self.snapshot(context)
        if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item:
            targets = {snapshot.target_item.fragment_type: 1}
        quotas = allocate_blueprint_quotas(
            relationships,
            targets,
            round_number=round_number,
            deficits=deficits,
            priority_fact_ids={
                fact.fact_id
                for fact in self._require_application(context).required
                if fact.field
                in {
                    InsightField.CORE_SELLING_POINT,
                    InsightField.CORE_SPECIFICATION,
                    InsightField.PRODUCT_NAME,
                    InsightField.CORE_PAIN_POINT,
                }
            },
        )
        if round_number == 0:
            self._cache(context).blueprint_quotas = quotas
        tasks = make_blueprint_tasks(
            relationships,
            quotas,
            {
                fragment_type: settings.fragment_configs[fragment_type].duration_seconds
                for fragment_type in FragmentType
            },
            round_number=round_number,
            ordinal_start=ordinal_start,
        )
        for task in tasks:
            self._cache(context).blueprint_tasks[task.slot_id] = task
        shards = make_blueprint_shards(tasks, round_number=round_number, shard_size=self.shard_size)
        completed = self._cache(context).completed_blueprint_shard_keys
        pending = [item for item in shards if item.key not in completed]
        await self._stage(
            context,
            NodeId.BLUEPRINT_QUOTA_ALLOCATION,
            StageStatus.SUCCEEDED,
            "营销组合蓝图配额与分片已完成",
            metadata={
                "round": round_number,
                "bundleQuotaCount": len(quotas),
                "plannedBlueprintCount": len(tasks),
                "blueprintShardCount": len(pending),
            },
        )
        await self._stage(
            context,
            NodeId.BLUEPRINT_FRAGMENT_ROUTER,
            StageStatus.SUCCEEDED,
            "蓝图分片已按六类素材用途完成路由",
            metadata={"totalShards": len(pending)},
        )
        return pending

    async def generate_blueprint_shard(
        self,
        context: RuntimeContext,
        shard: BlueprintShardPlan,
    ) -> list[GeneratedBlueprint]:
        running = ShardRecord(
            phase=ShardPhase.BLUEPRINT,
            round=shard.round,
            shard_index=shard.shard_index,
            status=StageStatus.RUNNING,
            blueprint_plan=shard.tasks,
        )
        await self.api.put_shard(context, running)
        node = BLUEPRINT_NODE_BY_FRAGMENT[shard.fragment_type]
        try:
            self._reserve_ai_call(context)
            relationship = self._cache(context).relationship_plans[shard.fragment_type]
            coordinate_plan = self._cache(context).coordinate_plans[shard.fragment_type]
            call = await self.provider.generate_blueprints(
                shard,
                relationships=relationship,
                coordinate_plan=coordinate_plan,
                application=self._require_application(context),
                shared_prompt=self._required_shared_prompt(context),
                avoid_signatures=[
                    blueprint_signature(item, coordinate_plan)
                    for item in self._cache(context).blueprints.values()
                    if item.fragment_type == shard.fragment_type
                    and item.bundle_id in {task.bundle_id for task in shard.tasks}
                ],
            )
            validate_generated_blueprints(call.value.items, shard.tasks, coordinate_plan)
            await self.api.put_shard(
                context,
                running.model_copy(
                    update={"status": StageStatus.SUCCEEDED, "blueprints": call.value.items}
                ),
            )
            for item in call.value.items:
                self._cache(context).blueprints[item.slot_id] = item
            self._cache(context).completed_blueprint_shard_keys.add(shard.key)
            return call.value.items
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
            if (
                isinstance(exc, ProviderError)
                and exc.error_type == ProviderErrorType.RESPONSE_INVALID
            ):
                return []
            raise

    async def gate_blueprints_and_plan_prompts(
        self,
        context: RuntimeContext,
        *,
        round_number: int,
        completed_prompt_keys: list[str],
    ) -> tuple[list[ShardPlan], dict[str, int]]:
        await self._stage(
            context,
            NodeId.BLUEPRINT_ORTHOGONAL_GATE,
            StageStatus.RUNNING,
            "正在执行全批次蓝图六维正交校验",
        )
        selected, deficits, rejected = select_orthogonal_blueprints(
            list(self._cache(context).blueprints.values()),
            self._cache(context).blueprint_quotas,
            list(self._cache(context).coordinate_plans.values()),
        )
        self._cache(context).selected_blueprints = {item.slot_id: item for item in selected}
        combinations = [
            materialize_blueprint(
                item,
                self._cache(context).blueprint_tasks[item.slot_id],
                self._cache(context).coordinate_plans[item.fragment_type],
                self._require_application(context),
            )
            for item in selected
        ]
        snapshot = self.snapshot(context)
        if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item:
            combinations = [
                _freeze_item_regeneration_combination(
                    combination,
                    snapshot=snapshot,
                    strategy=None,
                    application=self._require_application(context),
                )
                for combination in combinations
            ]
        shards = make_shards(combinations, round_number=round_number, shard_size=self.shard_size)
        pending = [item for item in shards if item.key not in set(completed_prompt_keys)]
        compared = len(selected) * (len(selected) - 1) // 2
        await self._stage(
            context,
            NodeId.BLUEPRINT_ORTHOGONAL_GATE,
            StageStatus.SUCCEEDED if not deficits else StageStatus.PARTIAL,
            "全批次蓝图六维正交校验完成",
            metadata={
                "acceptedBlueprintCount": len(selected),
                "rejectedBlueprintCount": rejected,
                "comparedPairCount": compared,
                "missingBlueprintCount": sum(deficits.values()),
            },
        )
        return pending, deficits

    def _expected_strategy_fragments(self, context: RuntimeContext) -> set[FragmentType]:
        snapshot = self.snapshot(context)
        if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item:
            return {snapshot.target_item.fragment_type}
        return set(FragmentType)

    def _require_application(self, context: RuntimeContext) -> InsightApplicationMap:
        application = self._cache(context).insight_application
        if application is None:
            raise PipelineError("提炼信息应用映射尚未完成")
        return application

    @staticmethod
    def _plan_stage_metadata(
        plan: FragmentMarketingPlan,
        allocation: FragmentFactAllocation,
        *,
        reused: bool,
    ) -> dict[str, Any]:
        return {
            "targetBundleCount": allocation.bundle_target,
            "actualBundleCount": len(plan.bundles),
            "mandatoryFactCount": len(allocation.mandatory_fact_ids),
            "coveredMandatoryFactCount": len(
                set(allocation.mandatory_fact_ids).intersection(
                    fact_id for row in plan.bundles for fact_id in row.fact_ids
                )
            ),
            "reusedCheckpoint": reused,
        }

    async def plan_round(
        self,
        context: RuntimeContext,
        *,
        strategy: StrategyPlan,
        application: InsightApplicationMap,
        round_number: int,
        missing_count: int,
        ordinal_start: int,
        completed_keys: list[str],
        priority_fact_ids: list[str] | None = None,
    ) -> list[ShardPlan]:
        node = NodeId.DIMENSION_COMBINATION if round_number == 0 else NodeId.REPLENISH
        await self._stage(context, node, StageStatus.RUNNING, "正在编排片段蓝图")
        snapshot = self.snapshot(context)
        requested = (
            missing_count
            if snapshot.operation == "ITEM_REGENERATE"
            else min(289, max(missing_count, math.ceil(missing_count * 1.25)))
        )
        settings = snapshot.settings
        targets = fragment_type_targets(
            {
                fragment_type: settings.fragment_configs[fragment_type].count
                for fragment_type in FragmentType
            }
        )
        existing = (
            self._cache(context).accepted_items
            or self.snapshot(context).retained_manual_items
        )
        actual_types = Counter(item.fragment_type for item in existing)
        deficits = fragment_type_deficits(
            targets,
            actual_types,
        )
        combinations = plan_combinations(
            strategy,
            application,
            count=requested,
            round_number=round_number,
            ordinal_start=ordinal_start,
            fragment_targets=targets,
            fragment_durations={
                fragment_type: settings.fragment_configs[fragment_type].duration_seconds
                for fragment_type in FragmentType
            },
            fragment_deficits=deficits,
            priority_fact_ids=(
                [] if snapshot.operation == "ITEM_REGENERATE" else priority_fact_ids or []
            ),
        )
        if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item:
            combinations = [
                _freeze_item_regeneration_combination(
                    combination,
                    snapshot=snapshot,
                    strategy=strategy,
                    application=application,
                )
                for combination in combinations
            ]
        shards = make_shards(
            combinations, round_number=round_number, shard_size=self.shard_size
        )
        all_pending = [item for item in shards if item.key not in set(completed_keys)]
        remaining_calls = max(
            0, self.max_ai_calls_per_run - self._cache(context).ai_call_count
        )
        pending = all_pending[:remaining_calls]
        stage_metadata: dict[str, int | float | str | bool | None] = {
            "replenishmentRound": round_number,
            "plannedCandidateCount": len(combinations),
            "pendingShardCount": len(pending),
            "resumedShardCount": len(shards) - len(all_pending),
            "combinationExample": _combination_example(
                combinations[0] if combinations else None
            ),
            "priorityFactCount": len(priority_fact_ids or []),
        }
        if node == NodeId.REPLENISH:
            stage_metadata["missingCount"] = missing_count
        await self._stage(
            context,
            node,
            StageStatus.SUCCEEDED,
            "片段蓝图已编排"
            if round_number == 0
            else f"第 {round_number} 轮定向补齐蓝图已编排",
            metadata=stage_metadata,
        )
        await self._stage(
            context,
            NodeId.FRAGMENT_TYPE_ROUTER,
            StageStatus.SUCCEEDED,
            "候选分片已按六类素材用途完成路由",
            metadata={
                "fragmentTypeCount": len(FragmentType),
                "totalShards": len(pending),
                "routedShards": len(pending),
            },
        )
        pending_by_type = Counter(shard.fragment_type for shard in pending)
        for fragment_type, generation_node in GENERATION_NODE_BY_FRAGMENT.items():
            shard_count = pending_by_type[fragment_type]
            await self._stage(
                context,
                generation_node,
                StageStatus.RUNNING if shard_count else StageStatus.SKIPPED,
                f"{fragment_type.value} 候选 Prompt 分片生成中"
                if shard_count
                else "当前轮次无需生成该类片段",
                metadata={
                    "totalShards": shard_count,
                    "completedShards": 0,
                    "targetCount": targets[fragment_type],
                },
            )
        if round_number == 0:
            self._cache(context).total_shards = (
                len(pending) + len(shards) - len(all_pending)
            )
        else:
            self._cache(context).total_shards += len(pending)
        await self.progress(context, 22 if round_number == 0 else 78, node)
        return pending

    async def generate_shard(
        self, context: RuntimeContext, shard: ShardPlan
    ) -> list[GeneratedCandidate]:
        running = ShardRecord(
            phase=ShardPhase.PROMPT,
            round=shard.round,
            shard_index=shard.shard_index,
            status=StageStatus.RUNNING,
            combination_plan=shard.combinations,
        )
        await self.api.put_shard(context, running)
        snapshot = self.snapshot(context)
        try:
            self._reserve_ai_call(context)
            if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item:
                call = await self.provider.generate_candidates(
                    shard.combinations,
                    insight=snapshot.insight_artifact.result,
                    shared_prompt=self._required_shared_prompt(context),
                    regeneration_context={
                        "originalPrompt": snapshot.target_item.content,
                        "instruction": snapshot.regeneration_instruction or "",
                        "lockedFields": {
                            "fragmentType": snapshot.target_item.fragment_type.value,
                            "durationSeconds": snapshot.target_item.target_duration_seconds,
                            "materialTags": snapshot.target_item.material_tags,
                        },
                    },
                )
            else:
                call = await self.provider.generate_candidates(
                    shard.combinations,
                    insight=snapshot.insight_artifact.result,
                    shared_prompt=self._required_shared_prompt(context),
                )
            plan_by_slot = {item.slot_id: item for item in call.value.items}
            insight = snapshot.insight_artifact.result
            product_name = (
                _insight_text(insight, "productName", "product_name") or "该产品"
            )
            generated_at = utc_now()
            candidates: list[GeneratedCandidate] = []
            for plan in shard.combinations:
                content, invalid_reasons = assemble_fragment_prompt(
                    plan_by_slot[plan.slot_id].prompt_text,
                    plan,
                    product_name=product_name,
                    source_facts=_source_fact_texts(insight),
                )
                candidates.append(
                    GeneratedCandidate(
                        slot_id=plan.slot_id,
                        ordinal=plan.ordinal,
                        round=shard.round,
                        shard_index=shard.shard_index,
                        fragment_type=plan.fragment_type,
                        material_tags=plan.material_tags,
                        target_duration_seconds=plan.target_duration_seconds,
                        dimensions=plan.dimensions,
                        content=content,
                        insight_bindings=plan.insight_bindings,
                        execution_invalid_reasons=invalid_reasons,
                        generated_at=generated_at,
                    )
                )
            await self.api.put_shard(
                context,
                running.model_copy(
                    update={"status": StageStatus.SUCCEEDED, "items": candidates}
                ),
            )
            cache = self._cache(context)
            for candidate in candidates:
                cache.candidates[candidate.slot_id] = candidate
                cache.execution_invalid_reasons.update(
                    candidate.execution_invalid_reasons
                )
            return candidates
        except Exception as exc:
            # Parallel fragment branches update progress independently. Attach the
            # actual failing branch so a slower sibling cannot be reported instead.
            setattr(exc, "node_id", GENERATION_NODE_BY_FRAGMENT[shard.fragment_type])
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
            if (
                isinstance(exc, ProviderError)
                and exc.error_type == ProviderErrorType.RESPONSE_INVALID
            ):
                return []
            raise

    async def normalize(self, context: RuntimeContext) -> list[PromptItem]:
        await self._stage(
            context, NodeId.NORMALIZATION, StageStatus.RUNNING, "正在标准化候选 Prompt"
        )
        unique = [
            item
            for item in _unique_candidates(
                list(self._cache(context).candidates.values())
            )
            if not hard_execution_reasons(item.execution_invalid_reasons)
        ]
        items = [
            PromptItem(
                id=_stable_item_id(context.source_fingerprint, candidate.slot_id),
                code=f"P{candidate.ordinal:03d}",
                origin="AI",
                fragment_type=candidate.fragment_type,
                material_tags=candidate.material_tags,
                target_duration_seconds=candidate.target_duration_seconds,
                dimensions=candidate.dimensions,
                content=candidate.content,
                insight_bindings=candidate.insight_bindings,
                manual_edited=False,
                created_at=candidate.generated_at,
                updated_at=candidate.generated_at,
            )
            for candidate in unique
        ]
        self._cache(context).normalized_items = items
        for fragment_type, generation_node in GENERATION_NODE_BY_FRAGMENT.items():
            generated = [item for item in unique if item.fragment_type == fragment_type]
            await self._stage(
                context,
                generation_node,
                StageStatus.SUCCEEDED if generated else StageStatus.SKIPPED,
                "该类候选 Prompt 分片生成完成"
                if generated
                else "当前批次未生成该类片段",
                metadata={
                    "totalShards": len(
                        {(item.round, item.shard_index) for item in generated}
                    ),
                    "completedShards": len(
                        {(item.round, item.shard_index) for item in generated}
                    ),
                    "candidateCount": len(generated),
                    "targetCount": self.snapshot(context)
                    .settings.fragment_configs[fragment_type]
                    .count,
                },
            )
        await self._stage(
            context,
            NodeId.NORMALIZATION,
            StageStatus.SUCCEEDED,
            "候选 Prompt 标准化完成",
            metadata={
                "candidateCount": len(items),
                "normalizedFieldCount": 12,
                "structureExample": _short(
                    "单一场景 + 单一连续动作 + 可见主体/产品 + 镜头/光线/节奏 + 结束状态"
                ),
            },
        )
        await self.progress(context, 55, NodeId.NORMALIZATION)
        return items

    async def semantic_check(self, context: RuntimeContext) -> list[PairViolation]:
        await self._stage(
            context,
            NodeId.SEMANTIC_DEDUP,
            StageStatus.RUNNING,
            "正在计算语义重复代理指标",
        )
        items = [
            *cast(list[PromptItem], self.snapshot(context).retained_manual_items),
            *self._cache(context).normalized_items,
        ]
        pairs = semantic_violations(items)
        compared_pairs = len(items) * (len(items) - 1) // 2
        await self._stage(
            context,
            NodeId.SEMANTIC_DEDUP,
            StageStatus.SUCCEEDED,
            "语义重复代理校验完成",
            metadata={
                "violatingPairCount": len(pairs),
                "comparedPairCount": compared_pairs,
                "semanticDuplicateRate": pair_rate(len(pairs), len(items)),
            },
        )
        return pairs

    async def visual_check(self, context: RuntimeContext) -> list[PairViolation]:
        await self._stage(
            context,
            NodeId.VISUAL_DEDUP,
            StageStatus.RUNNING,
            "正在计算视觉结构重合代理指标",
        )
        items = [
            *cast(list[PromptItem], self.snapshot(context).retained_manual_items),
            *self._cache(context).normalized_items,
        ]
        pairs = visual_violations(items)
        compared_pairs = len(items) * (len(items) - 1) // 2
        await self._stage(
            context,
            NodeId.VISUAL_DEDUP,
            StageStatus.SUCCEEDED,
            "视觉结构重合代理校验完成",
            metadata={
                "violatingPairCount": len(pairs),
                "comparedPairCount": compared_pairs,
                "visualOverlapRate": pair_rate(len(pairs), len(items)),
            },
        )
        return pairs

    async def quality_gate(
        self,
        context: RuntimeContext,
        *,
        round_number: int,
    ) -> EvaluationResult:
        await self._stage(
            context, NodeId.QUALITY_GATE, StageStatus.RUNNING, "正在执行批次质量门禁"
        )
        evaluation = self._cache(context).evaluation
        if evaluation is None:
            evaluation = await self.evaluate_insight_coverage(
                context,
                round_number=round_number,
            )
        self._cache(context).accepted_items = evaluation.items
        passed = evaluation.quality_status == "PASS"
        await self._stage(
            context,
            NodeId.QUALITY_GATE,
            StageStatus.SUCCEEDED if passed else StageStatus.PARTIAL,
            "批次质量门禁通过"
            if passed
            else (
                "批次缺少必须利用的提炼信息"
                if evaluation.missing_fact_ids
                else "批次仍需补齐或人工复核"
            ),
            metadata={
                "acceptedCount": evaluation.metrics.accepted_count,
                "targetCount": evaluation.metrics.target_count,
                "semanticDuplicateRate": evaluation.metrics.semantic_duplicate_rate,
                "visualOverlapRate": evaluation.metrics.visual_overlap_rate,
                "removedCount": (
                    evaluation.metrics.removed_semantic_duplicates
                    + evaluation.metrics.removed_visual_duplicates
                    + evaluation.metrics.removed_dimension_conflicts
                    + evaluation.metrics.removed_execution_invalid
                ),
                "missingFactCount": len(evaluation.missing_fact_ids),
                "replenishmentRound": round_number,
                "qualityStatus": evaluation.quality_status,
            },
        )
        await self.progress(context, 72, NodeId.QUALITY_GATE)
        return evaluation

    async def evaluate_insight_coverage(
        self,
        context: RuntimeContext,
        *,
        round_number: int,
    ) -> EvaluationResult:
        await self._stage(
            context,
            NodeId.INSIGHT_COVERAGE,
            StageStatus.RUNNING,
            "正在核对提炼信息实际利用情况",
        )
        settings = self.snapshot(context).settings
        application = self._cache(context).insight_application
        if application is None:
            raise PipelineError("提炼信息应用映射尚未完成")
        evaluation = evaluate_candidates(
            cast(list[PromptItem], self.snapshot(context).retained_manual_items),
            self._cache(context).normalized_items,
            target_count=settings.target_count,
            semantic_limit=settings.semantic_limit,
            visual_limit=settings.visual_limit,
            round_number=round_number,
            required_selling_points=_core_selling_points(
                self.snapshot(context).insight_artifact.result
            ),
            insight_application=application,
            fragment_type_targets=fragment_type_targets(
                {
                    fragment_type: settings.fragment_configs[fragment_type].count
                    for fragment_type in FragmentType
                }
            ),
            generated_candidate_count=len(self._cache(context).candidates),
            removed_execution_invalid=sum(
                bool(hard_execution_reasons(item.execution_invalid_reasons))
                for item in self._cache(context).candidates.values()
            ),
            execution_invalid_reasons=dict(
                self._cache(context).execution_invalid_reasons
            ),
        )
        self._cache(context).accepted_items = evaluation.items
        self._cache(context).evaluation = evaluation
        coverage = evaluation.metrics.insight_coverage
        await self._stage(
            context,
            NodeId.INSIGHT_COVERAGE,
            StageStatus.SUCCEEDED if not coverage.missing else StageStatus.PARTIAL,
            "必须利用的提炼信息已全部覆盖"
            if not coverage.missing
            else "仍有必须利用的提炼信息待补齐",
            metadata={
                "requiredCount": len(coverage.required),
                "coveredCount": len(coverage.covered),
                "missingCount": len(coverage.missing),
                "deferredCount": len(coverage.deferred),
                "appliedConstraintCount": len(coverage.applied_constraints),
                "replenishmentRound": round_number,
            },
        )
        await self.progress(context, 68, NodeId.INSIGHT_COVERAGE)
        return evaluation

    async def save_result(
        self,
        context: RuntimeContext,
        *,
        metrics: PromptMetrics,
        shared_prompt: SharedPrompt,
    ) -> str:
        metrics = await self._ensure_exact_batch(context, metrics)
        items = self._cache(context).accepted_items
        retained_ids = {
            item.id for item in self.snapshot(context).retained_manual_items
        }
        generated_only = [item for item in items if item.id not in retained_ids]
        renumbered = [
            item.model_copy(update={"code": f"P{index:03d}"})
            for index, item in enumerate(generated_only, 1)
        ]
        settings = cast(PromptBatchSettings, self.snapshot(context).settings)
        quality_status: Literal["PASS", "NEEDS_REVIEW"] = (
            "PASS"
            if (
                len(items) == settings.target_count
                and metrics.semantic_duplicate_rate <= settings.semantic_limit
                and metrics.visual_overlap_rate <= settings.visual_limit
                and all(
                    item.actual_count == item.target_count
                    for item in metrics.fragment_type_distribution
                )
                and not metrics.selling_point_coverage.missing
                and not metrics.insight_coverage.missing
            )
            else "NEEDS_REVIEW"
        )
        result = PromptBatchResult(
            settings=settings,
            render_profile=_render_profile(
                self.snapshot(context).insight_artifact.result,
            ),
            shared_prompt=shared_prompt,
            items=renumbered,
            metrics=metrics.model_copy(
                update={
                    "accepted_count": len(renumbered),
                    "fallback_count": self._cache(context).fallback_count,
                }
            ),
            quality_status=quality_status
            if len(renumbered) == settings.target_count
            else "NEEDS_REVIEW",
        )
        await self._stage(
            context,
            NodeId.RESULT_SAVE,
            StageStatus.RUNNING,
            "正在保存权威 Prompt 草稿",
            metadata={
                "batchSize": len(items),
                "qualityStatus": result.quality_status,
                "saveSummary": _short(
                    f"已准备保存 {len(items)} 条方案，质量状态 {result.quality_status}"
                ),
            },
        )
        return await self.api.complete(context, result)

    def _required_shared_prompt(self, context: RuntimeContext) -> SharedPrompt:
        prompt = self._cache(context).shared_prompt
        if prompt is None:
            raise PipelineError("批次共用提示词尚未编译")
        return prompt

    async def _ensure_exact_batch(
        self,
        context: RuntimeContext,
        metrics: PromptMetrics,
    ) -> PromptMetrics:
        snapshot = self.snapshot(context)
        if snapshot.graph_version == "V10_RELATION_COORDINATE_BLUEPRINT":
            # V10 never fabricates deterministic Prompt fallbacks. Every missing
            # item must return through the original relationship's blueprint branch.
            return metrics.model_copy(update={"fallback_count": 0})
        if snapshot.operation != "BATCH_GENERATE":
            return metrics.model_copy(update={"fallback_count": 0})
        settings = snapshot.settings
        targets = fragment_type_targets(
            {
                fragment_type: settings.fragment_configs[fragment_type].count
                for fragment_type in FragmentType
            }
        )
        accepted = list(self._cache(context).accepted_items)
        if _matches_fragment_targets(accepted, targets):
            return metrics.model_copy(update={"fallback_count": 0})
        application = self._cache(context).insight_application
        strategy = self._cache(context).strategy_plan
        if application is None or strategy is None:
            raise PipelineError("无法读取安全兜底所需的营销关系规划")
        product_name = (
            _insight_text(
                snapshot.insight_artifact.result, "productName", "product_name"
            )
            or "该产品"
        )
        fallback_items: list[PromptItem] = []
        ordinal = self.next_ordinal(context)
        for fallback_round in range(MAX_REPLENISHMENT_ROUNDS + 1, 25):
            actual = Counter(item.fragment_type for item in accepted)
            deficits = fragment_type_deficits(targets, actual)
            missing_count = sum(deficits.values())
            if missing_count <= 0:
                break
            evaluation = self._cache(context).evaluation
            combinations = plan_combinations(
                strategy,
                application,
                count=min(289, max(missing_count * 4, missing_count)),
                round_number=fallback_round,
                ordinal_start=ordinal,
                fragment_targets=targets,
                fragment_durations={
                    fragment_type: settings.fragment_configs[
                        fragment_type
                    ].duration_seconds
                    for fragment_type in FragmentType
                },
                fragment_deficits=deficits,
                priority_fact_ids=evaluation.missing_fact_ids if evaluation else [],
            )
            generated_at = utc_now()
            round_items: list[PromptItem] = []
            for combination in combinations:
                content, invalid_reasons = assemble_safe_fallback_prompt(
                    combination,
                    product_name=product_name,
                    source_facts=_source_fact_texts(snapshot.insight_artifact.result),
                )
                if invalid_reasons:
                    self._cache(context).execution_invalid_reasons.update(
                        invalid_reasons
                    )
                    continue
                round_items.append(
                    PromptItem(
                        id=_stable_item_id(
                            snapshot.insight_artifact.content_hash, combination.slot_id
                        ),
                        code=f"P{combination.ordinal:03d}",
                        origin="AI",
                        fragment_type=combination.fragment_type,
                        material_tags=combination.material_tags,
                        target_duration_seconds=combination.target_duration_seconds,
                        dimensions=combination.dimensions,
                        content=content,
                        insight_bindings=combination.insight_bindings,
                        manual_edited=False,
                        created_at=generated_at,
                        updated_at=generated_at,
                    )
                )
            fallback_items.extend(round_items)
            evaluation = evaluate_candidates(
                accepted,
                round_items,
                target_count=settings.target_count,
                semantic_limit=settings.semantic_limit,
                visual_limit=settings.visual_limit,
                round_number=MAX_REPLENISHMENT_ROUNDS,
                required_selling_points=_core_selling_points(
                    snapshot.insight_artifact.result
                ),
                insight_application=application,
                fragment_type_targets=targets,
                generated_candidate_count=len(self._cache(context).candidates)
                + len(fallback_items),
                removed_execution_invalid=sum(
                    bool(hard_execution_reasons(item.execution_invalid_reasons))
                    for item in self._cache(context).candidates.values()
                ),
                execution_invalid_reasons=dict(
                    self._cache(context).execution_invalid_reasons
                ),
            )
            accepted = evaluation.items
            self._cache(context).accepted_items = accepted
            self._cache(context).evaluation = evaluation
            metrics = evaluation.metrics
            ordinal += len(combinations)
            if _matches_fragment_targets(accepted, targets):
                break
        if not _matches_fragment_targets(accepted, targets):
            raise PipelineError("安全补齐后仍无法满足用户设置的 Prompt 数量与六类配额")
        fallback_ids = {item.id for item in fallback_items}
        self._cache(context).fallback_count = sum(
            item.id in fallback_ids for item in accepted
        )
        await self._stage(
            context,
            NodeId.REPLENISH,
            StageStatus.SUCCEEDED,
            "已通过安全蓝图补齐到用户设置数量",
            metadata={
                "replenishmentRound": MAX_REPLENISHMENT_ROUNDS,
                "fallbackCount": self._cache(context).fallback_count,
                "acceptedCount": len(accepted),
                "targetCount": settings.target_count,
            },
        )
        return metrics.model_copy(
            update={"fallback_count": self._cache(context).fallback_count}
        )

    def next_ordinal(self, context: RuntimeContext) -> int:
        return (
            max(
                (item.ordinal for item in self._cache(context).candidates.values()),
                default=len(self.snapshot(context).retained_manual_items),
            )
            + 1
        )

    def next_blueprint_ordinal(self, context: RuntimeContext) -> int:
        return (
            max(
                (item.ordinal for item in self._cache(context).blueprint_tasks.values()),
                default=len(self.snapshot(context).retained_manual_items),
            )
            + 1
        )

    def blueprint_deficits_from_accepted(self, context: RuntimeContext) -> dict[str, int]:
        cache = self._cache(context)
        accepted_ids = {item.id for item in cache.accepted_items}
        accepted_slots = {
            slot_id
            for slot_id in cache.selected_blueprints
            if _stable_item_id(context.source_fingerprint, slot_id) in accepted_ids
        }
        actual: Counter[str] = Counter(
            cache.selected_blueprints[slot_id].bundle_id for slot_id in accepted_slots
        )
        # Prompt-level rejection invalidates the originating blueprint. Keep only
        # accepted blueprints before replenishment so the next orthogonal gate
        # fills the exact relationship gaps instead of reselecting stale drafts.
        cache.blueprints = {
            slot_id: blueprint
            for slot_id, blueprint in cache.blueprints.items()
            if slot_id in accepted_slots
        }
        cache.selected_blueprints = dict(cache.blueprints)
        cache.candidates = {
            slot_id: candidate
            for slot_id, candidate in cache.candidates.items()
            if _stable_item_id(context.source_fingerprint, slot_id) in accepted_ids
        }
        cache.normalized_items = [
            item for item in cache.normalized_items if item.id in accepted_ids
        ]
        return {
            quota.bundle_id: quota.target_count - actual[quota.bundle_id]
            for quota in cache.blueprint_quotas
            if actual[quota.bundle_id] < quota.target_count
        }

    def _reserve_ai_call(self, context: RuntimeContext) -> None:
        cache = self._cache(context)
        if cache.ai_call_count >= self.max_ai_calls_per_run:
            raise PipelineError("Prompt 子工作流 AI 调用次数超过安全上限")
        cache.ai_call_count += 1

    async def mark_failed(self, context: RuntimeContext, exc: Exception) -> None:
        retryable = isinstance(
            exc,
            (InternalApiError, ProviderError, EmbeddingProviderError),
        ) and exc.retryable
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


def _v11_settings(snapshot: PromptGenerationSnapshot) -> PromptBatchSettingsV6:
    if not isinstance(snapshot.settings, PromptBatchSettingsV6):
        raise PipelineError("V11 run requires Prompt settings schema V6")
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


def _dimension_unique_gain(
    item: RankedCreative,
    selected: list[RankedCreative],
    anchors: list[PromptItemV6],
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
        normalize_creative_signature(
            getattr(item.candidate.dimensions, field_name)
        )
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


def _v11_prompt_items(
    context: RuntimeContext,
    selection: CreativeSelectionResult,
    application: InsightApplicationMap,
    default_duration_seconds: int,
) -> list[PromptItemV6]:
    result: list[PromptItemV6] = []
    for row in selection.selected:
        candidate = row.candidate
        evaluation = row.evaluation
        bindings: list[InsightBinding] = []
        for fact_id in evaluation.realized_fact_ids:
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
            PromptItemV6(
                id=_stable_item_id(context.source_fingerprint, candidate.slot_id),
                code=f"P{candidate.ordinal:03d}",
                origin="AI",
                fragment_type=evaluation.primary_purpose,
                primary_purpose=evaluation.primary_purpose,
                compatible_purposes=evaluation.compatible_purposes,
                classification_status="VERIFIED",
                product_relevance=round(evaluation.scores.product_relevance),
                material_tags=[
                    FRAGMENT_TYPE_LABELS[purpose]
                    for purpose in evaluation.compatible_purposes
                ],
                target_duration_seconds=default_duration_seconds,
                dimensions=candidate.dimensions,
                content=candidate.content,
                insight_bindings=bindings,
                manual_edited=False,
                created_at=timestamp,
                updated_at=timestamp,
            )
        )
    return result


def _retained_v11_items(
    retained: list[PromptItem | PromptItemV6],
) -> list[PromptItemV6]:
    result: list[PromptItemV6] = []
    for item in retained:
        if isinstance(item, PromptItemV6):
            result.append(item)
            continue
        result.append(
            PromptItemV6(
                id=item.id,
                code=item.code,
                origin=item.origin,
                fragment_type=item.fragment_type,
                primary_purpose=item.fragment_type,
                compatible_purposes=[item.fragment_type],
                classification_status="PENDING",
                product_relevance=0,
                material_tags=item.material_tags,
                target_duration_seconds=item.target_duration_seconds,
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


def _average_v11_scores(rows: list[CreativeScores]) -> CreativeAverageScores:
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


def _matches_fragment_targets(
    items: list[PromptItem], targets: dict[FragmentType, int]
) -> bool:
    actual = Counter(item.fragment_type for item in items)
    return len(items) == sum(targets.values()) and all(
        actual[fragment_type] == count for fragment_type, count in targets.items()
    )


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
    resolution_raw = (_insight_text(insight, "resolution") or "1080p").lower()
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


def _unique_candidates(items: list[GeneratedCandidate]) -> list[GeneratedCandidate]:
    by_slot: dict[str, GeneratedCandidate] = {}
    for item in items:
        by_slot.setdefault(item.slot_id, item)
    return sorted(
        by_slot.values(), key=lambda item: (item.ordinal, item.round, item.shard_index)
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
            "AI_OUTPUT_TRUNCATED": "营销关系规划结果超过安全长度，任务已停止",
            "AI_RESPONSE_INCOMPLETE": "营销关系规划响应未完成，任务已停止",
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


def _freeze_item_regeneration_combination(
    combination: PlannedCombination,
    *,
    snapshot: PromptGenerationSnapshot,
    strategy: StrategyPlan | None,
    application: InsightApplicationMap,
) -> PlannedCombination:
    target = snapshot.target_item
    if target is None:
        return combination
    if not isinstance(target, PromptItem):
        raise PipelineError("legacy item regeneration requires a V5 Prompt item")
    dimensions = cast(
        PromptDimensions,
        snapshot.replacement_dimensions or target.dimensions,
    )
    preserved_fact_ids = [
        binding.fact_id
        for binding in target.insight_bindings
        if binding.field
        not in {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT}
    ]
    normalized_selling_point = " ".join(dimensions.selling_point.split()).casefold()
    selling_fact = next(
        (
            fact
            for fact in application.usable
            if fact.field
            in {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT}
            and target.fragment_type in fact.eligible_fragment_types
            and " ".join(fact.value.split()).casefold() == normalized_selling_point
        ),
        None,
    )
    if selling_fact:
        preserved_fact_ids.append(selling_fact.fact_id)
    bindings = expression_bindings(
        bindings_for_fact_ids(application, preserved_fact_ids, target.fragment_type),
        fragment_type=target.fragment_type,
        occurrence=snapshot.target_item_index or 0,
        priority_fact_ids={selling_fact.fact_id} if selling_fact else set(),
    )
    evidence = next(
        (
            item
            for item in strategy.dimension_pools.evidence_plans
            if " ".join(item.selling_point.split()).casefold()
            == normalized_selling_point
        ),
        None,
    ) if strategy is not None else None
    return combination.model_copy(
        update={
            "fragment_type": target.fragment_type,
            "material_tags": list(target.material_tags),
            "target_duration_seconds": target.target_duration_seconds,
            "dimensions": dimensions,
            "insight_bindings": bindings,
            "evidence_mode": evidence.evidence_mode
            if evidence
            else EvidenceMode.TEXT_ONLY,
            "allowed_visual_evidence": (
                evidence.allowed_visual_evidence
                if evidence
                else "只按片段职责使用已绑定的信息卡原文和真实可见产品细节"
            ),
            "forbidden_inference": (
                evidence.forbidden_inference
                if evidence
                else "不得扩展为信息卡未确认的功效、数据、认证、工艺画面或承诺"
            ),
        }
    )


def _combination_example(value: PlannedCombination | None) -> str:
    if value is None:
        return "暂无组合"
    dims = value.dimensions
    return _short(
        f"{dims.narrative} / {dims.scene} / {dims.persona} / {dims.selling_point} / "
        f"{dims.camera} / {dims.emotion}"
    )
