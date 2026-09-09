from __future__ import annotations

import json
import hashlib

import httpx
import pytest
from pydantic import BaseModel, ValidationError
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDirectionResponse,
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
    _creative_output_token_budget,
    _temporal_intent_for_duration,
    _validate_structured_output,
)
from effect_prompt_generation.reliability import evaluation_chunks
from effect_prompt_generation.prompt_loader import load_prompt, load_prompt_hash
from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy


class _StructuredEnvelope(BaseModel):
    value: int


@pytest.mark.parametrize(
    ("duration", "band", "required_text"),
    [
        (4, "SHORT_FOCUS", "一个可立即看懂"),
        (8, "SHORT_FOCUS", "一个可立即看懂"),
        (9, "COMPLETE_ACTION", "1～2 个连续动作节拍"),
        (11, "COMPLETE_ACTION", "1～2 个连续动作节拍"),
        (12, "COMPLETE_ACTION", "1～2 个连续动作节拍"),
        (15, "COMPLETE_ACTION", "1～2 个连续动作节拍"),
    ],
)
def test_temporal_intent_scales_continuous_action_beats(
    duration: int,
    band: str,
    required_text: str,
) -> None:
    intent = _temporal_intent_for_duration(duration)

    assert intent["band"] == band
    assert required_text in intent["guidance"]
    assert "软参考" in intent["detailGuidance"]
    if duration <= 8:
        assert "首帧就位" in intent["guidance"]
    else:
        assert "结果停留并入最后一个" in intent["guidance"]
        assert "软建议" in intent["guidance"]
        assert "1～2 个节拍" in intent["detailGuidance"]
    assert f"本次为 {duration} 秒" in intent["detailGuidance"]


def test_temporal_intent_rejects_duration_above_15_seconds() -> None:
    with pytest.raises(ValueError, match="between 4 and 15 seconds"):
        _temporal_intent_for_duration(16)


@pytest.mark.parametrize(
    ("duration", "expected"),
    [
        (4, 6_534),
        (8, 7_067),
        (9, 7_200),
        (15, 8_000),
    ],
)
def test_creative_shard_reserves_duration_appropriate_output_budget(
    duration: int,
    expected: int,
) -> None:
    tasks = [
        CreativeTask(
            slotId=f"slot-{index}",
            ordinal=index,
            round=0,
            targetDurationSeconds=duration,
        )
        for index in range(1, 5)
    ]

    assert _creative_output_token_budget(tasks) == expected


def test_single_max_duration_creative_reserves_supplement_headroom() -> None:
    task = CreativeTask(
        slotId="slot-1",
        ordinal=1,
        round=1,
        targetDurationSeconds=15,
    )

    assert _creative_output_token_budget([task]) == 2_000


def test_evaluation_chunks_shrink_only_for_unusually_large_candidate_text() -> None:
    def candidate(slot_id: str, content: str) -> CreativeCandidate:
        return CreativeCandidate(
            slot_id=slot_id,
            ordinal=1,
            round=0,
            creative_core="产品在真实场景中完成一次连续动作",
            declared_fact_ids=["fact-1"],
            dimensions=CreativeDimensions(
                narrative="连续动作展示",
                scene="真实使用环境",
                persona="成年使用者",
                product_relation="产品参与主要动作",
                camera="中近景跟随",
                emotion="自然可信",
            ),
            content=content,
        )

    ordinary = candidate(
        "ordinary",
        "产品在真实场景中完成一次连续动作，镜头完整记录开始、过程与结束。",
    )
    large = candidate("large", "产品细节" * 3_000)

    chunks = evaluation_chunks(
        [
            ordinary,
            ordinary.model_copy(update={"slot_id": "ordinary-2"}),
            large,
            ordinary.model_copy(update={"slot_id": "ordinary-3"}),
        ],
        configured_max_size=4,
        max_output_tokens=6_144,
    )

    assert [len(chunk) for chunk in chunks] == [2, 1, 1]


def test_evaluation_chunks_reserve_located_diagnostic_output_at_max_duration() -> None:
    candidates = [
        CreativeCandidate(
            slot_id=f"long-{index}",
            ordinal=index,
            round=0,
            creative_core="围绕同一产品完成一段连续演示",
            declared_fact_ids=["fact-1"],
            dimensions=CreativeDimensions(
                narrative="连续过程展示",
                scene="真实使用环境",
                persona="成年使用者",
                product_relation="产品完成主要动作",
                camera="中近景跟随",
                emotion="自然可信",
            ),
            content="产品在真实场景中完成一段连续动作，镜头记录完整过程。",
        )
        for index in range(1, 6)
    ]

    chunks = evaluation_chunks(
        candidates,
        configured_max_size=4,
        max_output_tokens=6_144,
        target_durations={item.slot_id: 15 for item in candidates},
        max_input_tokens=12_000,
    )

    assert [len(chunk) for chunk in chunks] == [3, 2]


def test_ark_structured_output_rejects_non_artifact_trailing_content() -> None:
    with pytest.raises(ValidationError):
        _validate_structured_output(
            _StructuredEnvelope,
            '{"value": 1}\n第二个未经校验的回答',
        )


@pytest.mark.asyncio
async def test_ark_remote_protocol_disconnect_is_retryable_transport_error() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.RemoteProtocolError("server disconnected")

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3",
        api_key="test-key",
        strategy_model="strategy-model",
        candidate_model="creative-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError) as raised:
            await provider._structured(
                "test",
                _StructuredEnvelope,
                schema_name="transport_test",
                stage="COHERENT_CREATIVE_GENERATION",
                prompt_file="creative_base.system.prompt.txt",
                model="strategy-model",
                max_output_tokens=128,
                request_timeout=1,
            )
    finally:
        await provider.aclose()

    assert raised.value.retryable is True
    assert raised.value.error_type.value == "AI_NETWORK"


@pytest.mark.asyncio
async def test_timeout_log_identifies_step_without_logging_body(caplog: pytest.LogCaptureFixture) -> None:
    calls = 0

    async def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("PRIVATE_EXCEPTION_TEXT")

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3", api_key="PRIVATE_TEST_KEY",
        strategy_model="strategy-model", candidate_model="creative-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        with caplog.at_level("INFO"), pytest.raises(ProviderError):
            await provider._structured(
                "PRIVATE_PROMPT_BODY", _StructuredEnvelope,
                schema_name="direction_review_timeout_test",
                stage="COHERENT_CREATIVE_GENERATION",
                prompt_file="creative_base.system.prompt.txt", model="strategy-model",
                max_output_tokens=128, request_timeout=180, item_count=3,
            )
    finally:
        await provider.aclose()
    assert calls == 1
    assert "step=direction_review_timeout_test" in caplog.text
    assert "batch_size=3" in caplog.text
    assert "timeout_seconds=180" in caplog.text
    assert "exception_type=ReadTimeout" in caplog.text
    assert "PRIVATE_" not in caplog.text


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


def _shot_plan() -> dict[str, object]:
    return {
        "overview": {
            "visualIntent": "通勤途中自然完成单手开杯动作",
            "visualStyle": "真实轻快的生活记录",
        },
        "scene": {
            "environment": "早高峰地铁站台",
            "lighting": "站台自然顶光",
            "initialState": "成年通勤者单手拿包，另一只手握住便携杯",
        },
        "beats": [
            {
                "sequence": 1,
                "durationWeight": 2,
                "framing": "人物与杯子的中近景",
                "action": "通勤者单手打开杯盖",
                "camera": "跟随手部动作轻推",
                "visibleResult": "杯盖完成打开并稳定停住",
                "sound": "清楚的开盖声",
            },
            {
                "sequence": 2,
                "durationWeight": 1,
                "framing": "杯盖近景",
                "action": "手部收住动作并将杯子保持在胸前",
                "camera": "固定对焦杯盖",
                "visibleResult": "打开状态与单手操作关系清晰可见",
                "sound": None,
            },
        ],
        "finalFrame": "人物仍单手持杯，镜头停在打开的杯盖上",
    }


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
                coverage_focus_fact_ids=[pain_fact.fact_id],
                preferred_fact_ids=[primary_fact.fact_id],
                regeneration_variant_role="PRESENTATION_VARIATION",
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
                    "dimensions": {
                        "narrative": "动作直接进入产品使用",
                        "scene": "早高峰地铁站台",
                        "persona": "单手拿包的成年通勤者",
                        "productRelation": "普通杯盖需要双手操作，便携杯被单手打开",
                        "camera": "中近景跟随后轻推",
                        "emotion": "从容利落",
                    },
                    "shotPlan": _shot_plan(),
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
            regeneration_context={"mode": "AUTO_DIVERSE", "instruction": ""},
        )
    finally:
        await provider.aclose()

    assert seen["model"] == "creative-model"
    assert seen["text"]["format"]["strict"] is True  # type: ignore[index]
    item_schema = seen["text"]["format"]["schema"]["$defs"]["CreativeCandidateDraft"]  # type: ignore[index]
    assert "creativeCore" in item_schema["properties"]
    assert "factEvidence" not in item_schema["properties"]
    assert "focusFactId" not in item_schema["properties"]
    assert "dimensions" in item_schema["properties"]
    assert "shotPlan" in item_schema["properties"]
    assert "content" not in item_schema["properties"]
    assert "fragmentType" not in item_schema["properties"]
    prompt = seen["input"][0]["content"][0]["text"]  # type: ignore[index]
    assert "医疗功效" in prompt
    assert "单手开合" in prompt
    assert "便携杯" in prompt
    assert "普通杯盖需要双手操作" in prompt
    assert "factApplications" in prompt
    assert "coverageFocusFactIds" in prompt
    assert "事实此前未被独立评估器确认落实" in prompt
    assert "productSnapshot" in prompt
    assert '"regenerationVariantRole": "PRESENTATION_VARIATION"' in prompt
    assert "AUTO_DIVERSE" in prompt
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
    assert "【逐秒镜头】" in call.value.items[0].content
    assert "0–3秒" in call.value.items[0].content
    assert call.value.items[0].shot_plan is not None
    shot_plan_schema = seen["text"]["format"]["schema"]["$defs"]["MaterialShotBeat"]  # type: ignore[index]
    assert "dialogue" not in shot_plan_schema["properties"]
    overview_schema = seen["text"]["format"]["schema"]["$defs"]["MaterialShotOverview"]  # type: ignore[index]
    assert "audioDirection" not in overview_schema["properties"]


@pytest.mark.parametrize("duration", [4, 8, 12, 15])
@pytest.mark.parametrize("regenerate", [False, True])
@pytest.mark.parametrize(
    ("product", "feature", "action"),
    [
        ("便携杯", "单手开合", "成年人拇指打开杯盖，另一只手仍提着包"),
        ("衬衫", "侧面口袋", "成年人将小卡片放入侧面口袋，手顺势离开"),
        ("调味酱", "用于蘸食", "成年人拿起一块即食食物，轻蘸碟中的酱料"),
    ],
)
@pytest.mark.asyncio
async def test_director_request_and_compilation_across_products_and_durations(
    duration: int,
    regenerate: bool,
    product: str,
    feature: str,
    action: str,
) -> None:
    # Authored responses test transport/compilation, not AI creative quality.
    application = map_insight({"productName": product, "coreSellingPoints": [feature]})
    fact = next(item for item in application.usable if item.value == feature)
    shot_plan = _shot_plan()
    shot_plan.update(
        overview={
            "visualIntent": f"通过具体动作理解{feature}",
            "visualStyle": "自然生活记录",
        },
        scene={
            "environment": "室内日常使用空间",
            "lighting": "侧窗柔光使接触处可见",
            "initialState": f"{product}和必要道具就位，成年人手部在画面内",
        },
        beats=[{
            "sequence": 1,
            "durationWeight": 1,
            "framing": "手部与产品同框近景",
            "action": action,
            "camera": "固定机位",
            "focus": "焦点从靠近的手移到实际接触处",
            "motionSource": "成年人手部作用于产品",
            "visibleResult": "手结束动作，产品仍在原位",
            "sound": "保留手与物体接触的现场声",
        }],
        finalFrame="手收住动作，产品与接触处仍在画面内",
    )
    seen: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={
            "status": "completed",
            "output_text": json.dumps({"items": [{
                "slotId": "slot-1", "ordinal": 1, "round": 0,
                "creativeCore": f"通过真实动作理解{feature}",
                "declaredFactIds": [fact.fact_id],
                "dimensions": {
                    "narrative": "动作揭示细节", "scene": "室内使用空间",
                    "persona": "成年使用者", "productRelation": feature,
                    "camera": "固定观察与焦点转移", "emotion": "自然从容",
                },
                "shotPlan": shot_plan,
            }]}, ensure_ascii=False),
        })

    provider = ArkResponsesProvider(
        base_url="https://ark.example/v3", api_key="test-key",
        strategy_model="strategy-model", candidate_model="creative-model",
        transport=httpx.MockTransport(handler),
    )
    try:
        call = await provider.generate_creatives(
            CreativeShardPlan(round=0, shard_index=0, tasks=[CreativeTask(
                slot_id="slot-1", ordinal=1, round=0,
                target_duration_seconds=duration,
                fact_assignment=CreativeFactAssignment(
                    fact_ids=[fact.fact_id], assignment_hash="a" * 64,
                ),
            )]),
            application=application, shared_prompt=_shared_prompt(),
            regeneration_context={"mode": "AUTO_DIVERSE", "instruction": ""}
            if regenerate else None,
        )
    finally:
        await provider.aclose()

    assert len(seen) == 1
    assert seen[0]["instructions"] == load_prompt("creative_base.system.prompt.txt")
    assert call.metadata.template_hash == load_prompt_hash("creative_base.system.prompt.txt")
    item = call.value.items[0]
    assert item.shot_plan is not None
    assert item.shot_plan.model_dump(by_alias=True) == shot_plan
    assert item.declared_fact_ids == [fact.fact_id]
    assert f"0–{duration}秒" in item.content
    assert action in item.content
    assert "焦点从靠近的手移到实际接触处" in item.content
    assert "保留手与物体接触的现场声" in item.content
    assert "逐字台词" not in item.content
    assert "声音方向" not in item.content


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
                                "dimensions": {
                                    "narrative": "动作展示",
                                    "scene": "地铁站台",
                                    "persona": "成年通勤者",
                                    "productRelation": "普通杯盖需要双手操作，单手打开便携杯",
                                    "camera": "中近景跟随",
                                    "emotion": "从容利落",
                                },
                                "shotPlan": _shot_plan(),
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
async def test_ark_landscape_batch_audit_reviews_all_spaces_in_one_call() -> None:
    from effect_prompt_generation.creative_directions import (
        validate_creative_diversity_landscape,
    )
    from effect_prompt_generation.providers import (
        CREATIVE_DIRECTION_TEMPLATE_HASH,
        _mock_creative_landscape_response,
        _mock_fact_visual_strategy,
    )

    application = map_insight(
        {
            "productName": "便携杯",
            "productCategory": "饮水容器",
            "coreSellingPoints": ["单手开合", "防漏杯盖"],
            "corePainPoints": ["普通杯盖需要双手操作"],
            "targetAudiences": ["通勤成年人"],
            "usageScenarios": ["通勤途中饮水"],
        }
    )
    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="1" * 64,
        template_hash="2" * 64,
    )
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=8),
        application,
        source_hash="3" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        expected_direction_count=8,
    )
    seen_prompts: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen_prompts.append(payload["input"][0]["content"][0]["text"])
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(
                    {
                        "reviewedTerritoryIds": [
                            item.territory_id for item in landscape.territories
                        ],
                        "factIssues": [],
                        "requiresRevision": False,
                        "revisionTerritoryIds": [],
                        "summary": "整套创意空间关系自然",
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
        call = await provider.audit_creative_landscape(
            application,
            fact_visual_strategy=strategy,
            landscape=landscape,
        )
    finally:
        await provider.aclose()

    assert len(seen_prompts) == 1
    assert call.value.reviewed_territory_ids == [
        item.territory_id for item in landscape.territories
    ]
    assert all(item.label in seen_prompts[0] for item in landscape.territories)
    assert "单手开合" in seen_prompts[0]
    assert all(fact.fact_id not in seen_prompts[0] for fact in application.usable)


@pytest.mark.asyncio
async def test_ark_direction_audit_reviews_each_fact_and_restores_fact_ids() -> None:
    from effect_prompt_generation.creative_directions import (
        validate_creative_diversity_landscape,
        validate_creative_direction_plan,
    )
    from effect_prompt_generation.providers import (
        CREATIVE_DIRECTION_TEMPLATE_HASH,
        _mock_creative_direction_response,
        _mock_creative_landscape_response,
        _mock_fact_visual_strategy,
    )

    application = map_insight(
        {
            "productName": "便携杯",
            "productCategory": "饮水容器",
            "coreSellingPoints": ["单手开合", "防漏杯盖"],
            "corePainPoints": ["普通杯盖需要双手操作"],
            "targetAudiences": ["通勤成年人"],
            "decisionDrivers": ["在意携带便利"],
            "usageScenarios": ["通勤途中饮水"],
        }
    )
    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="1" * 64,
        template_hash="2" * 64,
    )
    landscape = validate_creative_diversity_landscape(
        _mock_creative_landscape_response(application, direction_count=8),
        application,
        source_hash="3" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        expected_direction_count=8,
    )
    all_directions = _mock_creative_direction_response(
        application,
        landscape=landscape,
    )
    validate_creative_direction_plan(
        all_directions,
        application,
        strategy,
        source_hash="3" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        expected_direction_count=8,
        landscape=landscape,
    )
    directions = CreativeDirectionResponse(directions=all_directions.directions[:1])
    aliases = {
        fact.fact_id: f"F{index + 1}" for index, fact in enumerate(application.usable)
    }
    seen_prompt = ""
    seen_payload = ""
    review_timeouts: list[float] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_payload, seen_prompt
        review_timeouts.append(request.extensions["timeout"]["read"])
        payload = json.loads(request.content)
        seen_payload = json.dumps(payload, ensure_ascii=False)
        seen_prompt = payload["input"][0]["content"][0]["text"]
        items = []
        for direction in directions.directions:
            items.append(
                {
                    "directionId": direction.direction_id,
                    "realizedTerritoryId": direction.territory_id,
                    "realizedActionId": direction.primary_action_id,
                    "aligned": True,
                    "factReviews": [
                        {
                            "factId": aliases[application.fact_id],
                            "verdict": "NATURAL",
                            "reason": "事实与版图和动作自然相容",
                        }
                        for application in direction.fact_applications
                    ],
                    "issues": [],
                }
            )
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output_text": json.dumps(
                    {
                        "items": items,
                        "requiresRevision": False,
                        "revisionDirectionIds": [],
                        "summary": "逐项事实关系均自然",
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
        evaluation_timeout=73,
        direction_review_timeout=137,
        transport=httpx.MockTransport(handler),
    )
    try:
        call = await provider.audit_creative_directions(
            application,
            fact_visual_strategy=strategy,
            landscape=landscape,
            directions=directions,
        )
    finally:
        await provider.aclose()

    expected_ids = {
        application.fact_id
        for direction in directions.directions
        for application in direction.fact_applications
    }
    restored_ids = {
        review.fact_id
        for item in call.value.items
        for review in item.fact_reviews or []
    }
    assert restored_ids == expected_ids
    assert review_timeouts == [137]
    assert provider._evaluation_timeout == 73
    assert "factCompatibilities" in seen_prompt
    assert "factReviews" in seen_payload
    assert "单手开合" in seen_prompt
    assert all(fact.fact_id not in seen_prompt for fact in application.usable)
    selected_territory_ids = {
        direction.territory_id for direction in directions.directions
    }
    unrelated_territory = next(
        territory
        for territory in landscape.territories
        if territory.territory_id not in selected_territory_ids
    )
    assert unrelated_territory.label not in seen_prompt


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("declared_selector", "message"),
    [
        ("missing-declared", "no valid candidate"),
        ("unassigned", "no valid candidate"),
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
                    "dimensions": {
                        "narrative": "动作直接进入产品使用",
                        "scene": "早高峰地铁站台",
                        "persona": "单手拿包的成年通勤者",
                        "productRelation": "普通杯盖需要双手操作，便携杯被单手打开",
                        "camera": "中近景跟随后轻推",
                        "emotion": "从容利落",
                    },
                    "shotPlan": _shot_plan(),
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
@pytest.mark.parametrize(
    ("candidate_count", "infer_creative_structure", "expected_output_tokens"),
    [(1, True, 4096), (3, False, 4096), (5, False, 4096)],
)
async def test_ark_evaluation_reserves_tokens_per_candidate_with_configured_ceiling(
    candidate_count: int,
    infer_creative_structure: bool,
    expected_output_tokens: int,
) -> None:
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
        for index in range(1, candidate_count + 1)
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.update(payload)
        output = {
            "items": [
                {
                    "slotId": item.slot_id,
                    "primaryPurpose": "PRODUCT_DISPLAY",
                    "compatiblePurposes": [],
                    "factEvidence": [
                        {"factId": product_fact.fact_id, "evidenceText": "便携杯"}
                    ],
                    "scores": {
                        "productRelevance": 95,
                        "creativeCoherence": 90,
                        "visualExecutability": 90,
                        "commercialUsefulness": 85,
                        "visualClarity": 90,
                    },
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
            infer_creative_structure=infer_creative_structure,
        )
    finally:
        await provider.aclose()

    assert seen["max_output_tokens"] == expected_output_tokens
    item_schema = seen["text"]["format"]["schema"]["$defs"][  # type: ignore[index]
        "CreativeEvaluationDraft"
    ]
    assert "realizedFactIds" not in item_schema["properties"]
    assert "semanticSignature" not in item_schema["properties"]
    assert "visualSignature" not in item_schema["properties"]
    prompt = seen["input"][0]["content"][0]["text"]  # type: ignore[index]
    assert '"ordinal"' not in prompt
    assert '"round"' not in prompt
    assert len(result.value.items) == candidate_count
    assert all(
        item.realized_fact_ids == [product_fact.fact_id]
        for item in result.value.items
    )
