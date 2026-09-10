from collections.abc import Sequence
from dataclasses import replace

import pytest
from pydantic import ValidationError
from test_visual_strategy import _StageApi

from effect_prompt_generation.insight_mapping import insight_coverage, map_insight
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDimensions,
    CreativeEvaluation,
    CreativeScores,
    FactVisualStrategyResponse,
    FactVisualUsage,
    FragmentType,
    InsightField,
    StrategyCheckpoint,
)
from effect_prompt_generation.pipeline import (
    PromptGenerationPipeline,
    _prompt_items,
    _silent_material_planning_inputs,
    _visually_required_business_fact_ids,
)
from effect_prompt_generation.providers import (
    FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)
from effect_prompt_generation.quality import CreativeSelectionResult, RankedCreative
from effect_prompt_generation.visual_strategy import (
    fact_visual_strategy_batches,
    validate_fact_visual_strategy,
)


@pytest.mark.parametrize(
    "product", ["紫苏梅子酱", "广式腊肠", "洁面产品", "磁吸移动电源", "旅行箱"]
)
def test_all_products_keep_full_text_without_keyword_or_fuzzy_deletion(product):
    prefix = "长事实" * 200
    points = [
        prefix + "甲",
        prefix + "乙",
        "规格待确认",
        "未知场景下便于携带",
        "ABC",
        "abc",
    ]
    app = map_insight(
        {"productName": product, "sellingPoints": points + [points[0], " "]}
    )
    actual = [f for f in app.usable if f.field == InsightField.SELLING_POINT]
    assert [f.value for f in actual] == points
    assert len({f.fact_id for f in actual}) == len(points)
    assert app.excluded == []


def test_one_hundred_selling_points_and_thousand_character_contract():
    points = [str(index).zfill(3) + "字" * 997 for index in range(100)]
    app = map_insight(
        dict(
            productName="商品",
            productCategory="品类",
            coreSpecification="规格",
            priceRange="价格",
            visualFeatures="外观",
            sellingPoints=points,
        )
    )
    assert len(app.usable) == 105
    assert [
        f.value for f in app.required if f.field == InsightField.SELLING_POINT
    ] == points
    batches = fact_visual_strategy_batches(app)
    assert [fid for batch in batches for fid in batch] == [
        f.fact_id for f in app.usable
    ]
    assert all(len(batch) <= 24 for batch in batches)
    assert all(
        sum(len(app.by_id[fid].value) for fid in batch) <= 12_000 for batch in batches
    )
    with pytest.raises(ValidationError):
        map_insight({"sellingPoints": ["字" * 1001]})


@pytest.mark.asyncio
async def test_context_is_available_but_not_forced_as_visual_proof():
    app = map_insight(
        {"productName": "通用产品", "sellingPoints": ["确认的工艺", "确认的使用动作"]}
    )
    call = await MockAiProvider().compile_fact_visual_strategy(app)
    context = next(f for f in app.usable if f.value == "确认的工艺")
    policies = [
        p.model_copy(update={"visual_usage": FactVisualUsage.FORBIDDEN_VISUAL_PROOF})
        if p.fact_id == context.fact_id
        else p
        for p in call.value.policies
    ]
    strategy = validate_fact_visual_strategy(
        FactVisualStrategyResponse(policies=policies),
        app,
        source_content_hash="source",
        template_hash=FACT_VISUAL_STRATEGY_TEMPLATE_HASH,
    )
    projected, projected_strategy = _silent_material_planning_inputs(app, strategy)
    assert projected.by_id.keys() == app.by_id.keys()
    assert projected_strategy == strategy
    assert context.fact_id in {f.fact_id for f in projected.adaptive}
    assert context.fact_id not in _visually_required_business_fact_ids(app, strategy)


class ChunkProvider(MockAiProvider):
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    async def compile_fact_visual_strategy(
        self, application, *, product_images=(), target_fact_ids: Sequence[str] = ()
    ):
        self.calls.append(tuple(target_fact_ids))
        assert (
            len(application.usable) == 101
        )  # Cross-chunk compatibility still has the full directory.
        if self.fail and len(self.calls) == 2:
            raise ProviderError(
                "test transport interruption",
                retryable=True,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        return await super().compile_fact_visual_strategy(
            application, target_fact_ids=target_fact_ids
        )


@pytest.mark.asyncio
async def test_large_strategy_recovers_only_missing_chunks(snapshot, runtime):
    snapshot.insight_artifact.result = {
        "productName": "商品",
        "sellingPoints": [f"事实 {i}" for i in range(100)],
    }
    api = _StageApi()
    broken = ChunkProvider(fail=True)
    pipeline = PromptGenerationPipeline(api=api, provider=broken)
    pipeline.register_snapshot(runtime, snapshot)
    await pipeline.map_insight(runtime)
    with pytest.raises(ProviderError):
        await pipeline.compile_fact_visual_strategy(runtime)
    checkpoint = StrategyCheckpoint.model_validate(
        next(
            stage.metadata["checkpoint"]
            for stage in reversed(api.stages)
            if "checkpoint" in stage.metadata
        )
    )
    assert len(checkpoint.plan.policies) == 24
    healthy = ChunkProvider()
    resumed = PromptGenerationPipeline(api=api, provider=healthy)
    resumed.register_snapshot(runtime, snapshot, [checkpoint])
    await resumed.map_insight(runtime)
    strategy = await resumed.compile_fact_visual_strategy(runtime)
    assert len(strategy.policies) == 101
    assert len(healthy.calls) == 4
    assert not set(healthy.calls[0]).intersection(broken.calls[0])
    assert api.stages[-1].status == "SUCCEEDED"
    assert api.stages[-1].metadata["policyCount"] == 101

    # An input/template change must not reuse the successful partial chunk.
    changed = checkpoint.model_copy(update={"template_hash": "0" * 64})
    fresh_provider = ChunkProvider()
    fresh = PromptGenerationPipeline(api=api, provider=fresh_provider)
    fresh.register_snapshot(runtime, snapshot, [changed])
    await fresh.map_insight(runtime)
    await fresh.compile_fact_visual_strategy(runtime)
    assert len(fresh_provider.calls) == 5


def test_final_result_retains_more_than_five_verified_bindings(runtime):
    app = map_insight({"sellingPoints": [f"事实 {i}" for i in range(8)]})
    ids = list(app.by_id)
    candidate = CreativeCandidate(
        slot_id="c1",
        ordinal=1,
        round=0,
        creative_core="连续事件",
        declared_fact_ids=ids,
        content="人物在明亮的室内完成一次连续产品使用动作，镜头观察接触区域的真实变化。",
        dimensions=CreativeDimensions(
            narrative="使用展示",
            scene="场景",
            persona="人物",
            product_relation="使用价值",
            camera="镜头",
            emotion="自然",
        ),
    )
    evaluation = CreativeEvaluation(
        slot_id="c1",
        primary_purpose=FragmentType.EFFECT,
        compatible_purposes=[FragmentType.EFFECT],
        realized_fact_ids=ids,
        fact_evidence=[{"factId": fid, "supportLevel": "SEMANTIC_FULL"} for fid in ids],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=90,
            visual_clarity=90,
        ),
        semantic_signature="semantic",
        visual_signature="visual",
    )
    selection = CreativeSelectionResult(
        [RankedCreative(candidate, evaluation, 90, 90, 90)], [], 0
    )
    items = _prompt_items(runtime, selection, app, 15, fact_visual_strategy=None)
    assert len(items[0].insight_bindings) == 8
    coverage = insight_coverage(app, items, required_fact_ids=ids)
    assert len(coverage.covered) == 8 and not coverage.missing


class ContextOnlyProvider(MockAiProvider):
    async def compile_fact_visual_strategy(self, application, **kwargs):
        call = await super().compile_fact_visual_strategy(application, **kwargs)
        policies = [
            p.model_copy(update={"visual_usage": FactVisualUsage.CONTEXT_ONLY})
            if application.by_id[p.fact_id].field == InsightField.SELLING_POINT
            else p
            for p in call.value.policies
        ]
        return replace(call, value=FactVisualStrategyResponse(policies=policies))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fact_count,context_only", [(1, False), (100, False), (1, True)]
)
async def test_planning_handles_sparse_dense_and_background_facts(
    snapshot, runtime, fact_count, context_only
):
    from test_creatives import PromptApi

    snapshot.insight_artifact.result = {
        "productName": "通用商品",
        "productCategory": "消费品",
        "sellingPoints": [f"已确认使用价值 {index}" for index in range(fact_count)],
    }
    snapshot.settings.target_count = 5
    pipeline = PromptGenerationPipeline(
        api=PromptApi(),
        provider=ContextOnlyProvider() if context_only else MockAiProvider(),
    )
    pipeline.register_snapshot(runtime, snapshot)
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    shards = await pipeline.plan_creatives(runtime, round_number=0)
    assert shards
