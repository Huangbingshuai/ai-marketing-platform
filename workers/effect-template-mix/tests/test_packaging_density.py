"""Offline paragraph-density regression; not a live copywriting quality evaluation."""
import copy
import json
import math
from typing import Any
from unittest.mock import AsyncMock

import pytest

from effect_template_mix.api import InternalApi
from effect_template_mix.packaging import (
    NARRATION_DENSITY_RULES, NARRATION_ROLE_INTENTS, NarrationPlan, PackagingHandler, ScriptRow,
    narration_windows, plan_script, shorten_voice_line,
)
from effect_template_mix.packaging_provider import PackagingProvider, TimedVoicePcm
from effect_template_mix.provider import ArkProvider


def snapshot() -> dict[str, Any]:
    return {'duration': 20, 'narrationLayoutVersion': 'SLOT_V1',
        'variant': {'slots': [{'id': 'a', 'role': 'HOOK'}, {'id': 'b', 'role': 'PRODUCT'},
                              {'id': 'c', 'role': 'END'}]},
        'clips': [{'slotId': 'a', 'start': 0, 'duration': 6},
                  {'slotId': 'b', 'start': 6, 'duration': 10},
                  {'slotId': 'c', 'start': 16, 'duration': 4}],
        'facts': [{'id': 'f', 'text': '产品采用按压喷头，可用于玻璃表面'}]}


def planned(texts: list[str]) -> NarrationPlan:
    return NarrationPlan.model_validate({'musicBrief': '连续纯器乐', 'lines': [
        {'id': slot, 'slotId': slot, 'text': text, 'factIds': ['f']}
        for slot, text in zip(['a', 'b', 'c'], texts)]})


def request_payload(call: Any) -> dict[str, Any]:
    return json.loads(call.args[0][0]['text'])  # type: ignore[no-any-return]


def test_speech_reference_tracks_available_time_without_sentence_count_requirement() -> None:
    value = snapshot()
    value['duration'] = 35
    value['clips'].append({'slotId': 'd', 'start': 20, 'duration': 15})
    value['variant']['slots'].append({'id': 'd', 'role': 'EFFECT'})
    windows = narration_windows(value)
    assert [w['availableSeconds'] for w in windows] == [6, 10, 4, 15]
    assert all(0 < w['speechSecondsReference'] < w['availableSeconds'] for w in windows)
    assert windows[3]['speechSecondsReference'] > windows[1]['speechSecondsReference'] > windows[0]['speechSecondsReference']
    assert all('minSentences' not in w and 'maxSentences' not in w for w in windows)


@pytest.mark.parametrize('role', ['HOOK', 'PAIN_POINT', 'PRODUCT', 'SELLING_POINT', 'TRANSFORMATION', 'END'])
async def test_explicit_slot_role_not_ordinal_drives_paragraph_and_repair(role: str) -> None:
    value = snapshot()
    # An arbitrary id and first position must not turn an END or other slot into a HOOK.
    value['clips'] = [{'slotId': 'arbitrary', 'start': 0, 'duration': 10}]
    value['variant']['slots'] = [{'id': 'arbitrary', 'role': role}]
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = NarrationPlan.model_validate({'musicBrief': '器乐', 'lines': [
        {'id': 'paragraph', 'slotId': 'arbitrary', 'text': '先说明细节。再自然收束。', 'factIds': ['f']}]})
    result = await plan_script(ark, value, [], AsyncMock())
    payload = request_payload(ark.structured.call_args)
    window, story = payload['narrationWindows'][0], payload['storyContext']['segments'][0]
    assert window['role'] == story['role'] == role
    assert window['roleIntent'] == story['roleIntent'] == NARRATION_ROLE_INTENTS[role]
    original = result.lines[0].model_dump()
    ark.structured.return_value = ScriptRow(**{**original, 'text': '说明后收束。'})
    await shorten_voice_line(ark, value, {'script': [original], 'vision': [], 'musicBrief': '器乐'},
                             0, 10.1, 10, AsyncMock())
    repair = request_payload(ark.structured.call_args)
    assert repair['role'] == role and repair['roleIntent'] == NARRATION_ROLE_INTENTS[role]


def test_end_intent_closes_whole_story_without_new_pitch_or_promotion() -> None:
    intent = NARRATION_ROLE_INTENTS['END']
    assert all(fragment in intent for fragment in ['最后一句必须', '自然结束语', '不是只承接前文', '不重新介绍商品',
                                                 '不开启新的卖点', '不编造优惠'])
    assert '不让每条成片复读同一个告别模板' in intent


@pytest.mark.parametrize('ending', ['今天就分享到这里。', '按自己的需要试试吧。'])
async def test_end_paragraph_retains_explicit_closing_sentence(ending: str) -> None:
    value = snapshot()
    ark = AsyncMock(spec=ArkProvider)
    texts = ['先看这个细节。', '采用按压喷头。可以用于玻璃表面。', '按需使用。' + ending]
    ark.structured.return_value = planned(texts)
    result = await plan_script(ark, value, [], AsyncMock())
    payload = request_payload(ark.structured.call_args)
    assert payload['narrationWindows'][-1]['role'] == 'END'
    assert '最后一句必须' in payload['narrationWindows'][-1]['roleIntent']
    assert result.lines[-1].text == texts[-1]
    assert ark.structured.await_count == 1


@pytest.mark.parametrize('texts', [
    ['先看这个细节。', '按压就能喷出。用在玻璃表面。操作直观。', '按需使用。'],
    ['一次按压就能喷出。使用时看准玻璃表面。', '这段用一句话充分说明按压喷头在玻璃表面使用的细节。', '看清再用。'],
    ['先看细节。', '按压喷头。', '按需使用。'],  # Deliberate brevity is not mechanically rejected.
])
async def test_planner_preserves_mixed_paragraphs_without_forcing_sentence_count(texts: list[str]) -> None:
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = planned(texts)
    result = await plan_script(ark, snapshot(), [], AsyncMock())
    payload = request_payload(ark.structured.call_args)
    assert all(rule in payload['rules'] for rule in NARRATION_DENSITY_RULES)
    assert '段内句数灵活' in payload['task']
    assert [row.text for row in result.lines] == texts
    assert [(row.start, row.end) for row in result.lines] == [(0, 6), (6, 16), (16, 20)]
    assert ark.structured.await_count == 1


@pytest.mark.parametrize('sentence_count', [1, 2, 3])
async def test_multi_sentence_voice_and_captions_stay_inside_slot_and_resume_once(sentence_count: int) -> None:
    value = snapshot()
    texts = ['看准位置。', ''.join(['按压喷头。', '用于玻璃表面。', '观察当前细节。'][:sentence_count]), '按需使用。']
    script = [{**row.model_dump(), 'start': start, 'end': end} for row, (start, end)
              in zip(planned(texts).lines, [(0, 6), (6, 16), (16, 20)])]
    saved_audio = {key: {'fileObjectId': key, 'start': start, 'duration': 1, 'volume': .6,
                        'speechRanges': [{'startFrame': 0, 'endFrame': 24000}]}
                   for key, start in [('a', 0), ('c', 16)]}
    music = {'fileObjectId': 'music', 'start': 0, 'duration': 20, 'volume': .4}
    item = {'id': 'film', 'stage': 'VOICE', 'snapshot': value, 'checkpoint': {
        'narrationLayoutVersion': 'SLOT_V1', 'script': script,
        'vision': [{'slotId': 'b', 'description': '喷头和玻璃表面'}],
        'voices': copy.deepcopy(saved_audio), 'music': music, 'musicBrief': '连续器乐'}}
    api, ark, provider = AsyncMock(spec=InternalApi), AsyncMock(spec=ArkProvider), AsyncMock(spec=PackagingProvider)
    api.request.return_value = {'fileObjectId': 'new-voice'}
    provider.voice.return_value = TimedVoicePcm(b'\0\0' * 36000, 0, 36000)
    worker = PackagingHandler(api, ark, provider, 1000)
    await worker.process_item('/run', {}, 'project', item)
    cp = item['checkpoint']
    voice = cp['voices']['b']
    assert voice['duration'] == sentence_count * 1.5 and voice['volume'] == 2
    captions = [row for row in cp['captions'] if row['voiceLineId'] == 'b']
    assert len(captions) == sentence_count
    assert [(row['start'], row['end']) for row in captions] == [
        (6 + i * 1.5, 6 + (i + 1) * 1.5) for i in range(sentence_count)]
    assert all(row['end'] <= 16 and row['segmentCount'] == sentence_count for row in captions)
    assert cp['voices']['a'] == saved_audio['a'] and cp['voices']['c'] == saved_audio['c']
    assert cp['music'] == music and cp['script'] == script
    assert item['stage'] == 'READY'
    assert provider.voice.await_count == sentence_count
    ark.structured.assert_not_called()
    provider.submit_music.assert_not_called()
    await worker.process_item('/run', {}, 'project', item)
    assert provider.voice.await_count == sentence_count


@pytest.mark.parametrize('measured,available', [(10.1, 10), (12, 10), (12, 6)])
async def test_voice_fit_uses_measured_ratio_without_extra_twenty_percent_cut(measured: float, available: float) -> None:
    value = snapshot()
    value['clips'] = [{'slotId': 'b', 'start': 6, 'duration': available}]
    original = {'id': 'b', 'slotId': 'b', 'text': '甲' * 50,
                'start': 6, 'end': 6 + available, 'factIds': ['f']}
    cp = {'script': [original], 'vision': [], 'musicBrief': '器乐'}
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = ScriptRow(**{**original, 'text': '先看喷头。再看玻璃表面。'})
    result = await shorten_voice_line(ark, value, cp, 0, measured, available, AsyncMock())
    payload = request_payload(ark.structured.call_args)
    assert payload['suggestedMaxCharacters'] == math.floor(50 * (available - .15) / measured)
    assert payload['suggestedMaxCharacters'] > math.floor(50 * available / measured * .8)
    assert all(rule in payload['rules'] for rule in NARRATION_DENSITY_RULES)
    assert result['text'] == '先看喷头。再看玻璃表面。'
    assert original['text'] == '甲' * 50 and ark.structured.await_count == 1


async def test_overrun_replan_keeps_density_guidance_and_saved_neighbor_context() -> None:
    full = snapshot()
    partial = {**full, 'clips': [full['clips'][1]]}
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = NarrationPlan.model_validate({'musicBrief': '器乐', 'lines': [
        {'id': 'b', 'slotId': 'b', 'text': '按压就能喷出。用在玻璃表面。', 'factIds': ['f']}]})
    result = await plan_script(ark, partial, [], AsyncMock(),
        voice_retry=[{'slotId': 'b', 'measuredSeconds': 10.2, 'availableSeconds': 10}],
        story_snapshot=full, existing_script=[{'id': 'a', 'slotId': 'a', 'text': '看准位置。'}])
    payload = request_payload(ark.structured.call_args)
    assert all(rule in payload['rules'] for rule in NARRATION_DENSITY_RULES)
    assert '实际比例' in payload['rules'][-1]
    assert payload['storyContext']['segments'][0]['existingLines'][0]['text'] == '看准位置。'
    assert [row.slotId for row in result.lines] == ['b']
