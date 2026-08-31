from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
from typing import Any

from effect_prompt_generation.embeddings import (
    ArkEmbeddingProvider,
    build_creative_vector_index,
)
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeEvaluation,
    SharedPrompt,
)
from effect_prompt_generation.pipeline import (
    _near_duplicate_reduction,
    _selection_vector_summary,
)
from effect_prompt_generation.quality import select_creatives


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


async def _run(payload: dict[str, Any]) -> dict[str, Any]:
    candidates = [
        CreativeCandidate.model_validate(item) for item in payload["candidates"]
    ]
    evaluations = [
        CreativeEvaluation.model_validate(item) for item in payload["evaluations"]
    ]
    target_count = int(payload["targetCount"])
    shared_prompt = SharedPrompt.model_validate(payload["sharedPrompt"])
    provider = ArkEmbeddingProvider(
        base_url=os.getenv(
            "ARK_BASE_URL",
            "https://ark.cn-beijing.volces.com/api/v3",
        ),
        api_key=_required_env("ARK_API_KEY"),
        model=_required_env("ARK_PROMPT_EMBEDDING_MODEL"),
        api_mode=os.getenv("ARK_PROMPT_EMBEDDING_API_MODE", "multimodal"),  # type: ignore[arg-type]
        timeout=float(os.getenv("ARK_PROMPT_EMBEDDING_TIMEOUT_SECONDS", "30")),
        max_attempts=int(os.getenv("ARK_PROMPT_EMBEDDING_MAX_ATTEMPTS", "3")),
    )
    try:
        baseline = select_creatives(
            candidates,
            evaluations,
            target_count=target_count,
        )
        vector_index = await build_creative_vector_index(
            candidates,
            provider=provider,
            vector_cache={},
            product_name=str(payload.get("productName") or ""),
            product_category=str(payload.get("productCategory") or ""),
            shared_prompt=shared_prompt,
            batch_size=int(os.getenv("PROMPT_EMBEDDING_BATCH_SIZE", "64")),
            max_concurrency=int(
                os.getenv("PROMPT_EMBEDDING_MAX_CONCURRENCY", "8")
            ),
        )
        content_vector = select_creatives(
            candidates,
            evaluations,
            target_count=target_count,
            novelty_resolver=lambda left, right: vector_index.content_novelty(
                left.candidate.slot_id,
                right.candidate.slot_id,
            ),
        )
        dual_vector = select_creatives(
            candidates,
            evaluations,
            target_count=target_count,
            novelty_resolver=lambda left, right: vector_index.dual_novelty(
                left.candidate.slot_id,
                right.candidate.slot_id,
            ),
        )
        baseline_summary = _selection_vector_summary(baseline, vector_index)
        content_summary = _selection_vector_summary(content_vector, vector_index)
        dual_summary = _selection_vector_summary(dual_vector, vector_index)
        content_applicable, content_reduction = _near_duplicate_reduction(
            baseline_summary,
            content_summary,
        )
        dual_applicable, dual_reduction = _near_duplicate_reduction(
            baseline_summary,
            dual_summary,
        )
        baseline_ids = {item.candidate.slot_id for item in baseline.selected}
        content_ids = {item.candidate.slot_id for item in content_vector.selected}
        dual_ids = {item.candidate.slot_id for item in dual_vector.selected}
        stats = vector_index.stats
        return {
            "productCategory": str(payload.get("productCategory") or ""),
            "candidateCount": len(candidates),
            "targetCount": target_count,
            "baselineSelection": baseline_summary,
            "contentVectorSelection": content_summary,
            "dualVectorSelection": dual_summary,
            "contentChangedItemCount": len(content_ids - baseline_ids),
            "dualChangedItemCount": len(dual_ids - baseline_ids),
            "contentOverlapPercent": round(
                100 * len(content_ids & baseline_ids) / max(1, len(baseline_ids)),
                2,
            ),
            "dualOverlapPercent": round(
                100 * len(dual_ids & baseline_ids) / max(1, len(baseline_ids)),
                2,
            ),
            "contentNearDuplicateReductionApplicable": content_applicable,
            "contentNearDuplicateReductionPercent": content_reduction,
            "dualNearDuplicateReductionApplicable": dual_applicable,
            "dualNearDuplicateReductionPercent": dual_reduction,
            "contentAverageQualityDelta": round(
                float(content_summary["averageQualityScore"])
                - float(baseline_summary["averageQualityScore"]),
                4,
            ),
            "dualAverageQualityDelta": round(
                float(dual_summary["averageQualityScore"])
                - float(baseline_summary["averageQualityScore"]),
                4,
            ),
            "embedding": {
                "inputCount": stats.input_count,
                "requestCount": stats.request_count,
                "inputTokens": stats.input_tokens,
                "retryCount": stats.retry_count,
                "durationMs": stats.duration_ms,
                "localComparisonMs": stats.local_comparison_ms,
                "comparisonCount": stats.comparison_count,
            },
        }
    finally:
        await provider.aclose()


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw.startswith("{"):
        raw = base64.b64decode(raw).decode("utf-8")
    payload = json.loads(raw)
    result = asyncio.run(_run(payload))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
