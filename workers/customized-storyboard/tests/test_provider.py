import asyncio
import json
import httpx
import pytest
from ai_runtime.responses import ProviderError, ProviderErrorType
from customized_storyboard.provider import Provider
from customized_storyboard.models import Review
from customized_storyboard.main import required


async def configured(handler):
    provider = Provider("https://ark.invalid/api/v3", "test-only", timeout=12)
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url="https://ark.invalid/api/v3/", transport=httpx.MockTransport(handler)
    )
    return provider


@pytest.mark.parametrize("failure", ["rate_limit", "timeout", "invalid", "rejected"])
async def test_bounded_retries_schema_and_timeout(failure, caplog):
    calls = []

    async def handler(request):
        calls.append(request)
        assert request.extensions["timeout"]["read"] == 12
        payload = json.loads(request.content)
        assert payload["model"] == "fixed-model" and payload["store"] is False
        assert payload["text"]["format"]["strict"] is True
        if failure == "rejected":
            return httpx.Response(400, json={})
        if failure == "invalid":
            return httpx.Response(200, json={"output_text": '{"unrecognized":true}'})
        if len(calls) == 1:
            if failure == "timeout":
                raise httpx.ReadTimeout("test timeout")
            return httpx.Response(429, json={})
        return httpx.Response(
            200, json={"output_text": '{"summary":"通过","findings":[]}'}
        )

    provider = await configured(handler)
    try:
        if failure in {"invalid", "rejected"}:
            with pytest.raises(ProviderError) as error:
                await provider.generate("REVIEW", "fixed-model", Review, {}, "审校")
            assert error.value.error_type == (
                ProviderErrorType.RESPONSE_INVALID
                if failure == "invalid"
                else ProviderErrorType.REQUEST_REJECTED
            )
        else:
            assert (
                await provider.generate("REVIEW", "fixed-model", Review, {}, "审校")
            ).summary == "通过"
        assert len(calls) == (1 if failure == "rejected" else 2)
        if failure == "invalid":
            report = next(record.message for record in caplog.records if 'storyboard_model_failure' in record.message)
            assert 'AI_RESPONSE_INVALID' in report and 'extra_forbidden' in report
            assert 'input' not in report and 'test-only' not in report and 'Authorization' not in report
    finally:
        await provider.close()


async def test_all_stages_share_one_concurrency_budget():
    active = peak = 0
    entered = asyncio.Event()
    release = asyncio.Event()

    async def handler(request):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        if active == 2:
            entered.set()
        await release.wait()
        active -= 1
        return httpx.Response(
            200, json={"output_text": '{"summary":"通过","findings":[]}'}
        )

    provider = await configured(handler)
    tasks = [
        asyncio.create_task(provider.generate(stage, "fixed-model", Review, {}, "测试"))
        for stage in ["CONCEPT", "STORY", "REVIEW", "RECHECK", "ASSETS"]
    ]
    try:
        await asyncio.wait_for(entered.wait(), 2)
        assert peak == 2
        release.set()
        await asyncio.gather(*tasks)
        assert peak == 2
    finally:
        release.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await provider.close()


@pytest.mark.parametrize("stage", ["REVIEW", "RECHECK"])
async def test_review_ids_are_constrained_to_current_script_and_retry_invalid_reply(
    stage,
):
    calls = []

    async def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        schema = payload["text"]["format"]["schema"]
        assert schema["$defs"]["Finding"]["properties"]["shotIds"]["items"]["enum"] == [
            "actual-1",
            "actual-2",
        ]
        return httpx.Response(
            200,
            json={
                "output_text": json.dumps(
                    {
                        "summary": "独立审校",
                        "findings": [
                            {
                                "severity": "ERROR",
                                "category": "STORY",
                                "shotIds": [
                                    "wrong-1" if len(calls) == 1 else "actual-2"
                                ],
                                "message": "物品连续性错误",
                                "evidence": "前后画面",
                                "suggestion": "补充动作",
                            }
                        ],
                    }
                )
            },
        )

    provider = await configured(handler)
    try:
        review = await provider.generate(
            stage,
            "fixed-model",
            Review,
            {"script": {"shots": [{"id": "actual-1"}, {"id": "actual-2"}]}},
            "独立审校",
        )
        assert len(calls) == 2
        assert review.findings[0].shotIds == ["actual-2"]
        assert review.findings[0].severity == "ERROR"
    finally:
        await provider.close()


def test_missing_configuration_fails_explicitly(monkeypatch):
    monkeypatch.delenv("CUSTOMIZED_STORYBOARD_WORKER_TOKEN", raising=False)
    with pytest.raises(ValueError, match="required"):
        required("CUSTOMIZED_STORYBOARD_WORKER_TOKEN")


@pytest.mark.parametrize("modern", [False, True])
async def test_video_script_repair_uses_capacity_reasoning_without_changing_legacy(modern):
    async def handler(request):
        payload = json.loads(request.content)
        assert payload["reasoning"]["effort"] == ("medium" if modern else "low")
        policy = payload["input"][0]["content"]
        assert ("参考时长仅指导信息规模" in policy) is modern
        return httpx.Response(
            200, json={"output_text": '{"summary":"通过","findings":[]}'}
        )

    provider = await configured(handler)
    try:
        context = {"storyFormat": "VIDEO_SCRIPT_V2"} if modern else {}
        await provider.generate("REPAIR", "fixed-model", Review, context, "修订")
    finally:
        await provider.close()


@pytest.mark.parametrize(('version', 'stage', 'role', 'route', 'effort'), [
    ('2026-10-14-drama.3', 'DRAMA_CONCEPT', 'DRAMA_SELECTION', 'DRAMA', 'medium'),
    ('2026-10-14-drama.3', 'DRAMA_STORY', None, 'DRAMA', 'medium'),
    ('2026-10-14-drama.3', 'DRAMA_REVIEW', 'EDITORIAL', 'DRAMA', 'medium'),
    ('2026-10-14-drama.1', 'DRAMA_CONCEPT', 'DRAMA_SELECTION', 'DRAMA', 'medium'),
    ('2026-10-14-drama.1', 'DRAMA_STORY', None, 'DRAMA', 'medium'),
    ('2026-10-14-drama.1', 'DRAMA_REVIEW', 'EDITORIAL', 'DRAMA', 'medium'),
    ('2026-10-14-drama.1', 'DRAMA_REVIEW', 'FACTS', 'DRAMA', 'medium'),
    ('2026-10-14-drama.1', 'REPAIR', None, 'DRAMA', 'medium'),
    ('2026-10-14-drama.1', 'RECHECK', 'EDITORIAL', 'DRAMA', 'medium'),
    ('2026-10-14.6', 'BRAND_AD_CONCEPT', 'IDEA_SELECTION', 'BRAND_AD', 'medium'),
    ('2026-10-14.6', 'BRAND_AD_REVIEW', 'EDITORIAL', 'BRAND_AD', 'medium'),
    ('2026-10-14.6', 'DRAMA_REVIEW', 'EDITORIAL', 'DRAMA', 'high'),
    ('2026-10-14.7', 'BRAND_AD_REVIEW', 'EDITORIAL', 'BRAND_AD', 'medium'),
    ('2026-10-14.7', 'DRAMA_REVIEW', 'EDITORIAL', 'DRAMA', 'high'),
    ('2026-10-14.5', 'BRAND_AD_CONCEPT', 'IDEA_SELECTION', 'BRAND_AD', 'medium'),
    ('2026-10-14.5', 'BRAND_AD_REVIEW', 'EDITORIAL', 'BRAND_AD', 'high'),
    ('2026-10-14.5', 'BRAND_AD_PROPOSITION', None, 'BRAND_AD', 'medium'),
    ('2026-10-14.4', 'BRAND_AD_PROPOSITION', None, 'BRAND_AD', 'medium'),
    ('2026-10-14.4', 'BRAND_AD_CONCEPT', 'IDEA_SELECTION', 'BRAND_AD', 'high'),
    ('2026-10-14.3', 'BRAND_AD_CONCEPT', 'IDEA_SELECTION', 'BRAND_AD', 'high'),
    ('2026-10-14.2', 'BRAND_AD_CONCEPT', 'IDEA_SELECTION', 'BRAND_AD', 'medium'),
    ('2026-10-14.2', 'BRAND_AD_PROPOSITION', None, 'BRAND_AD', 'medium'),
    ('2026-10-14.2', 'BRAND_AD_REVIEW', 'EDITORIAL', 'BRAND_AD', 'high'),
    ('2026-10-14.1', 'BRAND_AD_CONCEPT', 'IDEA_SELECTION', 'BRAND_AD', 'medium'),
    ('2026-10-13.11', 'BRAND_AD_CONCEPT', None, 'BRAND_AD', 'medium'),
    ('2026-10-13.11', 'DRAMA_REVIEW', 'EDITORIAL', 'DRAMA', 'high'),
    ('2026-10-13.11', 'DRAMA_REVIEW', 'FACTS', 'DRAMA', 'medium'),
    ('2026-10-13.10', 'BRAND_AD_CONCEPT', None, 'BRAND_AD', 'medium'),
    ('2026-10-13.10', 'DRAMA_REVIEW', 'EDITORIAL', 'DRAMA', 'high'),
    ('2026-10-13.10', 'DRAMA_REVIEW', 'FACTS', 'DRAMA', 'medium'),
    ('2026-10-13.9', 'BRAND_AD_CONCEPT', None, 'BRAND_AD', 'high'),
    ('2026-10-13.9', 'DRAMA_CONCEPT', None, 'DRAMA', 'high'),
    ('2026-10-13.9', 'DRAMA_REVIEW', 'EDITORIAL', 'DRAMA', 'high'),
    ('2026-10-13.9', 'RECHECK', 'EDITORIAL', 'BRAND_AD', 'high'),
    ('2026-10-13.9', 'BRAND_AD_REVIEW', 'FACTS', 'BRAND_AD', 'medium'),
    ('2026-10-13.9', 'DRAMA_STORY', None, 'DRAMA', 'medium'),
    ('2026-10-13.9', 'ECOMMERCE_CONCEPT', None, 'ECOMMERCE', 'medium'),
    ('2026-10-13.8', 'DRAMA_REVIEW', 'EDITORIAL', 'DRAMA', 'medium'),
])
async def test_reasoning_budget_follows_frozen_stage_not_every_call(version, stage, role, route, effort):
    async def handler(request):
        payload = json.loads(request.content)
        assert payload['reasoning']['effort'] == effort
        return httpx.Response(200, json={'output_text': '{"summary":"通过","findings":[]}'})
    provider = await configured(handler)
    try:
        await provider.generate(stage, 'fixed-model', Review, {
            'storyFormat': 'VIDEO_SCRIPT_V3', 'strategyVersion': version,
            'settings': {'videoType': route}, 'auditRole': role,
            **({'candidateCount': 6} if stage == 'BRAND_AD_PROPOSITION' else {}),
        }, '审校')
    finally:
        await provider.close()


async def test_drama_short_development_uses_low_budget_without_weakening_independent_selection():
    async def handler(request):
        payload=json.loads(request.content)
        assert payload['reasoning']['effort']=='low'
        assert payload['max_output_tokens']==8192
        return httpx.Response(200,json={'output_text':'{"summary":"通过","findings":[]}'})
    provider=await configured(handler)
    try:
        await provider.generate('DRAMA_CONCEPT','fixed-pro',Review,{
            'storyFormat':'VIDEO_SCRIPT_V3','strategyVersion':'2026-10-14-drama.3',
            'settings':{'videoType':'DRAMA'},'candidateCount':3},'短故事开发')
    finally:
        await provider.close()


@pytest.mark.parametrize('version', ['2026-10-14-commerce.1', '2026-10-14-commerce.2', '2026-10-14-commerce.3', '2026-10-14-commerce.4', '2026-10-14-commerce.5', '2026-10-14-presenter.1', '2026-10-14-presenter.2', '2026-10-14-presenter.3'])
@pytest.mark.parametrize('stage,role,compact', [
    ('ECOMMERCE_MOTIVATION', None, True),
    ('ECOMMERCE_CONCEPT', 'COMMERCE_SELECTION', True),
    ('ECOMMERCE_REVIEW', 'EDITORIAL', False),
    ('ECOMMERCE_REVIEW', 'FACTS', False),
])
async def test_commerce_uses_medium_and_scoped_roles_without_brand_gate(stage, role, compact, version):
    async def handler(request):
        payload = json.loads(request.content)
        assert payload['reasoning']['effort'] == ('low' if version in {'2026-10-14-commerce.4', '2026-10-14-commerce.5', '2026-10-14-presenter.1', '2026-10-14-presenter.2', '2026-10-14-presenter.3'} and stage == 'ECOMMERCE_MOTIVATION' else 'medium')
        assert payload['max_output_tokens'] == (8192 if compact else 16384)
        system = payload['input'][0]['content']
        if role == 'EDITORIAL':
            assert '电商商业表达' in system
            assert '不将品牌广告' in system
        if role == 'FACTS': assert '独立事实与执行' in system
        return httpx.Response(200, json={'output_text': '{"summary":"通过","findings":[]}'})
    provider = await configured(handler)
    try:
        await provider.generate(stage, 'fixed-model', Review, {
            'storyFormat': 'VIDEO_SCRIPT_V3', 'strategyVersion': version,
            'settings': {'videoType': 'ECOMMERCE'}, 'auditRole': role,
            **({'candidateCount': 6} if stage == 'ECOMMERCE_MOTIVATION' else {}),
        }, '专项检查')
    finally:
        await provider.close()
