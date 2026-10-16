from __future__ import annotations

from typing import Any
from dataclasses import replace

import pytest

from effect_prompt_generation.execution_correction import (
    ExecutionCorrectionBatch, ExecutionCorrectionItem, apply_execution_corrections,
    candidate_execution_hash, execution_review_input, validate_execution_reviews,
)
from effect_prompt_generation.models import (
    ExecutionReviewBatch, ExecutionIssue, ExecutionIssueResolution,
)
from effect_prompt_generation.providers import MockAiProvider, ProviderError
from test_material_planning import ready


class DiagnosedProvider(MockAiProvider):
    diagnostics = 0
    rewrites = 0
    fail_rewrite = True

    async def diagnose_creative_execution(self, candidates: Any, **kwargs: Any) -> Any:
        self.diagnostics += 1
        call = await super().diagnose_creative_execution(candidates, **kwargs)
        for row in call.value.items:
            row.issues = [ExecutionIssue(issue_id="I1", code="GRIP_SUPPORT", sequences=[1],
                                         diagnosis="Mock 仅验证诊断到重写协议")]
        return call

    async def correct_creative_execution(self, candidates: Any, **kwargs: Any) -> Any:
        self.rewrites += 1
        if self.fail_rewrite:
            raise ProviderError("timeout", retryable=True)
        call = await super().correct_creative_execution(candidates, **kwargs)
        value = ExecutionCorrectionBatch(items=[ExecutionCorrectionItem(
            slot_id=item.slot_id, changed=True, creative_core=item.creative_core,
            dimensions=item.dimensions, shot_plan=item.shot_plan,
            resolutions=[ExecutionIssueResolution(issue_id="I1", revised_sequences=[1],
                                                  change_summary="Mock 修订协议")],
        ) for item in candidates])
        return replace(call, value=value)


@pytest.mark.asyncio
async def test_diagnosis_persisted_before_rewrite_and_reused_with_source_fence() -> None:
    provider = DiagnosedProvider()
    pipeline, runtime, _ = await ready(provider=provider)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    with pytest.raises(ProviderError):
        await pipeline.generate_creative_shard(runtime, shard)
    drafts = pipeline.api.shards[shard.key].creative_items
    assert all(row.execution_correction.status == "DIAGNOSED" for row in drafts)
    assert provider.diagnostics == 1
    provider.fail_rewrite = False
    corrected = await pipeline.generate_creative_shard(runtime, shard)
    assert provider.diagnostics == 1 and provider.rewrites == 2
    assert all(row.execution_correction.status == "APPLIED" for row in corrected)
    assert all(row.execution_correction.resolutions[0].issue_id == "I1" for row in corrected)
    await pipeline._correct_execution(runtime, corrected)
    assert provider.diagnostics == 1 and provider.rewrites == 2
    changed = corrected[0].model_copy(update={"creative_core": "来源内容发生改变"})
    assert candidate_execution_hash(changed) != candidate_execution_hash(corrected[0])
    await pipeline._correct_execution(runtime, [changed])
    assert provider.diagnostics == 2 and provider.rewrites == 3


@pytest.mark.asyncio
async def test_normal_candidates_skip_rewrite_and_keep_business_fields() -> None:
    class Normal(MockAiProvider):
        async def correct_creative_execution(self, *args: Any, **kwargs: Any) -> Any:
            raise AssertionError("normal candidates must not be rewritten")

    pipeline, runtime, _ = await ready(provider=Normal())
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    call = await pipeline.provider.generate_creatives(
        shard, application=pipeline._require_application(runtime),
        shared_prompt=pipeline._required_shared_prompt(runtime),
    )
    cache = pipeline._cache(runtime)
    cache.creative_tasks.update({task.slot_id: task for task in shard.tasks})
    cache.creative_target_durations.update({task.slot_id: task.target_duration_seconds for task in shard.tasks})
    corrected = await pipeline._correct_execution(runtime, call.value.items)
    assert [candidate_execution_hash(row) for row in corrected] == [
        candidate_execution_hash(row) for row in call.value.items
    ]


@pytest.mark.asyncio
async def test_review_uses_actual_plan_and_rejects_only_protocol_errors() -> None:
    pipeline, runtime, _ = await ready()
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    candidates = await pipeline.generate_creative_shard(runtime, shard)
    item = candidates[0]
    item.shot_plan.beats[0].information_delta = "虚假的新增信息声明"
    item.shot_plan.beats[0].continuity_state = "虚假的支撑声明"
    payload = execution_review_input(item)
    assert "informationDelta" not in payload["shotPlan"]["beats"][0]
    assert "continuityState" not in payload["shotPlan"]["beats"][0]
    assert "executionCorrection" not in payload
    review = item.execution_correction.review.model_copy(deep=True)
    validate_execution_reviews([item], ExecutionReviewBatch(items=[review]))
    review.beats.pop()
    with pytest.raises(ValueError, match="every beat"):
        validate_execution_reviews([item], ExecutionReviewBatch(items=[review]))
    review = item.execution_correction.review.model_copy(deep=True)
    review.issues = [ExecutionIssue(issue_id="I1", code="INFORMATION_SPARSE", sequences=[1],
                                   diagnosis="AI 语义判断由模型负责")]
    unchanged = ExecutionCorrectionBatch(items=[ExecutionCorrectionItem(slot_id=item.slot_id, changed=False)])
    with pytest.raises(ValueError, match="each diagnosed issue"):
        apply_execution_corrections([item], unchanged, {item.slot_id: 15}, {item.slot_id: review})
    review.issues[0].sequences = [7]
    with pytest.raises(ValueError, match="out of range"):
        validate_execution_reviews([item], ExecutionReviewBatch(items=[review]))
