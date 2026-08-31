from __future__ import annotations

import json
import hashlib

import httpx
import pytest
from effect_prompt_generation.assembly import assemble_fragment_prompt
from effect_prompt_generation.combinations import make_shards, plan_combinations
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDimensionKey,
    CreativeDimensions,
    CreativeDirection,
    CreativeFactAssignment,
    CreativeDirectionResponse,
    CreativeSemanticProfile,
    CreativeShardPlan,
    CreativeTask,
    FactVisualUsage,
    EvidenceMode,
    FragmentType,
    InsightBinding,
    InsightBindingRole,
    InsightField,
    PlannedCombination,
    PromptDimensions,
    SharedPrompt,
    SharedPromptSection,
)
from effect_prompt_generation.providers import (
    ArkResponsesProvider,
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
    _temporal_intent_for_duration,
)
from effect_prompt_generation.providers import _mock_fact_visual_strategy
from effect_prompt_generation.v11_visual_strategy import validate_fact_visual_strategy


def _shared_prompt() -> SharedPrompt:
    disabled_content = "画面中不得出现以下内容：医疗功效；促销贴纸。"
    additional_content = "保持产品外观前后一致。"
    content = f"{disabled_content}\n{additional_content}"
    return SharedPrompt(
        sections=[
            SharedPromptSection(
                key="DISABLED_ELEMENTS",
                title="禁用元素",
                source="SYSTEM",
                content=disabled_content,
                editable=False,
                source_hash="1" * 64,
            ),
            SharedPromptSection(
                key="USER_ADDITIONAL",
                title="补充共用内容",
                source="USER",
                content=additional_content,
                editable=True,
                source_hash=hashlib.sha256(additional_content.encode()).hexdigest(),
            ),
        ],
        compiled_content=content,
        content_hash=hashlib.sha256(content.encode()).hexdigest(),
    )


@pytest.mark.asyncio
async def test_ark_plans_compact_batch_creative_directions() -> None:
    application = map_insight(
        {
            "productName": "广式腊肠",
            "visualFeatures": ["蒸熟后表面油润"],
            "coreSellingPoints": ["广式甜咸风味"],
            "usageScenarios": ["家庭蒸制", "年夜饭摆盘"],
            "visualStyleBaseline": "烟火食欲感",
        }
    )
    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="insight",
        prompt_version="test",
    )
    seen: dict[str, object] = {}
    seen_timeout: dict[str, float] = {}
    fact_ids = [item.fact_id for item in application.usable]

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        seen_timeout.update(request.extensions["timeout"])
        rows = []
        for index in range(8):
            rows.append(
                {
                    "directionId": f"d-{index + 1}",
                    "compatibleFactIds": fact_ids,
                    "creativeDirection": f"第{index + 1}种真实消费创意方向",
                    "priorityDimensions": ["SCENE", "PRODUCT_RELATION"],
                    "semanticProfile": {
                        "narrativeFamily": f"叙事{index + 1}",
                        "sceneFamily": f"场景{index + 1}",
                        "personaFamily": f"人物{index + 1}",
                        "productActionFamily": f"动作{index + 1}",
                        "cameraFamily": f"镜头{index + 1}",
                        "emotionFamily": f"情绪{index + 1}",
                    },
                    "avoidFamilies": ["重复厨房切制"],
                }
            )
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(
                    {"directions": rows}, ensure_ascii=False
                ),
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="creative-model",
        fragment_strategy_model="direction-model",
        strategy_timeout=180,
        fragment_strategy_timeout=120,
        transport=httpx.MockTransport(handler),
    )
    try:
        call = await provider.plan_creative_directions(
            application,
            fact_visual_strategy=strategy,
            shared_prompt=_shared_prompt(),
            target_count=50,
        )
    finally:
        await provider.aclose()

    assert isinstance(call.value, CreativeDirectionResponse)
    assert len(call.value.directions) == 8
    assert seen["model"] == "direction-model"
    assert seen["max_output_tokens"] == 6144
    assert seen_timeout["read"] == 180
    payload_text = json.dumps(seen, ensure_ascii=False)
    prompt_text = seen["input"][0]["content"][0]["text"]  # type: ignore[index]
    assert "广式腊肠" in payload_text
    assert "视觉风格基调（仅作为整批视觉底色，不是固定场景模板）" in prompt_text
    assert '"烟火食欲感"' in prompt_text
    assert "目标 Prompt 数量：50" in payload_text
    assert "effect_prompt_v11_creative_direction_plan" in payload_text
    assert "strategyHash" not in payload_text
    assert "reusedCheckpoint" not in payload_text


@pytest.mark.asyncio
async def test_ark_v11_creative_uses_one_coherent_schema_and_shared_constraints() -> None:
    seen: dict[str, object] = {}
    application = map_insight(
        {
            "productName": "便携杯",
            "coreSellingPoints": ["单手开合"],
            "corePainPoints": ["普通杯盖需要双手操作"],
            "visualStyleBaseline": "清透冰感",
        }
    )
    product_fact = next(item for item in application.usable if item.value == "便携杯")
    primary_fact = next(item for item in application.usable if item.value == "单手开合")
    shard = CreativeShardPlan(
        round=0,
        shard_index=0,
        tasks=[
            CreativeTask(
                slot_id="creative-1",
                ordinal=1,
                round=0,
                target_duration_seconds=5,
                fact_assignment=CreativeFactAssignment(
                    primary_fact_id=primary_fact.fact_id,
                    product_anchor_fact_ids=[product_fact.fact_id],
                    assignment_hash="a" * 64,
                ),
                preferred_fact_ids=[primary_fact.fact_id],
            )
        ],
    )
    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        output = {
            "items": [
                {
                    "slotId": "creative-1",
                    "ordinal": 99,
                    "round": 1,
                    "creativeCore": "通勤途中单手打开便携杯",
                    # Product anchor F2 is intentionally omitted. The exact
                    # product name in the candidate must repair this metadata.
                    "declaredFactIds": ["F1"],
                    "dimensions": {
                        "narrative": "动作直接进入产品使用",
                        "scene": "早高峰地铁站台",
                        "persona": "单手拿包的成年通勤者",
                        "productRelation": "便携杯被单手打开",
                        "camera": "中近景跟随后轻推",
                        "emotion": "从容利落",
                    },
                    "content": "早高峰地铁站台上，成年通勤者单手打开便携杯并喝水，镜头跟随后轻推至杯盖。",
                    "generatedAt": None,
                }
            ]
        }
        return httpx.Response(
            200,
            json={"status": "completed", "output_text": json.dumps(output, ensure_ascii=False)},
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="creative-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        call = await provider.generate_creatives(
            shard,
            application=application,
            shared_prompt=_shared_prompt(),
        )
    finally:
        await provider.aclose()

    assert seen["model"] == "creative-model"
    assert seen["text"]["format"]["strict"] is True  # type: ignore[index]
    item_schema = seen["text"]["format"]["schema"]["$defs"]["CreativeCandidate"]  # type: ignore[index]
    assert "creativeCore" in item_schema["properties"]
    assert "dimensions" in item_schema["properties"]
    assert "content" in item_schema["properties"]
    assert "fragmentType" not in item_schema["properties"]
    prompt = seen["input"][0]["content"][0]["text"]  # type: ignore[index]
    assert "医疗功效" in prompt
    assert "单手开合" in prompt
    assert "便携杯" in prompt
    assert "普通杯盖需要双手操作" not in prompt
    assert "清透冰感" not in prompt
    assert primary_fact.fact_id not in prompt
    assert product_fact.fact_id not in prompt
    assert "primaryFact" in prompt
    assert "productAnchorFacts" in prompt
    assert "productBoundaryFacts" in prompt
    assert "valueHash" not in prompt
    assert "eligibleFragmentTypes" not in prompt
    assert "contentHash" not in prompt
    assert call.value.items[0].ordinal == 1
    assert call.value.items[0].round == 0
    assert call.value.items[0].declared_fact_ids == [
        primary_fact.fact_id,
        product_fact.fact_id,
    ]


@pytest.mark.asyncio
async def test_ark_compiles_visual_usage_for_every_confirmed_fact() -> None:
    application = map_insight(
        {
            "productName": "广式腊肠",
            "visualFeatures": "油润透亮的肉质质感",
            "coreSellingPoints": ["纯猪肉无淀粉"],
        }
    )
    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        policies = []
        for fact in application.usable:
            forbidden = fact.value == "纯猪肉无淀粉"
            policies.append(
                {
                    "factId": fact.fact_id,
                    "visualUsage": (
                        "FORBIDDEN_VISUAL_PROOF"
                        if forbidden
                        else "DIRECTLY_VISIBLE"
                    ),
                    "visualInstruction": "" if forbidden else "展示真实可见外观",
                    "contextInstruction": "只作商业背景" if forbidden else "",
                    "compatibleFactIds": [],
                    "forbiddenInferences": (
                        ["不得用切面证明配方"] if forbidden else []
                    ),
                }
            )
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps({"policies": policies}, ensure_ascii=False),
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="creative-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        call = await provider.compile_fact_visual_strategy(application)
    finally:
        await provider.aclose()

    assert len(call.value.policies) == len(application.usable)
    assert any(
        policy.visual_usage == FactVisualUsage.FORBIDDEN_VISUAL_PROOF
        for policy in call.value.policies
    )
    payload_text = json.dumps(seen, ensure_ascii=False)
    assert "纯猪肉无淀粉" in payload_text
    assert "effect_prompt_v11_fact_visual_strategy" in payload_text
    assert seen["max_output_tokens"] == 4096


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("declared_selector", "should_raise"),
    [
        ("anchor-only", False),
        ("primary-only", False),
        ("unassigned", True),
    ],
)
async def test_ark_v11_creative_isolates_invalid_fact_usage(
    declared_selector: str,
    should_raise: bool,
) -> None:
    application = map_insight(
        {
            "productName": "便携杯",
            "coreSellingPoints": ["单手开合"],
            "corePainPoints": ["普通杯盖需要双手操作"],
        }
    )
    product_fact = next(item for item in application.usable if item.value == "便携杯")
    primary_fact = next(item for item in application.usable if item.value == "单手开合")
    declared = {
        "anchor-only": ["F2"],
        "primary-only": ["F1"],
        "unassigned": ["F1", "F2", "F99"],
    }[declared_selector]
    shard = CreativeShardPlan(
        round=0,
        shard_index=0,
        tasks=[
            CreativeTask(
                slot_id="creative-1",
                ordinal=1,
                round=0,
                target_duration_seconds=5,
                fact_assignment=CreativeFactAssignment(
                    primary_fact_id=primary_fact.fact_id,
                    product_anchor_fact_ids=[product_fact.fact_id],
                    assignment_hash="b" * 64,
                ),
            )
        ],
    )

    async def handler(_: httpx.Request) -> httpx.Response:
        omits_product_evidence = declared_selector == "primary-only"
        content = (
            "早高峰地铁站台上，成年通勤者完成单手开合动作，镜头跟随后轻推。"
            if omits_product_evidence
            else "早高峰地铁站台上，成年通勤者单手打开便携杯并喝水，镜头跟随后轻推至杯盖。"
        )
        output = {
            "items": [
                {
                    "slotId": "creative-1",
                    "ordinal": 1,
                    "round": 0,
                    "creativeCore": (
                        "通勤途中完成单手开合动作"
                        if omits_product_evidence
                        else "通勤途中单手打开便携杯"
                    ),
                    "declaredFactIds": declared,
                    "dimensions": {
                        "narrative": "动作直接进入产品使用",
                        "scene": "早高峰地铁站台",
                        "persona": "单手拿包的成年通勤者",
                        "productRelation": (
                            "单手开合动作"
                            if omits_product_evidence
                            else "便携杯被单手打开"
                        ),
                        "camera": "中近景跟随后轻推",
                        "emotion": "从容利落",
                    },
                    "content": content,
                    "generatedAt": None,
                }
            ]
        }
        return httpx.Response(
            200,
            json={"status": "completed", "output_text": json.dumps(output, ensure_ascii=False)},
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="creative-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        if should_raise:
            with pytest.raises(ProviderError, match="outside its assigned brief"):
                await provider.generate_creatives(
                    shard,
                    application=application,
                    shared_prompt=_shared_prompt(),
                )
        else:
            call = await provider.generate_creatives(
                shard,
                application=application,
                shared_prompt=_shared_prompt(),
            )
            assert call.value.items == []
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_ark_v11_creative_recovers_omitted_anchor_declaration_from_exact_content() -> None:
    application = map_insight(
        {
            "productName": "便携杯",
            "coreSellingPoints": ["单手开合"],
        }
    )
    product_fact = next(item for item in application.usable if item.value == "便携杯")
    primary_fact = next(item for item in application.usable if item.value == "单手开合")
    shard = CreativeShardPlan(
        round=0,
        shard_index=0,
        tasks=[
            CreativeTask(
                slot_id="creative-1",
                ordinal=1,
                round=0,
                target_duration_seconds=5,
                fact_assignment=CreativeFactAssignment(
                    primary_fact_id=primary_fact.fact_id,
                    product_anchor_fact_ids=[product_fact.fact_id],
                    assignment_hash="c" * 64,
                ),
            )
        ],
    )

    async def handler(_: httpx.Request) -> httpx.Response:
        output = {
            "items": [
                {
                    "slotId": "creative-1",
                    "ordinal": 1,
                    "round": 0,
                    "creativeCore": "通勤途中单手打开便携杯",
                    "declaredFactIds": ["F1"],
                    "dimensions": {
                        "narrative": "动作直接进入产品使用",
                        "scene": "早高峰地铁站台",
                        "persona": "单手拿包的成年通勤者",
                        "productRelation": "便携杯被单手打开",
                        "camera": "中近景跟随后轻推",
                        "emotion": "从容利落",
                    },
                    "content": "早高峰地铁站台上，成年通勤者单手打开便携杯并喝水，镜头跟随后轻推至杯盖。",
                    "generatedAt": None,
                }
            ]
        }
        return httpx.Response(
            200,
            json={"status": "completed", "output_text": json.dumps(output, ensure_ascii=False)},
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="creative-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        call = await provider.generate_creatives(
            shard,
            application=application,
            shared_prompt=_shared_prompt(),
        )
    finally:
        await provider.aclose()

    assert call.value.items[0].declared_fact_ids == [
        primary_fact.fact_id,
        product_fact.fact_id,
    ]


@pytest.mark.asyncio
async def test_ark_v11_creative_recovers_omitted_visual_fact_from_exact_content() -> None:
    application = map_insight(
        {"productName": "便携杯", "coreSellingPoints": ["单手开合"]}
    )
    product_fact = next(item for item in application.usable if item.value == "便携杯")
    visual_fact = next(item for item in application.usable if item.value == "单手开合")
    shard = CreativeShardPlan(
        round=0,
        shard_index=0,
        tasks=[
            CreativeTask(
                slot_id="creative-1",
                ordinal=1,
                round=0,
                target_duration_seconds=5,
                fact_assignment=CreativeFactAssignment(
                    primary_fact_id=visual_fact.fact_id,
                    product_anchor_fact_ids=[product_fact.fact_id],
                    assignment_hash="d" * 64,
                ),
            )
        ],
    )

    async def handler(_: httpx.Request) -> httpx.Response:
        output = {
            "items": [
                {
                    "slotId": "creative-1",
                    "ordinal": 1,
                    "round": 0,
                    "declaredFactIds": ["F2"],
                    "creativeCore": "便携杯单手开合动作体验",
                    "dimensions": {
                        "narrative": "动作体验",
                        "scene": "通勤站台",
                        "persona": "成年通勤者",
                        "productRelation": "便携杯单手开合",
                        "camera": "中近景跟随",
                        "emotion": "从容",
                    },
                    "content": "成年通勤者拿起便携杯完成单手开合，镜头跟随杯盖动作。",
                    "generatedAt": None,
                }
            ]
        }
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(output, ensure_ascii=False),
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="creative-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        call = await provider.generate_creatives(
            shard,
            application=application,
            shared_prompt=_shared_prompt(),
        )
    finally:
        await provider.aclose()

    assert set(call.value.items[0].declared_fact_ids) == {
        visual_fact.fact_id,
        product_fact.fact_id,
    }


@pytest.mark.asyncio
async def test_ark_v11_multi_task_shard_uses_slot_local_fact_aliases() -> None:
    seen: dict[str, object] = {}
    application = map_insight(
        {
            "productName": "便携杯",
            "coreSellingPoints": ["单手开合", "杯身轻量方便随身携带"],
        }
    )
    product_fact = next(item for item in application.usable if item.value == "便携杯")
    first_fact = next(item for item in application.usable if item.value == "单手开合")
    second_fact = next(
        item for item in application.usable if item.value == "杯身轻量方便随身携带"
    )
    profile = CreativeSemanticProfile(
        narrative_family="动作体验",
        scene_family="通勤场景",
        persona_family="成年通勤者",
        product_action_family="手持使用",
        camera_family="中近景跟随",
        emotion_family="从容明快",
    )
    direction = CreativeDirection(
        direction_id="direction-shared",
        compatible_fact_ids=[first_fact.fact_id, second_fact.fact_id],
        creative_direction="在通勤动作中表现产品的便利使用",
        priority_dimensions=[CreativeDimensionKey.SCENE, CreativeDimensionKey.CAMERA],
        semantic_profile=profile,
        avoid_families=["静态桌面陈列"],
    )
    shard = CreativeShardPlan(
        round=0,
        shard_index=0,
        tasks=[
            CreativeTask(
                slot_id=f"creative-{index}",
                ordinal=index,
                round=0,
                target_duration_seconds=5,
                fact_assignment=CreativeFactAssignment(
                    primary_fact_id=fact.fact_id,
                    product_anchor_fact_ids=[product_fact.fact_id],
                    assignment_hash=str(index) * 64,
                ),
                creative_direction=direction,
            )
            for index, fact in enumerate((first_fact, second_fact), start=1)
        ],
    )
    cross_slot_fact_in_first_candidate = False

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        output = {
            "items": [
                {
                    "slotId": f"creative-{index}",
                    "ordinal": index,
                    "round": 0,
                    "creativeCore": f"第{index}条通勤产品动作",
                    # F1 is intentionally repeated: it must resolve per slot.
                    "declaredFactIds": ["F1", "F2"],
                    "dimensions": {
                        "narrative": profile.narrative_family,
                        "scene": profile.scene_family,
                        "persona": profile.persona_family,
                        "productRelation": profile.product_action_family,
                        "camera": profile.camera_family,
                        "emotion": profile.emotion_family,
                    },
                    "content": (
                        f"成年通勤者使用便携杯完成第{index}条连续动作，镜头跟随杯身。"
                        + (
                            "画面同时明确强调杯身轻量方便随身携带。"
                            if cross_slot_fact_in_first_candidate and index == 1
                            else ""
                        )
                    ),
                    "generatedAt": None,
                }
                for index in (1, 2)
            ]
        }
        return httpx.Response(
            200,
            json={"status": "completed", "output_text": json.dumps(output, ensure_ascii=False)},
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="creative-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        call = await provider.generate_creatives(
            shard,
            application=application,
            shared_prompt=_shared_prompt(),
        )
    finally:
        await provider.aclose()

    prompt = seen["input"][0]["content"][0]["text"]  # type: ignore[index]
    assert "compatibleFactIds" not in prompt
    assert first_fact.fact_id not in prompt
    assert second_fact.fact_id not in prompt
    assert product_fact.fact_id not in prompt
    assert prompt.count('"factId": "F1"') == 2
    assert [item.declared_fact_ids for item in call.value.items] == [
        [first_fact.fact_id, product_fact.fact_id],
        [second_fact.fact_id, product_fact.fact_id],
    ]

    cross_slot_fact_in_first_candidate = True
    rejecting_provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="creative-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError, match="unassigned confirmed fact"):
            await rejecting_provider.generate_creatives(
                shard,
                application=application,
                shared_prompt=_shared_prompt(),
            )
    finally:
        await rejecting_provider.aclose()


@pytest.mark.asyncio
async def test_ark_v11_evaluation_reserves_reasoning_room_for_five_items() -> None:
    seen: dict[str, object] = {}
    application = map_insight(
        {"productName": "便携杯", "visualStyleBaseline": "极简商务"}
    )
    product_fact = next(item for item in application.usable if item.value == "便携杯")
    candidates = [
        CreativeCandidate(
            slot_id=f"creative-{index}",
            ordinal=index,
            round=0,
            creative_core="通勤途中展示便携杯",
            declared_fact_ids=[product_fact.fact_id],
            dimensions=CreativeDimensions(
                narrative="动作展示",
                scene="地铁站台",
                persona="成年通勤者",
                product_relation="便携杯作为画面主体",
                camera="中近景轻推",
                emotion="从容",
            ),
            content=f"地铁站台上，成年通勤者拿起便携杯喝水，镜头轻推至杯身细节，编号{index}。",
        )
        for index in range(1, 6)
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        output = {
            "items": [
                {
                    "slotId": item.slot_id,
                    "primaryPurpose": "PRODUCT_DISPLAY",
                    "compatiblePurposes": ["PRODUCT_DISPLAY"],
                    "factEvidence": [
                        {"factId": product_fact.fact_id, "evidenceText": "便携杯"}
                    ],
                    "realizedFactIds": [product_fact.fact_id],
                    "scores": {
                        "productRelevance": 95,
                        "creativeCoherence": 90,
                        "visualExecutability": 90,
                        "commercialUsefulness": 85,
                        "visualClarity": 90,
                    },
                    "semanticSignature": f"semantic-{item.ordinal}",
                    "visualSignature": f"visual-{item.ordinal}",
                    "hardIssues": [],
                    "warnings": [],
                }
                for item in candidates
            ]
        }
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(output, ensure_ascii=False),
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="creative-model",
        evaluation_max_output_tokens=4096,
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.evaluate_creatives(
            candidates,
            target_durations={item.slot_id: 30 for item in candidates},
            application=application,
        )
    finally:
        await provider.aclose()

    assert seen["max_output_tokens"] == 3600
    assert len(result.value.items) == 5
    prompt_text = seen["input"][0]["content"][0]["text"]
    assert prompt_text.count('"targetDurationSeconds": 30') == 5
    assert "极简商务" not in prompt_text


@pytest.mark.parametrize(
    ("duration_seconds", "expected_band"),
    [
        (4, "SHORT_FOCUS"),
        (5, "SHORT_FOCUS"),
        (8, "SHORT_FOCUS"),
        (9, "COMPLETE_ACTION"),
        (15, "COMPLETE_ACTION"),
        (16, "GRADUAL_PROCESS"),
        (22, "GRADUAL_PROCESS"),
        (23, "CONNECTED_PHASES"),
        (30, "CONNECTED_PHASES"),
    ],
)
def test_v11_temporal_intent_uses_soft_duration_bands(
    duration_seconds: int,
    expected_band: str,
) -> None:
    intent = _temporal_intent_for_duration(duration_seconds)

    assert intent["band"] == expected_band
    assert "动作数" not in intent["guidance"]
    assert "镜头数" not in intent["guidance"]
    if expected_band == "SHORT_FOCUS":
        assert "一个可立即看懂的视觉事件" in intent["guidance"]
        assert "第二阶段" in intent["guidance"]


@pytest.mark.asyncio
async def test_ark_strategy_uses_compact_schema_and_worker_expands_safely() -> None:
    seen: dict[str, object] = {}
    seen_timeout: dict[str, float] = {}
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
    full_plan = (
        await MockAiProvider().plan_strategy(application, target_count=50)
    ).value

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        seen_timeout.update(request.extensions["timeout"])
        compact_bundles = [
            {
                "bundleId": bundle.bundle_id,
                "fragmentType": bundle.eligible_fragment_types[0].value,
                "factIds": bundle.fact_ids[:8],
            }
            for bundle in full_plan.relationship_bundles[:8]
        ]
        compact_bundles[0]["factIds"] = ["unknown-model-fact"]
        output = {"relationshipBundles": compact_bundles}
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(output, ensure_ascii=False),
                "usage": {
                    "input_tokens": 900,
                    "output_tokens": 700,
                    "total_tokens": 1600,
                },
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="candidate-model",
        strategy_timeout=234,
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
    assert seen_timeout["read"] == 234
    schema = text_format["format"]["schema"]
    assert set(schema["properties"]) == {"relationshipBundles"}
    prompt = seen["input"][0]["content"][0]["text"]  # type: ignore[index]
    assert "fragmentStrategyPools" not in prompt
    assert "dimensionPools" not in prompt
    assert result.value.dimension_pools.selling_points == ["已确认卖点", "次要卖点"]
    assert (
        result.value.dimension_pools.evidence_plans[0].evidence_mode
        == EvidenceMode.TEXT_ONLY
    )
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
    assert all(
        forbidden not in bundle.persona
        for bundle in result.value.relationship_bundles
        for forbidden in ("消费者", "人群", "爱好者", "家庭厨房决策者")
    )
    assert "unknown-model-fact" not in covered_fact_ids
    assert (result.metadata.model_relationship_bundle_count or 0) >= 1
    assert (result.metadata.worker_completed_relationship_bundle_count or 0) >= 1


@pytest.mark.asyncio
@pytest.mark.parametrize("incomplete_reason", ["max_output_tokens", "length"])
async def test_ark_output_limit_is_non_retryable_without_provider_retry(
    incomplete_reason: str,
) -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "status": "incomplete",
                "incomplete_details": {"reason": incomplete_reason},
                "output_text": '{"relationshipBundles":[{"bundleId":"cut',
                "usage": {
                    "input_tokens": 800,
                    "output_tokens": 8192,
                    "total_tokens": 8992,
                },
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="candidate-model",
        max_attempts=3,
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError) as exc_info:
            await provider.plan_strategy(
                map_insight(
                    {
                        "productName": "便携杯",
                        "coreSellingPoints": ["单手开合"],
                        "corePainPoints": ["双手被占用"],
                        "targetAudience": "通勤人群",
                        "marketingGoal": "引导了解",
                    }
                ),
                target_count=50,
            )
    finally:
        await provider.aclose()

    assert calls == 1
    assert exc_info.value.error_type == ProviderErrorType.OUTPUT_TRUNCATED
    assert exc_info.value.retryable is False


@pytest.mark.asyncio
async def test_ark_other_incomplete_response_is_non_retryable() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "incomplete",
                "incomplete_details": {"reason": "content_filter"},
                "output_text": "{}",
            },
        )

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="candidate-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError) as exc_info:
            await provider.plan_strategy(
                map_insight(
                    {
                        "productName": "便携杯",
                        "coreSellingPoints": ["单手开合"],
                    }
                ),
                target_count=50,
            )
    finally:
        await provider.aclose()

    assert exc_info.value.error_type == ProviderErrorType.RESPONSE_INCOMPLETE
    assert exc_info.value.retryable is False


@pytest.mark.asyncio
async def test_ark_candidate_rejects_missing_slot() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"status": "completed", "output_text": '{"items":[]}'}
        )

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
                shared_prompt=_shared_prompt(),
            )
    finally:
        await provider.aclose()

    assert exc_info.value.error_type == ProviderErrorType.RESPONSE_INVALID


@pytest.mark.asyncio
async def test_ark_candidate_returns_only_slot_and_direct_prompt() -> None:
    seen: dict[str, object] = {}
    seen_timeout: dict[str, float] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        seen_timeout.update(request.extensions["timeout"])
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(_prompt_batch("slot-1"), ensure_ascii=False),
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
        candidate_timeout=87,
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
            shared_prompt=_shared_prompt(),
            regeneration_context={
                "originalPrompt": "旧版 Prompt",
                "instruction": "产品更早出现",
                "lockedFields": {"fragmentType": "SELLING_POINT_EXPLANATION"},
            },
        )
    finally:
        await provider.aclose()

    assert seen["model"] == "candidate-model"
    assert seen["max_output_tokens"] == 768
    assert seen_timeout["read"] == 87
    assert "instructions" in seen
    assert "effect-prompt-candidate-base-v9" in str(seen["instructions"])
    prompt = seen["input"][0]["content"][0]["text"]  # type: ignore[index]
    assert "便携杯" in prompt
    assert "产品更早出现" in prompt
    assert "旧版 Prompt" in prompt
    assert "浅蓝色圆柱杯身" in prompt
    assert "促销贴纸" in prompt
    assert "保持产品外观前后一致" in prompt
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
async def test_ark_candidate_uses_worker_blueprint_as_fact_binding_authority() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        payload = _prompt_batch("slot-1")
        payload["items"][0]["usedFactIds"] = ["model-invented-fact"]  # type: ignore[index]
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(payload, ensure_ascii=False),
            },
        )

    fact_value = "单手开合"
    combination = _combination().model_copy(
        update={
            "insight_bindings": [
                InsightBinding(
                    fact_id="fact-core-selling-point-1",
                    field=InsightField.CORE_SELLING_POINT,
                    value=fact_value,
                    value_hash=hashlib.sha256(fact_value.encode()).hexdigest(),
                    role=InsightBindingRole.PRIMARY,
                )
            ]
        }
    )
    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="candidate-model",
        max_attempts=1,
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.generate_candidates(
            [combination],
            insight={"coreSellingPoints": [fact_value]},
            shared_prompt=_shared_prompt(),
        )
    finally:
        await provider.aclose()

    assert result.value.items[0].used_fact_ids == ["fact-core-selling-point-1"]


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
                    shared_prompt=_shared_prompt(),
                )
            ).value.items
        )

    assert all(80 <= len(item.prompt_text) <= 150 for item in generated_items)
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
