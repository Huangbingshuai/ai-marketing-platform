from __future__ import annotations

from typing import Any
import uuid

import pytest

from effect_prompt_generation.api_client import InternalApi
from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.models import (
    ClaimResponse,
    FailurePayload,
    ProgressPayload,
    PromptBatchResult,
    PromptGenerationSnapshot,
    PromptItem,
    RuntimeContext,
    ShardRecord,
    StageOutput,
)
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import MockAiProvider


class FakeApi(InternalApi):
    def __init__(self) -> None:
        self.stages: list[StageOutput] = []
        self.shards: dict[str, ShardRecord] = {}
        self.result: PromptBatchResult | None = None

    async def claim(self, run_id: str, project_id: str) -> ClaimResponse:
        raise NotImplementedError

    async def put_stage(self, context: RuntimeContext, output: StageOutput) -> None:
        self.stages.append(output)

    async def put_shard(self, context: RuntimeContext, shard: ShardRecord) -> None:
        self.shards[shard.key] = shard

    async def get_shards(self, context: RuntimeContext) -> list[ShardRecord]:
        return list(self.shards.values())

    async def heartbeat(self, context: RuntimeContext, payload: ProgressPayload) -> None:
        return None

    async def complete(self, context: RuntimeContext, result: PromptBatchResult) -> str:
        self.result = result
        return "prompt-result-1"

    async def fail(self, context: RuntimeContext, payload: FailurePayload) -> None:
        raise AssertionError(f"unexpected failure: {payload.error_code}")


@pytest.mark.asyncio
async def test_mock_graph_runs_send_shards_and_completes(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    snapshot = snapshot.model_copy(
        update={"settings": snapshot.settings.model_copy(update={"count": 50})}
    )
    api = FakeApi()
    pipeline = PromptGenerationPipeline(api=api, provider=MockAiProvider(), shard_size=8)
    pipeline.register_snapshot(runtime, snapshot)

    result: dict[str, Any] = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
        config={"max_concurrency": 3},
    )

    assert result == {"prompt_result_id": "prompt-result-1"}
    assert api.result is not None
    assert api.result.quality_status == "PASS"
    assert len(api.result.items) == 50
    assert all(uuid.UUID(item.id).version == 4 for item in api.result.items)
    assert all(shard.status.value == "SUCCEEDED" for shard in api.shards.values())
    assert len(api.shards) == 8


@pytest.mark.asyncio
async def test_load_reuses_succeeded_shards(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    api = FakeApi()
    pipeline = PromptGenerationPipeline(api=api, provider=MockAiProvider(), shard_size=8)
    pipeline.register_snapshot(runtime, snapshot)
    first = await pipeline.load_and_snapshot(runtime)
    pools = await pipeline.plan_strategy(runtime, target_count=10)
    shards = await pipeline.plan_round(
        runtime,
        pools=pools,
        round_number=0,
        missing_count=10,
        ordinal_start=1,
        completed_keys=[],
    )
    candidates = await pipeline.generate_shard(runtime, shards[0])
    second = await pipeline.load_and_snapshot(runtime)

    assert first.candidates == []
    assert second.candidates == candidates
    assert second.completed_shard_keys == ["0:0"]


@pytest.mark.asyncio
async def test_item_regeneration_returns_only_one_replacement_candidate(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    first_api = FakeApi()
    first_pipeline = PromptGenerationPipeline(api=first_api, provider=MockAiProvider(), shard_size=8)
    first_pipeline.register_snapshot(runtime, snapshot)
    await build_graph(first_pipeline).ainvoke(
        {"project_id": runtime.project_id}, context=runtime, config={"max_concurrency": 3}
    )
    assert first_api.result is not None
    target, *retained = first_api.result.items

    item_snapshot = snapshot.model_copy(
        update={
            "operation": "ITEM_REGENERATE",
            "target_item_id": target.id,
            "target_item": target,
            "target_item_index": 0,
            "retained_manual_items": retained,
            "base_result_revision": 1,
        }
    )
    item_runtime = RuntimeContext(
        run_id="run-2",
        project_id=runtime.project_id,
        workflow_run_id=runtime.workflow_run_id,
        product_id=runtime.product_id,
        request_id="request-2",
        attempt_token="attempt-2",
        source_fingerprint="item-regeneration-fingerprint",
    )
    second_api = FakeApi()
    second_pipeline = PromptGenerationPipeline(
        api=second_api, provider=MockAiProvider(), shard_size=8
    )
    second_pipeline.register_snapshot(item_runtime, item_snapshot)
    await build_graph(second_pipeline).ainvoke(
        {"project_id": item_runtime.project_id},
        context=item_runtime,
        config={"max_concurrency": 3},
    )

    assert second_api.result is not None
    assert len(retained) == 9
    assert len(second_api.result.items) == 1
    assert second_api.result.items[0].id not in {item.id for item in retained}


def test_graph_state_does_not_carry_prompt_bodies() -> None:
    from effect_prompt_generation.models import GraphState

    keys = set(GraphState.__annotations__)
    assert "raw_candidates" not in keys
    assert "normalized_items" not in keys
    assert "accepted_items" not in keys


@pytest.mark.asyncio
async def test_planning_prioritizes_uncovered_core_selling_point(
    snapshot: PromptGenerationSnapshot,
    runtime: RuntimeContext,
    prompt_item: PromptItem,
) -> None:
    covered = prompt_item.model_copy(
        update={
            "dimensions": prompt_item.dimensions.model_copy(
                update={"selling_point": "单手开合"}
            )
        }
    )
    snapshot = snapshot.model_copy(update={"retained_manual_items": [covered]})
    api = FakeApi()
    pipeline = PromptGenerationPipeline(api=api, provider=MockAiProvider(), shard_size=8)
    pipeline.register_snapshot(runtime, snapshot)
    pools = await pipeline.plan_strategy(runtime, target_count=10)
    shards = await pipeline.plan_round(
        runtime,
        pools=pools,
        round_number=0,
        missing_count=1,
        ordinal_start=1,
        completed_keys=[],
    )

    assert shards[0].combinations[0].dimensions.selling_point == "轻量便携"
    pipeline.unregister(runtime)
    with pytest.raises(Exception, match="not registered"):
        pipeline.snapshot(runtime)
