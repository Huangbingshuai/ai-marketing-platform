from __future__ import annotations

from collections import Counter
from dataclasses import replace
from typing import Any

import pytest

from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDimensions,
    CreativeEvaluation,
    CreativeScores,
    FactEvidence,
    FragmentType,
    ProgressPayload,
    PromptBatchResultV6,
    PromptBatchSettingsV6,
    PromptGenerationSnapshot,
    PromptItemV6,
    RuntimeContext,
    ShardRecord,
    StageOutput,
)
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import MockAiProvider
from effect_prompt_generation.quality import (
    select_creatives,
    validate_creative_evaluation,
)


class V11Api:
    def __init__(self) -> None:
        self.stages: list[StageOutput] = []
        self.shards: dict[str, ShardRecord] = {}
        self.result: PromptBatchResultV6 | None = None
        self.execution_mode: str | None = None

    async def put_stage(self, context: RuntimeContext, output: StageOutput) -> None:
        del context
        self.stages.append(output)

    async def put_shard(self, context: RuntimeContext, shard: ShardRecord) -> None:
        del context
        self.shards[shard.key] = shard

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
        self.result = PromptBatchResultV6.model_validate(result)
        self.execution_mode = execution_mode
        return "prompt-result-v11"

    async def fail(self, context: RuntimeContext, payload: Any) -> None:
        del context, payload


class FirstRoundRejectingProvider(MockAiProvider):
    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        application: Any,
    ) -> Any:
        call = await super().evaluate_creatives(candidates, application=application)
        items = [
            item.model_copy(update={"hard_issues": ["TEST_FIRST_ROUND_REJECTION"]})
            if candidate.round == 0 and candidate.ordinal <= 3
            else item
            for candidate, item in zip(candidates, call.value.items, strict=True)
        ]
        return replace(call, value=call.value.model_copy(update={"items": items}))


def _snapshot() -> PromptGenerationSnapshot:
    return PromptGenerationSnapshot(
        schema_version=6,
        graph_version="V11_COHERENT_CREATIVE_GENERATION",
        project_id="project-v11",
        workflow_run_id="workflow-v11",
        product_id="sausage",
        operation="BATCH_GENERATE",
        settings=PromptBatchSettingsV6(
            target_count=10,
            default_duration_seconds=5,
        ),
        insight_artifact={
            "id": "insight-v11",
            "revision": 1,
            "contentHash": "sha256:sausage",
            "result": {
                "productName": "广式腊肠",
                "productCategory": "中式腊味",
                "visualFeatures": ["油润红亮切面"],
                "coreSellingPoints": ["广式甜咸风味", "蒸熟后油润有光泽"],
                "corePainPoints": ["普通腊味口感偏干"],
                "decisionDrivers": ["年节家宴方便摆盘"],
                "usageScenarios": ["家庭蒸制", "年夜饭摆盘"],
                "aspectRatio": "9:16",
                "disabledElements": ["虚构医疗功效"],
            },
        },
    )


def _runtime() -> RuntimeContext:
    return RuntimeContext(
        run_id="run-v11",
        project_id="project-v11",
        workflow_run_id="workflow-v11",
        product_id="sausage",
        request_id="request-v11",
        attempt_token="attempt-v11",
        source_fingerprint="source-v11",
    )


@pytest.mark.asyncio
async def test_v11_graph_generates_120_percent_then_selects_exact_count() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    result = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert result["prompt_result_id"] == "prompt-result-v11"
    assert api.result is not None
    assert api.result.schema_version == 6
    assert api.result.metrics.candidate_target_count == 12
    assert api.result.metrics.generated_candidate_count == 12
    assert len(api.result.items) == 10
    assert api.result.quality_status == "PASS"
    assert api.execution_mode == "MOCK"
    assert all(item.target_duration_seconds == 5 for item in api.result.items)
    assert all(item.fragment_type == item.primary_purpose for item in api.result.items)
    assert all(item.primary_purpose in item.compatible_purposes for item in api.result.items)
    assert all("广式腊肠" in item.content for item in api.result.items)
    assert all("虚构医疗功效" not in item.content for item in api.result.items)
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CREATIVE": 3,
        "CLASSIFICATION": 2,
    }


@pytest.mark.asyncio
async def test_v11_item_evaluate_preserves_content_and_only_runs_classification() -> None:
    snapshot = _snapshot()
    now = "2026-08-27T10:00:00Z"
    target = PromptItemV6(
        id="manual-prompt-1",
        code="P004",
        origin="MANUAL",
        fragment_type=FragmentType.PRODUCT_DISPLAY,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        classification_status="PENDING",
        product_relevance=0,
        material_tags=["待重新评估"],
        target_duration_seconds=5,
        dimensions=CreativeDimensions(
            narrative="从成品摆盘推进到切面细节",
            scene="节日家宴餐桌",
            persona="仅一双成年人手部",
            product_relation="广式腊肠油润红亮切面",
            camera="近景缓慢横移",
            emotion="温暖真实",
        ),
        content="节日家宴餐桌上，一双成年人手部夹起广式腊肠，近景清楚呈现油润红亮切面。",
        insight_bindings=[],
        manual_edited=True,
        created_at=now,
        updated_at=now,
    )
    item_snapshot = snapshot.model_copy(
        update={
            "operation": "ITEM_EVALUATE",
            "target_item_id": target.id,
            "target_item": target,
            "target_item_index": 3,
            "replacement_dimensions": target.dimensions,
        }
    )
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, item_snapshot)

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert len(api.result.items) == 1
    assert api.result.items[0].content == target.content
    assert api.result.items[0].classification_status == "VERIFIED"
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CLASSIFICATION": 1
    }
    assert not any(
        stage.node_id.value == "COHERENT_CREATIVE_GENERATION"
        for stage in api.stages
    )
    assert any(stage.node_id.value == "ITEM_EVALUATE" for stage in api.stages)


@pytest.mark.asyncio
async def test_v11_runs_only_one_supplement_round_for_quality_shortage() -> None:
    api = V11Api()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=FirstRoundRejectingProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert api.result.quality_status == "PASS"
    assert len(api.result.items) == 10
    assert api.result.metrics.candidate_target_count == 12
    assert api.result.metrics.generated_candidate_count == 14
    assert api.result.metrics.replenishment_rounds == 1
    assert Counter(item.phase.value for item in api.shards.values()) == {
        "CREATIVE": 4,
        "CLASSIFICATION": 3,
    }


def test_v11_evaluation_requires_real_text_evidence() -> None:
    application = map_insight(
        {"productName": "广式腊肠", "coreSellingPoints": ["油润红亮切面"]}
    )
    fact = next(item for item in application.usable if item.value == "广式腊肠")
    candidate = CreativeCandidate(
        slot_id="candidate-1",
        ordinal=1,
        round=0,
        creative_core="通用遮挡悬念",
        declared_fact_ids=[fact.fact_id],
        dimensions=CreativeDimensions(
            narrative="遮挡后停住",
            scene="午后书桌",
            persona="成年女性侧身",
            product_relation="没有产品进入画面",
            camera="中景固定",
            emotion="悬念",
        ),
        content="午后书桌前，成年女性缓慢移开一小部分遮挡物，然后停住观察。",
    )
    evaluation = CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.HOOK,
        compatible_purposes=[FragmentType.HOOK],
        fact_evidence=[FactEvidence(fact_id=fact.fact_id, evidence_text="广式腊肠")],
        realized_fact_ids=[fact.fact_id],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=80,
            visual_clarity=90,
        ),
        semantic_signature="ignored",
        visual_signature="ignored",
    )

    validated = validate_creative_evaluation(candidate, evaluation, application)

    assert "FACT_EVIDENCE_NOT_IN_CONTENT" in validated.hard_issues
    assert "MISSING_PRODUCT_RELATION" in validated.hard_issues


def test_v11_selection_uses_quality_80_and_novelty_20() -> None:
    def candidate(index: int, scene: str) -> CreativeCandidate:
        return CreativeCandidate(
            slot_id=f"c-{index}",
            ordinal=index,
            round=0,
            creative_core=f"创意{index}",
            declared_fact_ids=["fact-product"],
            dimensions=CreativeDimensions(
                narrative=f"叙事{index}",
                scene=scene,
                persona="成年人手部",
                product_relation="广式腊肠切面",
                camera="微距轻推",
                emotion="温暖",
            ),
            content=f"{scene}里展示广式腊肠切面并完成连续摆盘动作，镜头稳定停留。",
        )

    candidates = [candidate(1, "厨房"), candidate(2, "厨房"), candidate(3, "家宴餐桌")]

    def evaluation(item: CreativeCandidate, quality: float) -> CreativeEvaluation:
        return CreativeEvaluation(
            slot_id=item.slot_id,
            primary_purpose=FragmentType.PRODUCT_DISPLAY,
            compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
            fact_evidence=[],
            realized_fact_ids=[],
            scores=CreativeScores(
                product_relevance=quality,
                creative_coherence=quality,
                visual_executability=quality,
                commercial_usefulness=quality,
                visual_clarity=quality,
            ),
            semantic_signature=f"s-{item.ordinal}",
            visual_signature=f"v-{item.ordinal}",
        )

    result = select_creatives(
        candidates,
        [evaluation(candidates[0], 95), evaluation(candidates[1], 94), evaluation(candidates[2], 85)],
        target_count=2,
    )

    assert [item.candidate.slot_id for item in result.selected] == ["c-1", "c-3"]
    assert result.selected[1].novelty_score > 0
