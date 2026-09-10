from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import httpx
import pytest

from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.models import StageStatus
from effect_prompt_generation.providers import ArkResponsesProvider, MockAiProvider, ProviderError, ProviderErrorType
from effect_prompt_generation.prompt_loader import load_prompt, load_prompt_hash
from effect_prompt_generation.execution_refinement import (
    ExecutionEditDecision, apply_execution_edits, editable_execution_paths,
)
from test_supplement_recovery import ready_pipeline


class RefinementProvider(MockAiProvider):
    def __init__(self) -> None:
        self.generations = 0
        self.refinements = 0
        self.fail = False
        self.empty = False

    async def generate_creatives(self, *args: Any, **kwargs: Any) -> Any:
        self.generations += 1
        return await super().generate_creatives(*args, **kwargs)

    async def refine_creative_execution(self, *args: Any, **kwargs: Any) -> Any:
        self.refinements += 1
        if self.fail:
            raise ProviderError("execution refinement timeout", error_type=ProviderErrorType.TIMEOUT, retryable=True)
        call = await super().refine_creative_execution(*args, **kwargs)
        return replace(call, value=call.value.model_copy(update={"items": []})) if self.empty else call


@pytest.mark.asyncio
async def test_every_generated_shard_is_refined_without_waiting_for_quality_findings() -> None:
    provider = RefinementProvider()
    pipeline, runtime = await ready_pipeline(provider)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    before = pipeline._cache(runtime).ai_call_count
    items = await pipeline.generate_creative_shard(runtime, shard)
    assert provider.generations == provider.refinements == 1
    assert pipeline._cache(runtime).ai_call_count == before + 2
    assert not pipeline._cache(runtime).creative_evaluations
    assert pipeline.api.shards[shard.key].status == StageStatus.SUCCEEDED
    assert items


@pytest.mark.asyncio
async def test_failed_refinement_resumes_persisted_drafts_without_regenerating() -> None:
    provider = RefinementProvider()
    pipeline, runtime = await ready_pipeline(provider)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    provider.fail = True
    with pytest.raises(ProviderError):
        await pipeline.generate_creative_shard(runtime, shard)
    persisted = pipeline.api.shards[shard.key]
    assert persisted.status == StageStatus.FAILED
    assert persisted.creative_items
    assert not pipeline._cache(runtime).creatives
    resumed = PromptGenerationPipeline(api=pipeline.api, provider=provider)
    resumed.register_snapshot(runtime, pipeline.snapshot(runtime))
    await resumed.load_and_snapshot(runtime)
    assert resumed._cache(runtime).pending_execution_drafts[shard.key].creative_items == persisted.creative_items
    await resumed.map_insight(runtime)
    await resumed.compile_fact_visual_strategy(runtime)
    await resumed.compile_shared_prompt(runtime)
    provider.fail = False
    result = await resumed.generate_creative_shard(runtime, shard)
    assert provider.generations == 1
    assert provider.refinements == 2
    assert len(result) == len(persisted.creative_items)
    assert pipeline.api.shards[shard.key].status == StageStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_invalid_refinement_cannot_silently_discard_the_generated_shard() -> None:
    provider = RefinementProvider()
    pipeline, runtime = await ready_pipeline(provider)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    provider.empty = True
    with pytest.raises(ProviderError):
        await pipeline.generate_creative_shard(runtime, shard)
    persisted = pipeline.api.shards[shard.key]
    assert persisted.status == StageStatus.FAILED
    assert len(persisted.creative_items) == len(shard.tasks)
    assert provider.generations == 1
    assert provider.refinements <= 4 * len(shard.tasks)
    assert not pipeline._cache(runtime).creatives


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["none", "keep", "id", "facts", "ordinal", "duplicate", "missing"])
async def test_execution_model_uses_generation_route_and_preserves_identity(mutation: str) -> None:
    mock = MockAiProvider()
    pipeline, runtime = await ready_pipeline(mock)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    candidates = (await mock.generate_creatives(shard,
        application=pipeline._require_application(runtime),
        shared_prompt=pipeline._required_shared_prompt(runtime))).value.items
    seen: dict[str, Any] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        payload = json.loads(seen["input"][0]["content"][0]["text"])
        rows = [{"slotId": entry["draft"]["slotId"], "decision": "KEEP",
                 "conflicts": [], "replacements": []} for entry in payload["items"]]
        for entry in payload["items"]:
            assert "executionRoute" not in entry["task"]
            assert "creativeDirection" not in entry["task"]
            assert "coverageFocusFactIds" not in entry["task"]
            assert entry["task"]["productSnapshot"]
            assert entry["task"]["factApplications"]
            for fact in entry["task"]["factApplications"]:
                assert "creativeUsage" not in fact
                assert "instruction" not in fact
                assert "value" in fact and "visualUsage" in fact and "forbiddenInferences" in fact
        if mutation not in {"keep", "duplicate", "missing"}:
            rows[0].update(decision="REPAIR", conflicts=[{
                "paths": ["/shotPlan/beats/0/camera"], "reason": "模型指出观察路径冲突"}],
                replacements=[{"path": "/shotPlan/beats/0/camera", "value": "相机从侧面缓慢靠近静置主体"}])
        if mutation == "id":
            rows[0]["slotId"] = "unknown"
        elif mutation == "facts":
            rows[0]["replacements"][0]["path"] = "/declaredFactIds/0"
        elif mutation == "ordinal":
            rows[0]["replacements"][0]["path"] = "/ordinal"
        elif mutation == "duplicate":
            rows = [rows[0], rows[0]]
        elif mutation == "missing":
            rows = rows[:-1]
        return httpx.Response(200, json={"status": "completed", "output_text": json.dumps({"items": list(reversed(rows))})})

    provider = ArkResponsesProvider(base_url="https://ark.example/v3", api_key="test-key",
        strategy_model="strategy", candidate_model="same-generation-model", evaluation_model="unchanged-quality-model",
        transport=httpx.MockTransport(handler))
    try:
        if mutation in {"none", "keep"}:
            call = await provider.refine_creative_execution(candidates, shard=shard,
                application=pipeline._require_application(runtime), shared_prompt=pipeline._required_shared_prompt(runtime))
            assert len(call.value.items) == len(candidates)
            assert call.value.items[0].declared_fact_ids == candidates[0].declared_fact_ids
            if mutation == "none":
                assert "相机从侧面缓慢靠近静置主体" in call.value.items[0].content
                assert call.value.items[0].dimensions == candidates[0].dimensions
                assert call.value.items[0].creative_core == candidates[0].creative_core
            else:
                assert call.value.items == candidates
            assert call.metadata.template_hash == load_prompt_hash("creative_execution.system.prompt.txt")
        else:
            with pytest.raises(ProviderError):
                await provider.refine_creative_execution(candidates, shard=shard,
                    application=pipeline._require_application(runtime), shared_prompt=pipeline._required_shared_prompt(runtime))
        assert seen["model"] == "same-generation-model"
        assert seen["instructions"] == load_prompt("creative_execution.system.prompt.txt")
        assert seen["max_output_tokens"] >= 4096
        schema = seen["text"]["format"]["schema"]
        assert schema["properties"]["items"]["minItems"] == len(candidates)
        assert schema["properties"]["items"]["maxItems"] == len(candidates)
        assert schema["$defs"]["ExecutionEditDecision"]["properties"]["slotId"]["enum"] == [c.slot_id for c in candidates]
    finally:
        await provider.aclose()


def test_execution_template_handles_causes_without_keyword_worker_rules() -> None:
    template = load_prompt("creative_execution.system.prompt.txt")
    for phrase in ["不是打分", "不删候选", "多人接力", "相对位置", "拉丝", "气体、水蒸气"]:
        assert phrase in template
    assert "字幕、口播、旁白" in template
    assert "decision=KEEP" in template
    assert "只修改这些字段" in template
    assert "不理解语义" in template


@pytest.mark.asyncio
@pytest.mark.parametrize("product,initial,action,replacement", [
    ("食品", "工具留在容器口", "工具未撤离就盖上容器", "先把工具放到旁边托盘，再盖上容器"),
    ("洗护用品", "双手正在搓揉泡沫", "一手同时拿瓶并继续双手搓揉", "继续双手搓揉，瓶身留在台面"),
    ("服饰", "衣片在固定镜头前朝向观众", "保持原朝向展示被遮住的内侧", "手将衣片翻向镜头，展示内侧"),
    ("电子设备", "配件占据收纳盒闭合路径", "按下盒盖并保留配件原位", "取下配件放在桌面，再按下盒盖"),
])
@pytest.mark.parametrize("duration", [4, 8, 12, 15])
async def test_sparse_edit_is_product_and_duration_independent(
    product: str, initial: str, action: str, replacement: str, duration: int,
) -> None:
    mock = MockAiProvider()
    pipeline, runtime = await ready_pipeline(mock)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    original = (await mock.generate_creatives(shard, application=pipeline._require_application(runtime),
        shared_prompt=pipeline._required_shared_prompt(runtime))).value.items[0]
    assert original.shot_plan is not None
    plan = original.shot_plan.model_copy(update={
        "scene": original.shot_plan.scene.model_copy(update={"initial_state": initial}),
        "beats": [original.shot_plan.beats[0].model_copy(update={"action": action}),
                  *original.shot_plan.beats[1:]],
    })
    original = original.model_copy(update={"creative_core": f"{product}的观看事件", "shot_plan": plan})
    before = original.model_dump()
    keep = ExecutionEditDecision(slot_id=original.slot_id, decision="KEEP", conflicts=[], replacements=[])
    assert apply_execution_edits(original, keep, duration_seconds=duration) is original
    # The reason is deliberately opaque: Worker must never decide its semantic validity.
    edit = ExecutionEditDecision.model_validate({"slotId": original.slot_id, "decision": "REPAIR",
        "conflicts": [{"paths": ["/shotPlan/beats/0/action"], "reason": "opaque AI diagnosis"}],
        "replacements": [{"path": "/shotPlan/beats/0/action", "value": replacement}]})
    result = apply_execution_edits(original, edit, duration_seconds=duration)
    assert original.model_dump() == before
    assert result.shot_plan is not None and original.shot_plan is not None
    assert result.shot_plan.beats[0].action == edit.replacements[0].value
    assert result.shot_plan.scene == original.shot_plan.scene
    assert result.shot_plan.final_frame == original.shot_plan.final_frame
    assert result.dimensions == original.dimensions
    assert result.creative_core == original.creative_core
    assert result.declared_fact_ids == original.declared_fact_ids
    assert result.generated_at == original.generated_at
    assert f"–{duration}秒" in result.content
    assert [b.duration_weight for b in result.shot_plan.beats] == [b.duration_weight for b in original.shot_plan.beats]


@pytest.mark.asyncio
async def test_linked_edits_and_optional_null_preserve_all_unmentioned_fields() -> None:
    mock = MockAiProvider()
    pipeline, runtime = await ready_pipeline(mock)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    original = (await mock.generate_creatives(shard, application=pipeline._require_application(runtime),
        shared_prompt=pipeline._required_shared_prompt(runtime))).value.items[0]
    edit = ExecutionEditDecision.model_validate({"slotId": original.slot_id, "decision": "REPAIR",
        "conflicts": [{"paths": ["/shotPlan/scene/initialState", "/shotPlan/finalFrame"],
                       "reason": "模型要求同步相关状态"}],
        "replacements": [
            {"path": "/shotPlan/scene/initialState", "value": "主体已在稳定支撑上，活动工具在一旁"},
            {"path": "/shotPlan/finalFrame", "value": "主体完成局部变化，工具已撤离"},
            {"path": "/shotPlan/beats/0/sound", "value": None},
        ]})
    result = apply_execution_edits(original, edit, duration_seconds=15)
    expected = original.model_dump(mode="json", by_alias=True)
    expected["shotPlan"]["scene"]["initialState"] = edit.replacements[0].value
    expected["shotPlan"]["finalFrame"] = edit.replacements[1].value
    expected["shotPlan"]["beats"][0]["sound"] = None
    expected["content"] = result.content
    assert result.model_dump(mode="json", by_alias=True) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["unknown", "negative", "out_of_bounds", "object", "timing", "duplicate_path",
    "null_required", "too_long", "empty_repair", "keep_with_edits", "conflict_path"])
async def test_invalid_sparse_edits_are_rejected_without_mutating_draft(fault: str) -> None:
    mock = MockAiProvider()
    pipeline, runtime = await ready_pipeline(mock)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    original = (await mock.generate_creatives(shard, application=pipeline._require_application(runtime),
        shared_prompt=pipeline._required_shared_prompt(runtime))).value.items[0]
    before = original.model_dump()
    paths = editable_execution_paths(original)
    assert not any("durationWeight" in p or "sequence" in p for p in paths)
    payload: dict[str, Any] = {"slotId": original.slot_id, "decision": "REPAIR",
        "conflicts": [{"paths": ["/shotPlan/beats/0/camera"], "reason": "opaque"}],
        "replacements": [{"path": "/shotPlan/beats/0/camera", "value": "固定观察"}]}
    bad_paths = {"unknown": "/shotPlan/newField", "negative": "/shotPlan/beats/-1/camera",
        "out_of_bounds": "/shotPlan/beats/99/camera", "object": "/shotPlan/beats/0", "timing": "/shotPlan/beats/0/durationWeight"}
    if fault in bad_paths:
        payload["replacements"][0]["path"] = bad_paths[fault]
    elif fault == "duplicate_path":
        payload["replacements"] *= 2
    elif fault == "null_required":
        payload["replacements"][0]["value"] = None
    elif fault == "too_long":
        payload["replacements"][0]["value"] = "长" * 181
    elif fault == "empty_repair":
        payload["conflicts"] = []
    elif fault == "keep_with_edits":
        payload["decision"] = "KEEP"
    elif fault == "conflict_path":
        payload["conflicts"][0]["paths"] = ["/content"]
    with pytest.raises(ValueError):
        apply_execution_edits(original, ExecutionEditDecision.model_validate(payload), duration_seconds=15)
    assert original.model_dump() == before
