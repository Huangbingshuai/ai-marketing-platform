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
async def test_bounded_retries_schema_and_timeout(failure):
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


def test_missing_configuration_fails_explicitly(monkeypatch):
    monkeypatch.delenv("CUSTOMIZED_STORYBOARD_WORKER_TOKEN", raising=False)
    with pytest.raises(ValueError, match="required"):
        required("CUSTOMIZED_STORYBOARD_WORKER_TOKEN")
