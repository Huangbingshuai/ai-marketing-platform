from __future__ import annotations

import hashlib
import math
import re
import unicodedata
import uuid
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

from pydantic import ValidationError

from .api_client import InternalApi, InternalApiError
from .assembly import assemble_fragment_prompt
from .combinations import (
    fragment_type_deficits,
    fragment_type_targets,
    make_shards,
    plan_combinations,
)
from .models import (
    DimensionPools,
    FailurePayload,
    FragmentType,
    GeneratedCandidate,
    NodeId,
    PairViolation,
    PlannedCombination,
    ProgressPayload,
    PromptBatchResult,
    PromptGenerationSnapshot,
    PromptItem,
    PromptMetrics,
    RuntimeContext,
    ShardPlan,
    ShardRecord,
    StageOutput,
    StageStatus,
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
                "batchSize": snapshot.settings.count,
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
        self, context: RuntimeContext, *, target_count: int
    ) -> DimensionPools:
        await self._stage(context, NodeId.STRATEGY_PLANNING, StageStatus.RUNNING, "正在规划六维候选池")
        insight = self.snapshot(context).insight_artifact.result
        self._reserve_ai_call(context)
        call = await self.provider.plan_strategy(insight, target_count=target_count)
        pools = call.value
        await self._stage(
            context,
            NodeId.STRATEGY_PLANNING,
            StageStatus.SUCCEEDED,
            "六维候选池规划完成",
            metadata={
                "narrativeCount": len(pools.narratives),
                "sceneCount": len(pools.scenes),
                "personaCount": len(pools.personas),
                "sellingPointCount": len(pools.selling_points),
                "cameraCount": len(pools.cameras),
                "emotionCount": len(pools.emotions),
                "actionCount": len(pools.actions),
                "evidencePlanCount": len(pools.evidence_plans),
                "dimensionExample": _short(
                    f"{pools.narratives[0]} / {pools.scenes[0]} / {pools.selling_points[0]}"
                ),
            },
        )
        await self.progress(context, 15, NodeId.STRATEGY_PLANNING)
        return pools

    async def plan_round(
        self,
        context: RuntimeContext,
        *,
        pools: DimensionPools,
        round_number: int,
        missing_count: int,
        ordinal_start: int,
        completed_keys: list[str],
    ) -> list[ShardPlan]:
        node = NodeId.DIMENSION_COMBINATION if round_number == 0 else NodeId.REPLENISH
        await self._stage(context, node, StageStatus.RUNNING, "正在生成正交组合")
        requested = min(289, max(missing_count, math.ceil(missing_count * 1.25)))
        settings = self.snapshot(context).settings
        existing = self._cache(context).accepted_items or self.snapshot(context).retained_manual_items
        actual_types = Counter(item.fragment_type for item in existing)
        deficits = fragment_type_deficits(
            settings.count,
            actual_types,
            settings.fragment_type_weights,
        )
        combinations = plan_combinations(
            self._prioritized_pools(context, pools),
            count=requested,
            round_number=round_number,
            ordinal_start=ordinal_start,
            target_duration_seconds=settings.duration_seconds,
            fragment_type_weights=settings.fragment_type_weights,
            selling_point_weights={
                item.selling_point: item.weight for item in settings.selling_point_weights
            }
            or None,
            fragment_deficits=deficits,
        )
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
        }
        if node == NodeId.REPLENISH:
            stage_metadata["missingCount"] = missing_count
        await self._stage(
            context,
            node,
            StageStatus.SUCCEEDED,
            "正交组合已生成" if round_number == 0 else f"第 {round_number} 轮补齐组合已生成",
            metadata=stage_metadata,
        )
        if round_number == 0:
            self._cache(context).total_shards = (
                len(pending) + len(shards) - len(all_pending)
            )
            await self._stage(
                context,
                NodeId.CANDIDATE_GENERATION,
                StageStatus.RUNNING,
                "候选 Prompt 分片生成中",
                metadata={
                    "totalShards": self._cache(context).total_shards,
                    "completedShards": len(shards) - len(all_pending),
                },
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
            call = await self.provider.generate_candidates(
                shard.combinations,
                insight=snapshot.insight_artifact.result,
                duration_seconds=snapshot.settings.duration_seconds,
                style_override=snapshot.settings.style_override,
                additional_disabled_elements=snapshot.settings.additional_disabled_elements,
            )
            plan_by_slot = {item.slot_id: item for item in call.value.items}
            insight = snapshot.insight_artifact.result
            product_name = _insight_text(insight, "productName", "product_name") or "该产品"
            aspect_ratio = _insight_text(insight, "aspectRatio", "aspect_ratio") or "以信息卡为准"
            disabled_elements = _insight_list(
                insight, "disabledElements", "disabled_elements"
            ) + snapshot.settings.additional_disabled_elements
            generated_at = utc_now()
            candidates: list[GeneratedCandidate] = []
            for plan in shard.combinations:
                content, invalid_reasons = assemble_fragment_prompt(
                    plan_by_slot[plan.slot_id].prompt_text,
                    plan,
                    product_name=product_name,
                    aspect_ratio=aspect_ratio,
                    disabled_elements=disabled_elements,
                    source_facts=_source_fact_texts(insight),
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
                manual_edited=False,
                created_at=candidate.generated_at,
                updated_at=candidate.generated_at,
            )
            for candidate in unique
        ]
        self._cache(context).normalized_items = items
        await self._stage(
            context,
            NodeId.CANDIDATE_GENERATION,
            StageStatus.SUCCEEDED,
            "候选 Prompt 分片生成完成",
            metadata={
                "totalShards": self._cache(context).total_shards,
                "completedShards": len({(item.round, item.shard_index) for item in unique}),
                "candidateCount": len(unique),
                "candidateExample": _short(unique[0].content if unique else "暂无可执行素材片段 Prompt"),
            },
        )
        await self._stage(
            context,
            NodeId.NORMALIZATION,
            StageStatus.SUCCEEDED,
            "候选 Prompt 标准化完成",
            metadata={
                "candidateCount": len(items),
                "normalizedFieldCount": 11,
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
        settings = self.snapshot(context).settings
        evaluation = evaluate_candidates(
            self.snapshot(context).retained_manual_items,
            self._cache(context).normalized_items,
            target_count=settings.count,
            semantic_limit=settings.semantic_limit,
            visual_limit=settings.visual_limit,
            round_number=round_number,
            required_selling_points=_core_selling_points(
                self.snapshot(context).insight_artifact.result
            ),
            fragment_type_targets=fragment_type_targets(
                settings.count,
                settings.fragment_type_weights,
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
        passed = evaluation.quality_status == "PASS"
        await self._stage(
            context,
            NodeId.QUALITY_GATE,
            StageStatus.SUCCEEDED if passed else StageStatus.PARTIAL,
            "批次质量门禁通过"
            if passed
            else (
                "批次缺少核心卖点覆盖"
                if evaluation.missing_selling_points
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
                "replenishmentRound": round_number,
                "qualityStatus": evaluation.quality_status,
            },
        )
        await self.progress(context, 72, NodeId.QUALITY_GATE)
        return evaluation

    async def save_result(
        self,
        context: RuntimeContext,
        *,
        metrics: PromptMetrics,
    ) -> str:
        items = self._cache(context).accepted_items
        retained_ids = {item.id for item in self.snapshot(context).retained_manual_items}
        generated_only = [item for item in items if item.id not in retained_ids]
        renumbered = [
            item.model_copy(update={"code": f"P{index:03d}"})
            for index, item in enumerate(generated_only, 1)
        ]
        settings = self.snapshot(context).settings
        quality_status: Literal["PASS", "NEEDS_REVIEW"] = "PASS" if (
            len(items) == settings.count
            and metrics.semantic_duplicate_rate <= settings.semantic_limit
            and metrics.visual_overlap_rate <= settings.visual_limit
            and all(
                item.actual_count == item.target_count
                for item in metrics.fragment_type_distribution
            )
            and not metrics.selling_point_coverage.missing
        ) else "NEEDS_REVIEW"
        result = PromptBatchResult(
            settings=settings,
            items=renumbered,
            metrics=metrics.model_copy(update={"accepted_count": len(renumbered)}),
            quality_status=quality_status if len(renumbered) == settings.count else "NEEDS_REVIEW",
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

    def _prioritized_pools(
        self, context: RuntimeContext, pools: DimensionPools
    ) -> DimensionPools:
        cache = self._cache(context)
        existing = cache.accepted_items or self.snapshot(context).retained_manual_items
        covered = {_normalized(item.dimensions.selling_point) for item in existing}
        required = _core_selling_points(self.snapshot(context).insight_artifact.result)
        missing = [item for item in required if _normalized(item) not in covered]
        ordered = list(dict.fromkeys([*missing, *pools.selling_points]))
        return pools.model_copy(update={"selling_points": ordered})

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


def _combination_example(value: PlannedCombination | None) -> str:
    if value is None:
        return "暂无组合"
    dims = value.dimensions
    return _short(
        f"{dims.narrative} / {dims.scene} / {dims.persona} / {dims.selling_point} / "
        f"{dims.camera} / {dims.emotion}"
    )
