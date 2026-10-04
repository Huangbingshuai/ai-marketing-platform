from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.api import ApiError, InternalApi


async def make_api(handler):
    api = InternalApi('http://test.invalid', 'secret', 1)
    await api.client.aclose()
    api.client = httpx.AsyncClient(base_url='http://test.invalid/', transport=httpx.MockTransport(handler))
    return api


async def test_checkpoint_recovers_connection_failure_with_same_lease(monkeypatch):
    calls = []
    def handler(request):
        calls.append(request)
        if len(calls) < 3:
            raise httpx.ConnectError('unavailable')
        return httpx.Response(200, json={'success': True, 'data': {'progress': 30}})
    api = await make_api(handler)
    sleep = AsyncMock()
    monkeypatch.setattr('effect_template_mix.api.asyncio.sleep', sleep)
    result = await api.request('PUT', 'checkpoint', headers={'x-attempt-token': 'lease'}, json={'value': 1})
    assert result == {'progress': 30}
    assert len(calls) == 3
    assert all(r.content == calls[0].content and r.headers['x-attempt-token'] == 'lease' for r in calls)
    assert [call.args[0] for call in sleep.await_args_list] == [2, 4]
    await api.close()


@pytest.mark.parametrize('status', [400, 401, 403, 409])
async def test_rejected_or_stale_lease_is_never_retried(status):
    calls = []
    api = await make_api(lambda request: calls.append(request) or httpx.Response(status))
    with pytest.raises(ApiError) as error:
        await api.request('PUT', 'progress')
    assert len(calls) == 1 and not error.value.retryable
    await api.close()


@pytest.mark.parametrize('failure', [httpx.ReadTimeout, httpx.RemoteProtocolError])
async def test_ambiguous_claim_failure_does_not_claim_again(failure):
    calls = []
    def handler(request):
        calls.append(request)
        raise failure('response lost')
    api = await make_api(handler)
    with pytest.raises(ApiError):
        await api.request('POST', 'claim')
    assert len(calls) == 1
    await api.close()


async def test_internal_api_retries_are_bounded(monkeypatch):
    calls = []
    api = await make_api(lambda request: calls.append(request) or httpx.Response(503))
    monkeypatch.setattr('effect_template_mix.api.asyncio.sleep', AsyncMock())
    with pytest.raises(ApiError) as error:
        await api.request('PUT', 'progress')
    assert len(calls) == 4 and error.value.retryable
    await api.close()
