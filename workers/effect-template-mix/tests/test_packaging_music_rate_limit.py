import asyncio
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.packaging import submit_music_safely
from effect_template_mix.packaging_provider import MusicRateLimited, PackagingError, PackagingProvider
from effect_template_mix.packaging import FrameVisionOutput
from effect_template_mix.provider import ArkProvider, ProviderError, ProviderOutputError
from effect_template_mix.api import InternalApi
from effect_template_mix.packaging import PackagingHandler
from effect_template_mix.packaging import understand_frames


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


async def test_query_rate_limit_reuses_saved_task_without_paid_resubmit(monkeypatch: Any) -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'saved-music'}
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.query_music.side_effect = [MusicRateLimited('限流'), 'https://v1-default.douyinvod.com/music']
    adapter.download_music.return_value = b'source'
    monkeypatch.setattr('effect_template_mix.packaging.music_wav', AsyncMock(return_value=b'wav'))
    monkeypatch.setattr('effect_template_mix.packaging.asyncio.sleep', AsyncMock())
    row = {'id': 'item', 'stage': 'MUSIC', 'snapshot': {'duration': 43, 'narrationLayoutVersion': 'SLOT_V1',
        'variant': {'slots': [{'id': 's', 'role': 'PRODUCT'}]}, 'clips': [{'slotId': 's', 'start': 0, 'duration': 5}]}, 'checkpoint': {
        'narrationLayoutVersion': 'SLOT_V1',
        'vision': [{'start': 0, 'end': 43, 'description': '画面'}],
        'script': [{'id': 'line', 'slotId': 's', 'text': '口播', 'start': 0, 'end': 5, 'factIds': ['f']}],
        'voices': {'line': {'fileObjectId': 'voice', 'start': 0, 'duration': 2, 'volume': 1}},
        'musicTaskId': 'existing-task', 'musicSubmissionPending': False}}
    await PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000).process_item('/run', {}, 'project', row)
    adapter.submit_music.assert_not_called()
    assert adapter.query_music.await_count == 2
    assert all(call.args == ('existing-task',) for call in adapter.query_music.await_args_list)
    assert row['stage'] == 'READY'


@pytest.mark.parametrize('recovered', [True, False])
async def test_vision_malformed_response_gets_one_bounded_structural_repair(recovered: bool) -> None:
    ark = AsyncMock(spec=ArkProvider)
    invalid = ProviderOutputError('invalid', retryable=False, split_recommended=True)
    valid = FrameVisionOutput.model_validate({'frames': [{'frameIndex': 0, 'description': '画面'}]})
    ark.structured.side_effect = [invalid, valid if recovered else invalid]
    guard = AsyncMock()
    if recovered:
        assert await understand_frames(ark, {'duration': 1, 'clips': []}, [(.5, b'frame')], guard)
    else:
        with pytest.raises(PackagingError, match='修正一次后仍无效'):
            await understand_frames(ark, {'duration': 1, 'clips': []}, [(.5, b'frame')], guard)
    assert ark.structured.await_count == 2 and guard.await_count == 2


async def test_vision_structural_repair_does_not_retry_transport_failure() -> None:
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.side_effect = ProviderError('timeout', retryable=True)
    with pytest.raises(ProviderError):
        await understand_frames(ark, {'duration': 1, 'clips': []}, [(.5, b'frame')], AsyncMock())
    assert ark.structured.await_count == 1
