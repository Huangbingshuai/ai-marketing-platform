import hashlib
import io
import json
import wave

import pytest
from unittest.mock import AsyncMock, Mock

from effect_template_mix.api import InternalApi
from effect_template_mix.packaging import PackagingHandler, ScriptRow
from effect_template_mix.packaging_captions import caption_text_parts, captions_for_voice, voice_text_parts
from effect_template_mix.packaging_provider import PackagingError, PackagingProvider
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
    voice = {'start': 5, 'duration': 4}
    captions = captions_for_voice(line, voice)
    assert [row['text'] for row in captions] == ['腊肠、米饭', '趁热享用']
    assert all(row['voiceLineId'] == line['id'] for row in captions)
    assert captions[0]['id'] == 'caption-' + hashlib.sha256(b'slot-a:0').hexdigest()[:24]
    assert 7.2 <= captions[0]['end'] <= 7.3
    assert captions[0]['end'] == captions[1]['start']
    assert captions[1]['end'] == 9
    assert captions_for_voice(line, voice) == captions
    trimmed = captions_for_voice(line, {'start': 8, 'offset': 1, 'duration': 2})
    assert 8.8 <= trimmed[0]['end'] <= 9.2
    assert trimmed[-1]['end'] == 10
    assert len({part['voiceLineId'] for part in captions}) == 1


def test_segment_frames_override_character_weighting() -> None:
    line = {'id': 'slot-a', 'text': '很长的第一段，短句！'}
    voice = {'start': 5, 'duration': 3, 'segmentFrames': [24000, 48000]}
    captions = captions_for_voice(line, voice)
    assert [(c['text'], c['start'], c['end']) for c in captions] == [
        ('很长的第一段', 5, 6), ('短句', 6, 8)]
    with pytest.raises(PackagingError, match='数量不一致'):
        captions_for_voice(line, {**voice, 'segmentFrames': [72000]})
    with pytest.raises(PackagingError, match='时长'):
        captions_for_voice(line, {**voice, 'segmentFrames': [24000, 24000]})


async def test_new_voice_synthesizes_each_clause_and_uses_exact_pcm_boundaries() -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'voice'}
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.voice.side_effect = [b'\x01\x00' * 24000, b'\x02\x00' * 48000]
    row = item()
    row['checkpoint']['script'][0]['text'] = '较长的前一句，短句！'
    await PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000).process_item(
        '/run', {}, 'project', row)
    assert [call.args[0] for call in adapter.voice.call_args_list] == ['较长的前一句，', '短句！']
    assert row['checkpoint']['captionLayoutVersion'] == 'SEGMENT_V3'
    assert row['checkpoint']['voices']['line-1']['segmentFrames'] == [24000, 48000]
    assert [(part['start'], part['end']) for part in row['checkpoint']['captions']] == [(1, 2), (2, 4)]
    upload = next(call for call in api.request.call_args_list if call.args[0] == 'POST')
    assert json.loads(upload.kwargs['data']['segmentFrames']) == [24000, 48000]
    with wave.open(io.BytesIO(upload.kwargs['files']['file'][1]), 'rb') as combined:
        assert combined.getnframes() == 72000
        assert combined.readframes(1) == b'\x01\x00'
        combined.setpos(24000)
        assert combined.readframes(1) == b'\x02\x00'


async def test_caption_only_redo_reuses_saved_segment_frames_without_tts() -> None:
    api = AsyncMock(spec=InternalApi)
    adapter = AsyncMock(spec=PackagingProvider)
    row = item()
    row['checkpoint']['script'][0]['text'] = '前一句，后一句。'
    row['checkpoint']['voices'] = {'line-1': {'fileObjectId': 'voice', 'start': 1,
        'duration': 3, 'volume': 1, 'segmentFrames': [24000, 48000]}}
    await PackagingHandler(api, AsyncMock(spec=ArkProvider), adapter, 1000).process_item(
        '/run', {}, 'project', row)
    assert row['checkpoint']['captionLayoutVersion'] == 'SEGMENT_V3'
    assert [(c['start'], c['end']) for c in row['checkpoint']['captions']] == [(1, 2), (2, 4)]
    adapter.voice.assert_not_called()


async def test_overlong_clauses_are_replaced_once_without_reusing_old_boundaries() -> None:
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'voice'}
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.voice.side_effect = [b'\0\0' * 24_000 * 3, b'\0\0' * 24_000 * 3,
        b'\0\0' * 24_000, b'\0\0' * 24_000]
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


async def test_caption_only_redo_uses_saved_duration_without_media_or_paid_calls() -> None:
    api = AsyncMock(spec=InternalApi)
    api.client = Mock()
    adapter = AsyncMock(spec=PackagingProvider)
    ark = AsyncMock(spec=ArkProvider)
    row = item()
    row['checkpoint']['script'][0]['text'] = '腊肠、米饭，第二句。'
    row['checkpoint']['voices'] = {'line-1': {'fileObjectId': 'voice', 'start': 1, 'duration': 2, 'volume': 1}}
    await PackagingHandler(api, ark, adapter, 1000).process_item('/run', {}, 'project', row)
    assert row['stage'] == 'READY'
    assert [part['text'] for part in row['checkpoint']['captions']] == ['腊肠、米饭', '第二句']
    assert row['checkpoint']['captionLayoutVersion'] == 'SEGMENT_V2'
    adapter.voice.assert_not_called()
    adapter.submit_music.assert_not_called()
    ark.structured.assert_not_called()
    api.client.stream.assert_not_called()
