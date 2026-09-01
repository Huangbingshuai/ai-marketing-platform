from __future__ import annotations

import json
import hashlib

import httpx
import pytest
from pydantic import BaseModel, ValidationError
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDimensions,
    CreativeFactAssignment,
    CreativeShardPlan,
    CreativeTask,
    FactVisualUsage,
    SharedPrompt,
    SharedPromptSection,
)
from effect_prompt_generation.providers import (
    ArkResponsesProvider,
    MockAiProvider,
    ProviderError,
    _validate_structured_output,
)
from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy


class _StructuredEnvelope(BaseModel):
    value: int


def test_ark_structured_output_rejects_non_artifact_trailing_content() -> None:
    with pytest.raises(ValidationError):
        _validate_structured_output(
            _StructuredEnvelope,
            '{"value": 1}\n第二个未经校验的回答',
        )


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
async def test_ark_creative_uses_one_coherent_schema_and_shared_constraints() -> None:
    seen: dict[str, object] = {}
    application = map_insight(
        {
            "productName": "便携杯",
            "coreSellingPoints": ["单手开合"],
            "corePainPoints": ["普通杯盖需要双手操作"],
        }
    )
    primary_fact = next(item for item in application.usable if item.value == "单手开合")
    pain_fact = next(
        item for item in application.usable if item.value == "普通杯盖需要双手操作"
    )
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
                    fact_ids=[primary_fact.fact_id, pain_fact.fact_id],
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
                    "declaredFactIds": [primary_fact.fact_id, pain_fact.fact_id],
                    "factEvidence": [
                        {
                            "factId": primary_fact.fact_id,
                            "evidenceText": "便携杯被单手打开",
                            "evidenceSource": "PRODUCT_RELATION",
                        },
                        {
                            "factId": pain_fact.fact_id,
                            "evidenceText": "普通杯盖需要双手操作",
                            "evidenceSource": "PRODUCT_RELATION",
                        },
                    ],
                    "dimensions": {
                        "narrative": "动作直接进入产品使用",
                        "scene": "早高峰地铁站台",
                        "persona": "单手拿包的成年通勤者",
                        "productRelation": "普通杯盖需要双手操作，便携杯被单手打开",
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
            json={
                "status": "completed",
                "output_text": (
                    json.dumps(output, ensure_ascii=False) + "\n]}\n</system></output>"
                ),
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

    assert seen["model"] == "creative-model"
    assert seen["text"]["format"]["strict"] is True  # type: ignore[index]
    item_schema = seen["text"]["format"]["schema"]["$defs"]["CreativeCandidate"]  # type: ignore[index]
    assert "creativeCore" in item_schema["properties"]
    assert "factEvidence" in item_schema["properties"]
    assert "focusFactId" not in item_schema["properties"]
    assert "dimensions" in item_schema["properties"]
    assert "content" in item_schema["properties"]
    assert "fragmentType" not in item_schema["properties"]
    prompt = seen["input"][0]["content"][0]["text"]  # type: ignore[index]
    assert "医疗功效" in prompt
    assert "单手开合" in prompt
    assert "便携杯" in prompt
    assert "普通杯盖需要双手操作" in prompt
    assert "factApplications" in prompt
    assert "focusFact" not in prompt
    assert "productSnapshot" in prompt
    assert "visualTask" not in prompt
    assert "businessContext" not in prompt
    assert "valueHash" not in prompt
    assert "eligibleFragmentTypes" not in prompt
    assert "contentHash" not in prompt
    assert call.value.items[0].ordinal == 1
    assert call.value.items[0].round == 0
    assert call.value.items[0].declared_fact_ids == [
        primary_fact.fact_id,
        pain_fact.fact_id,
    ]
    assert {item.fact_id for item in call.value.items[0].fact_evidence} == {
        primary_fact.fact_id,
        pain_fact.fact_id,
    }


@pytest.mark.asyncio
async def test_ark_creative_uses_slot_local_fact_aliases_and_restores_ids() -> None:
    seen_prompt = ""
    application = map_insight(
        {
            "productName": "便携杯",
            "coreSellingPoints": ["单手开合"],
            "corePainPoints": ["普通杯盖需要双手操作"],
        }
    )
    primary_fact = next(item for item in application.usable if item.value == "单手开合")
    pain_fact = next(
        item for item in application.usable if item.value == "普通杯盖需要双手操作"
    )
    visual_strategy = validate_fact_visual_strategy(
        (await MockAiProvider().compile_fact_visual_strategy(application)).value,
        application,
        source_content_hash="a" * 64,
        template_hash="b" * 64,
    )
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
                    fact_ids=[primary_fact.fact_id, pain_fact.fact_id],
                    assignment_hash="a" * 64,
                ),
            )
        ],
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_prompt
        payload = json.loads(request.content)
        seen_prompt = payload["input"][0]["content"][0]["text"]
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(
                    {
                        "items": [
                            {
                                "slotId": "creative-1",
                                "ordinal": 1,
                                "round": 0,
                                "creativeCore": "通勤途中单手打开便携杯",
                                "declaredFactIds": ["F1", "F2"],
                                "factEvidence": [
                                    {
                                        "factId": "F1",
                                        "evidenceText": "单手打开便携杯",
                                        "evidenceSource": "PRODUCT_RELATION",
                                    },
                                    {
                                        "factId": "F2",
                                        "evidenceText": "普通杯盖需要双手操作",
                                        "evidenceSource": "PRODUCT_RELATION",
                                    },
                                ],
                                "dimensions": {
                                    "narrative": "动作展示",
                                    "scene": "地铁站台",
                                    "persona": "成年通勤者",
                                    "productRelation": "普通杯盖需要双手操作，单手打开便携杯",
                                    "camera": "中近景跟随",
                                    "emotion": "从容利落",
                                },
                                "content": "地铁站台上，成年通勤者单手打开便携杯，镜头跟随杯盖动作。",
                                "generatedAt": None,
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
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
            fact_visual_strategy=visual_strategy,
        )
    finally:
        await provider.aclose()

    assert '"factId": "F1"' in seen_prompt
    assert '"factId": "F2"' in seen_prompt
    assert primary_fact.fact_id not in seen_prompt
    assert pain_fact.fact_id not in seen_prompt
    assert call.value.items[0].declared_fact_ids == [
        primary_fact.fact_id,
        pain_fact.fact_id,
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
        for index, fact in enumerate(application.usable):
            forbidden = fact.value == "纯猪肉无淀粉"
            policies.append(
                {
                    "factId": f"F{index + 1}",
                    "visualUsage": (
                        "FORBIDDEN_VISUAL_PROOF" if forbidden else "DIRECTLY_VISIBLE"
                    ),
                    "visualInstruction": "" if forbidden else "展示真实可见外观",
                    "contextInstruction": "只作商业背景" if forbidden else "",
                    "compatibleFactIds": (
                        [f"F{index + 2}"] if index + 1 < len(application.usable) else []
                    ),
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
    assert {item.fact_id for item in call.value.policies} == {
        item.fact_id for item in application.usable
    }
    assert all(
        fact_id in {item.fact_id for item in application.usable}
        for policy in call.value.policies
        for fact_id in policy.compatible_fact_ids
    )
    assert any(
        policy.visual_usage == FactVisualUsage.FORBIDDEN_VISUAL_PROOF
        for policy in call.value.policies
    )
    payload_text = json.dumps(seen, ensure_ascii=False)
    assert "纯猪肉无淀粉" in payload_text
    assert "F1" in payload_text
    assert "effect_prompt_fact_visual_strategy" in payload_text
    assert seen["max_output_tokens"] == 4096


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("declared_selector", "message"),
    [
        ("missing-declared", "no valid candidate"),
        ("unassigned", "no valid candidate"),
        ("missing-evidence", "no valid candidate"),
        ("evidence-not-in-source", "no valid candidate"),
    ],
)
async def test_ark_creative_rejects_invalid_fact_usage(
    declared_selector: str,
    message: str,
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
    pain_fact = next(
        item for item in application.usable if item.value == "普通杯盖需要双手操作"
    )
    unassigned_fact = product_fact
    declared = {
        "missing-declared": [primary_fact.fact_id],
        "missing-evidence": [primary_fact.fact_id, pain_fact.fact_id],
        "evidence-not-in-source": [primary_fact.fact_id, pain_fact.fact_id],
        "unassigned": [
            primary_fact.fact_id,
            pain_fact.fact_id,
            unassigned_fact.fact_id,
        ],
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
                    fact_ids=[primary_fact.fact_id, pain_fact.fact_id],
                    assignment_hash="b" * 64,
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
                    "declaredFactIds": declared,
                    "factEvidence": [
                        {
                            "factId": primary_fact.fact_id,
                            "evidenceText": "便携杯被单手打开",
                            "evidenceSource": "PRODUCT_RELATION",
                        },
                        *(
                            []
                            if declared_selector == "missing-evidence"
                            else [
                                {
                                    "factId": pain_fact.fact_id,
                                    "evidenceText": (
                                        "不存在的证据"
                                        if declared_selector == "evidence-not-in-source"
                                        else "普通杯盖需要双手操作"
                                    ),
                                    "evidenceSource": "PRODUCT_RELATION",
                                }
                            ]
                        ),
                        *(
                            [
                                {
                                    "factId": unassigned_fact.fact_id,
                                    "evidenceText": "便携杯",
                                    "evidenceSource": "PRODUCT_RELATION",
                                }
                            ]
                            if declared_selector == "unassigned"
                            else []
                        ),
                    ],
                    "dimensions": {
                        "narrative": "动作直接进入产品使用",
                        "scene": "早高峰地铁站台",
                        "persona": "单手拿包的成年通勤者",
                        "productRelation": "普通杯盖需要双手操作，便携杯被单手打开",
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
        with pytest.raises(ProviderError, match=message):
            await provider.generate_creatives(
                shard,
                application=application,
                shared_prompt=_shared_prompt(),
            )
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_ark_evaluation_uses_configured_ceiling_for_five_items() -> None:
    seen: dict[str, object] = {}
    application = map_insight({"productName": "便携杯"})
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
            application=application,
            target_durations={item.slot_id: 5 for item in candidates},
        )
    finally:
        await provider.aclose()

    assert seen["max_output_tokens"] == 4096
    assert len(result.value.items) == 5
