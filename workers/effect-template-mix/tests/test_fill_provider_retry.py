from unittest.mock import AsyncMock
import asyncio
import time

import httpx
import pytest

from effect_template_mix.models import TrimChoice
from effect_template_mix.provider import ArkProvider, ProviderError


async def provider_with_transport(handler):
    provider = ArkProvider('https://test.invalid', 'secret', 'model', 1, 8192, 'minimal')
    await provider.client.aclose()
    provider.client = httpx.AsyncClient(base_url='https://test.invalid/', transport=httpx.MockTransport(handler))
    provider.wait_for_provider = AsyncMock()
    return provider


async def test_fill_recovers_rate_limit_and_dns_failure_without_losing_input(monkeypatch):
    requests = []
    def handler(request):
        requests.append(request.content)
        if len(requests) == 1:
            return httpx.Response(429, headers={'retry-after': '9'})
        if len(requests) == 2:
            raise httpx.ConnectError('private DNS endpoint')
        return httpx.Response(200, json={'output_text': '{"trimStartSeconds": 1, "trimReason": "合适画面"}'})
    provider = await provider_with_transport(handler)
    cooldown = []
    original = provider.defer_requests
    def capture(failures, retry_after=None):
        cooldown.append((failures, retry_after))
        original(failures, retry_after)
    monkeypatch.setattr(provider, 'defer_requests', capture)
    result = await provider.structured([], TrimChoice, 'effect_template_mix_trim',
        max_output_tokens=1024, max_transient_attempts=4)
    assert result.trimStartSeconds == 1
    assert len(requests) == 3 and requests[0] == requests[1] == requests[2]
    assert cooldown == [(1, '9'), (2, None)]
    assert provider.wait_for_provider.await_count == 3
    await provider.close()


@pytest.mark.parametrize('status', [400, 401, 403])
async def test_permanent_provider_rejection_is_not_retried(status):
    calls = []
    provider = await provider_with_transport(lambda request: calls.append(request) or httpx.Response(status))
    with pytest.raises(ProviderError) as error:
        await provider.structured([], TrimChoice, 'effect_template_mix_trim',
            max_output_tokens=1024, max_transient_attempts=4)
    assert not error.value.retryable and len(calls) == 1
    await provider.close()


async def test_invalid_output_does_not_use_extra_transient_retry_budget():
    calls = []
    provider = await provider_with_transport(lambda request: calls.append(request) or
        httpx.Response(200, json={'output_text': 'not-json'}))
    with pytest.raises(ProviderError):
        await provider.structured([], TrimChoice, 'effect_template_mix_trim',
            max_output_tokens=1024, max_transient_attempts=4)
    assert len(calls) == 2
    await provider.close()


async def test_persistent_rate_limit_remains_retryable_and_bounded():
    calls = []
    provider = await provider_with_transport(lambda request: calls.append(request) or httpx.Response(429))
    with pytest.raises(ProviderError, match='请求受限') as error:
        await provider.structured([], TrimChoice, 'effect_template_mix_trim',
            max_output_tokens=1024, max_transient_attempts=4)
    assert error.value.retryable and len(calls) == 4
    await provider.close()


@pytest.mark.parametrize('failure', [httpx.ConnectError, httpx.RemoteProtocolError])
async def test_connection_failure_does_not_trigger_more_paid_calls_by_splitting(failure):
    calls = []
    def handler(request):
        calls.append(request)
        raise failure('connection unavailable')
    provider = await provider_with_transport(handler)
    with pytest.raises(ProviderError) as error:
        await provider.structured([], TrimChoice, 'effect_template_mix_classification',
            max_output_tokens=1024, max_transient_attempts=4)
    assert len(calls) == 4 and error.value.retryable and not error.value.split_recommended
    await provider.close()


async def test_remote_disconnect_recovers_in_the_same_request(monkeypatch):
    calls = []
    def handler(request):
        calls.append(request.content)
        if len(calls) == 1:
            raise httpx.RemoteProtocolError('remote disconnected')
        return httpx.Response(200, json={'output_text': '{"trimStartSeconds": 0, "trimReason": "画面"}'})
    provider = await provider_with_transport(handler)
    result = await provider.structured([], TrimChoice, 'effect_template_mix_trim',
        max_output_tokens=1024, max_transient_attempts=4)
    assert result.trimStartSeconds == 0 and len(calls) == 2 and calls[0] == calls[1]
    await provider.close()


async def test_concurrent_chunks_obey_the_shared_provider_cooldown():
    sent_at = []
    provider = await provider_with_transport(lambda request: sent_at.append(time.monotonic()) or
        httpx.Response(200, json={'output_text': '{"trimStartSeconds": 0, "trimReason": "画面"}'}))
    provider.wait_for_provider = ArkProvider.wait_for_provider.__get__(provider)
    deadline = time.monotonic() + 0.02
    provider.retry_not_before = deadline
    await asyncio.gather(*(provider.structured([], TrimChoice, 'effect_template_mix_trim',
        max_output_tokens=1024) for _ in range(3)))
    assert len(sent_at) == 3 and all(sent >= deadline for sent in sent_at)
    await provider.close()
