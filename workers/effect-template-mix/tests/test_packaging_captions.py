import hashlib

import pytest
from unittest.mock import AsyncMock, Mock

from effect_template_mix.api import InternalApi
from effect_template_mix.packaging import PackagingHandler
from effect_template_mix.packaging_captions import caption_text_parts, captions_for_voice
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
