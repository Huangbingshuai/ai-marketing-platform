from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from effect_prompt_generation.execution_repair import (
    apply_execution_patch,
    candidate_hash,
    has_execution_diagnosis,
    repair_improves,
    restore_execution_candidate,
)
from effect_prompt_generation.models import (
    ClassificationShardPlan,
    ExecutionFinding,
    ExecutionRepairCheckpoint,
    ExecutionRepairDraft,
    StageStatus,
)
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import (
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)
from effect_prompt_generation.shot_plan import compile_material_shot_plan
from test_creatives import _snapshot
from test_supplement_recovery import ready_pipeline


class LocatedProvider(MockAiProvider):
    def __init__(self, mode: str = "accept") -> None:
        self.mode = mode
        self.evaluations = 0
        self.repairs = 0

    async def evaluate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        call = await super().evaluate_creatives(*args, **kwargs)
        self.evaluations += 1
        if self.evaluations > 1 and self.mode == "empty-review":
            return replace(call, value=call.value.model_copy(update={"items": []}))
        rows = []
        for item in call.value.items:
            diagnosed = self.evaluations == 1 or self.mode == "unimproved"
            scores = item.scores.model_copy(
                update={"visual_executability": 70 if diagnosed else 95}
            )
            rows.append(
                item.model_copy(
                    update={
                        "scores": scores,
                        "warnings": ["CAMERA_ACTION_MISMATCH"] if diagnosed else [],
                        "execution_findings": [
                            ExecutionFinding(
                                code="CAMERA_ACTION_MISMATCH",
                                sequence=1,
                                field="CAMERA",
                                diagnosis="同一节拍机位固定与机位移动互相冲突",
                            )
                        ]
                        if diagnosed and self.mode != "unlocated"
                        else [],
                    }
                )
            )
        return replace(call, value=call.value.model_copy(update={"items": rows}))

    async def repair_creative_execution(self, candidate: Any, **kwargs: Any) -> Any:
        self.repairs += 1
        if self.mode == "transport":
            raise ProviderError(
                "repair timed out", error_type=ProviderErrorType.TIMEOUT, retryable=True
            )
        call = await super().repair_creative_execution(candidate, **kwargs)
        return replace(
            call,
            value=ExecutionRepairDraft(
                slot_id="wrong-slot"
                if self.mode == "wrong-slot"
                else candidate.slot_id,
                patches=[
                    {
                        "sequence": 1,
                        "field": "CAMERA",
                        "value": "固定机位，不跟随主体平移",
                    },
                    {"sequence": 1, "field": "FOCUS", "value": "焦点落在主体接触面"},
                    {
                        "sequence": 1,
                        "field": "MOTION_SOURCE",
                        "value": "使用者施力推动主体",
                    },
                ],
                camera_dimension="固定机位，主体运动",
            ),
        )


async def prepared(provider: LocatedProvider) -> tuple[Any, Any, Any, Any]:
    pipeline, runtime = await ready_pipeline(provider)
    shards = await pipeline.plan_creatives(runtime, round_number=0)
    await pipeline.generate_creative_shard(runtime, shards[0])
    candidate = next(iter(pipeline._cache(runtime).creatives.values()))
    shard = ClassificationShardPlan(
        round=0, shard_index=0, candidate_ids=[candidate.slot_id]
    )
    return pipeline, runtime, candidate, shard


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode",
    ["accept", "transport", "wrong-slot", "unimproved", "unlocated", "empty-review"],
)
async def test_one_local_repair_preserves_original_unless_review_improves(
    mode: str,
) -> None:
    provider = LocatedProvider(mode)
    pipeline, runtime, original, shard = await prepared(provider)
    result = (await pipeline.evaluate_classification_shard(runtime, shard))[0]
    current = pipeline._cache(runtime).creatives[original.slot_id]
    assert provider.repairs == (0 if mode == "unlocated" else 1)
    assert provider.evaluations == (
        2 if mode in {"accept", "unimproved", "empty-review"} else 1
    )
    assert not result.hard_issues
    if mode == "accept":
        assert current.content != original.content
        assert current.shot_plan.beats[0].motion_source == "使用者施力推动主体"
        assert current.creative_core == original.creative_core
        assert current.declared_fact_ids == original.declared_fact_ids
        assert result.execution_repair.status == "ACCEPTED"
        assert restore_execution_candidate(original, result, duration=5) == current
    else:
        assert current == original
        assert result.warnings == ["CAMERA_ACTION_MISMATCH"]
        if mode != "unlocated":
            assert result.execution_repair.status == "KEPT_ORIGINAL"
    calls = (provider.repairs, provider.evaluations)
    resumed = PromptGenerationPipeline(api=pipeline.api, provider=provider)
    resumed.register_snapshot(runtime, _snapshot())
    await resumed.load_and_snapshot(runtime)
    assert resumed._cache(runtime).creatives[original.slot_id] == current
    assert shard.key in resumed._cache(runtime).completed_classification_shard_keys
    assert (provider.repairs, provider.evaluations) == calls


@pytest.mark.asyncio
async def test_attempt_marker_survives_interruption_before_repair_result() -> None:
    provider = LocatedProvider()
    pipeline, runtime, original, shard = await prepared(provider)

    async def interrupted(*args: Any, **kwargs: Any) -> Any:
        raise KeyboardInterrupt("simulated process exit")

    provider.repair_creative_execution = interrupted
    with pytest.raises(KeyboardInterrupt):
        await pipeline.evaluate_classification_shard(runtime, shard)
    stored = pipeline.api.shards[shard.key]
    assert stored.status == StageStatus.RUNNING
    assert stored.evaluations[0].execution_repair.status == "STARTED"
    resumed = PromptGenerationPipeline(api=pipeline.api, provider=provider)
    resumed.register_snapshot(runtime, _snapshot())
    await resumed.load_and_snapshot(runtime)
    resumed._cache(runtime).insight_application = pipeline._cache(
        runtime
    ).insight_application
    resumed._cache(runtime).shared_prompt = pipeline._cache(runtime).shared_prompt
    resumed._cache(runtime).fact_visual_strategy = pipeline._cache(
        runtime
    ).fact_visual_strategy
    await resumed.evaluate_classification_shard(runtime, shard)
    assert provider.evaluations == 1
    assert resumed._cache(runtime).creatives[original.slot_id] == original


@pytest.mark.asyncio
async def test_manual_task_never_rewrites_user_content() -> None:
    provider = LocatedProvider()
    pipeline, runtime, original, shard = await prepared(provider)
    pipeline._cache(runtime).creative_tasks.pop(original.slot_id)
    await pipeline.evaluate_classification_shard(runtime, shard)
    assert provider.repairs == 0
    assert pipeline._cache(runtime).creatives[original.slot_id] == original


@pytest.mark.asyncio
async def test_optional_repair_does_not_consume_remaining_mandatory_evaluation_budget() -> (
    None
):
    provider = LocatedProvider()
    pipeline, runtime, original, shard = await prepared(provider)
    pipeline.max_ai_calls_per_run = pipeline._cache(runtime).ai_call_count + 3
    # Other candidates are still unassessed. The remaining calls belong to
    # their mandatory evaluations, not optional execution improvements.
    await pipeline.evaluate_classification_shard(runtime, shard)
    assert provider.repairs == 0
    assert pipeline._cache(runtime).creatives[original.slot_id] == original


@pytest.mark.asyncio
async def test_patch_and_checkpoint_reject_only_structural_mismatches() -> None:
    pipeline, runtime, original, shard = await prepared(LocatedProvider())
    review = (await pipeline.evaluate_classification_shard(runtime, shard))[0]
    assert has_execution_diagnosis(original, review) is False
    for edits in [
        {"slot_id": "other"},
        {"declared_fact_ids": ["unknown"]},
        {"creative_core": "unrelated core"},
        {"content": "uncompiled body" * 3},
    ]:
        tampered = review.model_copy(
            update={
                "execution_repair": review.execution_repair.model_copy(
                    update={
                        "candidate": review.execution_repair.candidate.model_copy(
                            update=edits
                        ),
                    }
                )
            }
        )
        assert restore_execution_candidate(original, tampered, duration=5) is None
    changed_hash = review.model_copy(
        update={
            "execution_repair": review.execution_repair.model_copy(
                update={"original_hash": "0" * 64}
            )
        }
    )
    assert restore_execution_candidate(original, changed_hash, duration=5) is None
    record = pipeline.api.shards[shard.key]
    pipeline.api.shards[shard.key] = record.model_copy(
        update={"evaluations": [changed_hash]}
    )
    resumed = PromptGenerationPipeline(api=pipeline.api, provider=LocatedProvider())
    resumed.register_snapshot(runtime, _snapshot())
    await resumed.load_and_snapshot(runtime)
    assert shard.key not in resumed._cache(runtime).completed_classification_shard_keys
    assert original.slot_id not in resumed._cache(runtime).creative_evaluations
    for patches in [
        [{"sequence": 6, "field": "CAMERA", "value": "arbitrary text"}],
        [{"sequence": 1, "field": "FINAL_FRAME", "value": "arbitrary text"}],
        [{"sequence": 1, "field": "CAMERA", "value": "x"}] * 2,
    ]:
        with pytest.raises(ValueError):
            apply_execution_patch(
                original,
                ExecutionRepairDraft(slot_id=original.slot_id, patches=patches),
                duration=5,
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("duration", [4, 8, 12, 15])
@pytest.mark.parametrize("product", ["酱料", "洗发露", "折叠台灯"])
async def test_execution_fields_compile_for_durations_and_products_without_inference(
    duration: int, product: str
) -> None:
    _, _, original, _ = await prepared(LocatedProvider())
    plan = original.shot_plan
    original = original.model_copy(
        update={
            "content": compile_material_shot_plan(
                plan, target_duration_seconds=duration
            )
        }
    )
    legacy = plan.model_dump()
    for beat in legacy["beats"]:
        beat.pop("focus")
        beat.pop("motion_source")
    assert (
        compile_material_shot_plan(
            type(plan).model_validate(legacy), target_duration_seconds=duration
        )
        == original.content
    )
    repaired = apply_execution_patch(
        original,
        ExecutionRepairDraft(
            slot_id=original.slot_id,
            patches=[
                {
                    "sequence": 1,
                    "field": "MOTION_SOURCE",
                    "value": f"AI 提供的 {product} 运动来源原文",
                },
                {"sequence": 1, "field": "FOCUS", "value": "AI 提供的焦点说明"},
            ],
        ),
        duration=duration,
    )
    assert f"AI 提供的 {product} 运动来源原文" in repaired.content
    assert "焦点变化：AI 提供的焦点说明" in repaired.content
    assert repaired.shot_plan.beats[0].duration_weight == plan.beats[0].duration_weight


@pytest.mark.asyncio
async def test_numeric_acceptance_cannot_override_fact_loss_or_new_hard_issue() -> None:
    pipeline, runtime, original, shard = await prepared(LocatedProvider())
    reviewed = (await pipeline.evaluate_classification_shard(runtime, shard))[0]
    assert repair_improves(reviewed, reviewed)
    assert not repair_improves(
        reviewed, reviewed.model_copy(update={"realized_fact_ids": []})
    )
    assert not repair_improves(
        reviewed, reviewed.model_copy(update={"hard_issues": ["FACT_HALLUCINATION"]})
    )
    assert candidate_hash(original) == reviewed.execution_repair.original_hash
    assert (
        ExecutionRepairCheckpoint.model_validate(reviewed.execution_repair.model_dump())
        == reviewed.execution_repair
    )
