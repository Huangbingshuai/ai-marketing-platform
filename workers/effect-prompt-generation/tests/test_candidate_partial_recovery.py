from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import httpx
import pytest

from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import ArkResponsesProvider, MockAiProvider, ProviderError, ProviderErrorType
from effect_prompt_generation.providers import _creative_fact_aliases, _creative_task_brief
from test_supplement_recovery import ready_pipeline


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["length", "facts", "identity", "duplicate", "missing"])
async def test_bad_row_does_not_destroy_valid_sibling(fault: str, caplog: Any) -> None:
    mock = MockAiProvider()
    pipeline, runtime = await ready_pipeline(mock)
    plans = await pipeline.plan_creatives(runtime, round_number=0)
    tasks = [task for plan in plans for task in plan.tasks][:2]
    shard = plans[0].model_copy(update={"tasks": tasks})
    call = await mock.generate_creatives(shard, application=pipeline._require_application(runtime),
                                         shared_prompt=pipeline._required_shared_prompt(runtime))
    rows = [item.model_dump(mode="json", by_alias=True, exclude={"content", "generated_at"})
            for item in call.value.items]
    if fault == "length":
        rows[1]["shotPlan"]["finalFrame"] = "PRIVATE_CONTENT" * 30
    elif fault == "facts":
        rows[1]["declaredFactIds"] = ["PRIVATE_UNKNOWN_FACT"]
    elif fault == "identity":
        rows[1]["slotId"] = "unknown-slot"
    elif fault == "duplicate":
        rows.append(rows[1])
    else:
        rows.pop()

    async def handler(request: httpx.Request) -> httpx.Response:
        schema = json.loads(request.content)["text"]["format"]["schema"]
        assert "CreativeCandidateDraft" in schema["$defs"]  # wire schema remains strict
        return httpx.Response(200, json={"status": "completed", "output_text": json.dumps({"items": rows})})

    provider = ArkResponsesProvider(base_url="https://ark.example/v3", api_key="test-key",
        strategy_model="strategy", candidate_model="candidate", evaluation_model="quality",
        transport=httpx.MockTransport(handler))
    try:
        response = await provider.generate_creatives(shard,
            application=pipeline._require_application(runtime), shared_prompt=pipeline._required_shared_prompt(runtime))
        assert [i.slot_id for i in response.value.items] == [tasks[0].slot_id]
        assert "PRIVATE" not in caplog.text
        assert "accepted=1 missing=1" in caplog.text
    finally:
        await provider.aclose()


class PartialProvider(MockAiProvider):
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.fail = True
        self.refined: list[str] = []

    async def generate_creatives(self, shard: Any, **kwargs: Any) -> Any:
        self.calls.append([task.slot_id for task in shard.tasks])
        if len(self.calls) == 1:
            call = await super().generate_creatives(shard, **kwargs)
            return replace(call, value=call.value.model_copy(update={"items": call.value.items[:1]}))
        if self.fail:
            raise ProviderError("network error", error_type=ProviderErrorType.TIMEOUT, retryable=True)
        return await super().generate_creatives(shard, **kwargs)

    async def refine_creative_execution(self, candidates: Any, **kwargs: Any) -> Any:
        self.refined.extend(item.slot_id for item in candidates)
        return await super().refine_creative_execution(candidates, **kwargs)


@pytest.mark.asyncio
async def test_partial_draft_is_saved_and_resume_generates_only_missing_items() -> None:
    provider = PartialProvider()
    pipeline, runtime = await ready_pipeline(provider)
    plans = await pipeline.plan_creatives(runtime, round_number=0)
    tasks = [task for plan in plans for task in plan.tasks][:2]
    shard = plans[0].model_copy(update={"tasks": tasks})
    with pytest.raises(ProviderError):
        await pipeline.generate_creative_shard(runtime, shard)
    assert not pipeline._cache(runtime).creatives  # drafts are never rated as finished
    saved = pipeline.api.shards[shard.key]
    assert [i.slot_id for i in saved.creative_items] == [tasks[0].slot_id]
    resumed = PromptGenerationPipeline(api=pipeline.api, provider=provider)
    resumed.register_snapshot(runtime, pipeline.snapshot(runtime))
    await resumed.load_and_snapshot(runtime)
    await resumed.map_insight(runtime)
    await resumed.compile_fact_visual_strategy(runtime)
    await resumed.compile_shared_prompt(runtime)
    provider.fail = False
    result = await resumed.generate_creative_shard(runtime, shard)
    assert provider.calls == [[t.slot_id for t in tasks], [tasks[1].slot_id], [tasks[1].slot_id]]
    assert [i.slot_id for i in result] == [t.slot_id for t in tasks]
    assert provider.refined == [t.slot_id for t in tasks]


@pytest.mark.asyncio
async def test_task_supplies_copyable_source_ids_without_claiming_realization() -> None:
    pipeline, runtime = await ready_pipeline(MockAiProvider())
    task = (await pipeline.plan_creatives(runtime, round_number=0))[0].tasks[0]
    assignment = task.fact_assignment
    assert assignment is not None
    brief = _creative_task_brief(task, assignment=assignment,
        application=pipeline._require_application(runtime),
        fact_visual_strategy=pipeline._required_fact_visual_strategy(runtime),
        fact_aliases=_creative_fact_aliases(assignment))
    assert brief["declaredFactIds"] == [item["factId"] for item in brief["factApplications"]]
    assert "realizedFactIds" not in brief
