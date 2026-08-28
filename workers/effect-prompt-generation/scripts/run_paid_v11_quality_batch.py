from __future__ import annotations

import argparse
import asyncio
import base64
from collections import Counter
from dataclasses import asdict
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import re
import statistics
import sys
import time
from typing import Any
from uuid import uuid4

from effect_prompt_generation.config import WorkerSettings
from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.main import _provider
from effect_prompt_generation.models import (
    ProgressPayload,
    PromptBatchResultV6,
    PromptBatchSettingsV6,
    PromptGenerationSnapshot,
    RuntimeContext,
    ShardPhase,
    ShardRecord,
    StageOutput,
    StageStatus,
)
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import AiCallMetadata, ProviderError
from effect_prompt_generation.quality import trigram_dice


STYLE_PHRASES = (
    "电影级",
    "电影感",
    "高级感",
    "高级质感",
    "商业广告质感",
    "大片质感",
    "暖色光线",
    "暖色调",
    "浅景深",
    "缓慢推进",
)


def _load_env(path: Path) -> None:
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


class LocalApi:
    def __init__(self) -> None:
        self.stages: list[StageOutput] = []
        self.shards: dict[str, ShardRecord] = {}
        self.result: PromptBatchResultV6 | None = None
        self.failure: Any | None = None

    async def put_stage(self, context: RuntimeContext, output: StageOutput) -> None:
        del context
        self.stages.append(output)
        if output.status in {StageStatus.SUCCEEDED, StageStatus.FAILED}:
            print(f"stage {output.node_id}: {output.status}", flush=True)

    async def put_shard(self, context: RuntimeContext, shard: ShardRecord) -> None:
        del context
        self.shards[shard.key] = shard
        if shard.status == StageStatus.SUCCEEDED:
            completed = sum(
                1
                for item in self.shards.values()
                if item.phase == shard.phase and item.status == StageStatus.SUCCEEDED
            )
            print(f"{shard.phase} shard completed: {completed}", flush=True)

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
        if execution_mode != "ARK":
            raise RuntimeError("paid quality batch must use the real Ark provider")
        self.result = PromptBatchResultV6.model_validate(result)
        return f"local-paid-{uuid4()}"

    async def fail(self, context: RuntimeContext, payload: Any) -> None:
        del context
        self.failure = payload


class TrackingProvider:
    execution_mode = "ARK"

    def __init__(self, delegate: Any) -> None:
        self.delegate = delegate
        self.calls: list[Any] = []
        self.failures: list[dict[str, Any]] = []

    async def generate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        try:
            call = await self.delegate.generate_creatives(*args, **kwargs)
        except ProviderError as exc:
            self.failures.append(
                {
                    "stage": "COHERENT_CREATIVE_GENERATION",
                    "errorType": exc.error_type.value,
                    "attempts": exc.attempts,
                    "elapsedMs": exc.elapsed_ms,
                }
            )
            raise
        self.calls.append(call.metadata)
        return call

    async def evaluate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        try:
            call = await self.delegate.evaluate_creatives(*args, **kwargs)
        except ProviderError as exc:
            self.failures.append(
                {
                    "stage": "CREATIVE_EVALUATION_CLASSIFICATION",
                    "errorType": exc.error_type.value,
                    "attempts": exc.attempts,
                    "elapsedMs": exc.elapsed_ms,
                }
            )
            raise
        self.calls.append(call.metadata)
        return call

    async def aclose(self) -> None:
        await self.delegate.aclose()


def _normalize(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def _summary(
    result: PromptBatchResultV6,
    api: LocalApi,
    calls: list[Any],
    failed_calls: list[dict[str, Any]],
    elapsed_seconds: float,
) -> dict[str, Any]:
    items = result.items
    contents = [item.content for item in items]
    pair_scores = [
        trigram_dice(contents[left], contents[right])
        for left in range(len(contents))
        for right in range(left + 1, len(contents))
    ]
    style_counts = Counter(
        phrase for content in contents for phrase in STYLE_PHRASES if phrase in content
    )
    style_stack_items = sum(
        1
        for content in contents
        if sum(phrase in content for phrase in STYLE_PHRASES) >= 3
    )
    purpose_counts = Counter(
        item.primary_purpose.value if item.primary_purpose else "UNCLASSIFIED"
        for item in items
    )
    dimension_uniques = {
        key: len(
            {
                _normalize(getattr(item.dimensions, key))
                for item in items
            }
        )
        for key in (
            "narrative",
            "scene",
            "persona",
            "product_relation",
            "camera",
            "emotion",
        )
    }
    overall_scores = []
    candidate_content_by_id = {
        candidate.slot_id: candidate.content
        for shard in api.shards.values()
        if shard.phase == ShardPhase.CREATIVE
        for candidate in shard.creative_items
    }
    selected_contents = set(contents)
    evaluations = [
        evaluation
        for shard in api.shards.values()
        if shard.phase == ShardPhase.CLASSIFICATION
        for evaluation in shard.evaluations
        if candidate_content_by_id.get(evaluation.slot_id) in selected_contents
    ]
    for evaluation in evaluations:
        overall_scores.append(evaluation.scores.overall_quality)
    bottom_size = max(1, len(overall_scores) // 10)
    bottom_scores = sorted(overall_scores)[:bottom_size]
    combined_texts = [
        " ".join(
            (
                item.dimensions.product_relation,
                item.dimensions.narrative,
                item.content,
            )
        )
        for item in items
    ]
    abstract_visual_proof = {
        "noStarchVisibleProof": sum(
            1
            for content in combined_texts
            if "纯猪肉无淀粉" in content
            and any(
                term in content
                for term in ("肉纤维", "粉面感", "淀粉感", "没有粉质", "无粉质")
            )
        ),
        "processVisibleProof": sum(
            1
            for content in combined_texts
            if "广府糖酒腌制工艺" in content
            and any(term in content for term in ("光泽证明", "证明工艺", "可见糖酒", "腌制痕迹"))
        ),
    }
    warning_counts = Counter(
        warning
        for evaluation in evaluations
        for warning in evaluation.warnings
    )
    hard_counts = Counter(
        issue for evaluation in evaluations for issue in evaluation.hard_issues
    )
    token_totals = {
        "input": sum(item.input_tokens or 0 for item in calls),
        "output": sum(item.output_tokens or 0 for item in calls),
        "total": sum(item.total_tokens or 0 for item in calls),
    }
    average_scores = result.metrics.average_scores
    average_overall = round(
        average_scores.product_relevance * 0.30
        + average_scores.creative_coherence * 0.25
        + average_scores.visual_executability * 0.20
        + average_scores.commercial_usefulness * 0.15
        + average_scores.visual_clarity * 0.10,
        2,
    )
    return {
        "schemaVersion": result.schema_version,
        "templateVersions": sorted({item.prompt_version for item in calls}),
        "targetCount": result.settings.target_count,
        "candidateTargetCount": result.metrics.candidate_target_count,
        "generatedCandidateCount": result.metrics.generated_candidate_count,
        "acceptedCount": result.metrics.accepted_count,
        "rejectedCount": result.metrics.rejected_count,
        "qualityStatus": result.quality_status,
        "replenishmentRounds": result.metrics.replenishment_rounds,
        "exactDuplicateCount": result.metrics.exact_duplicate_count,
        "maxTrigramSimilarity": round(max(pair_scores, default=0.0), 4),
        "averageTrigramSimilarity": round(statistics.fmean(pair_scores), 4)
        if pair_scores
        else 0.0,
        "productAnchorMentionCount": sum(
            1 for content in contents if "广式腊肠" in content or "腊肠" in content
        ),
        "primaryPurposeDistribution": dict(sorted(purpose_counts.items())),
        "dimensionUniqueCounts": dimension_uniques,
        "averageScores": result.metrics.average_scores.model_dump(
            mode="json", by_alias=True
        ),
        "averageOverallQuality": average_overall,
        "bottom10PercentAverageQuality": round(statistics.fmean(bottom_scores), 2)
        if bottom_scores
        else None,
        "hardIssueCounts": dict(sorted(hard_counts.items())),
        "warningCounts": dict(sorted(warning_counts.items())),
        "genericStylePhraseCounts": dict(sorted(style_counts.items())),
        "genericStyleStackItemCount": style_stack_items,
        "abstractVisualProofRisks": abstract_visual_proof,
        "arkCallCount": len(calls),
        "arkFailedCallCount": len(failed_calls),
        "arkAttemptedCallCount": len(calls) + len(failed_calls),
        "arkTokenTotals": token_totals,
        "elapsedSeconds": round(elapsed_seconds, 2),
    }


async def _run(args: argparse.Namespace) -> None:
    repo_root = Path(args.repo_root).resolve()
    raw_snapshot = sys.stdin.read().strip()
    if args.stdin_base64:
        raw_snapshot = base64.b64decode(raw_snapshot).decode("utf-8")
    if args.analyze_result_only:
        result = PromptBatchResultV6.model_validate_json(raw_snapshot)
        summary = _summary(result, LocalApi(), [], [], 0.0)
        output_dir = Path(args.output_dir).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "result.json").write_text(
            result.model_dump_json(by_alias=True, indent=2),
            encoding="utf-8",
        )
        (output_dir / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
        return
    if args.analyze_full_only:
        payload = json.loads(raw_snapshot)
        result = PromptBatchResultV6.model_validate(payload["result"])
        api = LocalApi()
        api.shards = {
            shard.key: shard
            for shard in (ShardRecord.model_validate(item) for item in payload["shards"])
        }
        calls = [AiCallMetadata(**item) for item in payload.get("calls", [])]
        summary = _summary(
            result,
            api,
            calls,
            payload.get("failedCalls", []),
            0.0,
        )
        output_dir = Path(args.output_dir).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
        return
    _load_env(repo_root / ".env")
    os.environ["PROMPT_AI_PROVIDER"] = "ark"
    os.environ["PROMPT_SIMILARITY_MODE"] = "trigram"
    os.environ.setdefault("INTERNAL_API_BASE_URL", "http://127.0.0.1:1")
    os.environ.setdefault("EFFECT_PROMPT_WORKER_TOKEN", "local-paid-quality-run")
    settings = WorkerSettings()  # type: ignore[call-arg]
    snapshot_payload = json.loads(raw_snapshot)
    snapshot_payload["schemaVersion"] = 6
    snapshot_payload["graphVersion"] = "V11_COHERENT_CREATIVE_GENERATION"
    snapshot_payload["operation"] = "BATCH_GENERATE"
    snapshot_payload["settings"] = PromptBatchSettingsV6(
        target_count=50,
        default_duration_seconds=15,
    ).model_dump(mode="json", by_alias=True)
    snapshot_payload["retainedManualItems"] = []
    snapshot_payload["targetItemId"] = None
    snapshot_payload["targetItem"] = None
    snapshot_payload["targetItemIndex"] = None
    snapshot = PromptGenerationSnapshot.model_validate(snapshot_payload)
    context = RuntimeContext(
        run_id=str(uuid4()),
        project_id=snapshot.project_id,
        workflow_run_id=snapshot.workflow_run_id,
        product_id=snapshot.product_id,
        request_id=str(uuid4()),
        attempt_token=str(uuid4()),
        source_fingerprint=snapshot.insight_artifact.content_hash,
    )
    api = LocalApi()
    delegate = _provider(settings)
    provider = TrackingProvider(delegate)
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        similarity_mode="trigram",
        ai_max_concurrency=settings.prompt_max_concurrency,
        shard_size=settings.prompt_shard_size,
        max_ai_calls_per_run=settings.prompt_max_ai_calls_per_run,
    )
    pipeline.register_snapshot(context, snapshot)
    started = time.monotonic()
    try:
        await build_graph(pipeline).ainvoke(
            {"project_id": context.project_id},
            context=context,
        )
    finally:
        await provider.aclose()
    if api.result is None:
        raise RuntimeError("paid batch completed without a V6 result")
    elapsed = time.monotonic() - started
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    full_payload = {
        "createdAt": datetime.now(UTC).isoformat(),
        "context": asdict(context),
        "snapshot": snapshot.model_dump(mode="json", by_alias=True),
        "result": api.result.model_dump(mode="json", by_alias=True),
        "stages": [item.model_dump(mode="json", by_alias=True) for item in api.stages],
        "shards": [item.model_dump(mode="json", by_alias=True) for item in api.shards.values()],
        "calls": [asdict(item) for item in provider.calls],
        "failedCalls": provider.failures,
    }
    summary = _summary(api.result, api, provider.calls, provider.failures, elapsed)
    (output_dir / "full.json").write_text(
        json.dumps(full_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--stdin-base64", action="store_true")
    parser.add_argument("--analyze-result-only", action="store_true")
    parser.add_argument("--analyze-full-only", action="store_true")
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
