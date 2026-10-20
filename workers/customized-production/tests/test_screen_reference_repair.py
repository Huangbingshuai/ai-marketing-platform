from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from customized_production_runtime.video_domain import apply_repair, fingerprint, validate_plan, validate_screen_reference_repair
from customized_production_runtime.video_models import ScreenTextReferenceRepair
from customized_production_runtime.video_pipeline import run_video
from test_video_v2 import FakeApi, FakeProvider, clean_audit, snapshot

TEXT = '片尾：星沐。字幕：把清晨，留给自己。'
BRAND = '星沐'
TAGLINE = '把清晨，留给自己'


def source_ref(text: str) -> dict[str, Any]:
    start = TEXT.index(text)
    return {'unitId': 'U0003', 'start': start, 'end': start + len(text)}


def input_value() -> dict[str, Any]:
    data = snapshot()
    data['strategyVersion'] = '2026-10-19-capacity-clips.7'
    unit = data['sourceUnits'][-1]
    unit.update(text=TEXT, kind='TEXT', end=unit['start'] + len(TEXT))
    return data


def source_issue(plan: dict[str, Any]) -> dict[str, Any]:
    cues = [cue for cue in plan['cues'] if cue['kind'] == 'ON_SCREEN_TEXT']
    return {'id': 'F001', 'severity': 'ERROR', 'category': 'COVERAGE', 'repairKind': 'FIELDS',
        'title': '落版原文引用错误', 'impact': '当前引用未对应明确原句', 'suggestedFix': '定位品牌及标语原句',
        'evidence': [{'entity': 'SOURCE', 'id': 'U0003', 'field': 'text'}] + [{'entity': 'CUE', 'id': cue['id'], 'field': 'sourceRef'} for cue in cues],
        'affectedShotIds': [cues[0]['parts'][0]['shotId']], 'affectedClipIds': [plan['clips'][-1]['id']]}


def reference_patch(plan: dict[str, Any]) -> dict[str, Any]:
    cues = [cue for cue in plan['cues'] if cue['kind'] == 'ON_SCREEN_TEXT']
    return {'baseHash': fingerprint(plan), 'updates': [{'cueId': cue['id'], 'sourceRef': source_ref(text), 'text': text} for cue, text in zip(cues, [BRAND, TAGLINE], strict=True)]}


class Provider(FakeProvider):
    def __init__(self, stop_before_reference: bool = False, invalid_reference: bool = False) -> None:
        super().__init__()
        self.stop_before_reference = stop_before_reference
        self.invalid_reference = invalid_reference

    async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
        if stage == 'VIDEO_DIRECTOR':
            value = (await super().generate(stage, model, schema, context, instruction)).model_dump()
            screen = next(cue for cue in value['cues'] if cue['kind'] == 'ON_SCREEN_TEXT')
            screen['sourceRef'] = {'unitId': 'U0003', 'start': TEXT.index(BRAND)+1, 'end': TEXT.index(BRAND)+3}
            screen['allocations'][0]['textEnd'] = 2
            tagline = copy.deepcopy(screen)
            tagline.update(id='tagline', sourceRef={'unitId': 'U0003', 'start': TEXT.index(TAGLINE), 'end': TEXT.index(TAGLINE)+9})
            tagline['allocations'][0]['textEnd'] = 9
            value['cues'].append(tagline)
            return schema.model_validate(value)
        if stage == 'VIDEO_SHOTS':
            return await super().generate(stage, model, schema, context, instruction)
        self.calls.append(stage)
        if stage == 'VIDEO_REVIEW':
            return schema.model_validate(clean_audit() | {'findings': [source_issue(context['result'])]})
        if stage in ('VIDEO_SCREEN_REFERENCE_REPAIR', 'VIDEO_SCREEN_REFERENCE_REPAIR_CORRECT'):
            if self.stop_before_reference:
                raise ValueError('controlled process stopped before purchasing missing capability')
            updates = [{'cueId': cue['id'], 'sourceRef': source_ref(text), 'text': text} for cue, text in zip(context['cues'], [BRAND, TAGLINE], strict=True)]
            if self.invalid_reference:
                updates[-1]['text'] = '未在原文出现的文字'
            return schema.model_validate({'baseHash': context['candidateHash'], 'updates': updates})
        assert stage == 'VIDEO_RECHECK'
        assert context['previousErrors'][0]['id'] == 'F001'
        return schema.model_validate(clean_audit() | {'severityChanges': [], 'resolutions': [
            {'issueId': 'F001', 'status': 'RESOLVED', 'evidence': [{'entity': 'CUE', 'id': context['result']['cues'][-1]['id'], 'field': 'sourceRef'}], 'explanation': '受控复核确认原句范围正确'},
        ]})


async def legacy_checkpoint() -> tuple[FakeApi, dict[str, Any]]:
    api, provider, data = FakeApi(), Provider(stop_before_reference=True), input_value()
    with pytest.raises(ValueError, match='controlled process'):
        await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    # The old deployed protocol did not have this capability or its request fence.
    api.output.pop('screenReferenceRequestStarted', None)
    plan = api.output['value']['videoPlan']
    cues = [cue for cue in plan['cues'] if cue['kind'] == 'ON_SCREEN_TEXT']
    patch = {'baseHash': fingerprint(plan), 'issueIds': ['F001'], 'fields': [], 'ranges': [], 'timingExplanation': '受控旧补丁，只支持parts，不支持sourceRef',
        'cueUpdates': [{'cueId': cue['id'], 'parts': [{**part, 'textEnd': length} for part in cue['parts']]} for cue, length in zip(cues, [2, 8], strict=True)]}
    api.output.update(repairCandidate=copy.deepcopy(patch), repairCandidateCorrected=copy.deepcopy(patch), corrections={'repairCandidate': 1},
        failureReason='INVALID_CANDIDATE', mechanicalErrors={'repairCandidate': 'screen text is truncated', 'repairCandidateCorrected': 'screen text is truncated'})
    next(step for step in api.steps if step['id'] == 'REPAIR')['status'] = 'FAILED'
    return api, data


def test_checked_in_internal_reference_schema_matches_python() -> None:
    path = Path(__file__).resolve().parents[3] / 'packages/contracts/schemas/customized-video-screen-reference-repair-v1.schema.json'
    assert json.loads(path.read_text(encoding='utf-8')) == ScreenTextReferenceRepair.model_json_schema()


@pytest.mark.asyncio
async def test_new_reference_only_task_uses_one_focused_repair_instead_of_broad_repair() -> None:
    api, provider = FakeApi(), Provider()
    await run_video(api, provider, api.claim(input_value()))  # type: ignore[arg-type]
    assert provider.calls == ['VIDEO_DIRECTOR', 'VIDEO_SHOTS', 'VIDEO_REVIEW', 'VIDEO_SCREEN_REFERENCE_REPAIR', 'VIDEO_RECHECK']
    assert api.completed is not None and len(api.output['changes']) == 2


@pytest.mark.asyncio
async def test_legacy_checkpoint_reuses_paid_generation_review_and_patch_without_resetting_budget() -> None:
    api, data = await legacy_checkpoint()
    old = copy.deepcopy(api.output)
    original_plan = old['value']['videoPlan']
    with pytest.raises(ValueError, match='screen text is truncated'):
        apply_repair(original_plan, old['repairCandidateCorrected'], old['audit'], data)
    provider = Provider()
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == ['VIDEO_SCREEN_REFERENCE_REPAIR', 'VIDEO_RECHECK']
    assert api.completed is not None
    after = api.completed['videoPlan']
    assert after['shots'] == original_plan['shots'] and after['clips'] == original_plan['clips']
    assert after['sourceUnits'] == original_plan['sourceUnits'] and after['sources'] == original_plan['sources']
    assert after['cues'][0] == original_plan['cues'][0]
    for before, cue, expected in zip(original_plan['cues'][-2:], after['cues'][-2:], [BRAND, TAGLINE], strict=True):
        assert cue['sourceRef'] == source_ref(expected)
        assert cue['parts'] == [{**part, 'textStart': 0, 'textEnd': len(expected)} for part in before['parts']]
    assert api.output['repairCandidate'] == old['repairCandidate']
    assert api.output['repairCandidateCorrected'] == old['repairCandidateCorrected']
    assert api.output['corrections']['repairCandidate'] == 1
    assert 'failureReason' not in api.output
    resumed = Provider()
    await run_video(api, resumed, api.claim(data))  # type: ignore[arg-type]
    assert resumed.calls == []


@pytest.mark.asyncio
async def test_invalid_new_reference_candidate_has_bounded_correction_and_no_replay_purchase() -> None:
    api, data = await legacy_checkpoint()
    provider = Provider(invalid_reference=True)
    with pytest.raises(ValueError, match='exactly match'):
        await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == ['VIDEO_SCREEN_REFERENCE_REPAIR', 'VIDEO_SCREEN_REFERENCE_REPAIR_CORRECT']
    assert api.output['corrections'] == {'repairCandidate': 1, 'screenReferenceCandidate': 1}
    retry = Provider()
    with pytest.raises(ValueError):
        await run_video(api, retry, api.claim(data))  # type: ignore[arg-type]
    assert retry.calls == [] and api.completed is None


@pytest.mark.asyncio
async def test_missing_response_keeps_initial_request_fence_and_never_repurchases_on_replay() -> None:
    api, data = await legacy_checkpoint()
    interrupted = Provider(stop_before_reference=True)
    with pytest.raises(ValueError, match='controlled process'):
        await run_video(api, interrupted, api.claim(data))  # type: ignore[arg-type]
    assert api.output['screenReferenceRequestStarted'] is True
    assert 'screenReferenceCandidate' not in api.output
    retry = Provider()
    with pytest.raises(ValueError, match='refusing repeated purchase'):
        await run_video(api, retry, api.claim(data))  # type: ignore[arg-type]
    assert retry.calls == [] and api.completed is None


@pytest.mark.asyncio
@pytest.mark.parametrize('invalid', ['hash', 'unknown', 'duplicate', 'missing', 'quote', 'range', 'speech', 'blank'])
async def test_reference_repair_rejects_forgery_and_scope_expansion(invalid: str) -> None:
    api, data = await legacy_checkpoint()
    plan = api.output['value']['videoPlan']
    repair = reference_patch(plan)
    if invalid == 'hash': repair['baseHash'] = 'wrong'
    elif invalid == 'unknown': repair['updates'][0]['cueId'] = 'foreign-cue'
    elif invalid == 'duplicate': repair['updates'].append(copy.deepcopy(repair['updates'][0]))
    elif invalid == 'missing': repair['updates'].pop()
    elif invalid == 'quote': repair['updates'][0]['text'] += '改写'
    elif invalid == 'range': repair['updates'][0]['sourceRef']['end'] = 100000
    elif invalid == 'speech': repair['updates'][0]['cueId'] = plan['cues'][0]['id']
    elif invalid == 'blank': repair['updates'][0]['text'] = ' '
    with pytest.raises(ValueError): validate_screen_reference_repair(repair, plan, api.output['audit'])
    with pytest.raises(ValueError): apply_repair(plan, api.output['repairCandidateCorrected'], api.output['audit'], data, repair)


@pytest.mark.asyncio
async def test_unicode_full_display_projection_handles_growth_and_repeated_windows_but_still_rejects_truncation() -> None:
    api, data = await legacy_checkpoint()
    plan = copy.deepcopy(api.output['value']['videoPlan'])
    # A second full display uses the same original cue at a disjoint time window.
    cue = plan['cues'][-1]
    cue['parts'][0].update(startMs=0, endMs=2000)
    cue['parts'].append({**cue['parts'][0], 'startMs': 3000, 'endMs': 5000})
    plan['sourceUnits'][-1]['text'] = TEXT + '星沐🌿'
    data['sourceUnits'] = copy.deepcopy(plan['sourceUnits'])
    repair = reference_patch(plan)
    repair['updates'][0].update(sourceRef={'unitId': 'U0003', 'start': len(TEXT), 'end': len(TEXT)+3}, text='星沐🌿')
    patch = {**api.output['repairCandidateCorrected'], 'baseHash': fingerprint(plan), 'cueUpdates': []}
    result = apply_repair(plan, patch, api.output['audit'], data, repair)
    assert result['cues'][-2]['parts'][0]['textEnd'] == 3
    assert all(part['textEnd'] == 8 for part in result['cues'][-1]['parts'])
    result['cues'][-1]['parts'][-1]['textEnd'] = 7
    with pytest.raises(ValueError, match='screen text is truncated'): validate_plan(result, data)


@pytest.mark.asyncio
async def test_reviewed_reference_fix_cannot_mask_an_unrelated_truncated_caption() -> None:
    api, data = await legacy_checkpoint()
    plan = copy.deepcopy(api.output['value']['videoPlan'])
    repair = reference_patch(plan)
    unrelated = copy.deepcopy(plan['cues'][-1])
    unrelated['id'] = 'unreviewed-caption'
    unrelated['parts'][0]['textEnd'] = 8
    plan['cues'].append(unrelated)
    repair['baseHash'] = fingerprint(plan)
    patch = {**api.output['repairCandidateCorrected'], 'baseHash': fingerprint(plan)}
    with pytest.raises(ValueError, match='screen text is truncated'):
        apply_repair(plan, patch, api.output['audit'], data, repair)


@pytest.mark.asyncio
async def test_mixed_error_keeps_existing_field_repair_and_does_not_change_ordinary_call_order() -> None:
    from customized_production_runtime.video_models import RetimedShotFields
    class Mixed(Provider):
        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            if stage == 'VIDEO_REVIEW':
                value = (await super().generate(stage, model, schema, context, instruction)).model_dump()
                shot = context['result']['shots'][0]
                value['findings'].append({**copy.deepcopy(value['findings'][0]), 'id': 'F002',
                    'evidence': [{'entity': 'SHOT', 'id': shot['id'], 'field': 'visual'}],
                    'affectedShotIds': [shot['id']], 'affectedClipIds': [context['result']['clips'][0]['id']]})
                return schema.model_validate(value)
            if stage == 'VIDEO_REPAIR':
                self.calls.append(stage)
                shot = context['result']['shots'][0]
                fields = {key: None for key in RetimedShotFields.model_fields}
                fields.update(shotId=shot['id'], visual=shot['visual']+'；受控局部修订。')
                return schema.model_validate({'baseHash': context['candidateHash'], 'issueIds': ['F001','F002'],
                    'fields': [fields], 'ranges': [], 'cueUpdates': [], 'timingExplanation': '受控修订'})
            if stage == 'VIDEO_RECHECK':
                self.calls.append(stage)
                return schema.model_validate(clean_audit() | {'severityChanges': [], 'resolutions': [
                    {'issueId': issue['id'], 'status': 'RESOLVED', 'evidence': issue['evidence'], 'explanation': '受控复核通过'} for issue in context['previousErrors']]})
            return await super().generate(stage, model, schema, context, instruction)
    api, provider = FakeApi(), Mixed()
    await run_video(api, provider, api.claim(input_value()))  # type: ignore[arg-type]
    assert api.completed is not None
    assert provider.calls == ['VIDEO_DIRECTOR', 'VIDEO_SHOTS', 'VIDEO_REVIEW', 'VIDEO_SCREEN_REFERENCE_REPAIR', 'VIDEO_REPAIR', 'VIDEO_RECHECK']
