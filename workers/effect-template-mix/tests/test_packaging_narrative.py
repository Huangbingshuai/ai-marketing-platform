"""Prompt/context regression, not a substitute for authorized live model quality evaluation."""
import asyncio
import copy
import json
from typing import Any
from unittest.mock import AsyncMock

import pytest

from effect_template_mix.api import InternalApi
from effect_template_mix.packaging import (
    NARRATION_STORY_RULES, NarrationPlan, NarrationRepair, PackagingHandler, ScriptRow,
    narration_story_context, plan_script, shorten_voice_line,
)
from effect_template_mix.packaging_provider import PackagingProvider, TimedVoicePcm
from effect_template_mix.provider import ArkProvider


def film(fact: str = '清洁剂采用按压式喷头') -> dict[str, Any]:
    roles = ['HOOK', 'PAIN', 'PRODUCT', 'SELLING_POINT', 'EFFECT', 'END']
    return {
        'duration': 24, 'narrationLayoutVersion': 'SLOT_V1',
        'variant': {'slots': [{'id': f's{i}', 'role': role} for i, role in enumerate(roles)]},
        'facts': [{'id': 'confirmed-1', 'text': fact}],
        # Storage order must not become the story's speaking order.
        'clips': [{'slotId': f's{i}', 'start': i * 4, 'duration': 4, 'prompt': f'镜头{i}'}
                  for i in (4, 1, 5, 0, 3, 2)],
    }


def line(index: int, text: str = '承接前文自然推进') -> dict[str, Any]:
    return {'id': f'line-{index}', 'slotId': f's{index}', 'start': index * 4,
            'end': index * 4 + 4, 'text': text, 'factIds': ['confirmed-1']}


def plan(lines: list[dict[str, Any]]) -> NarrationPlan:
    return NarrationPlan.model_validate({'musicBrief': '轻快纯器乐', 'lines': [
        {key: row[key] for key in ('id', 'slotId', 'text', 'factIds')} for row in lines]})


def observations() -> list[dict[str, Any]]:
    return [{'slotId': f's{i}', 'description': f'本槽位可见画面{i}'} for i in range(6)]


def payload(call: Any) -> dict[str, Any]:
    return json.loads(call.args[0][0]['text'])  # type: ignore[no-any-return]


def test_story_context_keeps_order_gaps_and_only_real_non_overlay_slots() -> None:
    snapshot = film()
    snapshot['clips'] = [clip for clip in snapshot['clips'] if clip['slotId'] != 's1']
    snapshot['clips'].append({'slotId': 'overlay', 'start': 1, 'duration': 20, 'overlay': True})
    baseline = copy.deepcopy(snapshot)
    context = narration_story_context(snapshot, observations(), [line(0), line(5)], {'s2'})
    rows = context['segments']
    assert [row['slotId'] for row in rows] == ['s0', 's2', 's3', 's4', 's5']
    assert [row['order'] for row in rows] == [1, 2, 3, 4, 5]
    assert rows[1]['gapBefore'] == 4 and context['duration'] == 24
    assert rows[1]['editable'] and all(not row['editable'] for row in [rows[0], *rows[2:]])
    assert rows[0]['existingLines'] == [line(0)] and rows[1]['existingLines'] == []
    assert rows[1]['visualDescription'] == '本槽位可见画面2'
    assert snapshot == baseline


@pytest.mark.parametrize('fact', ['梅子酱使用紫苏调味', '清洁剂采用按压式喷头', '项目管理软件支持任务分配'])
async def test_full_film_planning_is_category_neutral_and_does_not_add_audit_calls(fact: str) -> None:
    snapshot = film(fact)
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = plan([line(i) for i in reversed(range(6))])
    result = await plan_script(ark, snapshot, observations(), AsyncMock())
    request = payload(ark.structured.call_args)
    assert request['confirmedFacts'] == snapshot['facts']
    assert [row['slotId'] for row in request['shots']] == [f's{i}' for i in range(6)]
    assert [row['slotId'] for row in request['storyContext']['segments']] == [f's{i}' for i in range(6)]
    assert all(row['editable'] for row in request['storyContext']['segments'])
    assert all(rule in request['rules'] for rule in NARRATION_STORY_RULES)
    assert '完整成片' in request['task'] and '分别策划' not in request['task']
    # Production instructions contain no product keyword/template branch.
    assert not any(word in ''.join(request['rules']) for word in ('腊肠', '梅子酱', '清洁剂', '软件'))
    assert [(row.slotId, row.start, row.end) for row in result.lines] == [
        (f's{i}', i * 4, i * 4 + 4) for i in range(6)]
    assert ark.structured.await_count == 1
    assert ark.structured.call_args.kwargs['max_attempts'] == 1


async def test_local_replanning_reads_whole_film_but_only_returns_target() -> None:
    snapshot = film()
    # An untouched user-moved clip is not revalidated or automatically repaired.
    next(clip for clip in snapshot['clips'] if clip['slotId'] == 's3').update(start=9, duration=2)
    existing = [line(i, f'保留邻句{i}') for i in (0, 1, 3, 5)]
    baseline = copy.deepcopy(existing)
    partial = {**snapshot, 'clips': [clip for clip in snapshot['clips'] if clip['slotId'] == 's2']}
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = plan([line(2, '新的中间句'), line(3, '不应写回邻句')])
    result = await plan_script(ark, partial, observations(), AsyncMock(),
        voice_retry=[{'slotId': 's2', 'previousText': '超时旧句', 'measuredSeconds': 6, 'availableSeconds': 4}],
        story_snapshot=snapshot, existing_script=existing)
    request = payload(ark.structured.call_args)
    rows = {row['slotId']: row for row in request['storyContext']['segments']}
    assert set(rows) == {f's{i}' for i in range(6)}
    assert rows['s1']['existingLines'] == [line(1, '保留邻句1')]
    assert rows['s3']['existingLines'] == [line(3, '保留邻句3')]
    assert rows['s4']['existingLines'] == []  # Intentionally absent narration stays absent.
    assert [row['slotId'] for row in rows.values() if row['editable']] == ['s2']
    assert [row.slotId for row in result.lines] == ['s2']
    assert request['voiceRetry'][0]['previousText'] == '超时旧句'
    assert existing == baseline and ark.structured.await_count == 1


async def test_story_context_is_per_film_not_shared_between_concurrent_plans() -> None:
    ark = AsyncMock(spec=ArkProvider)
    received: list[dict[str, Any]] = []

    async def generate(content: Any, *_args: Any, **_kwargs: Any) -> NarrationPlan:
        request = json.loads(content[0]['text'])
        received.append(request)
        await asyncio.sleep(0)
        return plan([line(2)])

    ark.structured.side_effect = generate
    first, second = film('产品甲的确认事实'), film('产品乙的确认事实')
    await asyncio.gather(*(
        plan_script(ark, {**snapshot, 'clips': [c for c in snapshot['clips'] if c['slotId'] == 's2']},
            observations(), AsyncMock(), story_snapshot=snapshot, existing_script=[line(1, previous)])
        for snapshot, previous in [(first, '甲成片专属前句'), (second, '乙成片专属前句')]))
    assert received[0]['confirmedFacts'] == first['facts']
    assert received[1]['confirmedFacts'] == second['facts']
    assert received[0]['storyContext']['segments'][1]['existingLines'][0]['text'] == '甲成片专属前句'
    assert received[1]['storyContext']['segments'][1]['existingLines'][0]['text'] == '乙成片专属前句'


async def test_repeated_name_does_not_trigger_keyword_rejection_or_automatic_rewrite() -> None:
    ark = AsyncMock(spec=ArkProvider)
    repeated = plan([line(i, '某商品的已确认特点') for i in range(6)])
    ark.structured.return_value = repeated
    result = await plan_script(ark, film(), observations(), AsyncMock())
    # Coherence belongs to the model's composition task, not a Worker string-matching filter.
    assert [row.text for row in result.lines] == [row.text for row in repeated.lines]
    assert ark.structured.await_count == 1


async def test_structure_repairs_keep_valid_neighbors_and_refresh_read_only_context() -> None:
    snapshot = film()
    draft = [line(i, f'整片句{i}') for i in range(6)]
    draft[1]['factIds'] = []
    draft[4]['factIds'] = ['invented']
    first_repair = [line(1, '已修复的前句'), line(4, '仍待修复的后句')]
    first_repair[1]['factIds'] = []
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.side_effect = [plan(draft), NarrationRepair(lines=plan(first_repair).lines),
        NarrationRepair(lines=plan([line(4, '最终修复句')]).lines)]
    result = await plan_script(ark, snapshot, observations(), AsyncMock())
    first = payload(ark.structured.call_args_list[1])
    second = payload(ark.structured.call_args_list[2])
    assert len(first['storyContext']['segments']) == len(second['storyContext']['segments']) == 6
    assert [row['slotId'] for row in first['storyContext']['segments'] if row['editable']] == ['s1', 's4']
    assert [row['slotId'] for row in second['storyContext']['segments'] if row['editable']] == ['s4']
    assert second['storyContext']['segments'][1]['existingLines'][0]['text'] == '已修复的前句'
    assert result.lines[0].text == '整片句0' and result.lines[4].text == '最终修复句'
    assert all(rule in second['rules'] for rule in NARRATION_STORY_RULES)
    assert [call.args[2] for call in ark.structured.call_args_list] == [
        'packaging_script', 'packaging_script_repair', 'packaging_script_repair']


async def test_local_voice_shortening_sees_neighbors_without_expanding_write_scope() -> None:
    snapshot = film()
    partial = {**snapshot, 'clips': [clip for clip in snapshot['clips'] if clip['slotId'] == 's2']}
    original = line(2, '这段需要缩短但必须保留前后语义衔接的长口播')
    existing = [line(0), line(1, '前句已建立产品身份'), original, line(3, '后句继续介绍细节')]
    cp = {'script': [original], 'vision': observations(), 'musicBrief': '纯器乐'}
    baseline = copy.deepcopy(cp)
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.return_value = ScriptRow(**{**original, 'text': '继续讲细节'})
    result = await shorten_voice_line(ark, partial, cp, 0, 6, 4, AsyncMock(),
        story_snapshot=snapshot, existing_script=existing)
    request = payload(ark.structured.call_args)
    rows = request['storyContext']['segments']
    assert rows[1]['existingLines'][0]['text'] == '前句已建立产品身份'
    assert rows[3]['existingLines'][0]['text'] == '后句继续介绍细节'
    assert [row['slotId'] for row in rows if row['editable']] == ['s2']
    assert all(rule in request['rules'] for rule in NARRATION_STORY_RULES)
    assert result == {**original, 'text': '继续讲细节'} and cp == baseline


async def test_resume_missing_line_uses_saved_siblings_and_keeps_their_audio() -> None:
    snapshot = film()
    preserved = [line(i, f'既有口播{i}') for i in range(6) if i != 2]
    voices = {row['id']: {'fileObjectId': f"saved-{row['id']}", 'start': row['start'],
        'duration': 1, 'volume': .8, 'speechRanges': [{'startFrame': 0, 'endFrame': 24000}]}
        for row in preserved}
    item = {'id': 'one-film', 'stage': 'SCRIPT', 'snapshot': snapshot, 'checkpoint': {
        'narrationLayoutVersion': 'SLOT_V1', 'vision': observations(), 'script': preserved,
        'voices': copy.deepcopy(voices), 'musicBrief': '保留器乐',
        'music': {'fileObjectId': 'saved-music', 'start': 0, 'duration': 24, 'volume': .4},
    }}
    ark, api, provider = AsyncMock(spec=ArkProvider), AsyncMock(spec=InternalApi), AsyncMock(spec=PackagingProvider)
    ark.structured.return_value = plan([line(2, '中间继续推进')])
    api.request.return_value = {'fileObjectId': 'new-voice'}
    provider.voice.return_value = TimedVoicePcm(b'\0\0' * 24000, 0, 24000)
    worker = PackagingHandler(api, ark, provider, 1000)
    await worker.process_item('/run', {}, 'project', item)
    request = payload(ark.structured.call_args)
    assert [row['slotId'] for row in request['narrationWindows']] == ['s2']
    assert len(request['storyContext']['segments']) == 6
    assert request['storyContext']['segments'][1]['existingLines'] == [line(1, '既有口播1')]
    assert request['storyContext']['segments'][3]['existingLines'] == [line(3, '既有口播3')]
    provider.voice.assert_awaited_once_with('中间继续推进', require_timing=True)
    provider.submit_music.assert_not_called()
    assert all(item['checkpoint']['voices'][key] == audio for key, audio in voices.items())
    assert item['checkpoint']['music']['fileObjectId'] == 'saved-music'
    assert item['stage'] == 'READY'
    # A second resume neither rewrites content nor repeats a paid step.
    await worker.process_item('/run', {}, 'project', item)
    assert ark.structured.await_count == provider.voice.await_count == 1
