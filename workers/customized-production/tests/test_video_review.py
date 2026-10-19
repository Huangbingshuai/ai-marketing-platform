from __future__ import annotations
import copy
from typing import Any
import pytest
from test_video_v2 import fixture, finding, clean_audit
from customized_production_runtime.video_review import review_context, finish_review, performance_timeline


def case() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any], set[str]]:
    before = fixture()['document']['videoPlan']
    for index in range(3):
        shot = copy.deepcopy(before['shots'][-1]) | {'id': f'other-shot-{index}'}
        before['shots'].append(shot)
        before['clips'].append(copy.deepcopy(before['clips'][-1]) | {'id': f'other-clip-{index}', 'shotIds': [shot['id']]})
    previous = clean_audit()
    previous['findings'] = [finding(before), finding(before) | {'id':'warning','severity':'WARNING','affectedShotIds':['other-shot-2'],'affectedClipIds':['other-clip-2'],'evidence':[{'entity':'SHOT','id':'other-shot-2','field':'visual'}]}]
    after = copy.deepcopy(before)
    after['shots'][0]['visual'] = '确已修订的连续动作'
    context, scope = review_context(before,after,previous)
    raw = clean_audit() | {'severityChanges': [], 'resolutions':[{'issueId':'capacity-1','status':'RESOLVED','evidence':[{'entity':'SHOT','id':'shot-a','field':'visual'}],'explanation':'当前画面已修订'}]}
    return before,after,previous,raw,scope


def test_unchanged_warning_keeps_identity_and_severity_outside_delta() -> None:
    before,after,previous,raw,scope = case()
    context,_ = review_context(before,after,previous)
    assert len(context['result']['clips']) < len(after['clips'])
    assert 'other-clip-2' not in scope
    value = finish_review(raw,before,after,previous,scope)
    assert value['findings'] == [previous['findings'][1]]


def test_regrading_unchanged_range_cannot_hide_behind_a_new_issue_id() -> None:
    before,after,previous,raw,scope = case()
    raw['findings'] = [previous['findings'][1] | {'id':'invented-new-id','severity':'ERROR'}]
    with pytest.raises(ValueError,match='out-of-scope'):
        finish_review(raw,before,after,previous,scope)


def test_severity_changes_require_an_explicit_record_for_the_original_issue() -> None:
    before,after,previous,raw,scope = case()
    raw['findings'] = [previous['findings'][1] | {'severity':'ERROR'}]
    with pytest.raises(ValueError,match='explicit classification record'):
        finish_review(raw,before,after,previous,scope)
    raw['severityChanges'] = [{'issueId':'warning','fromSeverity':'WARNING','toSeverity':'ERROR','reason':'NEW_EVIDENCE','explanation':'声称有新依据','evidence':previous['findings'][1]['evidence']}]
    with pytest.raises(ValueError,match='unchanged evidence'):
        finish_review(raw,before,after,previous,scope)
    raw['severityChanges'][0].update(reason='INITIAL_REVIEW_CORRECTION',explanation='首审将明确的动作矛盾错误归为建议；当前原画面同时要求手持和静置，故纠正首审分类。')
    value = finish_review(raw,before,after,previous,scope)
    assert value['findings'][0]['severity'] == 'ERROR'
    assert value['severityChanges'][0]['reason'] == 'INITIAL_REVIEW_CORRECTION'


def test_real_new_error_in_changed_scope_still_blocks() -> None:
    before,after,previous,raw,scope = case()
    raw['findings'] = [finding(after) | {'id':'new-fact-error','category':'FACT'}]
    value = finish_review(raw,before,after,previous,scope)
    assert any(f['severity']=='ERROR' for f in value['findings'])


def test_performance_windows_resolve_actual_words_and_shot_offsets_without_estimating_speech() -> None:
    plan = fixture()['document']['videoPlan']
    original = copy.deepcopy(plan)
    rows = performance_timeline(plan)
    assert rows[0]['durationSeconds'] == 10
    first, second = rows[0]['voiceWindows']
    assert first['fromSeconds'] == 0 and first['toSeconds'] == 2.5
    assert first['allocatedSeconds'] == 2.5
    from customized_production_runtime.video_domain import evidence_value
    for row in rows:
        for window in row['voiceWindows']+row['screenTextWindows']:
            for evidence in window['evidence']:
                evidence_value(plan, evidence)
    assert second['fromSeconds'] == plan['shots'][0]['durationSeconds']
    assert second['allocatedSeconds'] == 3
    assert first['text']+second['text'] == '把日常留给自己。'
    assert rows[1]['voiceWindows'] == []
    assert rows[1]['screenTextWindows'][0]['text'] == '一杯清晨'
    assert performance_timeline(plan, {'clip-b'}) == [rows[1]]
    assert plan == original


def test_performance_windows_use_unicode_characters_and_preserve_fractional_seconds() -> None:
    plan = fixture()['document']['videoPlan']
    plan['sourceUnits'][1]['text'] = '杯☕😊USB-C'
    cue = plan['cues'][0]
    cue['sourceRef'].update(start=1, end=8)
    cue['parts'] = [cue['parts'][0] | {'textStart': 0, 'textEnd': 2, 'startMs': 125, 'endMs': 2125}]
    window = performance_timeline(plan)[0]['voiceWindows'][0]
    assert window['text'] == '☕😊'
    assert window['fromSeconds'] == 0.125
    assert window['allocatedSeconds'] == 2
