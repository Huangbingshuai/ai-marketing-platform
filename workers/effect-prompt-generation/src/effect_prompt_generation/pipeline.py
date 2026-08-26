from __future__ import annotations

import hashlib
import math
import re
import unicodedata
import uuid
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, cast

from pydantic import ValidationError

from .api_client import InternalApi, InternalApiError
from .assembly import assemble_fragment_prompt, assemble_safe_fallback_prompt
from .combinations import (
    fragment_type_deficits,
    fragment_type_targets,
    make_shards,
    plan_combinations,
)
from .insight_mapping import bindings_for_fact_ids, map_insight
from .models import (
    EvidenceMode,
    FailurePayload,
    FragmentType,
    GeneratedCandidate,
    InsightApplicationMap,
    InsightField,
    NodeId,
    PairViolation,
    PlannedCombination,
    ProgressPayload,
    PromptBatchResult,
    PromptGenerationSnapshot,
    PromptItem,
    PromptMetrics,
    RenderProfile,
    RuntimeContext,
    SharedRenderConstraints,
    ShardPlan,
    ShardRecord,
    StageOutput,
    StageStatus,
    StrategyPlan,
    utc_now,
)
from .providers import AiProvider, ProviderError
from .quality import (
    EvaluationResult,
    evaluate_candidates,
    pair_rate,
    semantic_violations,
    visual_violations,
)

MAX_REPLENISHMENT_ROUNDS = 3

GENERATION_NODE_BY_FRAGMENT: dict[FragmentType, NodeId] = {
    FragmentType.HOOK: NodeId.GENERATE_HOOK,
    FragmentType.PAIN: NodeId.GENERATE_PAIN,
    FragmentType.PRODUCT_DISPLAY: NodeId.GENERATE_PRODUCT_DISPLAY,
    FragmentType.SELLING_POINT_EXPLANATION: NodeId.GENERATE_SELLING_POINT_EXPLANATION,
    FragmentType.CTA: NodeId.GENERATE_CTA,
    FragmentType.OUTRO: NodeId.GENERATE_OUTRO,
}


class PipelineError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class LoadedRun:
    snapshot: PromptGenerationSnapshot
    candidates: list[GeneratedCandidate]
    completed_shard_keys: list[str]
    highest_round: int


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


class PromptGenerationPipeline:
    def __init__(
        self,
        *,
        api: InternalApi,
        provider: AiProvider,
        shard_size: int = 8,
        max_ai_calls_per_run: int = 129,
    ) -> None:
        self.api = api
        self.provider = provider
        self.shard_size = shard_size
        self.max_ai_calls_per_run = max_ai_calls_per_run
        self._snapshots: dict[str, PromptGenerationSnapshot] = {}
        self._runs: dict[str, RunCache] = {}

    def register_snapshot(
        self, context: RuntimeContext, snapshot: PromptGenerationSnapshot
    ) -> None:
        self._snapshots[context.run_id] = snapshot
        self._runs[context.run_id] = RunCache()

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
        await self._stage(context, NodeId.LOAD_AND_SNAPSHOT, StageStatus.RUNNING, "正在读取不可变输入快照")
        snapshot = self.snapshot(context)
        shards = await self.api.get_shards(context)
        succeeded = [item for item in shards if item.status == StageStatus.SUCCEEDED]
        candidates = [candidate for shard in succeeded for candidate in shard.items]
        unique_candidates = _unique_candidates(candidates)
        self._cache(context).candidates = {item.slot_id: item for item in unique_candidates}
        self._cache(context).execution_invalid_reasons = Counter(
            reason for item in unique_candidates for reason in item.execution_invalid_reasons
        )
        loaded = LoadedRun(
            snapshot=snapshot,
            candidates=unique_candidates,
            completed_shard_keys=[item.key for item in succeeded],
            highest_round=max((item.round for item in succeeded), default=0),
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
        await self._stage(context, NodeId.STRATEGY_PLANNING, StageStatus.RUNNING, "正在规划营销关系")
        self._reserve_ai_call(context)
        call = await self.provider.plan_strategy(application, target_count=target_count)
        plan = call.value
        pools = plan.dimension_pools
        self._cache(context).strategy_plan = plan
        await self._stage(
            context,
            NodeId.STRATEGY_PLANNING,
            StageStatus.SUCCEEDED,
            "营销关系规划完成",
            metadata={
                "narrativeCount": len(pools.narratives),
                "sceneCount": len(pools.scenes),
                "personaCount": len(pools.personas),
                "sellingPointCount": len(pools.selling_points),
                "cameraCount": len(pools.cameras),
                "emotionCount": len(pools.emotions),
                "actionCount": len(pools.actions),
                "evidencePlanCount": len(pools.evidence_plans),
                "relationshipBundleCount": len(plan.relationship_bundles),
                "dimensionExample": _short(
                    f"{pools.narratives[0]} / {pools.scenes[0]} / {pools.selling_points[0]}"
                ),
            },
        )
        await self.progress(context, 15, NodeId.STRATEGY_PLANNING)
        return plan

    async def map_insight(self, context: RuntimeContext) -> InsightApplicationMap:
        await self._stage(context, NodeId.INSIGHT_MAPPING, StageStatus.RUNNING, "正在映射提炼信息用途")
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
            },
        )
        await self.progress(context, 11, NodeId.INSIGHT_MAPPING)
        return application

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
            {fragment_type: settings.fragment_configs[fragment_type].count for fragment_type in FragmentType}
        )
        existing = self._cache(context).accepted_items or self.snapshot(context).retained_manual_items
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
            priority_fact_ids=priority_fact_ids or [],
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
        shards = make_shards(combinations, round_number=round_number, shard_size=self.shard_size)
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
            "片段蓝图已编排" if round_number == 0 else f"第 {round_number} 轮定向补齐蓝图已编排",
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
                f"{fragment_type.value} 候选 Prompt 分片生成中" if shard_count else "当前轮次无需生成该类片段",
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
                )
            plan_by_slot = {item.slot_id: item for item in call.value.items}
            insight = snapshot.insight_artifact.result
            product_name = _insight_text(insight, "productName", "product_name") or "该产品"
            generated_at = utc_now()
            candidates: list[GeneratedCandidate] = []
            for plan in shard.combinations:
                content, invalid_reasons = assemble_fragment_prompt(
                    plan_by_slot[plan.slot_id].prompt_text,
                    plan,
                    product_name=product_name,
                    source_facts=_source_fact_texts(insight),
                    forbidden_visible_terms=_insight_list(
                        insight, "disabledElements", "disabled_elements"
                    ),
                )
                candidates.append(GeneratedCandidate(
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
                ))
            await self.api.put_shard(
                context,
                running.model_copy(update={"status": StageStatus.SUCCEEDED, "items": candidates}),
            )
            cache = self._cache(context)
            for candidate in candidates:
                cache.candidates[candidate.slot_id] = candidate
                cache.execution_invalid_reasons.update(candidate.execution_invalid_reasons)
            return candidates
        except Exception as exc:
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

    async def normalize(self, context: RuntimeContext) -> list[PromptItem]:
        await self._stage(context, NodeId.NORMALIZATION, StageStatus.RUNNING, "正在标准化候选 Prompt")
        unique = [
            item
            for item in _unique_candidates(list(self._cache(context).candidates.values()))
            if not item.execution_invalid_reasons
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
                "该类候选 Prompt 分片生成完成" if generated else "当前批次未生成该类片段",
                metadata={
                    "totalShards": len({(item.round, item.shard_index) for item in generated}),
                    "completedShards": len({(item.round, item.shard_index) for item in generated}),
                    "candidateCount": len(generated),
                    "targetCount": self.snapshot(context).settings.fragment_configs[fragment_type].count,
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
        await self._stage(context, NodeId.SEMANTIC_DEDUP, StageStatus.RUNNING, "正在计算语义重复代理指标")
        items = self.snapshot(context).retained_manual_items + self._cache(context).normalized_items
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
        await self._stage(context, NodeId.VISUAL_DEDUP, StageStatus.RUNNING, "正在计算视觉结构重合代理指标")
        items = self.snapshot(context).retained_manual_items + self._cache(context).normalized_items
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
        await self._stage(context, NodeId.QUALITY_GATE, StageStatus.RUNNING, "正在执行批次质量门禁")
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
            self.snapshot(context).retained_manual_items,
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
                {fragment_type: settings.fragment_configs[fragment_type].count for fragment_type in FragmentType}
            ),
            generated_candidate_count=len(self._cache(context).candidates),
            removed_execution_invalid=sum(
                bool(item.execution_invalid_reasons)
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
    ) -> str:
        metrics = await self._ensure_exact_batch(context, metrics)
        items = self._cache(context).accepted_items
        retained_ids = {item.id for item in self.snapshot(context).retained_manual_items}
        generated_only = [item for item in items if item.id not in retained_ids]
        renumbered = [
            item.model_copy(update={"code": f"P{index:03d}"})
            for index, item in enumerate(generated_only, 1)
        ]
        settings = self.snapshot(context).settings
        quality_status: Literal["PASS", "NEEDS_REVIEW"] = "PASS" if (
            len(items) == settings.target_count
            and metrics.semantic_duplicate_rate <= settings.semantic_limit
            and metrics.visual_overlap_rate <= settings.visual_limit
            and all(
                item.actual_count == item.target_count
                for item in metrics.fragment_type_distribution
            )
            and not metrics.selling_point_coverage.missing
            and not metrics.insight_coverage.missing
        ) else "NEEDS_REVIEW"
        result = PromptBatchResult(
            settings=settings,
            render_profile=_render_profile(self.snapshot(context).insight_artifact.result),
            items=renumbered,
            metrics=metrics.model_copy(
                update={
                    "accepted_count": len(renumbered),
                    "fallback_count": self._cache(context).fallback_count,
                }
            ),
            quality_status=quality_status if len(renumbered) == settings.target_count else "NEEDS_REVIEW",
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

    async def _ensure_exact_batch(
        self,
        context: RuntimeContext,
        metrics: PromptMetrics,
    ) -> PromptMetrics:
        snapshot = self.snapshot(context)
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
        product_name = _insight_text(
            snapshot.insight_artifact.result, "productName", "product_name"
        ) or "该产品"
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
                    fragment_type: settings.fragment_configs[fragment_type].duration_seconds
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
                    forbidden_visible_terms=_insight_list(
                        snapshot.insight_artifact.result,
                        "disabledElements",
                        "disabled_elements",
                    ),
                )
                if invalid_reasons:
                    self._cache(context).execution_invalid_reasons.update(invalid_reasons)
                    continue
                round_items.append(
                    PromptItem(
                        id=_stable_item_id(snapshot.insight_artifact.content_hash, combination.slot_id),
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
                required_selling_points=_core_selling_points(snapshot.insight_artifact.result),
                insight_application=application,
                fragment_type_targets=targets,
                generated_candidate_count=len(self._cache(context).candidates)
                + len(fallback_items),
                removed_execution_invalid=sum(
                    bool(item.execution_invalid_reasons)
                    for item in self._cache(context).candidates.values()
                ),
                execution_invalid_reasons=dict(self._cache(context).execution_invalid_reasons),
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
        self._cache(context).fallback_count = sum(item.id in fallback_ids for item in accepted)
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
        return metrics.model_copy(update={"fallback_count": self._cache(context).fallback_count})

    def next_ordinal(self, context: RuntimeContext) -> int:
        return max(
            (item.ordinal for item in self._cache(context).candidates.values()),
            default=len(self.snapshot(context).retained_manual_items),
        ) + 1

    def _reserve_ai_call(self, context: RuntimeContext) -> None:
        cache = self._cache(context)
        if cache.ai_call_count >= self.max_ai_calls_per_run:
            raise PipelineError("Prompt 子工作流 AI 调用次数超过安全上限")
        cache.ai_call_count += 1

    async def mark_failed(self, context: RuntimeContext, exc: Exception) -> None:
        retryable = isinstance(exc, (InternalApiError, ProviderError)) and exc.retryable
        await self.api.fail(
            context,
            FailurePayload(
                error_code=_error_code(exc),
                error_message=_safe_error(exc),
                retryable=retryable,
            ),
        )

    async def progress(self, context: RuntimeContext, value: int, node: NodeId) -> None:
        await self.api.heartbeat(context, ProgressPayload(progress=value, current_node=node))

    async def heartbeat(self, context: RuntimeContext) -> None:
        await self.api.heartbeat(context, ProgressPayload())

    async def _stage(
        self,
        context: RuntimeContext,
        node: NodeId,
        status: StageStatus,
        summary: str,
        *,
        metadata: dict[str, int | float | str | bool | None] | None = None,
    ) -> None:
        await self.api.put_stage(
            context,
            StageOutput(
                node_id=node,
                status=status,
                summary=summary,
                metadata=metadata or {},
            ),
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


def _render_profile(insight: Mapping[str, object]) -> RenderProfile:
    ratio_raw = (_insight_text(insight, "aspectRatio", "aspect_ratio") or "9:16").replace(
        "：", ":"
    )
    if ratio_raw not in {"16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"}:
        raise PipelineError(f"Seedance 不支持当前画幅：{ratio_raw}")
    resolution_raw = (_insight_text(insight, "resolution") or "1080p").lower()
    if resolution_raw not in {"480p", "720p", "1080p"}:
        raise PipelineError(f"Seedance 不支持当前分辨率：{resolution_raw}")
    disabled = list(
        dict.fromkeys(
            value.strip()
            for value in _insight_list(insight, "disabledElements", "disabled_elements")
            if value.strip()
        )
    )
    digest = hashlib.sha256("\n".join(disabled).encode("utf-8")).hexdigest()
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
    return sorted(by_slot.values(), key=lambda item: (item.ordinal, item.round, item.shard_index))


def _safe_error(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "Prompt 子工作流数据结构校验失败"
    if isinstance(exc, ProviderError):
        return {
            "AI_TIMEOUT": "Prompt AI 生成超时",
            "AI_NETWORK": "Prompt AI 连接失败",
            "AI_RATE_LIMIT": "Prompt AI 服务繁忙，请稍后重试",
            "AI_SERVICE": "Prompt AI 服务暂时不可用",
            "AI_RESPONSE_INVALID": "Prompt AI 返回格式异常",
            "AI_REQUEST_REJECTED": "Prompt AI 请求被拒绝",
            "AI_UNKNOWN": "Prompt AI 生成失败",
        }.get(exc.error_type.value, "Prompt AI 生成失败")
    if isinstance(exc, InternalApiError):
        return "内部服务暂时不可用" if exc.retryable else "内部服务拒绝了任务更新"
    message = " ".join(str(exc).split())
    return (message or type(exc).__name__)[:500]


def _error_code(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "VALIDATION_ERROR"
    if isinstance(exc, ProviderError):
        return exc.error_type.value
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
            result.extend(str(item) for item in value if isinstance(item, (str, int, float, bool)))
    return result


def _short(value: str, limit: int = 180) -> str:
    return " ".join(value.split())[:limit]


def _freeze_item_regeneration_combination(
    combination: PlannedCombination,
    *,
    snapshot: PromptGenerationSnapshot,
    strategy: StrategyPlan,
    application: InsightApplicationMap,
) -> PlannedCombination:
    target = snapshot.target_item
    if target is None:
        return combination
    dimensions = snapshot.replacement_dimensions or target.dimensions
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
    bindings = bindings_for_fact_ids(application, preserved_fact_ids, target.fragment_type)
    evidence = next(
        (
            item
            for item in strategy.dimension_pools.evidence_plans
            if " ".join(item.selling_point.split()).casefold() == normalized_selling_point
        ),
        None,
    )
    return combination.model_copy(
        update={
            "fragment_type": target.fragment_type,
            "material_tags": list(target.material_tags),
            "target_duration_seconds": target.target_duration_seconds,
            "dimensions": dimensions,
            "insight_bindings": bindings,
            "evidence_mode": evidence.evidence_mode if evidence else EvidenceMode.TEXT_ONLY,
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
