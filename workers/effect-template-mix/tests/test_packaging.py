import asyncio
import base64
import copy
import hashlib
import io
import json
import wave
from datetime import datetime, timezone
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.api import ApiError, InternalApi
from effect_template_mix.packaging import PackagingHandler, ScriptOutput, ScriptRow, VisionOutput, plan_script, script_structure_issues, shorten_voice_line, valid_vision, vision_frame_windows, valid_frame_vision
from effect_template_mix.packaging_media import pcm_wav, visible_intervals
from effect_template_mix.packaging_provider import MusicTaskFailed, PackagingError, PackagingProvider, PackagingTransientError, signed_headers
from effect_template_mix.provider import ArkProvider
from effect_template_mix.consumer import Consumer
from effect_template_mix.packaging import FrameVisionOutput, NarrationPlan, NarrationRepair, materialize_script, narration_windows, run_packaging_shards, safe_error_chain, understand_frames
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


async def test_music_terminal_failure_is_distinct_from_a_reply_we_cannot_read() -> None:
    def answering(status: Any) -> PackagingProvider:
        return provider(lambda _: httpx.Response(200, json={'Code': 0, 'Result': {'TaskID': 't', 'Status': status}}))
    dead = answering(3)
    with pytest.raises(MusicTaskFailed):
        await dead.query_music('t')
    await dead.close()
    # Only an explicit failure may spend a new submission; an unknown or missing status keeps the
    # saved TaskID so the poller retries instead of paying for a song that may still be running.
    for status in (9, None, '2'):
        unknown = answering(status)
        with pytest.raises(PackagingTransientError, match='保留原任务'):
            await unknown.query_music('t')
        await unknown.close()


async def test_music_missing_service_reports_actionable_safe_error(caplog: Any) -> None:
    adapter = provider(lambda _: httpx.Response(200, json={'Code': 200028, 'Message': 'secret-original-response',
        'ResponseMetadata': {'RequestId': 'safe-request-id', 'Error': {'Code': 'APINoSource', 'Message': 'secret'}}}))
    with pytest.raises(PackagingError, match='AK 所属账号.*计费模式'):
        await adapter.submit_music('纯器乐', 32)
    assert 'safe-request-id' in caplog.text
    assert 'secret' not in caplog.text
    await adapter.close()


async def test_paid_script_request_does_not_hide_extra_transport_attempts() -> None:
    calls = 0
    def response(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={'output_text': 'not-json'})
    ark = ArkProvider('https://test.invalid', 'key', 'model', 1, 8192, 'minimal')
    await ark.client.aclose()
    ark.client = httpx.AsyncClient(base_url='https://test.invalid/', transport=httpx.MockTransport(response))
    from effect_template_mix.provider import ProviderError
    with pytest.raises(ProviderError):
        await ark.structured([], ScriptOutput, 'packaging_script', max_output_tokens=8192, max_attempts=1)
    assert calls == 1
    await ark.close()


async def test_incomplete_packaging_script_reports_safe_capacity_reason(caplog: Any) -> None:
    ark = ArkProvider('https://test.invalid', 'secret-key', 'model', 1, 8192, 'minimal')
    await ark.client.aclose()
    ark.client = httpx.AsyncClient(base_url='https://test.invalid/', transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json={'status': 'incomplete', 'output_text': 'private-response'},
                                headers={'x-request-id': 'audit-id'})))
    from effect_template_mix.provider import ProviderError
    with pytest.raises(ProviderError, match='超过当前分片容量'):
        await ark.structured([], ScriptOutput, 'packaging_script', max_output_tokens=8192, max_attempts=1)
    assert 'token_budget=8192' in caplog.text and 'audit-id' in caplog.text
    assert 'private-response' not in caplog.text and 'secret-key' not in caplog.text
    await ark.close()


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
    return {'id': 'item', 'stage': 'VOICE', 'snapshot': {'narrationLayoutVersion': 'SLOT_V1',
        'variant': {'slots': [{'id': 's1', 'role': 'PRODUCT'}]},
        'duration': 10, 'clips': [{'slotId': 's1', 'start': 1, 'duration': 4}], 'facts': []}, 'checkpoint': {
        'narrationLayoutVersion': 'SLOT_V1',
        'vision': [{'start': 0, 'end': 10, 'description': '镜头'}],
        'script': [{'id': 'line-1', 'slotId': 's1', 'text': '口播', 'start': 1, 'end': 5, 'factIds': ['f']}], 'musicBrief': '纯器乐',
        'music': {'fileObjectId': 'music', 'start': 0, 'duration': 10, 'volume': .12}}}


async def test_vision_assigns_exact_windows_even_when_model_returns_reverse_order() -> None:
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = FrameVisionOutput.model_validate({'frames': [
        {'frameIndex': 1, 'description': '后图'}, {'frameIndex': 0, 'description': '前图'}]})
    guard = AsyncMock()
    result = await understand_frames(ark, {'duration': 4, 'clips': []}, [(1, b'a'), (3, b'b')], guard)
    assert result == [{'start': 0, 'end': 2, 'description': '前图'}, {'start': 2, 'end': 4, 'description': '后图'}]
    guard.assert_awaited_once()
    assert ark.structured.call_args.kwargs['max_attempts'] == 1


async def test_vision_repairs_duplicate_ids_once_without_accepting_guessed_times() -> None:
    ark = AsyncMock(spec=ArkProvider)
    invalid = FrameVisionOutput.model_validate({'frames': [{'frameIndex': 0, 'description': '重复'}] * 2})
    valid = FrameVisionOutput.model_validate({'frames': [
        {'frameIndex': 0, 'description': '前图'}, {'frameIndex': 1, 'description': '后图'}]})
    ark.structured.side_effect = [invalid, valid]
    guard = AsyncMock()
    result = await understand_frames(ark, {'duration': 4, 'clips': []}, [(1, b'a'), (3, b'b')], guard)
    assert len(result) == 2 and guard.await_count == 2
    ark.structured.side_effect = [invalid, invalid]
    with pytest.raises(PackagingError, match='修正后仍无效'):
        await understand_frames(ark, {'duration': 4, 'clips': []}, [(1, b'a'), (3, b'b')], guard)
    assert ark.structured.await_count == 4


async def test_vision_cancellation_between_groups_prevents_next_paid_request() -> None:
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = FrameVisionOutput.model_validate({'frames': [
        {'frameIndex': i, 'description': '帧'} for i in range(8)]})
    guard = AsyncMock(side_effect=[None, RuntimeError('cancelled')])
    with pytest.raises(RuntimeError, match='cancelled'):
        await understand_frames(ark, {'duration': 9, 'clips': []}, [(i + .5, b'a') for i in range(9)], guard)
    assert ark.structured.await_count == 1


def script_result(**updates: Any) -> ScriptOutput:
    line = {'id': 'line-1', 'slotId': 's1', 'text': '已确认事实', 'start': 0, 'end': 10, 'factIds': ['facts:0']}
    return ScriptOutput.model_validate({'lines': [{**line, **updates}], 'musicBrief': '轻快纯器乐'})


def script_snapshot() -> dict[str, Any]:
    return {'duration': 10, 'variant': {'slots': [{'id': 's1', 'role': 'PRODUCT'}]},
        'clips': [{'slotId': 's1', 'start': 0, 'duration': 10}], 'facts': [{'id': 'facts:0', 'text': '已确认事实'}]}


def plan_result(**updates: Any) -> NarrationPlan:
    return NarrationPlan.model_validate({'lines': [{'id': 'line-1', 'slotId': 's1',
        'text': '依据已确认商品信息，结合当前画面自然讲解这款商品的真实特点。', 'factIds': ['facts:0'], **updates}], 'musicBrief': '轻快纯器乐'})


def test_narration_window_materialization_has_no_model_timing_or_order_dependency() -> None:
    snapshot = script_snapshot()
    snapshot['clips'].append({'slotId': 's2', 'start': 10, 'duration': 4})
    snapshot['variant']['slots'].append({'id': 's2', 'role': 'END'})
    windows = narration_windows(snapshot)
    assert len(windows) == 2 and windows[0]['maxCharacters'] == 39
    plan = NarrationPlan(lines=[*plan_result(slotId='s2').lines, *plan_result(id='line-2').lines], musicBrief='纯音乐')
    result = materialize_script(plan, windows)
    assert [(r.start, r.end) for r in result.lines] == [(0, 10), (10, 14)]


@pytest.mark.parametrize(('duration', 'valid'), [(3.999, False), (4, True), (15, True), (15.001, False)])
def test_narration_window_four_second_minimum(duration: float, valid: bool) -> None:
    snapshot = script_snapshot()
    snapshot['clips'][0]['duration'] = duration
    snapshot['duration'] = duration
    if valid:
        assert narration_windows(snapshot)[0]['end'] == duration
    else:
        with pytest.raises(PackagingError, match='4–15'):
            narration_windows(snapshot)


@pytest.mark.parametrize('index', [-1, 4])
def test_narration_invalid_window_is_not_silently_clamped(index: int) -> None:
    with pytest.raises(PackagingError, match='槽位'):
        materialize_script(plan_result(slotId=str(index)), narration_windows(script_snapshot()))


async def test_narration_duplicate_windows_get_one_mechanical_repair() -> None:
    ark = AsyncMock(spec=ArkProvider)
    duplicate = NarrationPlan(lines=[*plan_result().lines, *plan_result(id='line-2').lines], musicBrief='纯音乐')
    ark.structured.side_effect = [duplicate, NarrationRepair(lines=plan_result().lines)]
    result = await plan_script(ark, script_snapshot(), [], AsyncMock())
    assert result.lines[0].start == 0 and result.lines[0].end == 10
    assert [call.args[2] for call in ark.structured.call_args_list] == ['packaging_script', 'packaging_script_repair']
    ark.structured.side_effect = [duplicate, NarrationRepair(lines=duplicate.lines)]
    with pytest.raises(PackagingError, match='定点修正未覆盖'):
        await plan_script(ark, script_snapshot(), [], AsyncMock())


async def test_narration_ignores_extra_unbound_model_row_without_losing_real_slot() -> None:
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = NarrationPlan(lines=[*plan_result().lines,
        *plan_result(id='unexpected', slotId='not-a-real-slot').lines], musicBrief='纯器乐')
    result = await plan_script(ark, script_snapshot(), [], AsyncMock())
    assert [line.slotId for line in result.lines] == ['s1']
    assert ark.structured.await_count == 1


@pytest.mark.parametrize(('start', 'end', 'description', 'valid'), [
    (0, 32, '画面动作', True), (-1, 3, '画面', False), (29, 35, '画面', False),
    (3, 3, '画面', False), (0, float('nan'), '画面', False), (0, 3, '', False),
])
def test_vision_intervals_are_validated_before_api_write(start: float, end: float, description: str, valid: bool) -> None:
    result = VisionOutput.model_validate({'scenes': [{'start': start, 'end': end, 'description': description}]})
    assert valid_vision(result, 32) is valid


def test_frame_windows_cover_real_cuts_without_overlap_or_cross_group_extension() -> None:
    snapshot = {'duration': 32, 'clips': [{'start': 0, 'duration': 29, 'lane': 0}, {'start': 29, 'duration': 3, 'lane': 0}]}
    windows = vision_frame_windows(snapshot, [1, 10, 28, 30.5, 30.667])
    assert windows == [(0, 5.5), (5.5, 19), (19, 29), (29, 30.5835), (30.5835, 32)]
    result = VisionOutput.model_validate({'scenes': [{'start': a, 'end': b, 'description': '对应帧'} for a, b in windows]})
    assert valid_frame_vision(result, 32, windows)
    result.scenes[2].end = 32  # Historical bug: pizza extended over the final rice-food clip.
    assert not valid_frame_vision(result, 32, windows)


def test_frame_windows_reject_missing_coverage_and_description_rows() -> None:
    snapshot = {'duration': 5, 'clips': [{'start': 1, 'duration': 4, 'lane': 0}]}
    with pytest.raises(PackagingError, match='未覆盖'):
        vision_frame_windows(snapshot, [2])
    assert not valid_frame_vision(VisionOutput(scenes=[]), 5, [(0, 1)])


@pytest.mark.parametrize(('updates', 'code'), [
    ({'factIds': []}, 'FACT_REFERENCE'),
    ({'factIds': ['invented']}, 'FACT_REFERENCE'),
    ({'start': -1}, 'TIME_BOUNDARY'),
    ({'end': 11}, 'TIME_BOUNDARY'),
    ({'end': float('nan')}, 'TIME_BOUNDARY'),
    ({'id': '句1'}, 'LINE_ID'),
    ({'text': ''}, 'LINE_TEXT'),
])
def test_script_preflight_rejects_bad_structure(updates: dict[str, Any], code: str) -> None:
    assert code in script_structure_issues(script_result(**updates), script_snapshot())


async def test_script_repairs_missing_fact_ids_without_audit() -> None:
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.side_effect = [plan_result(factIds=[]), NarrationRepair(lines=plan_result().lines)]
    guard = AsyncMock()
    result = await plan_script(ark, script_snapshot(), [], guard)
    assert result.lines[0].factIds == ['facts:0']
    assert [call.args[2] for call in ark.structured.call_args_list] == ['packaging_script', 'packaging_script_repair']
    repaired = json.loads(ark.structured.call_args_list[1].args[0][0]['text'])
    assert repaired['narrationWindows'][0]['slotId'] == 's1'
    assert repaired['measuredCharacters'][0]['slotId'] == 's1'
    assert repaired['validationErrors'][0]['reason'] == 'FACT_IDS'
    assert guard.await_count == 2


async def test_short_slot_text_is_soft_guidance_not_a_paid_repair_trigger() -> None:
    snapshot = script_snapshot()
    snapshot['duration'] = 20
    snapshot['clips'].append({'slotId': 's2', 'start': 10, 'duration': 10})
    snapshot['variant']['slots'].append({'id': 's2', 'role': 'PRODUCT'})
    good = plan_result().lines[0]
    short = good.model_copy(update={'id': 'line-2', 'slotId': 's2', 'text': '太短'})
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = NarrationPlan(lines=[good, short], musicBrief='纯器乐')
    diagnostics: dict[str, int] = {}
    result = await plan_script(ark, snapshot, [], AsyncMock(), diagnostics)
    assert result.lines[0].text == good.text
    assert result.lines[1].text == '太短'
    assert [(r.start, r.end) for r in result.lines] == [(0, 10), (10, 20)]
    assert ark.structured.await_count == 1
    assert diagnostics == {'scriptRepairSlots': 0}


async def test_script_second_repair_only_revisits_remaining_invalid_fact_slot() -> None:
    ark = AsyncMock(spec=ArkProvider)
    short = plan_result(factIds=['invented'])
    still_short = NarrationRepair(lines=plan_result(factIds=[]).lines)
    complete = NarrationRepair(lines=plan_result().lines)
    ark.structured.side_effect = [short, still_short, complete]
    result = await plan_script(ark, script_snapshot(), [], AsyncMock())
    assert result.lines[0].text == complete.lines[0].text
    assert [call.args[2] for call in ark.structured.call_args_list] == [
        'packaging_script', 'packaging_script_repair', 'packaging_script_repair']
    second_input = json.loads(ark.structured.call_args_list[2].args[0][0]['text'])
    assert second_input['repairAttempt'] == 2
    assert second_input['validationErrors'][0]['reason'] == 'FACT_IDS'


async def test_script_cancel_before_revision_stops_new_model_requests() -> None:
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = plan_result(factIds=[])
    guard = AsyncMock(side_effect=[None, RuntimeError('cancelled')])
    with pytest.raises(RuntimeError, match='cancelled'):
        await plan_script(ark, script_snapshot(), [], guard)
    assert ark.structured.await_count == 1


def test_planning_length_is_soft_but_slot_boundaries_remain_hard() -> None:
    assert script_structure_issues(script_result(text='简短解说'), script_snapshot()) == []
    script = script_result(text='这是超过短窗口的较长中文口播句子', start=8, end=10)
    assert script_structure_issues(script, script_snapshot()) == ['TIME_BOUNDARY']


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
    assert row['checkpoint']['captionLayoutVersion'] == 'SEGMENT_V2'
    assert row['checkpoint']['captions'] == [{
        'id': row['checkpoint']['captions'][0]['id'], 'voiceLineId': 'line-1',
        'segmentIndex': 0, 'segmentCount': 1,
        'text': '口播', 'start': 1, 'end': 3.123}]
    assert row['stage'] == 'READY'


async def test_music_wait_overlaps_tts_and_reuses_both_checkpoints(monkeypatch: Any) -> None:
    from effect_template_mix import packaging
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'saved-audio'}
    adapter = AsyncMock(spec=PackagingProvider)
    voice_started, music_started = asyncio.Event(), asyncio.Event()

    async def voice(_: str) -> bytes:
        voice_started.set()
        await asyncio.wait_for(music_started.wait(), 1)
        return b'\0\0' * 24_000 * 2

    async def submit_music(_: str, __: float) -> str:
        music_started.set()
        await asyncio.wait_for(voice_started.wait(), 1)
        return 'task-1'

    adapter.voice.side_effect = voice
    adapter.submit_music.side_effect = submit_music
    adapter.query_music.return_value = 'https://example.test/music.wav'
    adapter.download_music.return_value = b'music'

    async def converted(*_: Any) -> bytes:
        return b'RIFF-test-wav'

    monkeypatch.setattr(packaging, 'music_wav', converted)
    row = item()
    row['checkpoint'].pop('music')
    worker = PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000)
    await asyncio.wait_for(worker.process_item('/run', {}, 'project', row), 2)
    assert row['stage'] == 'READY'
    assert row['checkpoint']['musicTaskId'] == 'task-1'
    assert len(row['checkpoint']['voices']) == 1
    await worker.process_item('/run', {}, 'project', row)
    assert adapter.submit_music.await_count == adapter.voice.await_count == 1


async def test_dead_music_task_is_forgotten_so_recovery_submits_a_new_song(monkeypatch: Any) -> None:
    from effect_template_mix import packaging
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'saved-audio'}
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.query_music.side_effect = MusicTaskFailed('纯音乐生成失败，请重做本条音乐')
    row = item()
    row['checkpoint'].pop('music')
    row['checkpoint']['voices'] = {'line-1': {'fileObjectId': 'voice', 'start': 1, 'duration': 2, 'volume': 1}}
    row['checkpoint']['musicTaskId'] = 'dead-task'
    worker = PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000)
    with pytest.raises(MusicTaskFailed):
        await worker.process_item('/run', {}, 'project', row)
    # The dead id is dropped, so the next attempt submits rather than replaying the same verdict.
    assert row['checkpoint']['musicTaskId'] is None
    assert row['stage'] == 'MUSIC'
    adapter.submit_music.assert_not_called()

    async def converted(*_: Any) -> bytes:
        return b'RIFF-test-wav'

    monkeypatch.setattr(packaging, 'music_wav', converted)
    adapter.submit_music.return_value = 'fresh-task'
    adapter.query_music.side_effect = None
    adapter.query_music.return_value = 'https://example.test/music.wav'
    adapter.download_music.return_value = b'music'
    await worker.process_item('/run', {}, 'project', row)
    adapter.submit_music.assert_awaited_once()
    assert row['checkpoint']['musicTaskId'] == 'fresh-task'
    assert row['stage'] == 'READY'
    item_timings = row['checkpoint']['timings']['_item']
    for metric in ('musicWaitSeconds', 'musicDownloadSeconds', 'musicPreprocessQueueSeconds',
                   'musicTranscodeSeconds', 'musicUploadSeconds', 'apiHeartbeatSeconds',
                   'checkpointSeconds', 'captionSeconds'):
        assert item_timings[metric] >= 0


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
    ark = AsyncMock(spec=ArkProvider)
    row = item()
    row['snapshot']['facts'] = [{'id': 'f', 'text': '事实'}]
    ark.structured.side_effect = [
        ScriptRow(**{**row['checkpoint']['script'][0], 'text': '播'}),
        NarrationPlan.model_validate({'lines': [{'id': 'replanned', 'slotId': 's1', 'text': '新句',
            'factIds': ['f']}], 'musicBrief': '纯器乐'}),
        ScriptRow(**{**row['checkpoint']['script'][0],
            'id': 'slot-' + hashlib.sha256(b's1').hexdigest()[:24], 'text': '新'}),
    ]
    with pytest.raises(PackagingError, match='缩句一次后仍超出'):
        await PackagingHandler(api, ark, adapter, 1000).process_item('/run', {}, 'project', row)
    assert adapter.voice.await_count == 4
    assert ark.structured.await_count == 3
    assert row['checkpoint']['voiceSlotRetries'] == {'s1': 1}
    assert not any(call.args[0] == 'POST' for call in api.request.call_args_list)


async def test_voice_fit_auto_replans_only_failed_slot_and_preserves_siblings() -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'saved-voice'}
    adapter = AsyncMock(spec=PackagingProvider)
    calls: list[str] = []

    async def voice(text: str, **_: Any) -> bytes:
        calls.append(text)
        return b'\0\0' * 24_000 * (12 if text in ('超长的口播文案', '缩短口播') else 2)

    adapter.voice.side_effect = voice
    ark = AsyncMock(spec=ArkProvider)
    row = item()
    row['snapshot']['facts'] = [{'id': 'f', 'text': '事实'}]
    row['checkpoint']['script'][0]['text'] = '超长的口播文案'
    row['snapshot']['variant']['slots'].append({'id': 's2', 'role': 'END'})
    row['snapshot']['clips'].append({'slotId': 's2', 'start': 5, 'duration': 4})
    row['checkpoint']['script'].append({'id': 'line-2', 'slotId': 's2', 'text': '已存口播',
        'start': 5, 'end': 9, 'factIds': ['f']})
    row['checkpoint']['voices'] = {'line-2': {'fileObjectId': 'existing', 'start': 5,
        'duration': 1, 'volume': 1, 'segmentFrames': [24_000]}}
    ark.structured.side_effect = [
        ScriptRow(**{**row['checkpoint']['script'][0], 'text': '缩短口播'}),
        NarrationPlan.model_validate({'lines': [{'id': 'replanned', 'slotId': 's1', 'text': '新短句',
            'factIds': ['f']}], 'musicBrief': '纯器乐'}),
    ]
    await PackagingHandler(api, ark, adapter, 1000).process_item('/run', {}, 'project', row)
    assert row['stage'] == 'READY'
    assert calls == ['超长的口播文案', '缩短口播', '新短句']
    assert row['checkpoint']['voiceSlotRetries'] == {'s1': 1}
    assert row['checkpoint']['voices']['line-2']['fileObjectId'] == 'existing'
    assert row['checkpoint']['music']['fileObjectId'] == 'music'
    assert row['checkpoint']['script'][0]['text'] == '新短句'
    assert row['checkpoint']['captionLayoutVersion'] == 'SEGMENT_V3'
    adapter.submit_music.assert_not_called()


async def test_voice_fit_keeps_existing_audio_and_aligns_caption_to_measured_repair() -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'repaired-voice'}
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.voice.side_effect = [b'\0\0' * 24_000 * 12, b'\0\0' * 24_000 * 2]
    ark = AsyncMock(spec=ArkProvider)
    row = item()
    row['snapshot']['facts'] = [{'id': 'f', 'text': '事实'}]
    row['snapshot']['clips'][0]['start'] = 4
    row['checkpoint']['script'][0].update(start=4, end=8)
    row['snapshot']['clips'].insert(0, {'slotId': 'previous', 'start': 0, 'duration': 4})
    row['snapshot']['variant']['slots'].insert(0, {'id': 'previous', 'role': 'HOOK'})
    previous = {'id': 'previous', 'slotId': 'previous', 'text': '前句', 'start': 0, 'end': 4, 'factIds': ['f']}
    row['checkpoint']['script'].insert(0, previous)
    row['checkpoint']['voices'] = {'previous': {'fileObjectId': 'saved', 'start': 0, 'duration': .5, 'volume': 1}}
    ark.structured.side_effect = [ScriptRow(**{**row['checkpoint']['script'][1], 'text': '播'})]
    await PackagingHandler(api, ark, adapter, 1000).process_item('/run', {}, 'project', row)
    assert row['stage'] == 'READY'
    assert row['checkpoint']['script'][0] == previous
    assert row['checkpoint']['voices']['previous']['fileObjectId'] == 'saved'
    assert row['checkpoint']['captions'][1] == {
        'id': row['checkpoint']['captions'][1]['id'], 'voiceLineId': 'line-1',
        'segmentIndex': 0, 'segmentCount': 1,
        'text': '播', 'start': 4, 'end': 6}
    assert ark.structured.await_count == 1
    assert ark.structured.call_args.args[2] == 'packaging_voice_fit'
    adapter.submit_music.assert_not_called()


@pytest.mark.parametrize('change', [{'id': 'different'}, {'start': 2}, {'factIds': ['invented']}])
async def test_voice_fit_rejects_changed_identity_timing_and_facts(change: dict[str, Any]) -> None:
    row = item()
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = ScriptRow(**{**row['checkpoint']['script'][0], **change})
    with pytest.raises(PackagingError, match='身份、时间或来源'):
        await shorten_voice_line(ark, row['snapshot'], row['checkpoint'], 0, 12, 9, AsyncMock())
    assert ark.structured.await_count == 1


async def test_voice_fit_cancel_before_model_does_not_pay() -> None:
    row = item()
    ark = AsyncMock(spec=ArkProvider)
    with pytest.raises(RuntimeError, match='cancelled'):
        await shorten_voice_line(ark, row['snapshot'], row['checkpoint'], 0, 12, 9,
                                 AsyncMock(side_effect=RuntimeError('cancelled')))
    ark.structured.assert_not_called()


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


async def test_hundred_items_refill_four_global_slots_without_shard_barriers() -> None:
    active = maximum = 0
    launched: list[int] = []
    finished: list[int] = []
    later_before_first_finished = False
    release_first = asyncio.Event()

    async def execute(row: dict[str, Any]) -> None:
        nonlocal active, maximum, later_before_first_finished
        active += 1
        maximum = max(maximum, active)
        launched.append(row['index'])
        if row['index'] >= 4 and 0 not in finished:
            later_before_first_finished = True
            release_first.set()
        if row['index'] == 0:
            await release_first.wait()
        else:
            await asyncio.sleep(0)
        active -= 1
        finished.append(row['index'])

    rows = [{'index': i, 'shardIndex': i // 4, 'status': 'QUEUED'} for i in range(100)]
    await asyncio.wait_for(run_packaging_shards(rows, 4, execute), 2)
    assert maximum == 4
    assert len(launched) == len(set(launched)) == 100
    assert later_before_first_finished  # Later shards start before a slow first item finishes.


async def test_packaging_pool_can_use_six_items_without_crossing_its_limit() -> None:
    active = maximum = 0

    async def execute(_row: dict[str, Any]) -> None:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(.001)
        active -= 1

    rows = [{'shardIndex': index // 4, 'status': 'QUEUED'} for index in range(100)]
    await run_packaging_shards(rows, 6, execute)
    assert maximum == 6


def test_nested_run_error_log_contains_types_and_status_not_provider_payload() -> None:
    error = ExceptionGroup('sensitive payload', [ApiError('secret-url', retryable=True, status_code=502)])
    assert safe_error_chain(error) == 'ApiError(502)'


def test_packaging_uses_independent_model_and_voice_limits() -> None:
    worker = PackagingHandler(AsyncMock(spec=InternalApi), AsyncMock(spec=ArkProvider),
        AsyncMock(spec=PackagingProvider), 1000, concurrency=6, model_concurrency=3, tts_concurrency=8)
    assert worker.concurrency == 6
    assert worker.model_requests._value == 3
    assert worker.requests._value == 8
    assert worker.preprocessing._value == 2


async def test_missing_configuration_fails_without_calling_ark() -> None:
    adapter = PackagingProvider('', '', 'seed-tts-2.0', '', '', 'GenBGMForTime')
    with pytest.raises(PackagingError, match='未配置'):
        adapter.require_configuration()
    await adapter.close()


async def test_one_consumer_routes_legacy_and_packaging_without_cross_claims() -> None:
    api = AsyncMock(spec=InternalApi)
    api.claim.return_value = SimpleNamespace(terminal=True)
    packaging = AsyncMock(spec=PackagingHandler)
    packaging.requests = asyncio.Semaphore(2)
    final_output = AsyncMock()
    worker = Consumer('amqp://test', 'effect.template-mix.requested', api, AsyncMock(spec=ArkProvider), 1000, 10, 16000, 8192, 2, packaging, final_output)
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
    output = AsyncMock()
    output.body = json.dumps({'schemaVersion': 2, 'taskType': 'FINAL_OUTPUT', 'projectId': 'p', 'runId': 'r3', 'requestId': 'id3'}).encode()
    await worker.handle(output)
    final_output.handle.assert_awaited_once()
    packaging.handle.assert_awaited_once()
    assert api.claim.await_count == 1
