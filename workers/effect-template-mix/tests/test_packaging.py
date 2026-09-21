import base64
import copy
import io
import json
import wave
from datetime import datetime, timezone
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.api import InternalApi
from effect_template_mix.packaging import PackagingHandler
from effect_template_mix.packaging_media import pcm_wav, visible_intervals
from effect_template_mix.packaging_provider import PackagingError, PackagingProvider, signed_headers
from effect_template_mix.provider import ArkProvider
from effect_template_mix.consumer import Consumer
from types import SimpleNamespace


def provider(handler: Any) -> PackagingProvider:
    return PackagingProvider('test-key', 'test-speaker', 'seed-tts-2.0', 'test-ak', 'test-sk', 'GenBGMForTime',
        httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def test_signature_is_deterministic_and_signs_the_exact_body() -> None:
    now = datetime(2026, 9, 21, tzinfo=timezone.utc)
    a = signed_headers('QuerySong', b'{"TaskID":"1"}', 'ak', 'sk', now)
    assert a == signed_headers('QuerySong', b'{"TaskID":"1"}', 'ak', 'sk', now)
    assert a['authorization'] != signed_headers('QuerySong', b'{"TaskID":"2"}', 'ak', 'sk', now)['authorization']
    assert '20260921/cn-beijing/imagination/request' in a['authorization']
    assert 'sk' not in a['authorization']


async def test_tts_sse_requires_completion_and_uses_pcm() -> None:
    def response(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body['req_params']['audio_params'] == {'format': 'pcm', 'sample_rate': 24000}
        assert request.headers['X-Api-Resource-Id'] == 'seed-tts-2.0'
        return httpx.Response(200, text='event: 352\ndata: ' + json.dumps({'code': 0, 'data': base64.b64encode(b'\x00\x00' * 24).decode()}) + '\n\ndata: {"code":20000000}\n')
    adapter = provider(response)
    assert len(await adapter.voice('测试')) == 48
    await adapter.close()
    interrupted = provider(lambda _: httpx.Response(200, text='data: {"code":0,"data":"AAA="}\n'))
    with pytest.raises(PackagingError, match='未完整结束'):
        await interrupted.voice('测试')
    await interrupted.close()


async def test_music_submit_and_query_protocol_and_no_cdn_credentials() -> None:
    requests: list[httpx.Request] = []
    def response(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        action = request.url.params.get('Action')
        if action == 'GenBGMForTime':
            assert json.loads(request.content)['Duration'] == 30
            return httpx.Response(200, json={'Code': 0, 'Result': {'TaskID': 'task-1'}})
        if action == 'QuerySong':
            assert json.loads(request.content) == {'TaskID': 'task-1'}
            return httpx.Response(200, json={'Code': 0, 'Result': {'Status': 2, 'SongDetail': {'Lyrics': '', 'AudioUrl': 'https://v1-default.douyinvod.com/audio.wav'}}})
        assert 'authorization' not in request.headers and 'X-Api-Key' not in request.headers
        return httpx.Response(200, content=b'audio')
    adapter = provider(response)
    assert await adapter.submit_music('轻快纯器乐', 12) == 'task-1'
    url = await adapter.query_music('task-1')
    assert url and await adapter.download_music(url) == b'audio'
    assert len(requests) == 3
    await adapter.close()


@pytest.mark.parametrize('status', [0, 1])
async def test_music_pending_statuses(status: int) -> None:
    adapter = provider(lambda _: httpx.Response(200, json={'Code': 0, 'Result': {'Status': status}}))
    assert await adapter.query_music('t') is None
    await adapter.close()


@pytest.mark.parametrize('song', [{'Lyrics': '歌词', 'AudioUrl': 'https://v1-default.douyinvod.com/a'}, {'AudioUrl': 'http://127.0.0.1/a'}, {'AudioUrl': 'https://evil.test/a'}])
async def test_music_rejects_lyrics_and_nonofficial_downloads(song: dict[str, str]) -> None:
    adapter = provider(lambda _: httpx.Response(200, json={'Code': 0, 'Result': {'Status': 2, 'SongDetail': song}}))
    with pytest.raises(PackagingError):
        await adapter.query_music('t')
    await adapter.close()


def test_caption_duration_comes_from_pcm_and_layer_priority_matches_player() -> None:
    data, duration = pcm_wav(b'\x00\x00' * 36_000)
    assert duration == 1.5
    with wave.open(io.BytesIO(data)) as audio:
        assert audio.getnframes() / audio.getframerate() == duration
    clips = [{'start': 1, 'duration': 3, 'lane': 2, 'id': 'low'}, {'start': 2, 'duration': 1, 'lane': 0, 'id': 'top'}]
    intervals = visible_intervals({'duration': 5, 'clips': clips})
    assert [(start, end, clip['id'] if clip else None) for start, end, clip in intervals] == [(0, 1, None), (1, 2, 'low'), (2, 3, 'top'), (3, 4, 'low'), (4, 5, None)]


def item() -> dict[str, Any]:
    return {'id': 'item', 'stage': 'VOICE', 'snapshot': {'duration': 10, 'clips': [], 'facts': []}, 'checkpoint': {
        'vision': [{'start': 0, 'end': 10, 'description': '镜头'}],
        'script': [{'id': 'line-1', 'text': '口播', 'start': 1, 'end': 5, 'factIds': ['f']}], 'musicBrief': '纯器乐',
        'music': {'fileObjectId': 'music', 'start': 0, 'duration': 10, 'volume': .12}}}


async def test_item_resume_skips_saved_voice_and_creates_exact_captions() -> None:
    api = AsyncMock(spec=InternalApi)
    ark = AsyncMock(spec=ArkProvider)
    adapter = AsyncMock(spec=PackagingProvider)
    row = item()
    row['checkpoint']['voices'] = {'line-1': {'fileObjectId': 'voice', 'start': 1, 'duration': 2.123, 'volume': 1}}
    worker = PackagingHandler(api, ark, adapter, 1000)
    await worker.process_item('/run', {}, 'project', row)
    adapter.voice.assert_not_called()
    adapter.submit_music.assert_not_called()
    ark.structured.assert_not_called()
    assert row['checkpoint']['captions'] == [{'id': 'line-1', 'text': '口播', 'start': 1, 'end': 3.123}]
    assert row['stage'] == 'READY'


async def test_unknown_music_submission_never_auto_resubmits() -> None:
    api = AsyncMock(spec=InternalApi)
    adapter = AsyncMock(spec=PackagingProvider)
    row = item()
    row['checkpoint'].pop('music')
    row['checkpoint']['voices'] = {'line-1': {'fileObjectId': 'voice', 'start': 1, 'duration': 2, 'volume': 1}}
    row['checkpoint']['musicSubmissionPending'] = True
    with pytest.raises(PackagingError, match='不会重复计费'):
        await PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000).process_item('/run', {}, 'project', row)
    adapter.submit_music.assert_not_called()


async def test_tts_overrun_is_not_silently_truncated() -> None:
    api = AsyncMock(spec=InternalApi)
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.voice.return_value = b'\0\0' * 24_000 * 12
    with pytest.raises(PackagingError, match='真实配音超出'):
        await PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000).process_item('/run', {}, 'project', item())
    assert not any(call.args[0] == 'POST' for call in api.request.call_args_list)


@pytest.mark.parametrize('count', [1, 10, 100])
async def test_run_resume_handles_each_missing_item_only(count: int) -> None:
    api = AsyncMock(spec=InternalApi)
    api.ROOT = 'internal/workers/effect-template-mix'
    rows = [dict(item(), id=f'item-{i}', status='COMPLETED' if i % 2 else 'QUEUED') for i in range(count)]
    api.request.return_value = {'terminal': False, 'attemptToken': 'token', 'items': copy.deepcopy(rows)}
    worker = PackagingHandler(api, AsyncMock(spec=ArkProvider), AsyncMock(spec=PackagingProvider), 1000)
    worker.process_item = AsyncMock()  # type: ignore[method-assign]
    message = AsyncMock()
    await worker.handle(message, {'projectId': '11111111-1111-4111-8111-111111111111', 'runId': '22222222-2222-4222-8222-222222222222'})
    assert worker.process_item.await_count == (count + 1) // 2
    message.ack.assert_awaited_once()
    message.nack.assert_not_called()


async def test_missing_configuration_fails_without_calling_ark() -> None:
    adapter = PackagingProvider('', '', 'seed-tts-2.0', '', '', 'GenBGMForTime')
    with pytest.raises(PackagingError, match='未配置'):
        adapter.require_configuration()
    await adapter.close()


async def test_one_consumer_routes_legacy_and_packaging_without_cross_claims() -> None:
    api = AsyncMock(spec=InternalApi)
    api.claim.return_value = SimpleNamespace(terminal=True)
    packaging = AsyncMock(spec=PackagingHandler)
    worker = Consumer('amqp://test', 'effect.template-mix.requested', api, AsyncMock(spec=ArkProvider), 1000, 10, 16000, 8192, 2, packaging)
    legacy = AsyncMock()
    legacy.body = json.dumps({'schemaVersion': 1, 'projectId': 'p', 'runId': 'r', 'requestId': 'id'}).encode()
    await worker.handle(legacy)
    api.claim.assert_awaited_once_with('p', 'r')
    packaging.handle.assert_not_called()
    modern = AsyncMock()
    modern.body = json.dumps({'schemaVersion': 2, 'taskType': 'PACKAGING', 'projectId': 'p', 'runId': 'r2', 'requestId': 'id2'}).encode()
    await worker.handle(modern)
    packaging.handle.assert_awaited_once()
    assert api.claim.await_count == 1
