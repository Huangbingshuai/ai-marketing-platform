import hashlib
import io
import json
import wave
import httpx

import pytest
from unittest.mock import AsyncMock, Mock

from effect_template_mix.api import InternalApi
from effect_template_mix.packaging import PackagingHandler, ScriptRow
from effect_template_mix.packaging_captions import caption_text_parts, captions_for_voice, voice_text_parts, speech_aligned_segment_frames
from effect_template_mix.packaging_media import pcm_wav
from effect_template_mix.packaging_provider import PackagingError, PackagingProvider, TimedVoicePcm
from effect_template_mix.provider import ArkProvider
from test_packaging import item


def test_sentence_punctuation_splits_but_enumeration_comma_stays() -> None:
    assert caption_text_parts('刚出锅，，趁热吃！「真香」') == ['刚出锅', '趁热吃', '「真香」']
    assert caption_text_parts('腊肠、米饭、青菜，趁热吃！好吃吗？') == [
        '腊肠、米饭、青菜', '趁热吃', '好吃吗']
    assert caption_text_parts('“真香！”接着吃？') == ['“真香”', '接着吃']
    assert caption_text_parts('把广式三七瘦腊肠斜片铺在嫩鸡块上同蒸，开盖就香') == [
        '把广式三七瘦腊肠斜片铺在嫩鸡块上同蒸', '开盖就香']
    assert caption_text_parts('长句' * 30) == ['长句' * 30]
    with pytest.raises(PackagingError, match='字幕文字'):
        caption_text_parts('，。？！')
    assert voice_text_parts('腊肠、米饭，趁热吃！') == ['腊肠、米饭，', '趁热吃！']
    assert voice_text_parts('“真香！”接着吃？') == ['“真香！”', '接着吃？']


def test_caption_segments_have_stable_ids_and_stay_inside_voice() -> None:
    line = {'id': 'slot-a', 'text': '腊肠、米饭，趁热享用！'}
    voice = {'start': 5, 'duration': 4, 'speechRanges': [
        {'startFrame': 0, 'endFrame': 52800}, {'startFrame': 52800, 'endFrame': 96000}]}
    captions = captions_for_voice(line, voice)
    assert [row['text'] for row in captions] == ['腊肠、米饭', '趁热享用']
    assert all(row['voiceLineId'] == line['id'] for row in captions)
    assert captions[0]['id'] == 'caption-' + hashlib.sha256(b'slot-a:0').hexdigest()[:24]
    assert 7.2 <= captions[0]['end'] <= 7.3
    assert captions[0]['end'] == captions[1]['start']
    assert captions[1]['end'] == 9
    assert captions_for_voice(line, voice) == captions
    with pytest.raises(PackagingError, match='不能严格对齐'):
        captions_for_voice(line, {'start': 8, 'offset': 1, 'duration': 2})
    assert len({part['voiceLineId'] for part in captions}) == 1


def test_actual_speech_ranges_override_character_weighting() -> None:
    line = {'id': 'slot-a', 'text': '很长的第一段，短句！'}
    voice = {'start': 5, 'duration': 3, 'speechRanges': [
        {'startFrame': 0, 'endFrame': 24000}, {'startFrame': 24000, 'endFrame': 72000}]}
    captions = captions_for_voice(line, voice)
    assert [(c['text'], c['start'], c['end']) for c in captions] == [
        ('很长的第一段', 5, 6), ('短句', 6, 8)]
    with pytest.raises(PackagingError, match='数量不一致'):
        captions_for_voice(line, {**voice, 'speechRanges': [{'startFrame': 0, 'endFrame': 72000}]})
    with pytest.raises(PackagingError, match='超出音频'):
        captions_for_voice(line, {**voice, 'speechRanges': [
            {'startFrame': 0, 'endFrame': 24000}, {'startFrame': 24000, 'endFrame': 72001}]})


async def test_new_voice_synthesizes_each_clause_and_uses_exact_pcm_boundaries() -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'voice'}
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.voice.side_effect = [TimedVoicePcm(b'\x01\x00' * 24000, 0, 24000), TimedVoicePcm(b'\x02\x00' * 48000, 0, 48000)]
    row = item()
    row['checkpoint']['script'][0]['text'] = '较长的前一句，短句！'
    await PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000).process_item(
        '/run', {}, 'project', row)
    assert [call.args[0] for call in adapter.voice.call_args_list] == ['较长的前一句，', '短句！']
    assert row['checkpoint']['captionLayoutVersion'] == 'SPEECH_V1'
    assert row['checkpoint']['voices']['line-1']['segmentFrames'] == [24000, 48000]
    assert [(part['start'], part['end']) for part in row['checkpoint']['captions']] == [(1, 2), (2, 4)]
    upload = next(call for call in api.request.call_args_list if call.args[0] == 'POST')
    assert json.loads(upload.kwargs['data']['segmentFrames']) == [24000, 48000]
    with wave.open(io.BytesIO(upload.kwargs['files']['file'][1]), 'rb') as combined:
        assert combined.getnframes() == 72000
        assert combined.readframes(1) == b'\x01\x00'
        combined.setpos(24000)
        assert combined.readframes(1) == b'\x02\x00'


async def test_caption_generation_refuses_legacy_segment_frames_without_actual_word_ranges() -> None:
    api = AsyncMock(spec=InternalApi)
    adapter = AsyncMock(spec=PackagingProvider)
    row = item()
    row['checkpoint']['script'][0]['text'] = '前一句，后一句。'
    row['checkpoint']['voices'] = {'line-1': {'fileObjectId': 'voice', 'start': 1,
        'duration': 3, 'volume': 1, 'segmentFrames': [24000, 48000]}}
    with pytest.raises(PackagingError, match='不能严格对齐'):
        await PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000).process_item(
            '/run', {}, 'project', row)
    assert not row['checkpoint'].get('captions')
    adapter.voice.assert_not_called()


def test_partition_metadata_requires_explicit_word_timestamps() -> None:
    pcm = b'\xe8\x03' * 24000 + b'\0\0' * 2880 + b'\xe8\x03' * 21120
    frames = speech_aligned_segment_frames(pcm, [24000, 24000], [0, 2880])
    assert frames == [26880, 21120]
    assert sum(frames) == len(pcm) // 2
    captions = captions_for_voice({'id': 'line', 'text': '前句，后句'},
        {'start': 16, 'duration': 2, 'speechRanges': [
            {'startFrame': 0, 'endFrame': 26880}, {'startFrame': 26880, 'endFrame': 48000}]})
    assert captions[1]['start'] == 17.12
    assert captions[0]['end'] == captions[1]['start']
    assert captions[-1]['end'] == 18


def test_energy_alone_never_generates_caption_alignment() -> None:
    for pcm in [b'\0\0' * 48000, b'\xe8\x03' * 48000]:
        with pytest.raises(PackagingError, match='缺少字词时间戳'):
            speech_aligned_segment_frames(pcm, [24000, 24000])
    with pytest.raises(PackagingError, match='缺少字词时间戳'):
        speech_aligned_segment_frames(b'\0\0' * 10, [5, 5])
    with pytest.raises(PackagingError):
        speech_aligned_segment_frames(b'\0\0', [24000])


async def test_explicit_caption_redo_reuses_same_synthesis_ranges_without_any_prediction() -> None:
    api = AsyncMock(spec=InternalApi)
    pcm = b'\xe8\x03' * 24000 + b'\0\0' * 2880 + b'\xe8\x03' * 21120
    data, _ = pcm_wav(pcm)
    api.client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=data)),
        base_url='https://internal.test')
    adapter = AsyncMock(spec=PackagingProvider)
    ark = AsyncMock(spec=ArkProvider)
    row = item()
    row['snapshot']['redoCaptionsOnly'] = True
    row['checkpoint']['script'][0]['text'] = '前句，后句'
    row['checkpoint']['voices'] = {'line-1': {'fileObjectId': 'voice', 'start': 1,
        'duration': 2, 'volume': 1, 'segmentFrames': [24000, 24000],
        'speechRanges': [{'startFrame': 2400, 'endFrame': 21600}, {'startFrame': 26880, 'endFrame': 45600}]}}
    try:
        await PackagingHandler(api, ark, adapter, 1000).process_item('/run', {}, 'project', row)
    finally:
        await api.client.aclose()
    assert row['checkpoint']['voices']['line-1']['segmentFrames'] == [24000, 24000]
    assert row['checkpoint']['captions'][0]['start'] == 1.1
    assert row['checkpoint']['captions'][0]['end'] == 1.9
    assert row['checkpoint']['captions'][1]['start'] == 2.12
    assert row['checkpoint']['captions'][1]['end'] == 2.9
    adapter.voice.assert_not_called()
    adapter.submit_music.assert_not_called()
    ark.structured.assert_not_called()


async def test_overlong_clauses_are_replaced_once_without_reusing_old_boundaries() -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'voice'}
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.voice.side_effect = [TimedVoicePcm(b'\0\0' * 24_000 * n, 0, 24000 * n) for n in (3, 3, 1, 1)]
    ark = AsyncMock(spec=ArkProvider)
    row = item()
    row['snapshot']['facts'] = [{'id': 'f', 'text': '事实'}]
    row['checkpoint']['script'][0]['text'] = '原来前句，原来后句。'
    ark.structured.return_value = ScriptRow(**{**row['checkpoint']['script'][0], 'text': '缩短前句，后句。'})
    await PackagingHandler(api, ark, adapter, 1000).process_item('/run', {}, 'project', row)
    assert adapter.voice.await_count == 4
    assert row['checkpoint']['voices']['line-1']['segmentFrames'] == [24000, 24000]
    assert [c['text'] for c in row['checkpoint']['captions']] == ['缩短前句', '后句']
    assert [(c['start'], c['end']) for c in row['checkpoint']['captions']] == [(1, 2), (2, 3)]


async def test_legacy_multiclause_voice_without_timing_requires_explicit_voice_redo() -> None:
    api = AsyncMock(spec=InternalApi)
    api.client = Mock()
    adapter = AsyncMock(spec=PackagingProvider)
    ark = AsyncMock(spec=ArkProvider)
    row = item()
    row['checkpoint']['script'][0]['text'] = '腊肠、米饭，第二句。'
    row['checkpoint']['voices'] = {'line-1': {'fileObjectId': 'voice', 'start': 1, 'duration': 2, 'volume': 1}}
    with pytest.raises(PackagingError, match='不能严格对齐'):
        await PackagingHandler(api, ark, adapter, 1000).process_item('/run', {}, 'project', row)
    adapter.voice.assert_not_called()
    adapter.submit_music.assert_not_called()
    ark.structured.assert_not_called()
    api.client.stream.assert_not_called()
