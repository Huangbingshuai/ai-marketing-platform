from __future__ import annotations
import copy
import json
from pathlib import Path
from typing import Any
import pytest
from customized_production_runtime.video_models import DirectorPlan, ShotBatch, Audit, ScopedAudit, Repair, TimingRepair, VideoPlan, ClipPrompt
from customized_production_runtime.video_domain import validate_plan, validate_audit, apply_repair, fingerprint
from customized_production_runtime.video_pipeline import run_video

ROOT = Path(__file__).resolve().parents[3]


def fixture() -> dict[str, Any]:
    return json.loads((ROOT / 'packages/contracts/fixtures/customized-video-plan-v2.json').read_text(encoding='utf-8'))  # type: ignore[no-any-return]


def snapshot() -> dict[str, Any]:
    data = fixture()
    doc = data['document']
    plan = doc['videoPlan']
    return {'shotWorkflowVersion': 2, 'strategyVersion': '2026-10-19-capacity-clips.1', 'identitySeed': 'test-seed', 'script': {'name': '一杯清晨', 'story': {'content': data['scriptText']}}, 'brief': {'productName': '陶瓷杯'}, 'document': doc, 'sourceUnits': plan['sourceUnits'], 'sources': plan['sources'], 'durationPolicy': plan['durationPolicy'], 'renderCapability': plan['capability'], 'models': {'creative': 'controlled-pro', 'detail': 'controlled-turbo'}, 'operation': 'SHOTS', 'draftRevision': 0}


def clean_audit() -> dict[str, Any]:
    return {'summary': '实际内容已核对', 'checks': [{'dimension': dimension, 'conclusion': '实际内容已核对；明确独立定版'} for dimension in ['原稿兑现','时间容量','镜头表达','产品事实','动作与空间','素材绑定','模型能力']], 'findings': [], 'resolutions': []}


def finding(plan: dict[str, Any]) -> dict[str, Any]:
    return {'id': 'capacity-1', 'severity': 'ERROR', 'category': 'CAPACITY', 'title': '动作需要拆镜', 'impact': '必须明确两个连续镜头', 'evidence': [{'entity': 'SHOT', 'id': plan['shots'][0]['id'], 'field': 'visual'}], 'affectedShotIds': [plan['shots'][0]['id']], 'affectedClipIds': [plan['clips'][0]['id']], 'suggestedFix': '拆镜且合理调时', 'repairKind': 'STRUCTURE'}


class FakeApi:
    def __init__(self) -> None:
        self.steps = [{'id': s, 'status': 'PENDING', 'title': s, 'content': ''} for s in ('SNAPSHOT', 'PLAN', 'GENERATE', 'REVIEW', 'REPAIR', 'SAVE')]
        self.output: dict[str, Any] = {}
        self.completed: dict[str, Any] | None = None

    async def call(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        assert body is not None
        if path == 'checkpoint':
            step = body['step']
            old = next(s for s in self.steps if s['id'] == step['id'])
            if old['status'] != 'SUCCEEDED':
                self.steps[self.steps.index(old)] = copy.deepcopy(step)
                self.output = copy.deepcopy(body['output'])
        elif path == 'complete':
            self.completed = copy.deepcopy(body['output'])
        return {'accepted': True}

    def claim(self, data: dict[str, Any]) -> dict[str, Any]:
        return {'input': data, 'steps': self.steps, 'output': self.output}


class FakeProvider:
    def __init__(self, repair: bool = False, fail_recheck: bool = False, infeasible: bool = False) -> None:
        self.calls: list[str] = []
        self.repair = repair
        self.fail_recheck = fail_recheck
        self.infeasible = infeasible

    async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
        self.calls.append(stage)
        data = fixture()['document']['videoPlan']
        if context.get('strategyVersion') == '2026-10-19-capacity-clips.7':
            assert '包含多个真实连续镜头' not in instruction
            assert '需要切镜就生成下一shot' not in instruction
        if stage == 'VIDEO_DIRECTOR':
            assert all('start' not in u and 'end' not in u and u['fullReference']['start'] == 0 and u['fullReference']['end'] == len(u['text']) for u in context['immutableSourceUnits'])
            layouts = [{k: v for k, v in c.items() if k != 'shotIds'} | {'durationSeconds': sum(s['durationSeconds'] for s in data['shots'] if s['id'] in c['shotIds']), 'eventIds': ['event']} for c in data['clips']]
            value = {'summary': '完整原句与分场安排', 'feasible': not self.infeasible, 'inputIssue': 'DURATION_CAPACITY_CONFLICT' if self.infeasible else 'NONE', 'timing': data['timing'], 'suggestedSeconds': 15, 'events': data['events'], 'scenes': data['scenes'], 'clips': layouts, 'cues': [{k: v for k, v in c.items() if k != 'parts'} | {'allocations': [{'clipId': 'clip-a' if c['id'] == 'voice' else 'clip-b', 'textStart': 0, 'textEnd': c['sourceRef']['end']}]} for c in data['cues']]}
        elif stage == 'VIDEO_SHOTS':
            layouts = context['confirmedClipPlans']
            result_clips, shots, parts = [], [], []
            for i, layout in enumerate(layouts):
                sid = f's{i+1}'
                source = copy.deepcopy(data['shots'][0])
                source.update(id=sid, durationSeconds=layout['durationSeconds'], sourceEventIds=layout['eventIds'])
                result_clips.append({k: v for k, v in layout.items() if k not in ('durationSeconds', 'eventIds')} | {'shotIds': [sid]})
                shots.append(source)
                for cue in context['cueAllocations']:
                    allocation = next((a for a in cue['allocations'] if a['clipId'] == layout['id']), None)
                    if allocation:
                        parts.append({'cueId': cue['id'], 'parts': [{'shotId': sid, 'startMs': 0, 'endMs': int(layout['durationSeconds'] * 1000), 'textStart': allocation['textStart'], 'textEnd': allocation['textEnd']}]})
            value = {'clips': result_clips, 'shots': shots, 'cueParts': parts}
        elif stage == 'VIDEO_REVIEW':
            value = clean_audit()
            if self.repair:
                value['findings'] = [finding(context['result'])]
        elif stage == 'VIDEO_REPAIR':
            original = context['result']
            clip = original['clips'][0]
            a, b = copy.deepcopy(original['shots'][0]), copy.deepcopy(original['shots'][0])
            a.update(id='new-a', durationSeconds=6, visual='起手拿杯')
            b.update(id='new-b', durationSeconds=6, visual='杯身近景')
            cue = original['cues'][0]
            replacement = {'clips': [clip | {'id': 'new-clip', 'shotIds': ['new-a', 'new-b']}], 'shots': [a, b], 'cueParts': [{'cueId': cue['id'], 'parts': [{'shotId': 'new-a', 'startMs': 0, 'endMs': 4000, 'textStart': 0, 'textEnd': 4}, {'shotId': 'new-b', 'startMs': 0, 'endMs': 4000, 'textStart': 4, 'textEnd': cue['sourceRef']['end']}]}]}
            value = {'baseHash': context['candidateHash'], 'issueIds': ['capacity-1'], 'fields': [], 'ranges': [{'clipIds': [clip['id']], 'replacement': replacement, 'scenes': [], 'reason': '拆镜并增加自然时长'}], 'timingExplanation': '参考时长下拆镜并增加2秒，原句完整保留'}
        elif stage == 'VIDEO_RECHECK':
            assert context['previousFindings']
            assert all(f in context['previousFindings'] for f in context['previousErrors'])
            value = clean_audit()
            value['resolutions'] = [{'issueId': 'capacity-1', 'status': 'UNRESOLVED' if self.fail_recheck else 'RESOLVED', 'evidence': [{'entity': 'SHOT', 'id': context['result']['shots'][0]['id'], 'field': 'visual'}], 'explanation': '对照实际修订稿'}]
            if schema is ScopedAudit:
                value['severityChanges'] = []
        else:
            raise AssertionError(stage)
        return schema.model_validate(value)


@pytest.mark.asyncio
async def test_normal_path_three_calls_soft_duration_and_clip_identity() -> None:
    api, provider, data = FakeApi(), FakeProvider(), snapshot()
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == ['VIDEO_DIRECTOR', 'VIDEO_SHOTS', 'VIDEO_REVIEW']
    assert api.completed is not None
    plan = api.completed['videoPlan']
    validate_plan(plan, data)
    assert len(plan['clips']) == 2
    assert sum(s['durationSeconds'] for s in plan['shots']) == 15
    assert plan['durationPolicy']['seconds'] == 10
    assert 'shots' not in api.completed


@pytest.mark.asyncio
async def test_one_complete_storyboard_per_task_strategy() -> None:
    api, provider, data = FakeApi(), FakeProvider(), snapshot()
    data['strategyVersion'] = '2026-10-19-capacity-clips.7'
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert api.completed is not None
    plan = api.completed['videoPlan']
    assert len(plan['shots']) == len(plan['clips'])
    assert all(len(c['shotIds']) == 1 for c in plan['clips'])
    validate_plan(plan, data)


def test_new_strategy_rejects_child_shots_without_breaking_historical_prompt_sources() -> None:
    plan, data = fixture()['document']['videoPlan'], snapshot()
    data['strategyVersion'] = '2026-10-19-capacity-clips.7'
    with pytest.raises(ValueError, match='one complete storyboard'):
        validate_plan(plan, data)
    data['operation'] = 'PROMPT'
    validate_plan(plan, data)


@pytest.mark.asyncio
async def test_capacity_stops_before_expensive_shots_and_recovery_buys_nothing() -> None:
    api, provider, data = FakeApi(), FakeProvider(infeasible=True), snapshot()
    data['durationPolicy'] = {'mode': 'FIXED', 'seconds': 5}
    for _ in range(2):
        with pytest.raises(ValueError, match='capacity conflict'):
            await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == ['VIDEO_DIRECTOR']
    assert api.output['failureReason'] == 'DURATION_CAPACITY_CONFLICT'
    assert api.completed is None


@pytest.mark.asyncio
async def test_structural_repair_can_split_and_retime_while_preserving_unaffected_clip() -> None:
    api, provider, data = FakeApi(), FakeProvider(repair=True), snapshot()
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == ['VIDEO_DIRECTOR', 'VIDEO_SHOTS', 'VIDEO_REVIEW', 'VIDEO_REPAIR', 'VIDEO_RECHECK']
    assert api.completed is not None
    before, after = api.output['value']['videoPlan'], api.completed['videoPlan']
    assert len(after['shots']) == len(before['shots']) + 1
    assert sum(s['durationSeconds'] for s in after['shots']) == 17
    assert before['clips'][1] == after['clips'][1]
    assert before['shots'][-1] == after['shots'][-1]
    assert before['sourceUnits'] == after['sourceUnits']
    assert fingerprint(after) == api.output['recheckHash']


@pytest.mark.asyncio
async def test_structural_repair_tolerates_only_identical_echoes_outside_its_range() -> None:
    api, provider, data = FakeApi(), FakeProvider(repair=True), snapshot()
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    before = api.output['value']['videoPlan']
    patch = copy.deepcopy(api.output['repairCandidate'])
    external = before['cues'][1]
    patch['ranges'][0]['replacement']['cueParts'].append({'cueId': external['id'], 'parts': copy.deepcopy(external['parts'])})
    after = apply_repair(before, patch, api.output['audit'], data)
    assert after == api.completed['videoPlan']  # type: ignore[index]
    patch['ranges'][0]['replacement']['cueParts'][-1]['parts'][0]['startMs'] += 1
    with pytest.raises(ValueError, match='outside replacement shots'):
        apply_repair(before, patch, api.output['audit'], data)


@pytest.mark.asyncio
async def test_unresolved_recheck_preserves_candidate_and_resumes_without_paid_repair() -> None:
    api, provider, data = FakeApi(), FakeProvider(repair=True, fail_recheck=True), snapshot()
    for _ in range(2):
        with pytest.raises(ValueError, match='recheck unresolved'):
            await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls.count('VIDEO_REPAIR') == 1
    assert provider.calls.count('VIDEO_RECHECK') == 1
    assert 'revised' in api.output and 'recheck' in api.output
    assert api.completed is None


def test_audit_requires_actual_evidence_and_each_old_error() -> None:
    plan = fixture()['document']['videoPlan']
    original = clean_audit() | {'findings': [finding(plan)]}
    with pytest.raises(ValueError, match='every original'):
        validate_audit(clean_audit(), plan, original)
    original['findings'][0]['evidence'][0]['id'] = 'invented-shot'
    with pytest.raises(ValueError, match='actual field'):
        validate_audit(original, plan)


@pytest.mark.parametrize('name,model', [('director', DirectorPlan), ('batch', ShotBatch), ('audit', Audit), ('scoped-audit', ScopedAudit), ('repair', Repair), ('timing-repair', TimingRepair), ('plan', VideoPlan), ('clip-prompt', ClipPrompt)])
def test_checked_in_schema_matches_python(name: str, model: Any) -> None:
    actual = model.model_json_schema()
    path = ROOT / f'packages/contracts/schemas/customized-video-{name}-v2.schema.json'
    assert json.loads(path.read_text(encoding='utf-8')) == actual


def test_shared_ts_fixture_accepted_by_python_and_rejects_repeated_speech() -> None:
    plan, data = fixture()['document']['videoPlan'], snapshot()
    validate_plan(plan, data)
    plan['cues'][0]['parts'][1]['textStart'] = 0
    with pytest.raises(ValueError, match='omitted/repeated'):
        validate_plan(plan, data)


@pytest.mark.asyncio
async def test_prompt_uses_only_current_clip_speech_and_two_calls() -> None:
    data = snapshot()
    plan = data['document']['videoPlan']
    voice = plan['cues'][0]
    # One original sentence continues through two clips.
    voice['parts'] = [
        {'shotId': plan['clips'][0]['shotIds'][0], 'startMs': 0, 'endMs': 2000, 'textStart': 0, 'textEnd': 4},
        {'shotId': plan['clips'][1]['shotIds'][0], 'startMs': 0, 'endMs': 2000, 'textStart': 4, 'textEnd': voice['sourceRef']['end']},
    ]
    data['operation'] = 'PROMPT'
    data['target'] = {'kind': 'CLIP', 'id': plan['clips'][1]['id']}
    class PromptProvider:
        def __init__(self) -> None:
            self.calls: list[str] = []
        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            self.calls.append(stage)
            if stage == 'VIDEO_PROMPT':
                cue = next(c for c in context['cues'] if c['id'] == voice['id'])
                source = next(u['text'] for u in plan['sourceUnits'] if u['id'] == voice['sourceRef']['unitId'])
                assert cue['sourceText'] == source[voice['sourceRef']['start']:voice['sourceRef']['end']][4:]
                assert cue['continuedFromPrevious'] and not cue['continuesNextClip']
                assert len(cue['parts']) == 1
                ids = sorted({b['assetId'] for shot in context['shots'] for b in shot['bindings']})
                return schema.model_validate({'target': data['target'], 'content': '只呈现当前片段与当前语音，不重复前文。', 'assetIds': ids})
            assert stage == 'VIDEO_REVIEW'
            return schema.model_validate(clean_audit())
    api, provider = FakeApi(), PromptProvider()
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == ['VIDEO_PROMPT', 'VIDEO_REVIEW']
    assert api.completed is not None


def test_rejects_overlapping_parts_of_same_original_voice() -> None:
    plan, data = fixture()['document']['videoPlan'], snapshot()
    voice = plan['cues'][0]
    voice['parts'] = [
        {'shotId': plan['shots'][0]['id'], 'startMs': 0, 'endMs': 2000, 'textStart': 0, 'textEnd': 4},
        {'shotId': plan['shots'][0]['id'], 'startMs': 1000, 'endMs': 3000, 'textStart': 4, 'textEnd': voice['sourceRef']['end']},
    ]
    with pytest.raises(ValueError, match='overlap'):
        validate_plan(plan, data)


def test_director_reports_unit_relative_bounds_before_any_semantic_work() -> None:
    from customized_production_runtime.video_domain import validate_director
    data = snapshot()
    plan = fixture()['document']['videoPlan']
    event = copy.deepcopy(plan['events'][0])
    event['sourceRefs'][0].update(start=100, end=110)
    layouts = [{k: v for k, v in c.items() if k != 'shotIds'} | {'durationSeconds': 5, 'eventIds': [event['id']]} for c in plan['clips']]
    value = {'summary': '结构候选', 'feasible': True, 'inputIssue': 'NONE', 'timing': plan['timing'], 'suggestedSeconds': 10, 'events': [event], 'scenes': plan['scenes'], 'clips': layouts, 'cues': []}
    with pytest.raises(ValueError, match='unit-relative.*allowed='):
        validate_director(value, data)


def test_request_reference_compaction_is_lossless_and_leaves_business_text_untouched() -> None:
    from customized_production_runtime.video_identity import compact_references, rewrite
    data = snapshot()
    original_id = 'asset-01234567-0123-4123-8123-0123456789ab'
    context: dict[str, Any] = {'assets': [{'id': original_id, 'description': '正文原样保留：'+original_id}], 'target': {'kind': 'CLIP','id':'REF1'}, 'bindings':[{'assetId':original_id,'description':'REF1是原文，不替换'}], 'affectedShotIds':[original_id], 'sourceRef':{'unitId':'U0001','start':0,'end':8}}
    compact, restore = compact_references(context)
    assert compact['assets'][0]['id'] != original_id
    assert compact['assets'][0]['description'] == context['assets'][0]['description']
    assert compact['bindings'][0]['assetId'] == compact['affectedShotIds'][0]
    assert compact['target']['id'] == 'REF1'
    assert rewrite(compact,restore) == context
    assert len(json.dumps(compact)) < len(json.dumps(context))


@pytest.mark.asyncio
@pytest.mark.parametrize('repair',[False, True])
async def test_compact_request_references_restore_full_persisted_identities(repair: bool) -> None:
    data = snapshot()
    data['strategyVersion'] = '2026-10-19-capacity-clips.3'
    api, provider = FakeApi(), FakeProvider(repair=repair)
    await run_video(api,provider,api.claim(data))  # type: ignore[arg-type]
    assert api.completed is not None
    validate_plan(api.completed['videoPlan'],data)
    assert all(s['id'].startswith('v') for s in api.completed['videoPlan']['shots'])
    assert all(not b['assetId'].startswith('REF') for s in api.completed['videoPlan']['shots'] for b in s['bindings'])


def test_transport_batching_changes_requests_without_changing_business_clips() -> None:
    from customized_production_runtime.video_pipeline import request_batches
    clips = [{'id':str(i),'sceneId':'same-scene','durationSeconds':10} for i in range(6)]
    batches = request_batches(clips,30)
    assert [len(batch) for batch in batches] == [3,3]
    assert [clip for batch in batches for clip in batch] == clips


def test_review_aliases_are_resolved_only_in_model_authored_commentary() -> None:
    from customized_production_runtime.video_identity import restore_review_text
    value = {'summary': 'REF1与REF10需核对', 'checks': [{'conclusion': 'REF1动作完整'}],
             'findings': [{'title': 'REF10容量', 'impact': 'REF1太短', 'suggestedFix': '延长REF10',
                           'evidence': [{'id': 'real-shot', 'field': 'visual'}]}],
             'resolutions': [{'explanation': 'REF1已经延长'}],
             'sourceText': 'REF1是原稿', 'content': 'REF10是提示词', 'unknown': 'REF1suffix'}
    result = restore_review_text(value, {'REF1': 'real-shot', 'REF10': 'second-shot'})
    assert result['summary'] == 'real-shot与second-shot需核对'
    assert result['findings'][0]['suggestedFix'] == '延长second-shot'
    assert result['sourceText'] == 'REF1是原稿'
    assert result['content'] == 'REF10是提示词'
    assert result['unknown'] == 'REF1suffix'


@pytest.mark.asyncio
async def test_transient_heartbeat_failure_does_not_discard_inflight_generation(monkeypatch: Any) -> None:
    import asyncio
    from ai_runtime.http import InternalApiError
    from customized_production_runtime import consumer
    original_sleep = asyncio.sleep
    async def fast_sleep(delay: float) -> None:
        await original_sleep(0)
    monkeypatch.setattr(consumer.asyncio,'sleep',fast_sleep)
    finished = asyncio.Event()
    class HeartbeatApi:
        calls = 0
        async def call(self, method: str, path: str) -> dict[str, Any]:
            self.calls += 1
            if self.calls == 1:
                raise InternalApiError('temporary disconnect',retryable=True)
            finished.set()
            return {}
    api = HeartbeatApi()
    task = asyncio.create_task(consumer.keep_lease(api))  # type: ignore[arg-type]
    await asyncio.wait_for(finished.wait(),1)
    assert api.calls >= 2 and not task.done()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_lost_lease_stops_without_retrying_unauthorized_writes(monkeypatch: Any) -> None:
    import asyncio
    from ai_runtime.http import InternalApiError
    from customized_production_runtime import consumer
    original_sleep = asyncio.sleep
    async def fast_sleep(delay: float) -> None:
        await original_sleep(0)
    monkeypatch.setattr(consumer.asyncio,'sleep',fast_sleep)
    class LostLeaseApi:
        calls = 0
        async def call(self, method: str, path: str) -> dict[str, Any]:
            self.calls += 1
            raise InternalApiError('old attempt',retryable=False,status_code=409)
    api = LostLeaseApi()
    with pytest.raises(InternalApiError):
        await consumer.keep_lease(api)  # type: ignore[arg-type]
    assert api.calls == 1


@pytest.mark.asyncio
async def test_request_budget_fails_before_a_paid_call_without_truncating_source() -> None:
    data = snapshot()
    data['requestLimits'] = {'maxSourceCharacters':40000,'maxModelInputCharacters':10,'maxBatches':60,'maxClips':120,'maxShots':500,'maxBatchSeconds':30}
    api, provider = FakeApi(), FakeProvider()
    with pytest.raises(ValueError,match='frozen request capacity'):
        await run_video(api,provider,api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == []
    assert api.output['failureReason'] == 'REQUEST_LIMIT'
    assert data['sourceUnits'] == fixture()['document']['videoPlan']['sourceUnits']


@pytest.mark.asyncio
@pytest.mark.parametrize('strategy',['2026-10-19-capacity-clips.4','2026-10-19-capacity-clips.5','2026-10-19-capacity-clips.6'])
async def test_new_strategy_uses_scoped_review_and_reuses_its_saved_result(strategy: str) -> None:
    api, provider, data = FakeApi(), FakeProvider(repair=True), snapshot()
    data['strategyVersion'] = strategy
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == ['VIDEO_DIRECTOR','VIDEO_SHOTS','VIDEO_REVIEW','VIDEO_REPAIR','VIDEO_RECHECK']
    assert api.output['recheck']['severityChanges'] == []
    assert api.completed is not None
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert len(provider.calls) == 5


def test_timing_patch_keeps_existing_visuals_ids_and_unaffected_cues() -> None:
    data = snapshot(); data['strategyVersion'] = '2026-10-19-capacity-clips.5'
    before = data['document']['videoPlan']
    fields: dict[str, Any] = {name:None for name in ['title','shotType','cameraMovement','visual','audio','atmosphere','information','framing','angle','startState','endState','bindings']}
    fields.update(shotId='shot-a',durationSeconds=6)
    patch: dict[str, Any]={'baseHash':fingerprint(before),'issueIds':['capacity-1'],'fields':[fields],'ranges':[],'timingExplanation':'原画面与原话保留，延长自然动作。','cueUpdates':[{'cueId':before['cues'][0]['id'],'parts':copy.deepcopy(before['cues'][0]['parts'])}]}
    result=apply_repair(before,patch,clean_audit() | {'findings':[finding(before)]},data)
    assert result['shots'][0]['durationSeconds']==6
    assert result['shots'][0]['visual']==before['shots'][0]['visual']
    assert result['clips']==before['clips'] and result['cues']==before['cues']
    assert result['shots'][1:]==before['shots'][1:]
    patch['cueUpdates'][0]['parts'][0]['shotId']='shot-c'
    with pytest.raises(ValueError,match='unrelated'):
        apply_repair(before,patch,clean_audit() | {'findings':[finding(before)]},data)


@pytest.mark.asyncio
async def test_checkpoint_recovery_keeps_a_paid_candidate_without_rebuying(monkeypatch: Any) -> None:
    from ai_runtime.http import InternalApiError
    import asyncio
    async def no_sleep(*args: Any) -> None:pass
    monkeypatch.setattr(asyncio,'sleep',no_sleep)
    class InterruptedApi(FakeApi):
        interrupted=False
        async def call(self, method: str,path: str,body: dict[str,Any] | None=None) -> dict[str,Any]:
            if path=='checkpoint' and body and 'directorCandidate' in body.get('output',{}) and not self.interrupted:
                self.interrupted=True
                raise InternalApiError('temporary interruption',retryable=True)
            return await super().call(method,path,body)
    api,provider=InterruptedApi(),FakeProvider()
    await run_video(api,provider,api.claim(snapshot()))  # type: ignore[arg-type]
    assert api.completed is not None and api.interrupted
    assert provider.calls==['VIDEO_DIRECTOR','VIDEO_SHOTS','VIDEO_REVIEW']


@pytest.mark.asyncio
async def test_timeline_is_resolved_for_each_actual_review_and_repair_candidate() -> None:
    class TimelineProvider(FakeProvider):
        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            if stage in {'VIDEO_REVIEW','VIDEO_REPAIR','VIDEO_RECHECK'}:
                assert context['performanceTimeline']
                assert {r['clipId'] for r in context['performanceTimeline']} == {c['id'] for c in context['result']['clips']}
                assert all('allocatedSeconds' in w and 'text' in w for r in context['performanceTimeline'] for w in r['voiceWindows'])
            return await super().generate(stage, model, schema, context, instruction)
    api, provider, data = FakeApi(), TimelineProvider(repair=True), snapshot()
    data['strategyVersion'] = '2026-10-19-capacity-clips.6'
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert api.completed is not None
    assert len(provider.calls) == 5


@pytest.mark.asyncio
async def test_clip_boundaries_come_from_actual_shots_without_buying_a_repair() -> None:
    api, provider, data = FakeApi(), FakeProvider(), snapshot()
    data['strategyVersion'] = '2026-10-19-capacity-clips.6'
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert api.completed is not None
    plan = api.completed['videoPlan']
    shots = {s['id']:s for s in plan['shots']}
    assert len(provider.calls) == 3
    for clip in plan['clips']:
        assert clip['startState'] == shots[clip['shotIds'][0]]['startState']
        assert clip['endState'] == shots[clip['shotIds'][-1]]['endState']
    assert data['document'] == fixture()['document']


def test_boundary_projection_does_not_silently_change_shot_actions_or_other_clips() -> None:
    from customized_production_runtime.video_domain import align_clip_boundaries
    plan = fixture()['document']['videoPlan']; original = copy.deepcopy(plan)
    plan['clips'][0]['startState'] = '过时的片段摘要'
    plan['shots'][0]['startState'] = '镜头真实起幅'
    plan['shots'][0]['visual'] = '保留需要AI判断的实际动作，不由投影猜测动作是否合理'
    current = copy.deepcopy(plan)
    align_clip_boundaries(plan, {'clip-a'})
    assert plan['clips'][0]['startState'] == '镜头真实起幅'
    assert plan['shots'] == current['shots']
    assert plan['cues'] == original['cues']
    assert plan['sourceUnits'] == original['sourceUnits']
    assert plan['clips'][1] == original['clips'][1]
