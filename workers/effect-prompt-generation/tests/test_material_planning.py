from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import httpx
import pytest

from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.models import (
    CreativeCandidateDraft, FactEvidence, MaterialPlanResponse, PromptBatchSettings,
    StrategyCheckpoint, ExecutionFinding, StageStatus,
)
from effect_prompt_generation.execution_refinement import ExecutionEditDecision, apply_execution_edits
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.product_images import PreparedProductImage
from effect_prompt_generation.providers import (
    ArkResponsesProvider, MockAiProvider, ProviderError, ProviderErrorType,
    _creative_fact_aliases,
)
from effect_prompt_generation.quality import validate_creative_evaluation
from test_creatives import PromptApi, DistinctEmbeddingProvider, _runtime, _snapshot


class TrackingProvider(MockAiProvider):
    def __init__(self) -> None:
        self.plans: list[dict[str, Any]] = []
        self.refinements = 0

    async def plan_materials(self, *args: Any, **kwargs: Any) -> Any:
        self.plans.append(kwargs)
        return await super().plan_materials(*args, **kwargs)

    async def plan_creative_landscape(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError("new material path must not plan a landscape")

    async def plan_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError("new material path must not plan directions")

    async def refine_creative_execution(self, *args: Any, **kwargs: Any) -> Any:
        self.refinements += 1
        return await super().refine_creative_execution(*args, **kwargs)


async def ready(count: int = 10, facts: int = 6, provider: Any = None, name: str = "通用商品") -> tuple[Any, Any, Any]:
    snapshot = _snapshot()
    artifact = snapshot.insight_artifact.model_copy(update={"result": {
        "productName": name, "productCategory": "日常用品", "coreSpecification": "已确认规格",
        "priceRange": "", "visualFeatures": "已确认外观",
        "sellingPoints": [f"资料确认的独立使用事实{index + 1}" for index in range(facts)],
    }})
    snapshot = snapshot.model_copy(update={"insight_artifact": artifact,
        "settings": PromptBatchSettings(target_count=count, default_duration_seconds=15)})
    api = PromptApi()
    provider = provider or TrackingProvider()
    pipeline = PromptGenerationPipeline(api=api, provider=provider,
        embedding_provider=DistinctEmbeddingProvider(), shard_size=4)
    runtime = _runtime()
    pipeline.register_snapshot(runtime, snapshot)
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    return pipeline, runtime, provider


@pytest.mark.asyncio
@pytest.mark.parametrize("count,facts", [(10, 1), (10, 12), (12, 5), (40, 40), (50, 40), (100, 100), (10, 100)])
async def test_fact_first_counts_combinations_and_expansion(count: int, facts: int) -> None:
    pipeline, runtime, provider = await ready(count, facts)
    shards = await pipeline.plan_creatives(runtime, round_number=0)
    tasks = [task for shard in shards for task in shard.tasks]
    assert len(tasks) == count
    assert len({task.slot_id for task in tasks}) == count
    assert all(task.material_brief is not None and task.creative_direction is None for task in tasks)
    required = {fact.fact_id for fact in pipeline._require_application(runtime).usable if fact.field.value == "SELLING_POINT"}
    assert required <= {key for task in tasks for key in task.fact_assignment.fact_ids}
    assert all(len(call["task_ids"]) <= 20 for call in provider.plans)
    assert all(not task.execution_route for task in tasks)


@pytest.mark.asyncio
@pytest.mark.parametrize("product", ["紫苏梅子酱", "广式腊肠", "洗发露", "磁吸移动电源", "旅行箱"])
async def test_generic_product_graph_has_final_execution_edit_without_old_planning(product: str) -> None:
    pipeline, runtime, provider = await ready(10, 10, name=product)
    await build_graph(pipeline).ainvoke({"project_id": runtime.project_id}, context=runtime)
    assert len(pipeline.api.result.items) == 10
    assert pipeline.api.result.metrics.candidate_target_count == 10
    assert provider.refinements == 3
    assert pipeline._cache(runtime).creative_direction_plan is None


@pytest.mark.asyncio
async def test_material_final_edit_precedes_scoring_and_is_last_writer() -> None:
    class FinalEditor(TrackingProvider):
        async def refine_creative_execution(self, candidates: Any, **kwargs: Any) -> Any:
            call = await super().refine_creative_execution(candidates, **kwargs)
            revised = []
            for original in candidates:
                decision = ExecutionEditDecision.model_validate({
                    "slotId": original.slot_id, "decision": "REPAIR",
                    "conflicts": [{"paths": ["/shotPlan/beats/0/camera"], "reason": "opaque AI verdict"}],
                    "replacements": [
                        {"path": "/shotPlan/beats/0/camera", "value": "模型修订后的观察位置"},
                        {"path": "/dimensions/camera", "value": "模型同步后的镜头维度"},
                        {"path": "/creativeCore", "value": "模型保留商品价值后的连贯事件"},
                    ],
                })
                revised.append(apply_execution_edits(original, decision, duration_seconds=15))
            return replace(call, value=call.value.model_copy(update={"items": revised}))

        async def evaluate_creatives(self, candidates: Any, **kwargs: Any) -> Any:
            assert all("模型修订后的观察位置" in item.content for item in candidates)
            assert all(item.dimensions.camera == "模型同步后的镜头维度" for item in candidates)
            call = await super().evaluate_creatives(candidates, **kwargs)
            return replace(call, value=call.value.model_copy(update={"items": [
                row.model_copy(update={"execution_findings": [ExecutionFinding(
                    code="CAMERA_ACTION_MISMATCH", sequence=1, field="CAMERA", diagnosis="opaque remaining concern",
                )]}) for row in call.value.items
            ]}))

        async def repair_creative_execution(self, *args: Any, **kwargs: Any) -> Any:
            raise AssertionError("scoring must not rewrite a material after the final writer")

    pipeline, runtime, _ = await ready(10, 10, FinalEditor())
    await build_graph(pipeline).ainvoke({"project_id": runtime.project_id}, context=runtime)
    assert len(pipeline.api.result.items) == 10
    assert all(item.dimensions.camera == "模型同步后的镜头维度" for item in pipeline.api.result.items)
    assert not pipeline._cache(runtime).execution_repair_records


@pytest.mark.asyncio
async def test_material_final_edit_failure_resumes_without_regeneration() -> None:
    from test_creative_execution import RefinementProvider
    provider = RefinementProvider()
    pipeline, runtime, _ = await ready(10, 3, provider)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    provider.fail = True
    with pytest.raises(ProviderError):
        await pipeline.generate_creative_shard(runtime, shard)
    persisted = pipeline.api.shards[shard.key]
    assert persisted.status == StageStatus.FAILED
    assert len(persisted.creative_items) == len(shard.tasks)
    assert not pipeline._cache(runtime).creatives
    resumed = PromptGenerationPipeline(api=pipeline.api, provider=provider)
    resumed.register_snapshot(runtime, pipeline.snapshot(runtime))
    await resumed.load_and_snapshot(runtime)
    await resumed.map_insight(runtime)
    await resumed.compile_fact_visual_strategy(runtime)
    await resumed.compile_shared_prompt(runtime)
    provider.fail = False
    await resumed.generate_creative_shard(runtime, shard)
    assert provider.generations == 1
    assert provider.refinements == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("images", [False, True])
async def test_final_editor_receives_product_images_and_can_keep_original(images: bool) -> None:
    pipeline, runtime, mock = await ready(10, 3)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    candidates = (await mock.generate_creatives(shard, application=pipeline._require_application(runtime),
        shared_prompt=pipeline._required_shared_prompt(runtime))).value.items
    captured = []

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        captured.append(payload)
        return httpx.Response(200, json={"status": "completed", "output_text": json.dumps({"items": [
            {"slotId": c.slot_id, "decision": "KEEP", "conflicts": [], "replacements": []}
            for c in candidates
        ]})})

    provider = ArkResponsesProvider(base_url="https://ark.example/v3", api_key="test",
        candidate_model="turbo", strategy_model="turbo", transport=httpx.MockTransport(handler))
    try:
        result = await provider.refine_creative_execution(candidates, shard=shard,
            application=pipeline._require_application(runtime), shared_prompt=pipeline._required_shared_prompt(runtime),
            product_images=[PreparedProductImage(data_uri="data:image/jpeg;base64,dGVzdA==")] if images else ())
        assert result.value.items == candidates
    finally:
        await provider.aclose()
    assert sum(item["type"] == "input_image" for item in captured[0]["input"][0]["content"]) == int(images)


@pytest.mark.asyncio
async def test_material_preflight_counts_execution_edit_and_exact_initial_pool() -> None:
    pipeline, runtime, _ = await ready(50, 3)
    budget = pipeline._preflight_run(runtime)
    assert budget["plannedInitialCandidateCount"] == 50
    generation_calls = (50 + budget["plannedCreativeShardSize"] - 1) // budget["plannedCreativeShardSize"]
    evaluation_calls = (50 + budget["plannedEvaluationShardSize"] - 1) // budget["plannedEvaluationShardSize"]
    assert budget["plannedMinimumAiCallCount"] >= 2 * generation_calls + evaluation_calls + 3


@pytest.mark.asyncio
async def test_same_run_checkpoint_reuses_tasks_and_new_run_does_not() -> None:
    pipeline, runtime, provider = await ready(50, 40)
    initial = await pipeline.plan_creatives(runtime, round_number=0)
    checkpoints = list(pipeline._cache(runtime).strategy_checkpoints.values())
    serialized = [StrategyCheckpoint.model_validate_json(row.model_dump_json(by_alias=True)) for row in checkpoints]
    resumed = PromptGenerationPipeline(api=pipeline.api, provider=provider)
    resumed.register_snapshot(runtime, pipeline.snapshot(runtime), serialized)
    await resumed.map_insight(runtime)
    await resumed.compile_fact_visual_strategy(runtime)
    await resumed.compile_shared_prompt(runtime)
    before = len(provider.plans)
    restored = await resumed.plan_creatives(runtime, round_number=0)
    assert [task for shard in restored for task in shard.tasks] == [task for shard in initial for task in shard.tasks]
    assert len(provider.plans) == before
    other = replace(runtime, run_id="another-run")
    resumed.register_snapshot(other, pipeline.snapshot(runtime), serialized)
    await resumed.map_insight(other)
    await resumed.compile_fact_visual_strategy(other)
    await resumed.compile_shared_prompt(other)
    await resumed.plan_creatives(other, round_number=0)
    assert len(provider.plans) > before


@pytest.mark.asyncio
async def test_missing_fact_supplement_plans_new_event_without_old_direction() -> None:
    pipeline, runtime, provider = await ready(10, 10)
    await pipeline.plan_creatives(runtime, round_number=0)
    missing = pipeline._require_application(runtime).required[-1].fact_id
    supplement = await pipeline.plan_creatives(runtime, round_number=1, requested_count=20,
        supplement_kind="COVERAGE", coverage_fact_ids=[missing])
    assert sum(len(row.tasks) for row in supplement) == 2
    assert provider.plans[-1]["repair_context"]["missingFactIds"] == [missing]
    assert missing in provider.plans[-1]["remaining_fact_ids"]
    assert provider.plans[-1]["existing_tasks"]
    assert await pipeline.plan_creatives(runtime, round_number=2, missing_count=3) == []


@pytest.mark.asyncio
async def test_actual_binding_can_use_confirmed_unassigned_fact_but_not_unknown() -> None:
    pipeline, runtime, _ = await ready(10, 6)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    candidate = (await pipeline.generate_creative_shard(runtime, shard))[0]
    application = pipeline._require_application(runtime)
    other = next(fact.fact_id for fact in application.usable if fact.fact_id not in candidate.declared_fact_ids)
    call = await MockAiProvider().evaluate_creatives([candidate], application=application,
        target_durations={candidate.slot_id: 15})
    evaluation = call.value.items[0].model_copy(update={"fact_evidence": [
        FactEvidence(fact_id=other, support_level="SEMANTIC_FULL"),
        FactEvidence(fact_id="UNKNOWN", support_level="SEMANTIC_FULL"),
        FactEvidence(fact_id=candidate.declared_fact_ids[0], support_level="PARTIAL"),
    ]})
    verified = validate_creative_evaluation(candidate, evaluation, application)
    assert verified.realized_fact_ids == [other]
    assert "UNKNOWN_FACT" in verified.warnings


@pytest.mark.asyncio
async def test_planning_failure_resumes_only_unfinished_page() -> None:
    class Interrupted(TrackingProvider):
        fail = True

        async def plan_materials(self, *args: Any, **kwargs: Any) -> Any:
            if self.fail and kwargs["task_ids"][0] == "M0_021":
                raise ProviderError("temporary transport failure", retryable=True,
                                    error_type=ProviderErrorType.TIMEOUT)
            return await super().plan_materials(*args, **kwargs)

    provider = Interrupted()
    pipeline, runtime, _ = await ready(50, 40, provider)
    with pytest.raises(ProviderError):
        await pipeline.plan_creatives(runtime, round_number=0)
    checkpoints = [StrategyCheckpoint.model_validate_json(row.model_dump_json(by_alias=True))
                   for row in pipeline._cache(runtime).strategy_checkpoints.values()]
    provider.fail = False
    resumed = PromptGenerationPipeline(api=pipeline.api, provider=provider)
    resumed.register_snapshot(runtime, pipeline.snapshot(runtime), checkpoints)
    await resumed.map_insight(runtime)
    await resumed.compile_fact_visual_strategy(runtime)
    await resumed.compile_shared_prompt(runtime)
    tasks = [task for shard in await resumed.plan_creatives(runtime, round_number=0) for task in shard.tasks]
    assert len(tasks) == 50
    assert [call["task_ids"][0] for call in provider.plans] == ["M0_001", "M0_021", "M0_041"]


@pytest.mark.asyncio
async def test_candidate_image_mode_change_invalidates_saved_plan() -> None:
    pipeline, runtime, provider = await ready(10, 3)
    await pipeline.plan_creatives(runtime, round_number=0)
    checkpoints = list(pipeline._cache(runtime).strategy_checkpoints.values())
    resumed = PromptGenerationPipeline(api=pipeline.api, provider=provider, candidate_product_images=False)
    resumed.register_snapshot(runtime, pipeline.snapshot(runtime), checkpoints)
    await resumed.map_insight(runtime)
    await resumed.compile_fact_visual_strategy(runtime)
    await resumed.compile_shared_prompt(runtime)
    await resumed.plan_creatives(runtime, round_number=0)
    assert len(provider.plans) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("images", [False, True])
async def test_candidate_request_contains_verified_images_only_when_supplied(images: bool) -> None:
    pipeline, runtime, _ = await ready(10, 1)
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    shard = shard.model_copy(update={"tasks": shard.tasks[:1]})
    candidate = (await MockAiProvider().generate_creatives(shard,
        application=pipeline._require_application(runtime), shared_prompt=pipeline._required_shared_prompt(runtime))).value.items[0]
    task = shard.tasks[0]
    aliases = _creative_fact_aliases(task.fact_assignment)
    draft = CreativeCandidateDraft.model_validate(candidate.model_dump(exclude={"content", "generated_at"}))
    draft = draft.model_copy(update={"declared_fact_ids": [aliases[key] for key in draft.declared_fact_ids]})
    captured = []

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"status": "completed", "output_text": json.dumps({"items": [draft.model_dump(mode="json", by_alias=True)]})})

    provider = ArkResponsesProvider(base_url="https://ark.example/v3", api_key="test",
        candidate_model="turbo", strategy_model="turbo", transport=httpx.MockTransport(handler))
    try:
        options = {"product_images": [PreparedProductImage(data_uri="data:image/jpeg;base64,dGVzdA==")]} if images else {}
        await provider.generate_creatives(shard, application=pipeline._require_application(runtime),
            shared_prompt=pipeline._required_shared_prompt(runtime), **options)
    finally:
        await provider.aclose()
    content = captured[0]["input"][0]["content"]
    assert len([item for item in content if item["type"] == "input_image"]) == int(images)
    assert "materialTask" in content[0]["text"]


@pytest.mark.asyncio
async def test_invalid_material_sources_retry_once_without_legacy_fallback() -> None:
    class Invalid(TrackingProvider):
        async def plan_materials(self, *args: Any, **kwargs: Any) -> Any:
            call = await super().plan_materials(*args, **kwargs)
            return replace(call, value=MaterialPlanResponse(tasks=[
                row.model_copy(update={"fact_ids": ["UNKNOWN"]}) for row in call.value.tasks]))
    pipeline, runtime, provider = await ready(10, 5, Invalid())
    with pytest.raises(ProviderError) as error:
        await pipeline.plan_creatives(runtime, round_number=0)
    assert error.value.error_type == ProviderErrorType.RESPONSE_INVALID
    assert len(provider.plans) == 2
