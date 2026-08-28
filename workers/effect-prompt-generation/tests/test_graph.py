from __future__ import annotations

import hashlib
import uuid
from typing import Any, Mapping

import pytest

from effect_prompt_generation.api_client import InternalApi
from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.models import (
    ClaimResponse,
    FailurePayload,
    FragmentConfig,
    FragmentType,
    GeneratedPromptTextBatch,
    PlannedCombination,
    ProgressPayload,
    PromptBatchResult,
    PromptGenerationSnapshot,
    PromptItem,
    RuntimeContext,
    SharedPrompt,
    SharedPromptSection,
    ShardRecord,
    StageOutput,
    StrategyCheckpoint,
)
from effect_prompt_generation.pipeline import PipelineError, PromptGenerationPipeline
from effect_prompt_generation.providers import (
    FRAGMENT_STRATEGY_VERSION,
    AiCallResult,
    MockAiProvider,
)


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

    async def heartbeat(
        self, context: RuntimeContext, payload: ProgressPayload
    ) -> None:
        return None

    async def complete(self, context: RuntimeContext, result: PromptBatchResult) -> str:
        self.result = result
        return "prompt-result-1"

    async def fail(self, context: RuntimeContext, payload: FailurePayload) -> None:
        raise AssertionError(f"unexpected failure: {payload.error_code}")


class TechnicalMetadataProvider(MockAiProvider):
    async def generate_candidates(
        self,
        combinations: list[PlannedCombination],
        *,
        insight: Mapping[str, Any],
        shared_prompt: SharedPrompt,
        regeneration_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[GeneratedPromptTextBatch]:
        generated = await super().generate_candidates(
            combinations,
            insight=insight,
            shared_prompt=shared_prompt,
            regeneration_context=regeneration_context,
        )
        return AiCallResult(
            value=generated.value.model_copy(
                update={
                    "items": [
                        item.model_copy(
                            update={
                                "prompt_text": f"{item.prompt_text} 画幅9:16，分辨率1080p，时长5秒。"
                            }
                        )
                        for item in generated.value.items
                    ]
                }
            ),
            metadata=generated.metadata,
        )


@pytest.mark.asyncio
async def test_strategy_router_reuses_only_hash_matching_checkpoint(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    seed_pipeline = PromptGenerationPipeline(api=FakeApi(), provider=MockAiProvider())
    seed_pipeline.register_snapshot(runtime, snapshot)
    application = await seed_pipeline.map_insight(runtime)
    shared_prompt = await seed_pipeline.compile_shared_prompt(runtime)
    allocations = await seed_pipeline.allocate_strategy_facts(runtime, application)
    allocation = allocations[FragmentType.HOOK]
    plan = (
        await MockAiProvider().plan_fragment_strategy(
            allocation,
            application=application,
            shared_prompt=shared_prompt,
        )
    ).value
    checkpoint = StrategyCheckpoint(
        node_id="PLAN_HOOK_STRATEGY",
        source_fingerprint=runtime.source_fingerprint,
        allocation_hash=allocation.allocation_hash,
        prompt_version=FRAGMENT_STRATEGY_VERSION,
        plan=plan,
    )

    pipeline = PromptGenerationPipeline(api=FakeApi(), provider=MockAiProvider())
    pipeline.register_snapshot(runtime, snapshot, strategy_checkpoints=[checkpoint])
    application = await pipeline.map_insight(runtime)
    await pipeline.compile_shared_prompt(runtime)
    allocations = await pipeline.allocate_strategy_facts(runtime, application)
    reusable = await pipeline.prepare_strategy_router(runtime, allocations)
    assert len(reusable) == 1
    assert reusable[0].fragment_type == FragmentType.HOOK
    assert reusable[0].reused_checkpoint is True

    invalid_pipeline = PromptGenerationPipeline(api=FakeApi(), provider=MockAiProvider())
    invalid_pipeline.register_snapshot(
        runtime,
        snapshot,
        strategy_checkpoints=[checkpoint.model_copy(update={"allocation_hash": "0" * 64})],
    )
    invalid_application = await invalid_pipeline.map_insight(runtime)
    await invalid_pipeline.compile_shared_prompt(runtime)
    invalid_allocations = await invalid_pipeline.allocate_strategy_facts(
        runtime, invalid_application
    )
    assert (
        await invalid_pipeline.prepare_strategy_router(runtime, invalid_allocations)
    ) == []


@pytest.mark.asyncio
async def test_render_metadata_does_not_discard_otherwise_valid_candidates(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    api = FakeApi()
    pipeline = PromptGenerationPipeline(
        api=api, provider=TechnicalMetadataProvider(), shard_size=8
    )
    pipeline.register_snapshot(runtime, snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
        config={"max_concurrency": 3},
    )

    assert api.result is not None
    assert api.result.quality_status == "PASS"
    assert len(api.result.items) == snapshot.settings.target_count
    assert api.result.metrics.fallback_count == 0
    actual_by_type = {
        fragment_type: sum(
            item.fragment_type == fragment_type for item in api.result.items
        )
        for fragment_type in FragmentType
    }
    assert actual_by_type == {
        fragment_type: snapshot.settings.fragment_configs[fragment_type].count
        for fragment_type in FragmentType
    }
    visible_content = "\n".join(item.content for item in api.result.items)
    assert "9:16" in visible_content
    assert "1080p" in visible_content.lower()
    assert "5秒" in visible_content


@pytest.mark.asyncio
async def test_mock_graph_runs_send_shards_and_completes(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    snapshot = snapshot.model_copy(
        update={
            "settings": snapshot.settings.model_copy(
                update={
                    "fragment_configs": {
                        FragmentType.HOOK: FragmentConfig(count=10, duration_seconds=5),
                        FragmentType.PAIN: FragmentConfig(count=8, duration_seconds=5),
                        FragmentType.PRODUCT_DISPLAY: FragmentConfig(
                            count=12, duration_seconds=5
                        ),
                        FragmentType.SELLING_POINT_EXPLANATION: FragmentConfig(
                            count=10, duration_seconds=5
                        ),
                        FragmentType.CTA: FragmentConfig(count=6, duration_seconds=5),
                        FragmentType.OUTRO: FragmentConfig(count=4, duration_seconds=5),
                    }
                }
            ),
            "insight_artifact": snapshot.insight_artifact.model_copy(
                update={
                    "result": {
                        **snapshot.insight_artifact.result,
                        "productName": "广式腊肠",
                        "productCategory": "广式腊味",
                        "coreSpecification": "袋装",
                        "priceRange": "需确认",
                        "visualFeatures": "红润油亮切面",
                        "coreSellingPoints": [
                            "纯猪肉无淀粉",
                            "广式风味",
                            "广府糖酒腌制工艺",
                        ],
                        "secondarySellingPoints": ["便于切配"],
                        "trustBackings": ["非遗工艺说明"],
                        "targetAudience": "25-45岁家庭厨房决策者",
                        "corePainPoints": ["年货腊味难选", "担心口感和配料不合适"],
                        "decisionDrivers": ["真实切面", "家庭烹饪适配"],
                        "marketingGoal": "引导了解广式腊肠",
                        "usageScenarios": ["煲仔饭烹饪", "蒸制", "年节家宴"],
                        "purchaseScenarios": ["年货选购"],
                        "emotionalScenarios": ["家庭团聚"],
                        "aspectRatio": "3:4",
                        "disabledElements": ["夸大功效", " 夸大功效 ", "医疗暗示"],
                    }
                }
            ),
        }
    )
    api = FakeApi()
    pipeline = PromptGenerationPipeline(
        api=api, provider=MockAiProvider(), shard_size=8
    )
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
    assert api.result.metrics.insight_coverage.missing == []
    required_ids = {
        fact.fact_id for fact in api.result.metrics.insight_coverage.required
    }
    covered_ids = {fact.fact_id for fact in api.result.metrics.insight_coverage.covered}
    assert required_ids <= covered_ids
    assert any(
        fact.field.value == "PRICE_RANGE" and fact.reason == "UNCERTAIN"
        for fact in api.result.metrics.insight_coverage.excluded
    )
    assert "需确认" not in "\n".join(item.content for item in api.result.items)
    assert api.result.render_profile.shared_constraints.disabled_elements == [
        "夸大功效",
        "医疗暗示",
    ]
    assert (
        api.result.shared_prompt.compiled_content
        == "画面中不得出现以下内容：夸大功效；医疗暗示。"
    )
    assert all(
        api.result.shared_prompt.compiled_content not in item.content
        for item in api.result.items
    )
    assert len(api.result.render_profile.shared_constraints.content_hash) == 64
    assert all(uuid.UUID(item.id).version == 4 for item in api.result.items)
    assert all(shard.status.value == "SUCCEEDED" for shard in api.shards.values())
    # 初始九个同类型分片之外，允许按质量缺口定向补齐；真实信息卡中的
    # 三个抽象卖点会触发补齐，但必须在三轮上限内收敛为 PASS。
    assert len(api.shards) >= 9
    assert max(shard.round for shard in api.shards.values()) <= 3
    assert all(
        len({item.fragment_type for item in shard.combination_plan}) == 1
        for shard in api.shards.values()
    )
    stage_ids = {stage.node_id.value for stage in api.stages}
    assert "SHARED_PROMPT_COMPILATION" in stage_ids
    assert "GLOBAL_FACT_ALLOCATION" in stage_ids
    assert "STRATEGY_FRAGMENT_ROUTER" in stage_ids
    assert "STRATEGY_MERGE_VALIDATION" in stage_ids
    assert {
        "PLAN_HOOK_STRATEGY",
        "PLAN_PAIN_STRATEGY",
        "PLAN_PRODUCT_DISPLAY_STRATEGY",
        "PLAN_SELLING_POINT_EXPLANATION_STRATEGY",
        "PLAN_CTA_STRATEGY",
        "PLAN_OUTRO_STRATEGY",
    } <= stage_ids
    assert "FRAGMENT_TYPE_ROUTER" in stage_ids
    assert {
        f"GENERATE_{fragment_type.value}" for fragment_type in FragmentType
    } <= stage_ids


@pytest.mark.asyncio
async def test_shared_prompt_keeps_editable_section_when_disabled_elements_are_empty(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    snapshot = snapshot.model_copy(
        update={
            "insight_artifact": snapshot.insight_artifact.model_copy(
                update={
                    "result": {
                        **snapshot.insight_artifact.result,
                        "disabledElements": [],
                    }
                }
            )
        }
    )
    api = FakeApi()
    pipeline = PromptGenerationPipeline(
        api=api, provider=MockAiProvider(), shard_size=8
    )
    pipeline.register_snapshot(runtime, snapshot)

    prompt = await pipeline.compile_shared_prompt(runtime)

    assert prompt.compiled_content == ""
    assert [section.key for section in prompt.sections] == [
        "DISABLED_ELEMENTS",
        "USER_ADDITIONAL",
    ]
    assert api.stages[-1].node_id.value == "SHARED_PROMPT_COMPILATION"
    metadata = api.stages[-1].metadata
    assert {
        key: metadata[key]
        for key in (
            "disabledElementCount",
            "sectionCount",
            "sharedPromptGenerated",
            "hasUserAdditionalContent",
        )
    } == {
        "disabledElementCount": 0,
        "sectionCount": 2,
        "sharedPromptGenerated": False,
        "hasUserAdditionalContent": False,
    }
    assert metadata["compiledContent"] == ""
    assert [section["source"] for section in metadata["sections"]] == [
        "SYSTEM",
        "USER",
    ]


@pytest.mark.asyncio
async def test_shared_prompt_preserves_user_additional_content_for_regeneration(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    additional = "保持产品外观前后一致。"
    previous = SharedPrompt(
        sections=[
            SharedPromptSection(
                key="DISABLED_ELEMENTS",
                title="禁用元素",
                source="SYSTEM",
                content="",
                editable=False,
                source_hash="1" * 64,
            ),
            SharedPromptSection(
                key="USER_ADDITIONAL",
                title="补充共用内容",
                source="USER",
                content=additional,
                editable=True,
                source_hash=hashlib.sha256(additional.encode()).hexdigest(),
            ),
        ],
        compiled_content=additional,
        content_hash=hashlib.sha256(additional.encode()).hexdigest(),
    )
    snapshot = snapshot.model_copy(update={"shared_prompt": previous})
    api = FakeApi()
    pipeline = PromptGenerationPipeline(
        api=api, provider=MockAiProvider(), shard_size=8
    )
    pipeline.register_snapshot(runtime, snapshot)

    compiled = await pipeline.compile_shared_prompt(runtime)

    assert compiled.sections[-1].content == additional
    assert compiled.compiled_content.endswith(additional)
    assert api.stages[-1].metadata["hasUserAdditionalContent"] is True


@pytest.mark.asyncio
async def test_load_reuses_succeeded_shards(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    api = FakeApi()
    pipeline = PromptGenerationPipeline(
        api=api, provider=MockAiProvider(), shard_size=8
    )
    pipeline.register_snapshot(runtime, snapshot)
    first = await pipeline.load_and_snapshot(runtime)
    application = await pipeline.map_insight(runtime)
    await pipeline.compile_shared_prompt(runtime)
    strategy = await pipeline.plan_strategy(
        runtime, application=application, target_count=10
    )
    shards = await pipeline.plan_round(
        runtime,
        strategy=strategy,
        application=application,
        round_number=0,
        missing_count=10,
        ordinal_start=1,
        completed_keys=[],
    )
    candidates = await pipeline.generate_shard(runtime, shards[0])
    saved = api.shards["0:0"]
    api.shards["0:0"] = saved.model_copy(
        update={
            "combination_plan": [
                item.model_copy(update={"planning_version": "v10-coordinate-blueprint"})
                for item in saved.combination_plan
            ]
        }
    )
    second = await pipeline.load_and_snapshot(runtime)

    assert first.candidates == []
    assert second.candidates == candidates
    assert second.completed_shard_keys == ["0:0"]


@pytest.mark.asyncio
async def test_load_rejects_succeeded_legacy_planning_shard(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    api = FakeApi()
    pipeline = PromptGenerationPipeline(
        api=api, provider=MockAiProvider(), shard_size=8
    )
    pipeline.register_snapshot(runtime, snapshot)
    application = await pipeline.map_insight(runtime)
    await pipeline.compile_shared_prompt(runtime)
    strategy = await pipeline.plan_strategy(
        runtime, application=application, target_count=10
    )
    shards = await pipeline.plan_round(
        runtime,
        strategy=strategy,
        application=application,
        round_number=0,
        missing_count=10,
        ordinal_start=1,
        completed_keys=[],
    )
    await pipeline.generate_shard(runtime, shards[0])
    saved = api.shards["0:0"]
    api.shards["0:0"] = saved.model_copy(
        update={
            "combination_plan": [
                item.model_copy(update={"planning_version": "legacy"})
                for item in saved.combination_plan
            ]
        }
    )

    with pytest.raises(PipelineError, match="生成规则已升级"):
        await pipeline.load_and_snapshot(runtime)


@pytest.mark.asyncio
async def test_item_regeneration_returns_only_one_replacement_candidate(
    snapshot: PromptGenerationSnapshot, runtime: RuntimeContext
) -> None:
    first_api = FakeApi()
    first_pipeline = PromptGenerationPipeline(
        api=first_api, provider=MockAiProvider(), shard_size=8
    )
    first_pipeline.register_snapshot(runtime, snapshot)
    await build_graph(first_pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
        config={"max_concurrency": 3},
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
    pipeline = PromptGenerationPipeline(
        api=api, provider=MockAiProvider(), shard_size=8
    )
    pipeline.register_snapshot(runtime, snapshot)
    application = await pipeline.map_insight(runtime)
    strategy = await pipeline.plan_strategy(
        runtime, application=application, target_count=10
    )
    missing_fact = next(
        fact for fact in application.required if fact.value == "轻量便携"
    )
    shards = await pipeline.plan_round(
        runtime,
        strategy=strategy,
        application=application,
        round_number=0,
        missing_count=1,
        ordinal_start=1,
        completed_keys=[],
        priority_fact_ids=[missing_fact.fact_id],
    )

    prioritized = [
        combination
        for shard in shards
        for combination in shard.combinations
        if missing_fact.fact_id
        in {binding.fact_id for binding in combination.insight_bindings}
    ]
    assert prioritized
    assert prioritized[0].dimensions.selling_point == "轻量便携"
    pipeline.unregister(runtime)
    with pytest.raises(Exception, match="not registered"):
        pipeline.snapshot(runtime)
