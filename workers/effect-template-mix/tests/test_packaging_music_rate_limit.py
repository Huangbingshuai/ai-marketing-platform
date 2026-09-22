import asyncio
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.packaging import submit_music_safely
from effect_template_mix.packaging_provider import MusicRateLimited, PackagingError, PackagingProvider
from effect_template_mix.packaging import FrameVisionOutput
from effect_template_mix.provider import ArkProvider, ProviderError


@pytest.mark.parametrize('task_id', [None, 'possibly-created'])
async def test_only_explicit_rejection_without_task_can_retry(task_id: str | None) -> None:
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={
        'Code': 200023, 'Result': {'TaskID': task_id},
        'ResponseMetadata': {'Error': {'Code': 'APIOutOfQps'}}})))
    adapter = PackagingProvider('', '', '', 'ak', 'sk', 'GenBGMForTime', client)
    with pytest.raises(PackagingError) as caught:
        await adapter.submit_music('纯音乐', 43)
    assert isinstance(caught.value, MusicRateLimited) == (task_id is None)
    await adapter.close()


async def test_shared_throttle_spaces_submit_and_query_requests() -> None:
    times: list[float] = []
    def response(_: httpx.Request) -> httpx.Response:
        times.append(asyncio.get_running_loop().time())
        return httpx.Response(200, json={'Code': 0, 'Result': {'TaskID': 'task', 'Status': 0}})
    adapter = PackagingProvider('', '', '', 'ak', 'sk', 'GenBGMForTime',
        httpx.AsyncClient(transport=httpx.MockTransport(response)), music_min_interval=.03)
    await asyncio.gather(adapter.submit_music('音乐', 43), adapter.query_music('task'), adapter.query_music('task'))
    assert len(times) == 3 and all(b - a >= .025 for a, b in zip(times, times[1:]))
    await adapter.close()


@pytest.mark.parametrize('failure, expected', [(httpx.ReadTimeout, '响应超时'), (httpx.ConnectError, '连接中断')])
async def test_transport_failure_is_not_mislabeled_as_model_structure(failure: Any, expected: str, caplog: Any) -> None:
    def response(_: httpx.Request) -> httpx.Response:
        raise failure('private endpoint must not be logged')
    ark = ArkProvider('https://test.invalid', 'key', 'model', 1, 8192, 'minimal')
    await ark.client.aclose()
    ark.client = httpx.AsyncClient(base_url='https://test.invalid/', transport=httpx.MockTransport(response))
    with pytest.raises(ProviderError, match=expected) as caught:
        await ark.structured([], FrameVisionOutput, 'packaging_vision', max_output_tokens=4096, max_attempts=1)
    assert caught.value.retryable
    assert 'private endpoint' not in caplog.text
    assert 'packaging model transport failed' in caplog.text
    await ark.close()


@pytest.mark.parametrize('failure', ['rate-limit', 'timeout', 'malformed', 'exhausted', 'cancel'])
async def test_submission_recovery_preserves_uncertainty_and_checks_cancel(failure: str) -> None:
    adapter = AsyncMock(spec=PackagingProvider)
    cp: dict[str, Any] = {'musicBrief': '纯器乐'}
    async def save(_: str, patch: dict[str, Any]) -> None:
        cp.update(patch)
    guard = AsyncMock()
    if failure in ('rate-limit', 'cancel'):
        adapter.submit_music.side_effect = [MusicRateLimited('限流'), 'saved-task']
        if failure == 'cancel':
            guard.side_effect = [None, RuntimeError('cancelled')]
    else:
        adapter.submit_music.side_effect = {
            'timeout': httpx.ReadTimeout('unknown'), 'malformed': PackagingError('invalid'),
            'exhausted': MusicRateLimited('限流')}[failure]
    if failure == 'rate-limit':
        assert await submit_music_safely(adapter, cp, 43, save, guard, backoff_seconds=0) == 'saved-task'
        assert cp['musicTaskId'] == 'saved-task' and cp['musicSubmissionPending'] is False
        assert adapter.submit_music.await_count == 2
    else:
        with pytest.raises((PackagingError, httpx.ReadTimeout, RuntimeError)):
            await submit_music_safely(adapter, cp, 43, save, guard, backoff_seconds=0)
        assert adapter.submit_music.await_count == (3 if failure == 'exhausted' else 1)
        assert cp['musicSubmissionPending'] == (failure in ('timeout', 'malformed'))
        assert 'musicTaskId' not in cp
