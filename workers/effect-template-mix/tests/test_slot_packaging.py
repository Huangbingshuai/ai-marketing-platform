import asyncio
import copy
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.api import InternalApi
from effect_template_mix.packaging import PackagingHandler, SlotVisionOutput, narration_windows, slot_vision_key
from effect_template_mix.packaging_provider import PackagingProvider, PackagingError, TimedVoicePcm
from effect_template_mix.provider import ArkProvider
from effect_template_mix.provider import ProviderIncompleteError, ProviderError, ProviderOutputError


def snapshot(duration: float = 4) -> dict[str, Any]:
    return {'duration': duration, 'narrationLayoutVersion': 'SLOT_V1', 'facts': [{'id': 'f', 'text': '事实'}],
        'variant': {'slots': [{'id': 's', 'role': 'HOOK'}]},
        'clips': [{'slotId': 's', 'contentHash': 'hash', 'fileObjectId': 'file', 'start': 0, 'duration': duration, 'offset': 1}]}


@pytest.mark.parametrize('duration', [4, 15])
def test_valid_slot_edges(duration: float) -> None:
    assert narration_windows(snapshot(duration))[0]['end'] == duration


@pytest.mark.parametrize('duration', [3.99, 15.01, float('nan')])
def test_invalid_duration(duration: float) -> None:
    with pytest.raises(PackagingError, match='4–15'):
        narration_windows(snapshot(duration))


def test_overlap_is_rejected_without_lane_escape() -> None:
    value = snapshot()
    value['clips'].append({**value['clips'][0], 'slotId': 's2', 'start': 3, 'lane': 1})
    value['variant']['slots'].append({'id': 's2', 'role': 'END'})
    with pytest.raises(PackagingError, match='边界冲突'):
        narration_windows(value)


def test_overlay_covers_a_narrated_slot_without_being_narrated() -> None:
    value = snapshot()
    # The overlay lands inside the narrated slot, on a lane above it: covering it is its job, so
    # the overlap that would otherwise be a boundary conflict is not one.
    value['clips'].append({**value['clips'][0], 'slotId': 's2', 'start': 1, 'lane': 1,
                           'overlay': True})
    value['variant']['slots'].append({'id': 's2', 'role': 'END', 'overlay': True})
    assert [row['slotId'] for row in narration_windows(value)] == ['s']


def test_cache_key_changes_on_trim_or_content_but_not_timeline_position() -> None:
    clip = snapshot()['clips'][0]
    assert slot_vision_key(clip) == slot_vision_key({**clip, 'start': 22, 'slotId': 'another'})
    for update in ({'offset': 2}, {'duration': 5}, {'contentHash': 'changed'}):
        assert slot_vision_key(clip) != slot_vision_key({**clip, **update})


async def test_shared_vision_singleflight_and_restart_cache(tmp_path: Path, monkeypatch: Any) -> None:
    api = AsyncMock(spec=InternalApi)
    downloads = 0
    def response(_: httpx.Request) -> httpx.Response:
        nonlocal downloads
        downloads += 1
        return httpx.Response(200, content=b'video')
    api.client = httpx.AsyncClient(base_url='http://test/', transport=httpx.MockTransport(response))
    ark = AsyncMock(spec=ArkProvider)
    async def vision(*args: Any, **kwargs: Any) -> SlotVisionOutput:
        await asyncio.sleep(.01)
        return SlotVisionOutput.model_validate({'slots': [{'slotId': 's', 'description': '画面'}]})
    ark.structured.side_effect = vision
    frames = AsyncMock(return_value=[b'a', b'b', b'c'])
    monkeypatch.setattr('effect_template_mix.packaging.slot_frames', frames)
    worker = PackagingHandler(api, ark, AsyncMock(spec=PackagingProvider), 1000)
    async def run(index: int) -> dict[str, Any]:
        cp: dict[str, Any] = {'timings': {}}
        async def save(_: str, patch: dict[str, Any]) -> None:
            cp.update(patch)
        directory = tmp_path / str(index)
        directory.mkdir()
        await worker.slot_vision(snapshot(), cp, '/item', {}, 'p', directory, AsyncMock(), save)
        return cp
    results = await asyncio.gather(run(0), run(1))
    assert downloads == frames.await_count == ark.structured.await_count == 1
    assert results[0]['slotVision'] == results[1]['slotVision']
    assert results[1]['timings']['s']['cacheHit'] is True
    worker.vision_cache = {v['key']: v['description'] for v in results[0]['slotVision'].values()}
    await run(2)
    assert ark.structured.await_count == 1
    await api.client.aclose()


@pytest.mark.parametrize('connection_failures', [0, 3])
async def test_global_tts_pool_bounds_calls_and_retains_successful_slots(connection_failures: int, monkeypatch: Any) -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'saved'}
    provider = AsyncMock(spec=PackagingProvider)
    pauses = []
    async def backoff(_: float) -> None:
        pauses.append(worker.requests._value)
        await asyncio.sleep(.001)
    monkeypatch.setattr('effect_template_mix.packaging_voice_recovery.sleep', backoff)
    active = maximum = 0
    attempts: dict[str, int] = {}
    async def voice(text: str, **__: Any) -> bytes:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(.01)
        active -= 1
        attempts[text] = attempts.get(text, 0) + 1
        if attempts[text] <= connection_failures:
            raise httpx.ConnectError('unavailable')
        return TimedVoicePcm(b'\0\0' * 24000, 0, 24000)
    provider.voice.side_effect = voice
    worker = PackagingHandler(api, AsyncMock(spec=ArkProvider), provider, 1000)
    value = snapshot()
    value['duration'] = 24
    value['variant']['slots'] = [{'id': str(i), 'role': 'PRODUCT'} for i in range(6)]
    value['clips'] = [{**snapshot()['clips'][0], 'slotId': str(i), 'start': i * 4} for i in range(6)]
    rows = [{'id': f'line-{i}', 'slotId': str(i), 'text': f'短句{i}', 'start': i * 4, 'end': i * 4 + 4, 'factIds': ['f']} for i in range(6)]
    item: dict[str, Any] = {'id': 'one', 'stage': 'VOICE', 'snapshot': value, 'checkpoint': {
        'narrationLayoutVersion': 'SLOT_V1', 'vision': [{'description': '画面'}], 'script': rows,
        'musicBrief': '器乐', 'music': {'fileObjectId': 'music', 'start': 0, 'duration': 24, 'volume': .12}}}
    other = copy.deepcopy(item)
    await asyncio.gather(worker.process_item('/r', {}, 'p', item), worker.process_item('/r', {}, 'p', other))
    assert maximum == 4 and provider.voice.await_count == 12 + 6 * connection_failures
    assert len(pauses) == 6 * connection_failures
    assert 'automaticRetries' not in item['checkpoint']
    assert len(item['checkpoint']['voices']) == len(item['checkpoint']['captions']) == 6
    await worker.process_item('/r', {}, 'p', item)
    assert provider.voice.await_count == 12 + 6 * connection_failures


@pytest.mark.parametrize('invalid_structure', [False, True])
async def test_incomplete_slot_vision_splits_without_downloading_frames_twice(tmp_path: Path, monkeypatch: Any, invalid_structure: bool) -> None:
    api, ark = AsyncMock(spec=InternalApi), AsyncMock(spec=ArkProvider)
    downloads = []
    api.client = httpx.AsyncClient(base_url='http://test/', transport=httpx.MockTransport(
        lambda req: downloads.append(req.url.path) or httpx.Response(200, content=b'video')))
    monkeypatch.setattr('effect_template_mix.packaging.slot_frames', AsyncMock(return_value=[b'a', b'b', b'c']))
    calls = []
    async def describe(content: Any, *_: Any, **__: Any) -> SlotVisionOutput:
        import json
        ids = [c['slotId'] for c in json.loads(content[0]['text'])['slots']]
        calls.append(ids)
        if len(ids) > 1:
            if invalid_structure:
                raise ProviderOutputError('invalid', retryable=False)
            raise ProviderIncompleteError('incomplete', retryable=False, split_recommended=True)
        return SlotVisionOutput.model_validate({'slots': [{'slotId': ids[0], 'description': '画面'}]})
    ark.structured.side_effect = describe
    worker = PackagingHandler(api, ark, AsyncMock(spec=PackagingProvider), 1000)
    value = snapshot(8)
    value['variant']['slots'] = [{'id': 'a'}, {'id': 'b'}]
    value['clips'] = [{**value['clips'][0], 'slotId': c, 'duration': 4, 'start': i * 4, 'contentHash': c}
                      for i, c in enumerate(['a', 'b'])]
    cp: dict[str, Any] = {'timings': {}}
    async def save(_stage: str, patch: Any) -> None:
        cp.update(patch)
    try:
        await worker.slot_vision(value, cp, '/item', {}, 'p', tmp_path, AsyncMock(), save)
        assert calls == [['a', 'b'], ['a'], ['b']] and len(downloads) == 2
        assert set(cp['slotVision']) == {'a', 'b'} and not worker.vision_pending
    finally:
        await api.client.aclose()


async def test_shared_vision_preserves_permanent_failure_and_can_be_retried(tmp_path: Path, monkeypatch: Any) -> None:
    api, ark = AsyncMock(spec=InternalApi), AsyncMock(spec=ArkProvider)
    api.client = httpx.AsyncClient(base_url='http://test/', transport=httpx.MockTransport(
        lambda _: httpx.Response(200, content=b'video')))
    monkeypatch.setattr('effect_template_mix.packaging.slot_frames', AsyncMock(return_value=[b'a']))
    async def rejected(*_: Any, **__: Any) -> None:
        await asyncio.sleep(.01)
        raise ProviderError('denied', retryable=False, status_code=401)
    ark.structured.side_effect = rejected
    worker = PackagingHandler(api, ark, AsyncMock(spec=PackagingProvider), 1000)
    async def run(index: int) -> None:
        directory = tmp_path / str(index)
        directory.mkdir()
        await worker.slot_vision(snapshot(), {'timings': {}}, '/i', {}, 'p', directory, AsyncMock(), AsyncMock())
    try:
        results = await asyncio.gather(run(0), run(1), return_exceptions=True)
        assert all(isinstance(e, ProviderError) and not e.retryable for e in results)
        assert not worker.vision_pending and not worker.vision_cache
        ark.structured.side_effect = None
        ark.structured.return_value = SlotVisionOutput.model_validate({'slots': [{'slotId': 's', 'description': '画面'}]})
        await run(2)
        assert ark.structured.await_count == 2 and len(worker.vision_cache) == 1
    finally:
        await api.client.aclose()


async def test_single_slot_vision_format_correction_is_bounded(tmp_path: Path, monkeypatch: Any) -> None:
    api, ark = AsyncMock(spec=InternalApi), AsyncMock(spec=ArkProvider)
    api.client = httpx.AsyncClient(base_url='http://test/', transport=httpx.MockTransport(
        lambda _: httpx.Response(200, content=b'video')))
    monkeypatch.setattr('effect_template_mix.packaging.slot_frames', AsyncMock(return_value=[b'a']))
    ark.structured.side_effect = [ProviderOutputError('invalid', retryable=False),
        SlotVisionOutput.model_validate({'slots': [{'slotId': 's', 'description': '合法画面'}]})]
    worker = PackagingHandler(api, ark, AsyncMock(spec=PackagingProvider), 1000)
    cp: dict[str, Any] = {'timings': {}}
    async def save(_stage: str, patch: dict[str, Any]) -> None:
        cp.update(patch)
    try:
        await worker.slot_vision(snapshot(), cp, '/i', {}, 'p', tmp_path, AsyncMock(), save)
        assert ark.structured.await_count == 2
        assert '结构校验' in ark.structured.call_args.args[0][-1]['text']
        assert cp['slotVision']['s']['description'] == '合法画面'
    finally:
        await api.client.aclose()


async def test_partial_split_vision_checkpoint_survives_failure_and_restart(tmp_path: Path, monkeypatch: Any) -> None:
    api, ark = AsyncMock(spec=InternalApi), AsyncMock(spec=ArkProvider)
    downloads: list[str] = []
    api.client = httpx.AsyncClient(base_url='http://test/', transport=httpx.MockTransport(
        lambda req: downloads.append(req.url.path) or httpx.Response(200, content=b'video')))
    monkeypatch.setattr('effect_template_mix.packaging.slot_frames', AsyncMock(return_value=[b'a']))
    calls: list[list[str]] = []
    async def describe(content: Any, *_: Any, **__: Any) -> SlotVisionOutput:
        import json
        ids = [c['slotId'] for c in json.loads(content[0]['text'])['slots']]
        calls.append(ids)
        if ids != ['a']:
            raise ProviderOutputError('invalid', retryable=False)
        return SlotVisionOutput.model_validate({'slots': [{'slotId': 'a', 'description': '已保存画面'}]})
    ark.structured.side_effect = describe
    value = snapshot(8)
    value['variant']['slots'] = [{'id': 'a'}, {'id': 'b'}]
    value['clips'] = [{**value['clips'][0], 'slotId': slot_id, 'duration': 4,
                       'start': index * 4, 'contentHash': slot_id}
                      for index, slot_id in enumerate(['a', 'b'])]
    cp: dict[str, Any] = {'timings': {}}
    async def save(_stage: str, patch: dict[str, Any]) -> None:
        cp.update(patch)
    worker = PackagingHandler(api, ark, AsyncMock(spec=PackagingProvider), 1000)
    try:
        with pytest.raises(PackagingError, match='格式修正后仍无效'):
            await worker.slot_vision(value, cp, '/i', {}, 'p', tmp_path, AsyncMock(), save)
        assert calls == [['a', 'b'], ['a'], ['b'], ['b']]
        assert set(cp['slotVision']) == {'a'} and 'vision' not in cp
        assert not worker.vision_pending
        restarted = PackagingHandler(api, ark, AsyncMock(spec=PackagingProvider), 1000)
        restarted.vision_cache = {row['key']: row['description'] for row in cp['slotVision'].values()}
        ark.structured.side_effect = None
        ark.structured.return_value = SlotVisionOutput.model_validate({'slots': [{'slotId': 'b', 'description': '恢复画面'}]})
        directory = tmp_path / 'restart'
        directory.mkdir()
        await restarted.slot_vision(value, cp, '/i', {}, 'p', directory, AsyncMock(), save)
        assert ark.structured.await_count == 5 and len(downloads) == 3
        assert set(cp['slotVision']) == {'a', 'b'} and len(cp['vision']) == 2
    finally:
        await api.client.aclose()
