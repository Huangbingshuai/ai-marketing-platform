import json
from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.models import TrimChoice
from effect_template_mix.provider import ArkProvider, ProviderIncompleteError


async def test_packaging_incomplete_increases_capacity_without_losing_frozen_input():
    requests = []
    def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        if payload['max_output_tokens'] < 16384:
            return httpx.Response(200, json={'status': 'incomplete'})
        return httpx.Response(200, json={'output_text': '{"trimStartSeconds": 0, "trimReason": "画面"}'})
    ark = ArkProvider('https://test.invalid', 'secret', 'model', 300, 16384, 'minimal')
    await ark.client.aclose()
    ark.client = httpx.AsyncClient(base_url='https://test.invalid/', transport=httpx.MockTransport(respond))
    try:
        await ark.structured([{'type': 'input_text', 'text': 'frozen'}], TrimChoice,
                             'packaging_script', max_output_tokens=4096, max_attempts=1)
        assert [r['max_output_tokens'] for r in requests] == [4096, 8192, 16384]
        assert all(r['input'] == requests[0]['input'] for r in requests)
    finally:
        await ark.close()


@pytest.mark.parametrize('name,expected', [('packaging_vision', [4096, 8192]),
                                         ('effect_template_mix_trim', [4096])])
async def test_capacity_is_bounded_and_non_packaging_behavior_unchanged(name, expected):
    budgets = []
    def respond(request):
        budgets.append(json.loads(request.content)['max_output_tokens'])
        return httpx.Response(200, json={'status': 'incomplete'})
    ark = ArkProvider('https://test.invalid', 'secret', 'model', 300, 8192, 'minimal')
    await ark.client.aclose()
    ark.client = httpx.AsyncClient(base_url='https://test.invalid/', transport=httpx.MockTransport(respond))
    try:
        with pytest.raises(ProviderIncompleteError):
            await ark.structured([], TrimChoice, name, max_output_tokens=4096, max_attempts=1)
        assert budgets == expected
    finally:
        await ark.close()


async def test_timeout_retries_keep_same_budget_and_frozen_content():
    requests = []
    def respond(request):
        requests.append(request.content)
        if len(requests) == 1:
            raise httpx.ReadTimeout('private URL not for logging')
        return httpx.Response(200, json={'output_text': '{"trimStartSeconds": 0, "trimReason": "画面"}'})
    ark = ArkProvider('https://test.invalid', 'secret', 'model', 300, 16384, 'minimal')
    await ark.client.aclose()
    ark.client = httpx.AsyncClient(base_url='https://test.invalid/', transport=httpx.MockTransport(respond))
    ark.wait_for_provider = AsyncMock()
    try:
        await ark.structured([], TrimChoice, 'packaging_script', max_output_tokens=8192,
                             max_attempts=1, max_transient_attempts=2)
        assert len(requests) == 2 and requests[0] == requests[1]
    finally:
        await ark.close()
