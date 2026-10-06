"""No provider calls: exercise the real SSE adapter and packaging upload boundary."""
import base64
import io
import json
import wave
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.api import InternalApi
from effect_template_mix.packaging import PackagingHandler
from effect_template_mix.packaging_captions import captions_for_voice, speech_aligned_segment_frames
from effect_template_mix.packaging_provider import PackagingError, PackagingProvider, TimedVoicePcm
from effect_template_mix.provider import ArkProvider
from test_packaging import item


def sse(rows: list[dict[str, Any]]) -> httpx.Response:
    return httpx.Response(200, text='\n\n'.join('data: ' + json.dumps(row) for row in rows) + '\n')


def test_spoken_ranges_include_first_onset_word_end_and_inter_sentence_silence() -> None:
    voice = {'start': 26, 'duration': 3, 'speechRanges': [
        {'startFrame': 4800, 'endFrame': 19200}, {'startFrame': 36000, 'endFrame': 64800}]}
    captions = captions_for_voice({'id': 'line', 'text': '第一句，第二句'}, voice)
    assert [(c['start'], c['end']) for c in captions] == [(26.2, 26.8), (27.5, 28.7)]


@pytest.mark.parametrize('ranges', [[], [{'startFrame': True, 'endFrame': 100}],
    [{'startFrame': -1, 'endFrame': 100}], [{'startFrame': 100, 'endFrame': 100}],
    [{'startFrame': 0, 'endFrame': 24001}]])
def test_invalid_spoken_ranges_never_fall_back_to_estimated_duration(ranges: list[Any]) -> None:
    with pytest.raises(PackagingError):
        captions_for_voice({'id': 'line', 'text': '第一句'}, {'start': 0, 'duration': 1, 'speechRanges': ranges})


@pytest.mark.parametrize('resource', ['seed-tts-2.0', 'seed-tts-1.0', 'seed-tts-1.0-concurr'])
@pytest.mark.parametrize('terminal_audio', [False, True])
async def test_same_request_word_onset_survives_late_subtitles_and_terminal_audio(
    resource: str, terminal_audio: bool,
) -> None:
    pcm = b'\x64\x00' * 12000 + b'\xe8\x03' * 12000  # noise is not an onset
    sentence = {'words': [{'word': '测试', 'startTime': .50001, 'endTime': .9}]}
    def response(request: httpx.Request) -> httpx.Response:
        params = json.loads(request.content)['req_params']['audio_params']
        option = 'enable_subtitle' if resource == 'seed-tts-2.0' else 'enable_timestamp'
        assert params == {'format': 'pcm', 'sample_rate': 24000, option: True}
        chunk = {'data': base64.b64encode(pcm).decode()}
        return sse([
            {'code': 0, **({} if terminal_audio else chunk)},
            {'code': 0, 'sentence': sentence},
            {'code': 20000000, 'sentence': sentence, **(chunk if terminal_audio else {})},
        ])
    provider = PackagingProvider('key', 'speaker', resource, '', '', '',
        httpx.AsyncClient(transport=httpx.MockTransport(response)))
    try:
        audio = await provider.voice('测试', require_timing=True)
        assert isinstance(audio, TimedVoicePcm)
        assert audio == pcm and audio.speech_start_frame == 12001  # ceil, never before the word
        assert audio.speech_end_frame == 21600
    finally:
        await provider.close()


@pytest.mark.parametrize('sentence', [
    None,
    {'words': []},
    {'words': 'invalid'},
    {'words': [{'startTime': True, 'endTime': .8}]},
    {'words': [{'startTime': float('nan'), 'endTime': .8}]},
    {'words': [{'startTime': .2, 'endTime': float('inf')}]},
    {'words': [{'startTime': -.1, 'endTime': .8}]},
    {'words': [{'startTime': .8, 'endTime': .7}]},
    {'words': [{'startTime': .2, 'endTime': 1.2}]},
    {'words': [{'startTime': .4, 'endTime': .6}, {'startTime': .1, 'endTime': .3}]},
    {'words': [{'startTime': .1, 'endTime': .5}, {'startTime': .3, 'endTime': .6}]},
])
async def test_missing_or_invalid_word_timing_fails_without_estimating_or_retrying(sentence: Any) -> None:
    calls = 0
    def response(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return sse([{'code': 0, 'data': base64.b64encode(b'\0\0' * 24000).decode()},
            {'code': 20000000, 'sentence': sentence}])
    provider = PackagingProvider('key', 'speaker', 'seed-tts-2.0', '', '', '',
        httpx.AsyncClient(transport=httpx.MockTransport(response)))
    try:
        with pytest.raises(PackagingError, match='时间戳'):
            await provider.voice('测试', require_timing=True)
        assert calls == 1
    finally:
        await provider.close()


async def test_packaging_uses_word_onsets_even_with_breath_noise_and_long_later_clause_heads() -> None:
    # Three clauses with deliberately misleading audio energy. Only supplier word timing
    # determines the starts; all samples (including the quiet heads) remain in the upload.
    chunks = [b'\xe8\x03' * 24000,
        b'\xe8\x03' * 1000 + b'\x64\x00' * 11000 + b'\xe8\x03' * 12000,
        b'\xe8\x03' * 2000 + b'\x64\x00' * 16000 + b'\xe8\x03' * 6000]
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'voice'}
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.voice.side_effect = [TimedVoicePcm(pcm, onset, len(pcm) // 2)
        for pcm, onset in zip(chunks, [0, 12000, 18000], strict=True)]
    row = item()
    row['checkpoint']['script'][0]['text'] = '长长的第一句，第二句，第三句。'
    worker = PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000)
    await worker.process_item('/run', {}, 'project', row)
    assert all(call.kwargs['require_timing'] for call in adapter.voice.call_args_list)
    assert row['checkpoint']['voices']['line-1']['segmentFrames'] == [36000, 30000, 6000]
    assert [(c['start'], c['end']) for c in row['checkpoint']['captions']] == [
        (1, 2), (2.5, 3), (3.75, 4)]
    upload = next(call for call in api.request.call_args_list if call.args[0] == 'POST')
    assert json.loads(upload.kwargs['data']['segmentFrames']) == [36000, 30000, 6000]
    with wave.open(io.BytesIO(upload.kwargs['files']['file'][1]), 'rb') as audio:
        assert audio.readframes(audio.getnframes()) == b''.join(chunks)
    # Resume is not a migration: keep user-edited caption timing and avoid any new TTS.
    row['checkpoint']['captions'][1]['start'] = 2.6
    await worker.process_item('/run', {}, 'project', row)
    assert row['checkpoint']['captions'][1]['start'] == 2.6
    assert adapter.voice.await_count == 3


async def test_packaging_rejects_untimed_audio_without_publishing_guessed_captions() -> None:
    api = AsyncMock(spec=InternalApi)
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.voice.return_value = b'\xe8\x03' * 24000
    row = item()
    with pytest.raises(PackagingError, match='缺少字词时间戳'):
        await PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000).process_item(
            '/run', {}, 'project', row)
    assert not row['checkpoint'].get('captions')
    assert not any(call.args[0] == 'POST' for call in api.request.call_args_list)
    assert adapter.voice.await_count == 1


async def test_sse_timing_flows_through_real_packaging_to_saved_caption_start() -> None:
    requests: list[str] = []
    def response(request: httpx.Request) -> httpx.Response:
        text = json.loads(request.content)['req_params']['text']
        requests.append(text)
        onset = 0 if text == '第一句，' else .7
        return sse([{'code': 0, 'data': base64.b64encode(b'\x64\x00' * 24000).decode()},
            {'code': 20000000, 'sentence': {'words': [
                {'word': text, 'startTime': onset, 'endTime': .95}]}}])
    adapter = PackagingProvider('key', 'speaker', 'seed-tts-2.0', 'ak', 'sk', '',
        httpx.AsyncClient(transport=httpx.MockTransport(response)))
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'voice'}
    row = item()
    row['checkpoint']['script'][0]['text'] = '第一句，第二句。'
    try:
        await PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000).process_item(
            '/run', {}, 'project', row)
    finally:
        await adapter.close()
    assert requests == ['第一句，', '第二句。']
    assert row['checkpoint']['voices']['line-1']['segmentFrames'] == [40800, 7200]
    assert row['checkpoint']['captions'][1]['start'] == 2.7


def test_legacy_noise_does_not_trigger_early_caption_or_stop_after_400_ms() -> None:
    pcm = b'\xe8\x03' * 24000 + b'\x64\x00' * 16800 + b'\xe8\x03' * 7200
    with pytest.raises(PackagingError, match='缺少字词时间戳'):
        speech_aligned_segment_frames(pcm, [24000, 24000])
    # Timed packaging is independent of this heuristic, even if energy says speech is present.
    assert speech_aligned_segment_frames(b'\xe8\x03' * 48000, [24000, 24000], [0, 16800]) == [40800, 7200]


@pytest.mark.parametrize('onsets', [[0], [0, -1], [0, 24000], [0, True]])
def test_invalid_clause_timestamp_is_not_clamped_or_guessed(onsets: list[int]) -> None:
    with pytest.raises(PackagingError, match='时间戳'):
        speech_aligned_segment_frames(b'\0\0' * 48000, [24000, 24000], onsets)


@pytest.mark.parametrize('speaker,resource,seconds,first_onset,later_onset', [
    ('female_slow', 'seed-tts-2.0', 1.7, .65, .83),
    ('male_fast', 'seed-tts-2.0', .8, .01, .03),
    ('female_legacy', 'seed-tts-1.0', 1.2, .13, .44),
    ('male_concurrent', 'seed-tts-1.0-concurr', 1.5, .42, .08),
])
async def test_each_selected_voice_uses_its_own_synthesis_timestamps_not_a_calibration(
    speaker: str, resource: str, seconds: float, first_onset: float, later_onset: float,
) -> None:
    frames = round(seconds * 24000)
    pcm = b'\xe8\x03' * frames  # Strong energy even before words: no RMS predictor is valid.
    requested: list[str] = []
    def respond(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)['req_params']
        assert payload['speaker'] == speaker
        assert request.headers['X-Api-Resource-Id'] == resource
        requested.append(payload['text'])
        onset = first_onset if len(requested) == 1 else later_onset
        return sse([
            {'code': 0, 'data': base64.b64encode(pcm).decode()},
            {'code': 0, 'sentence': {'words': [{'word': payload['text'], 'startTime': onset, 'endTime': seconds - .1}]}},
            {'code': 20000000},
        ])
    adapter = PackagingProvider('key', 'unused_default', 'seed-tts-2.0', 'ak', 'sk', '',
        httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    row = item()
    row['snapshot']['voiceProfile'] = {'speaker': speaker, 'resourceId': resource}
    row['checkpoint']['script'][0]['text'] = '第一句，第二句。'
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'saved'}
    try:
        await PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000).process_item('/run', {}, 'project', row)
    finally:
        await adapter.close()
    captions = row['checkpoint']['captions']
    assert captions[0]['start'] == pytest.approx(1 + first_onset, abs=1 / 24000)
    assert captions[0]['end'] == pytest.approx(1 + seconds - .1, abs=1 / 24000)
    assert captions[1]['start'] == pytest.approx(1 + seconds + later_onset, abs=1 / 24000)
    assert captions[1]['end'] == pytest.approx(1 + seconds * 2 - .1, abs=1 / 24000)
    assert row['checkpoint']['captionLayoutVersion'] == 'SPEECH_V1'
    assert requested == ['第一句，', '第二句。']
    upload = next(call for call in api.request.call_args_list if call.args[0] == 'POST')
    assert json.loads(upload.kwargs['data']['speechRanges']) == row['checkpoint']['voices']['line-1']['speechRanges']
    with wave.open(io.BytesIO(upload.kwargs['files']['file'][1]), 'rb') as audio:
        assert audio.readframes(audio.getnframes()) == pcm * 2
