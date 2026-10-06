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


async def test_global_tts_pool_bounds_calls_and_retains_successful_slots() -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'saved'}
    provider = AsyncMock(spec=PackagingProvider)
    active = maximum = 0
    async def voice(_: str, **__: Any) -> bytes:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(.01)
        active -= 1
        return TimedVoicePcm(b'\0\0' * 24000, 0, 24000)
    provider.voice.side_effect = voice
    worker = PackagingHandler(api, AsyncMock(spec=ArkProvider), provider, 1000)
    value = snapshot()
    value['duration'] = 24
    value['variant']['slots'] = [{'id': str(i), 'role': 'PRODUCT'} for i in range(6)]
    value['clips'] = [{**snapshot()['clips'][0], 'slotId': str(i), 'start': i * 4} for i in range(6)]
    rows = [{'id': f'line-{i}', 'slotId': str(i), 'text': '短句', 'start': i * 4, 'end': i * 4 + 4, 'factIds': ['f']} for i in range(6)]
    item: dict[str, Any] = {'id': 'one', 'stage': 'VOICE', 'snapshot': value, 'checkpoint': {
        'narrationLayoutVersion': 'SLOT_V1', 'vision': [{'description': '画面'}], 'script': rows,
        'musicBrief': '器乐', 'music': {'fileObjectId': 'music', 'start': 0, 'duration': 24, 'volume': .12}}}
    other = copy.deepcopy(item)
    await asyncio.gather(worker.process_item('/r', {}, 'p', item), worker.process_item('/r', {}, 'p', other))
    assert maximum == 4 and provider.voice.await_count == 12
    assert len(item['checkpoint']['voices']) == len(item['checkpoint']['captions']) == 6
    await worker.process_item('/r', {}, 'p', item)
    assert provider.voice.await_count == 12
