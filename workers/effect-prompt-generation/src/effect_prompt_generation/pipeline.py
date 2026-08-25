from __future__ import annotations

import hashlib
import math
import re
import unicodedata
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

from pydantic import ValidationError

from .api_client import InternalApi, InternalApiError
from .combinations import make_shards, plan_combinations
from .models import (
    DimensionPools,
    FailurePayload,
    GeneratedCandidate,
    NodeId,
    PairViolation,
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
from .quality import EvaluationResult, evaluate_candidates, semantic_violations, visual_violations


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


class PromptGenerationPipeline:
    def __init__(
        self,
        *,
        api: InternalApi,
        provider: AiProvider,
        shard_size: int = 8,
    ) -> None:
        self.api = api
        self.provider = provider
        self.shard_size = shard_size
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
            },
        )
        await self.progress(context, 8, NodeId.LOAD_AND_SNAPSHOT)
        return loaded

    async def plan_strategy(
        self, context: RuntimeContext, *, target_count: int
    ) -> DimensionPools:
        await self._stage(context, NodeId.STRATEGY_PLANNING, StageStatus.RUNNING, "正在规划六维候选池")
        insight = self.snapshot(context).insight_artifact.result
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
        combinations = plan_combinations(
            self._prioritized_pools(context, pools),
            count=requested,
            round_number=round_number,
            ordinal_start=ordinal_start,
        )
        shards = make_shards(combinations, round_number=round_number, shard_size=self.shard_size)
        pending = [item for item in shards if item.key not in set(completed_keys)]
        await self._stage(
            context,
            node,
            StageStatus.SUCCEEDED,
            "正交组合已生成" if round_number == 0 else f"第 {round_number} 轮补齐组合已生成",
            metadata={
                "replenishmentRound": round_number,
                "plannedCandidateCount": len(combinations),
                "pendingShardCount": len(pending),
                "resumedShardCount": len(shards) - len(pending),
            },
        )
        if round_number == 0:
            await self._stage(
                context,
                NodeId.CANDIDATE_GENERATION,
                StageStatus.RUNNING,
                "候选 Prompt 分片生成中",
                metadata={"totalShards": len(shards), "completedShards": len(shards) - len(pending)},
            )
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
            call = await self.provider.generate_candidates(
                shard.combinations,
                insight=snapshot.insight_artifact.result,
                duration_seconds=snapshot.settings.duration_seconds,
            )
            text_by_slot = {item.slot_id: item for item in call.value.items}
            generated_at = utc_now()
            candidates = [
                GeneratedCandidate(
                    slot_id=plan.slot_id,
                    ordinal=plan.ordinal,
                    round=shard.round,
                    shard_index=shard.shard_index,
                    fragment_type=plan.fragment_type,
                    dimensions=plan.dimensions,
                    content=text_by_slot[plan.slot_id].content,
                    generated_at=generated_at,
                )
                for plan in shard.combinations
            ]
            await self.api.put_shard(
                context,
                running.model_copy(update={"status": StageStatus.SUCCEEDED, "items": candidates}),
            )
            cache = self._cache(context)
            for candidate in candidates:
                cache.candidates[candidate.slot_id] = candidate
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
        unique = _unique_candidates(list(self._cache(context).candidates.values()))
        items = [
            PromptItem(
                id=_stable_item_id(context.source_fingerprint, candidate.slot_id),
                code=f"P{candidate.ordinal:03d}",
                origin="AI",
                fragment_type=candidate.fragment_type,
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
            metadata={"completedShards": len({(item.round, item.shard_index) for item in unique})},
        )
        await self._stage(
            context,
            NodeId.NORMALIZATION,
            StageStatus.SUCCEEDED,
            "候选 Prompt 标准化完成",
            metadata={"candidateCount": len(items)},
        )
        await self.progress(context, 55, NodeId.NORMALIZATION)
        return items

    async def semantic_check(self, context: RuntimeContext) -> list[PairViolation]:
        await self._stage(context, NodeId.SEMANTIC_DEDUP, StageStatus.RUNNING, "正在计算语义重复代理指标")
        items = self.snapshot(context).retained_manual_items + self._cache(context).normalized_items
        pairs = semantic_violations(items)
        await self._stage(
            context,
            NodeId.SEMANTIC_DEDUP,
            StageStatus.SUCCEEDED,
            "语义重复代理校验完成",
            metadata={"violatingPairCount": len(pairs)},
        )
        return pairs

    async def visual_check(self, context: RuntimeContext) -> list[PairViolation]:
        await self._stage(context, NodeId.VISUAL_DEDUP, StageStatus.RUNNING, "正在计算视觉结构重合代理指标")
        items = self.snapshot(context).retained_manual_items + self._cache(context).normalized_items
        pairs = visual_violations(items)
        await self._stage(
            context,
            NodeId.VISUAL_DEDUP,
            StageStatus.SUCCEEDED,
            "视觉结构重合代理校验完成",
            metadata={"violatingPairCount": len(pairs)},
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
                ),
                "replenishmentRound": round_number,
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
        await self._stage(context, NodeId.RESULT_SAVE, StageStatus.RUNNING, "正在保存权威 Prompt 草稿")
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
        ) else "NEEDS_REVIEW"
        result = PromptBatchResult(
            settings=settings,
            items=renumbered,
            metrics=metrics.model_copy(update={"accepted_count": len(renumbered)}),
            quality_status=quality_status if len(renumbered) == settings.count else "NEEDS_REVIEW",
        )
        return await self.api.complete(context, result)

    def next_ordinal(self, context: RuntimeContext) -> int:
        return max(
            (item.ordinal for item in self._cache(context).candidates.values()),
            default=len(self.snapshot(context).retained_manual_items),
        ) + 1

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
