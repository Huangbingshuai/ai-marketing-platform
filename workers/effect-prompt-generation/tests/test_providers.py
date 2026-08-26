from __future__ import annotations

import json

import httpx
import pytest
from effect_prompt_generation.assembly import assemble_fragment_prompt
from effect_prompt_generation.combinations import make_shards, plan_combinations
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    EvidenceMode,
    FragmentType,
    PlannedCombination,
    PromptDimensions,
)
from effect_prompt_generation.providers import (
    ArkResponsesProvider,
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)


@pytest.mark.asyncio
async def test_ark_strategy_uses_strict_schema_and_fills_missing_evidence_safely() -> (
    None
):
    seen: dict[str, object] = {}
    application = map_insight(
        {
            "productName": "便携杯",
            "productCategory": "随行杯",
            "coreSpecification": "轻量杯身",
            "visualFeatures": "浅蓝色圆柱杯身",
            "coreSellingPoints": ["已确认卖点"],
            "secondarySellingPoints": ["次要卖点"],
            "targetAudience": "通勤人群",
            "corePainPoints": ["双手被占用"],
            "decisionDrivers": ["单手操作"],
            "marketingGoal": "引导了解",
            "usageScenarios": ["地铁通勤"],
            "purchaseScenarios": ["通勤装备选购"],
            "emotionalScenarios": ["从容出门"],
        }
    )
    mock_plan = (
        await MockAiProvider().plan_strategy(application, target_count=50)
    ).value

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        output = mock_plan.model_dump(mode="json", by_alias=True)
        output["dimensionPools"]["evidencePlans"] = [
            output["dimensionPools"]["evidencePlans"][0],
            {
                "sellingPoint": "模型擅自增加的卖点",
                "evidenceMode": "VISIBLE_RESULT",
                "allowedVisualEvidence": "夸张效果画面",
                "forbiddenInference": "无",
            },
        ]
        output["relationshipBundles"] = output["relationshipBundles"][:1]
        output["relationshipBundles"][0]["factIds"] = ["unknown-model-fact"]
        return httpx.Response(
            200, json={"output_text": json.dumps(output, ensure_ascii=False)}
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="candidate-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.plan_strategy(
            application,
            target_count=50,
        )
    finally:
        await provider.aclose()

    text_format = seen["text"]
    assert isinstance(text_format, dict)
    assert text_format["format"]["strict"] is True
    assert seen["model"] == "strategy-model"
    assert seen["max_output_tokens"] == 8192
    assert seen["reasoning"] == {"effort": "minimal"}
    assert result.value.dimension_pools.selling_points == ["已确认卖点", "次要卖点"]
    assert (
        result.value.dimension_pools.evidence_plans[1].evidence_mode
        == EvidenceMode.TEXT_ONLY
    )
    assert result.value.dimension_pools.evidence_plans[1].selling_point == "次要卖点"
    assert (
        "结构化元数据"
        in result.value.dimension_pools.evidence_plans[1].allowed_visual_evidence
    )
    covered_fact_ids = {
        fact_id
        for bundle in result.value.relationship_bundles
        for fact_id in bundle.fact_ids
    }
    covered_fragment_types = {
        fragment_type
        for bundle in result.value.relationship_bundles
        for fragment_type in bundle.eligible_fragment_types
    }
    assert {fact.fact_id for fact in application.required} <= covered_fact_ids
    assert covered_fragment_types == set(FragmentType)
    assert any(
        bundle.bundle_id.startswith("worker-coverage-")
        for bundle in result.value.relationship_bundles
    )
    assert "unknown-model-fact" not in covered_fact_ids


@pytest.mark.asyncio
async def test_ark_candidate_rejects_missing_slot() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"output_text": '{"items":[]}'})

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="candidate-model",
        max_attempts=1,
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError) as exc_info:
            await provider.generate_candidates(
                [_combination()],
                insight={"coreSellingPoints": ["单手开合"]},
            )
    finally:
        await provider.aclose()

    assert exc_info.value.error_type == ProviderErrorType.RESPONSE_INVALID


@pytest.mark.asyncio
async def test_ark_candidate_returns_only_slot_and_direct_prompt() -> None:
    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        return httpx.Response(
            200,
            json={
                "output_text": json.dumps(_prompt_batch("slot-1"), ensure_ascii=False)
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="candidate-model",
        strategy_max_output_tokens=1024,
        candidate_max_output_tokens=4096,
        reasoning_effort="minimal",
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.generate_candidates(
            [_combination()],
            insight={
                "productName": "便携杯",
                "productCategory": "随行杯",
                "visualFeatures": "浅蓝色圆柱杯身",
                "coreSellingPoints": ["单手开合"],
                "targetAudience": "通勤人群",
                "usageScenarios": ["地铁通勤"],
                "disabledElements": ["医疗功效", "促销贴纸"],
                "aspectRatio": "9:16",
                "durationSeconds": 5,
                "resolution": "1080p",
            },
            regeneration_context={
                "originalPrompt": "旧版 Prompt",
                "instruction": "产品更早出现",
                "lockedFields": {"fragmentType": "SELLING_POINT_EXPLANATION"},
            },
        )
    finally:
        await provider.aclose()

    assert seen["model"] == "candidate-model"
    assert seen["max_output_tokens"] == 1024
    assert "instructions" in seen
    assert "当前分支只生成卖点讲解所需的干净画面素材" in str(seen["instructions"])
    prompt = seen["input"][0]["content"][0]["text"]  # type: ignore[index]
    assert "便携杯" in prompt
    assert "产品更早出现" in prompt
    assert "旧版 Prompt" in prompt
    assert "浅蓝色圆柱杯身" in prompt
    assert "促销贴纸" in prompt
    assert '"aspectRatio"' not in prompt
    assert '"durationSeconds"' not in prompt
    assert '"resolution"' not in prompt
    assert not result.value.items[0].prompt_text.startswith("5秒，9:16竖屏")
    assert result.value.items[0].model_dump(by_alias=True).keys() == {
        "slotId",
        "promptText",
        "usedFactIds",
    }


@pytest.mark.asyncio
async def test_mock_translates_stacked_audience_into_executable_single_person_fragments() -> (
    None
):
    provider = MockAiProvider()
    insight = {
        "productName": "广式腊肠",
        "coreSellingPoints": ["广府糖酒腌制工艺", "切面油润可见", "便于按需切割"],
        "targetAudience": "25-45岁家庭厨房决策者，美食爱好者，年货送礼人群，全国消费者",
        "usageScenarios": ["年节家庭厨房"],
        "aspectRatio": "3:4",
    }
    application = map_insight(insight)
    strategy = (await provider.plan_strategy(application, target_count=50)).value
    combinations = plan_combinations(
        strategy,
        application,
        count=50,
        round_number=0,
        ordinal_start=1,
        fragment_targets={
            FragmentType.HOOK: 10,
            FragmentType.PAIN: 8,
            FragmentType.PRODUCT_DISPLAY: 12,
            FragmentType.SELLING_POINT_EXPLANATION: 10,
            FragmentType.CTA: 6,
            FragmentType.OUTRO: 4,
        },
        fragment_durations={fragment_type: 5 for fragment_type in FragmentType},
    )
    generated_items = []
    for shard in make_shards(combinations, round_number=0, shard_size=8):
        generated_items.extend(
            (
                await provider.generate_candidates(
                    shard.combinations,
                    insight=insight,
                )
            ).value.items
        )

    assert all(160 <= len(item.prompt_text) <= 280 for item in generated_items)
    assert all(
        forbidden not in item.prompt_text
        for item in generated_items
        for forbidden in ("字幕", "口播", "旁白", "BGM", "二维码", "价格贴纸")
    )
    assert all(len(item.insight_bindings) <= 3 for item in combinations)

    assert all(
        "家庭厨房决策者" not in bundle.persona
        for bundle in strategy.relationship_bundles
    )
    abstract = next(
        item
        for item in strategy.dimension_pools.evidence_plans
        if item.selling_point == "广府糖酒腌制工艺"
    )
    assert abstract.evidence_mode == EvidenceMode.TEXT_ONLY
    invalid: list[tuple[str, list[str]]] = []
    by_slot = {item.slot_id: item.prompt_text for item in generated_items}
    for combination in combinations:
        _, item_reasons = assemble_fragment_prompt(
            by_slot[combination.slot_id],
            combination,
            product_name="广式腊肠",
            source_facts=["广府糖酒腌制工艺", "切面油润可见", "便于按需切割"],
        )
        if item_reasons:
            invalid.append(
                (
                    combination.dimensions.camera.encode("unicode_escape").decode(),
                    item_reasons,
                )
            )
    assert invalid == []


def _combination() -> PlannedCombination:
    return PlannedCombination(
        slot_id="slot-1",
        ordinal=1,
        fragment_type=FragmentType.SELLING_POINT_EXPLANATION,
        material_tags=["卖点", "口播"],
        target_duration_seconds=5,
        visible_action="一名年轻女性用拇指按下杯盖后停住",
        evidence_mode=EvidenceMode.USAGE_ACTION,
        allowed_visual_evidence="一次单手开合动作",
        forbidden_inference="不得推导防漏或保温效果",
        dimensions=PromptDimensions(
            narrative="动作悬念",
            scene="地铁通勤",
            persona="一名穿深蓝通勤外套的年轻女性",
            selling_point="单手开合",
            camera="中近景连续推近产品",
            emotion="明亮自然光下的利落节奏",
        ),
    )


def _prompt_batch(slot_id: str) -> dict[str, object]:
    return {
        "items": [
            {
                "slotId": slot_id,
                "promptText": (
                    "地铁站入口，一名穿深蓝通勤外套的年轻女性右手握便携杯，"
                    "镜头从肩后中近景连续推近杯盖，她用拇指按下杯盖并完成一次单手开合动作，"
                    "产品始终位于画面中心。明亮自然光勾出浅蓝色杯身，节奏利落，按键声处停顿，"
                    "结尾保持杯盖打开和产品正面清楚可见，不使用切镜或额外人物。"
                ),
                "usedFactIds": [],
            }
        ]
    }
