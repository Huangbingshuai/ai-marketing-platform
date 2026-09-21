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
from effect_template_mix.packaging import PackagingHandler, ScriptAudit, ScriptAuditIssue, ScriptOutput, ScriptRow, VisionOutput, plan_script, script_structure_issues, shorten_voice_line, valid_vision
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


def script_result(**updates: Any) -> ScriptOutput:
    line = {'id': 'line-1', 'text': '已确认事实', 'start': 0, 'end': 4, 'factIds': ['facts:0']}
    return ScriptOutput.model_validate({'lines': [{**line, **updates}], 'musicBrief': '轻快纯器乐'})


def script_snapshot() -> dict[str, Any]:
    return {'duration': 10, 'clips': [], 'facts': [{'id': 'facts:0', 'text': '已确认事实'}]}


@pytest.mark.parametrize(('start', 'end', 'description', 'valid'), [
    (0, 32, '画面动作', True), (-1, 3, '画面', False), (29, 35, '画面', False),
    (3, 3, '画面', False), (0, float('nan'), '画面', False), (0, 3, '', False),
])
def test_vision_intervals_are_validated_before_api_write(start: float, end: float, description: str, valid: bool) -> None:
    result = VisionOutput.model_validate({'scenes': [{'start': start, 'end': end, 'description': description}]})
    assert valid_vision(result, 32) is valid


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


async def test_script_repairs_missing_fact_ids_before_paying_for_audit() -> None:
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.side_effect = [script_result(factIds=[]), script_result(),
        ScriptAudit(supported=True, coherent=True, issues=[])]
    guard = AsyncMock()
    result = await plan_script(ark, script_snapshot(), [], guard)
    assert result.lines[0].factIds == ['facts:0']
    assert [call.args[2] for call in ark.structured.call_args_list] == ['packaging_script', 'packaging_script', 'packaging_audit']
    repaired = json.loads(ark.structured.call_args_list[1].args[0][0]['text'])
    assert repaired['revision']['issues'] == ['FACT_REFERENCE']
    assert guard.await_count == 3


async def test_script_repairs_audit_rejection_once_without_relaxing_facts() -> None:
    ark = AsyncMock(spec=ArkProvider)
    issue = ScriptAuditIssue(lineId='line-1', code='INCORRECT_FACT_REFERENCE', explanation='引用指向另一事实', correction='只使用正确事实的原样 ID')
    ark.structured.side_effect = [script_result(), ScriptAudit(supported=False, coherent=True, issues=[issue]),
        script_result(), ScriptAudit(supported=True, coherent=True, issues=[])]
    await plan_script(ark, script_snapshot(), [], AsyncMock())
    revised = json.loads(ark.structured.call_args_list[2].args[0][0]['text'])
    assert revised['confirmedFacts'] == script_snapshot()['facts']
    assert revised['revision']['issues'] == ['INCORRECT_FACT_REFERENCE']
    assert revised['revision']['audit'][0]['correction'] == issue.correction
    assert ark.structured.await_count == 4


async def test_script_repeated_audit_failure_stops_with_safe_reason() -> None:
    ark = AsyncMock(spec=ArkProvider)
    issue = ScriptAuditIssue(lineId='line-1', code='UNSUPPORTED_FACT', explanation='无确认依据', correction='删除这条声称')
    ark.structured.side_effect = [script_result(), ScriptAudit(supported=False, coherent=True, issues=[issue])] * 2
    with pytest.raises(PackagingError, match='一次修正.*商品声明缺少事实支持'):
        await plan_script(ark, script_snapshot(), [], AsyncMock())
    assert ark.structured.await_count == 4


async def test_script_cancel_before_revision_stops_new_model_requests() -> None:
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = script_result(factIds=[])
    guard = AsyncMock(side_effect=[None, RuntimeError('cancelled')])
    with pytest.raises(RuntimeError, match='cancelled'):
        await plan_script(ark, script_snapshot(), [], guard)
    assert ark.structured.await_count == 1


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
    ark = AsyncMock(spec=ArkProvider)
    row = item()
    row['snapshot']['facts'] = [{'id': 'f', 'text': '事实'}]
    ark.structured.side_effect = [ScriptRow(**{**row['checkpoint']['script'][0], 'text': '短句'}),
                                  ScriptAudit(supported=True, coherent=True, issues=[])]
    with pytest.raises(PackagingError, match='缩句一次后仍超出'):
        await PackagingHandler(api, ark, adapter, 1000).process_item('/run', {}, 'project', row)
    assert adapter.voice.await_count == 2
    assert not any(call.args[0] == 'POST' for call in api.request.call_args_list)


async def test_voice_fit_keeps_existing_audio_and_aligns_caption_to_measured_repair() -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'repaired-voice'}
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.voice.side_effect = [b'\0\0' * 24_000 * 12, b'\0\0' * 24_000 * 2]
    ark = AsyncMock(spec=ArkProvider)
    row = item()
    row['snapshot']['facts'] = [{'id': 'f', 'text': '事实'}]
    previous = {'id': 'previous', 'text': '前句', 'start': 0, 'end': .8, 'factIds': ['f']}
    row['checkpoint']['script'].insert(0, previous)
    row['checkpoint']['voices'] = {'previous': {'fileObjectId': 'saved', 'start': 0, 'duration': .5, 'volume': 1}}
    ark.structured.side_effect = [ScriptRow(**{**row['checkpoint']['script'][1], 'text': '短句'}),
                                  ScriptAudit(supported=True, coherent=True, issues=[])]
    await PackagingHandler(api, ark, adapter, 1000).process_item('/run', {}, 'project', row)
    assert row['stage'] == 'READY'
    assert row['checkpoint']['script'][0] == previous
    assert row['checkpoint']['voices']['previous']['fileObjectId'] == 'saved'
    assert row['checkpoint']['captions'][1] == {'id': 'line-1', 'text': '短句', 'start': 1, 'end': 3}
    assert ark.structured.await_count == 2
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
