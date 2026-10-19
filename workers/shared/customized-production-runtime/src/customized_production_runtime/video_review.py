"""Review scope and issue bookkeeping. No keyword-based semantic decisions."""
from __future__ import annotations
import copy
from typing import Any
from .video_domain import fingerprint, evidence_value, validate_audit, excerpt, ms
from .video_models import ScopedAudit


def performance_timeline(plan: dict[str, Any], clip_ids: set[str] | None = None) -> list[dict[str, Any]]:
    """Resolve authored source ranges and shot-local times, without judging speech rate.

    A generous clip duration does not imply that its voice has that whole window.
    Let the reviewer see the actual words and allocated seconds rather than asking
    it to reconstruct Unicode offsets and perform timeline arithmetic itself.
    """
    shots = {s['id']: s for s in plan['shots']}
    result = []
    for clip in plan['clips']:
        if clip_ids is not None and clip['id'] not in clip_ids:
            continue
        offsets: dict[str, int] = {}
        offset = 0
        for sid in clip['shotIds']:
            offsets[sid] = offset
            offset += ms(shots[sid]['durationSeconds'])
        voices: list[dict[str, Any]] = []
        screen_text: list[dict[str, Any]] = []
        for cue in plan['cues']:
            text = excerpt(cue['sourceRef'], plan['sourceUnits'])
            for part in cue['parts']:
                sid = part['shotId']
                if sid not in offsets:
                    continue
                window = {'cueId': cue['id'], 'shotId': sid, 'shotTitle': shots[sid]['title'],
                          'speaker': cue.get('speaker', ''), 'text': text[part['textStart']:part['textEnd']],
                          'fromSeconds': (offsets[sid]+part['startMs'])/1000,
                          'toSeconds': (offsets[sid]+part['endMs'])/1000,
                          'allocatedSeconds': (part['endMs']-part['startMs'])/1000,
                          'evidence': [{'entity': 'CUE', 'id': cue['id'], 'field': 'parts'},
                                       {'entity': 'CUE', 'id': cue['id'], 'field': 'sourceRef'},
                                       {'entity': 'SHOT', 'id': sid, 'field': 'durationSeconds'}]}
                (screen_text if cue['kind'] == 'ON_SCREEN_TEXT' else voices).append(window)
        voices.sort(key=lambda w: (w['fromSeconds'], w['toSeconds']))
        screen_text.sort(key=lambda w: (w['fromSeconds'], w['toSeconds']))
        result.append({'clipId': clip['id'], 'clipTitle': clip['title'], 'durationSeconds': offset/1000,
                       'voiceWindows': voices, 'screenTextWindows': screen_text})
    return result


def neighbourhood(plan: dict[str, Any], hits: set[str]) -> set[str]:
    clips = plan['clips']
    positions = [i for i, c in enumerate(clips) if c['id'] in hits]
    return {clips[j]['id'] for i in positions for j in (i-1, i, i+1) if 0 <= j < len(clips)}


def scope_projection(plan: dict[str, Any], clip_ids: set[str]) -> dict[str, Any]:
    clips = [c for c in plan['clips'] if c['id'] in clip_ids]
    shot_ids = {s for c in clips for s in c['shotIds']}
    shots = [s for s in plan['shots'] if s['id'] in shot_ids]
    events = {e for s in shots for e in s['sourceEventIds']}
    scenes = {c['sceneId'] for c in clips}
    cues = [copy.deepcopy(c) | {'parts': [p for p in c['parts'] if p['shotId'] in shot_ids]} for c in plan['cues'] if any(p['shotId'] in shot_ids for p in c['parts'])]
    return {'durationPolicy': plan['durationPolicy'], 'capability': plan['capability'], 'timing': plan['timing'], 'clips': clips, 'shots': shots, 'events': [e for e in plan['events'] if e['id'] in events], 'scenes': [s for s in plan['scenes'] if s['id'] in scenes], 'cues': cues}


def repair_context(plan: dict[str, Any], audit: dict[str, Any]) -> dict[str, Any]:
    errors = [f for f in audit['findings'] if f['severity'] == 'ERROR']
    hit_shots = {s for f in errors for s in f['affectedShotIds']}
    hits = {c for f in errors for c in f['affectedClipIds']}
    hits.update(c['id'] for c in plan['clips'] if hit_shots.intersection(c['shotIds']))
    scope = neighbourhood(plan, hits)
    result = scope_projection(plan, scope)
    return {'result': result, 'review': {'summary': '只修复下列必须处理的问题，其他内容保留', 'findings': errors},
            'repairScope': {'affectedClipIds': sorted(hits), 'boundaryClipIds': sorted(scope-hits),
                            'requiredCues': result['cues']}}


def review_context(before: dict[str, Any], after: dict[str, Any], audit: dict[str, Any]) -> tuple[dict[str, Any], set[str]]:
    old_shots = {s['id']: s for s in before['shots']}
    old_clips = {c['id']: c for c in before['clips']}
    changed_shots = {s['id'] for s in after['shots'] if s != old_shots.get(s['id'])}
    hits = {c['id'] for c in after['clips'] if c != old_clips.get(c['id']) or changed_shots.intersection(c['shotIds'])}
    # Cue-only edits are part of the actual production delta too.
    old_cues = {c['id']: c for c in before['cues']}
    for cue in after['cues']:
        if cue != old_cues.get(cue['id']):
            old_parts = old_cues.get(cue['id'], {}).get('parts', [])
            ids = {p['shotId'] for p in cue['parts'] if p not in old_parts}
            ids.update(p['shotId'] for p in old_parts if p not in cue['parts'])
            hits.update(c['id'] for c in after['clips'] if ids.intersection(c['shotIds']))
    scope = neighbourhood(after, hits)
    shot_ids = {s for c in after['clips'] if c['id'] in scope for s in c['shotIds']}
    changes = []
    for shot in after['shots']:
        old = old_shots.get(shot['id'])
        if old is None:
            if shot['id'] in changed_shots:
                changes.append({'title': shot['title'], 'change': '结构替换后的镜头，当前完整内容见result'})
        elif shot != old:
            changes.append({'title': shot['title'], 'fields': [{ 'field': k, 'before': old.get(k), 'after': v} for k, v in shot.items() if v != old.get(k)]})
    return {'result': scope_projection(after, scope), 'previousFindings': audit['findings'],
            'previousErrors': [f for f in audit['findings'] if f['severity'] == 'ERROR'],
            'actualChanges': changes, 'reviewScope': {'clipIds': sorted(scope), 'shotIds': sorted(shot_ids),
            'policy': '只重新检查实际修改及相邻衔接。范围外未改内容沿用首审，不重新全片打分；首审确有误判必须用原问题ID和severityChanges说明。'}}, scope


def finish_review(raw: dict[str, Any], before: dict[str, Any], after: dict[str, Any], previous: dict[str, Any], scope: set[str]) -> dict[str, Any]:
    value = ScopedAudit.model_validate(raw).model_dump()
    prior = {f['id']: f for f in previous['findings']}
    current = {f['id']: f for f in value['findings']}
    changes = value['severityChanges']
    if len({c['issueId'] for c in changes}) != len(changes):
        raise ValueError('duplicate severity change')
    actual_changes = {key for key, f in current.items() if key in prior and f['severity'] != prior[key]['severity']}
    if {c['issueId'] for c in changes} != actual_changes:
        raise ValueError('severity change requires the original issue identity and an explicit classification record')
    for change in changes:
        old, new = prior[change['issueId']], current[change['issueId']]
        if old['severity'] != change['fromSeverity'] or new['severity'] != change['toSeverity'] or not change['explanation'].strip():
            raise ValueError('severity change does not match original/current classification')
        for e in change['evidence']:
            evidence_value(after, e)
        if change['reason'] == 'NEW_EVIDENCE':
            changed = False
            for e in change['evidence']:
                try:
                    changed |= fingerprint(evidence_value(before, e)) != fingerprint(evidence_value(after, e))
                except ValueError:
                    changed = True
            if not changed:
                raise ValueError('unchanged evidence cannot be described as new evidence; explicitly correct the first review if it was misclassified')
    scope_shots = {s for c in after['clips'] if c['id'] in scope for s in c['shotIds']}
    corrections = {c['issueId'] for c in changes if c['reason'] == 'INITIAL_REVIEW_CORRECTION'}
    for finding in value['findings']:
        inside = bool(set(finding['affectedShotIds']) & scope_shots or set(finding['affectedClipIds']) & scope)
        old = prior.get(finding['id'])
        if not inside and finding['severity'] == 'ERROR' and finding['id'] not in corrections:
            raise ValueError('recheck may not invent an out-of-scope error by regrading unchanged content; use the original issue identity for a documented first-review correction')
        if old and old['category'] != finding['category']:
            raise ValueError('recheck changed an existing issue category; use a separate new issue identity')
    # Unchanged warnings outside the reviewed delta are kept, never silently resolved.
    for finding in previous['findings']:
        if finding['severity'] == 'WARNING' and finding['id'] not in current and not (set(finding['affectedShotIds']) & scope_shots or set(finding['affectedClipIds']) & scope):
            try:
                unchanged = all(fingerprint(evidence_value(before, e)) == fingerprint(evidence_value(after, e)) for e in finding['evidence'])
            except ValueError:
                unchanged = False
            if unchanged:
                value['findings'].append(copy.deepcopy(finding))
    validate_audit(value, after, previous)
    return value
