from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from effect_prompt_generation.execution_correction import (
    ExecutionCorrectionBatch,
    ExecutionCorrectionItem,
    apply_execution_corrections,
)
from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import (
    ArkResponsesProvider,
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)
from effect_prompt_generation.scheduling import AiConcurrencyLimiter
from test_material_planning import ready


@pytest.mark.asyncio
async def test_unchanged_is_identical_and_changed_syncs_without_changing_sources() -> (
    None
):
    pipeline, runtime, _ = await ready()
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    original = (await pipeline.generate_creative_shard(runtime, shard))[0]
    durations = {original.slot_id: 15}
    unchanged = ExecutionCorrectionBatch(
        items=[ExecutionCorrectionItem(slot_id=original.slot_id, changed=False)]
    )
    assert apply_execution_corrections([original], unchanged, durations)[0] is original
    plan = original.shot_plan.model_copy(
        update={"final_frame": "手部停在商品旁，商品稳定置于台面。"}
    )
    row = ExecutionCorrectionItem(
        slot_id=original.slot_id,
        changed=True,
        creative_core="保留商品价值的局部操作",
        dimensions=original.dimensions.model_copy(update={"camera": "侧面缓慢推近"}),
        shot_plan=plan,
    )
    corrected = apply_execution_corrections(
        [original], ExecutionCorrectionBatch(items=[row]), durations
    )[0]
    assert corrected.creative_core == row.creative_core
    assert corrected.dimensions == row.dimensions
    assert corrected.shot_plan == plan
    assert plan.final_frame in corrected.content
    for field in ("slot_id", "ordinal", "round", "declared_fact_ids", "generated_at"):
        assert getattr(corrected, field) == getattr(original, field)


@pytest.mark.parametrize("changed,core", [(True, None), (False, "unexpected")])
def test_partial_replacement_is_not_accepted(changed: bool, core: str | None) -> None:
    with pytest.raises(ValidationError):
        ExecutionCorrectionItem(slot_id="one", changed=changed, creative_core=core)


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["wrong-id", "duplicate", "missing"])
async def test_correction_identity_is_exact(fault: str) -> None:
    pipeline, runtime, _ = await ready()
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    originals = (await pipeline.generate_creative_shard(runtime, shard))[:2]
    rows = [
        ExecutionCorrectionItem(slot_id=item.slot_id, changed=False)
        for item in originals
    ]
    if fault == "wrong-id":
        rows[0].slot_id = "wrong"
    elif fault == "duplicate":
        rows[1] = rows[0]
    else:
        rows.pop()
    with pytest.raises(ValueError, match="identity/count"):
        apply_execution_corrections(
            originals,
            ExecutionCorrectionBatch(items=rows),
            {item.slot_id: 15 for item in originals},
        )


@pytest.mark.asyncio
async def test_correction_failure_restores_raw_draft_without_regeneration() -> None:
    class Failing(MockAiProvider):
        fail = True
        generated = 0

        async def generate_creatives(self, *args: Any, **kwargs: Any) -> Any:
            self.generated += 1
            return await super().generate_creatives(*args, **kwargs)

        async def correct_creative_execution(self, *args: Any, **kwargs: Any) -> Any:
            if self.fail:
                raise ProviderError(
                    "timeout", retryable=True, error_type=ProviderErrorType.TIMEOUT
                )
            return await super().correct_creative_execution(*args, **kwargs)

    provider = Failing()
    pipeline, runtime, _ = await ready(provider=provider)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    with pytest.raises(ProviderError):
        await pipeline.generate_creative_shard(runtime, shard)
    saved = pipeline.api.shards[shard.key]
    assert saved.status == "FAILED" and len(saved.creative_items) == len(shard.tasks)
    assert not pipeline._cache(runtime).creatives
    resumed = PromptGenerationPipeline(api=pipeline.api, provider=provider)
    resumed.register_snapshot(runtime, pipeline.snapshot(runtime))
    await resumed.load_and_snapshot(runtime)
    await resumed.map_insight(runtime)
    await resumed.compile_fact_visual_strategy(runtime)
    await resumed.compile_shared_prompt(runtime)
    provider.fail = False
    corrected = await resumed.generate_creative_shard(runtime, shard)
    assert provider.generated == 1
    assert len(corrected) == len(shard.tasks)
    assert "已完成独立画面执行修正" in pipeline.api.shards[shard.key].warnings


@pytest.mark.asyncio
async def test_graph_scores_fast_shard_before_slow_generation_finishes() -> None:
    scored = asyncio.Event()
    events: list[tuple[str, str]] = []

    class Streaming(MockAiProvider):
        async def generate_creatives(self, shard: Any, **kwargs: Any) -> Any:
            if shard.shard_index == 1:
                await asyncio.wait_for(scored.wait(), timeout=2)
            call = await super().generate_creatives(shard, **kwargs)
            events.extend(("generated", item.slot_id) for item in call.value.items)
            return call

        async def correct_creative_execution(
            self, candidates: Any, **kwargs: Any
        ) -> Any:
            events.extend(("corrected", item.slot_id) for item in candidates)
            return await super().correct_creative_execution(candidates, **kwargs)

        async def evaluate_creatives(self, candidates: Any, **kwargs: Any) -> Any:
            for item in candidates:
                assert ("corrected", item.slot_id) in events
            events.extend(("scored", item.slot_id) for item in candidates)
            scored.set()
            return await super().evaluate_creatives(candidates, **kwargs)

        async def repair_creative_execution(self, *args: Any, **kwargs: Any) -> Any:
            raise AssertionError("batch must not enter post-score repair loop")

    pipeline, runtime, _ = await ready(provider=Streaming())
    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id}, context=runtime
    )
    assert len(pipeline.api.result.items) == 10
    assert len([event for event in events if event[0] == "corrected"]) == 10


@pytest.mark.asyncio
async def test_limiter_reduces_after_429_without_dropping_waiters() -> None:
    limiter = AiConcurrencyLimiter(4)
    for _ in range(4):
        await limiter.__aenter__()
    entered = asyncio.Event()

    async def waiter() -> None:
        async with limiter:
            entered.set()

    task = asyncio.create_task(waiter())
    limiter.reduce_after_rate_limit()
    for _ in range(2):
        await limiter.__aexit__(None, None, None)
    await asyncio.sleep(0)
    assert not entered.is_set()
    await limiter.__aexit__(None, None, None)
    await asyncio.wait_for(task, timeout=1)
    await limiter.__aexit__(None, None, None)
    assert limiter.active == 0 and limiter.limit == 2


@pytest.mark.asyncio
async def test_provider_429_signals_limiter_and_correction_uses_candidate_model() -> (
    None
):
    pipeline, runtime, _ = await ready()
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    candidates = await pipeline.generate_creative_shard(runtime, shard)
    requests: list[Any] = []
    limiter = AiConcurrencyLimiter(4)

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            return httpx.Response(429, json={"error": {"message": "rate limited"}})
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(
                    {
                        "items": [
                            {"slotId": item.slot_id, "changed": False}
                            for item in candidates
                        ]
                    }
                ),
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test",
        candidate_model="candidate",
        strategy_model="strategy",
        evaluation_model="evaluation",
        max_attempts=2,
        on_rate_limit=limiter.reduce_after_rate_limit,
        transport=httpx.MockTransport(handler),
    )
    try:
        call = await provider.correct_creative_execution(
            candidates,
            tasks=shard.tasks,
            application=pipeline._require_application(runtime),
            shared_prompt=pipeline._required_shared_prompt(runtime),
            fact_visual_strategy=pipeline._required_fact_visual_strategy(runtime),
        )
    finally:
        await provider.aclose()
    assert limiter.limit == 2 and len(requests) == 2
    assert all(request["model"] == "candidate" for request in requests)
    assert len(call.value.items) == len(candidates)
