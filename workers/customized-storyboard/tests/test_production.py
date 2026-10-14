from typing import Any
import pytest
from customized_storyboard.production import check_output, run, coalesce_segments, Segment, scoped_shot_repair, story_context


ASSET={'id':'cup','kind':'PRODUCT','name':'陶瓷杯','description':'白色陶瓷杯','knownFacts':'陶瓷','designNotes':'颜色可设计','sourceText':'简报'}
SHOT={'id':'s1','title':'倒水','shotType':'特写','cameraMovement':'固定','durationSeconds':30,'visual':'杯中倒入水','dialogue':'','audio':'水声','atmosphere':'清晨','bindings':[{'assetId':'cup','description':'杯口'}]}

def snapshot(operation: str) -> dict[str,Any]:
    return {'operation':operation,'models':{'creative':'controlled','detail':'controlled'},'script':{'name':'清晨','synopsis':'倒水','story':{'content':'清晨倒水','beats':[{'durationSeconds':30}]}},'brief':{'productName':'陶瓷杯'},'shotId':'s1','document':{'assets':[ASSET,{**ASSET,'id':'unrelated','name':'无关对象'}],'shots':[SHOT]}}

def test_binding_and_duration_validation() -> None:
    check_output('SHOTS',{'shots':[SHOT]},snapshot('SHOTS'))
    with pytest.raises(ValueError):
        check_output('SHOTS',{'shots':[{**SHOT,'bindings':[{'assetId':'missing','description':''}]}]},snapshot('SHOTS'))
    with pytest.raises(ValueError):
        check_output('SHOTS',{'shots':[{**SHOT,'durationSeconds':5}]},snapshot('SHOTS'))
    with pytest.raises(ValueError):
        check_output('PROMPT',{'shotId':'s1','content':'倒水','assetIds':['cup','unrelated']},snapshot('PROMPT'))

def test_reference_duration_is_not_reapplied_by_downstream_shots() -> None:
    from customized_storyboard.production import target_duration
    value = snapshot('SHOTS')
    value['script']['creation'] = {'videoType': 'BRAND_AD', 'referenceDurationSeconds': 30, 'structureSections': ['视觉开场']}
    value['script']['structure'] = '视觉开场'
    value['script']['story']['beats'][0]['durationSeconds'] = 42
    assert target_duration(value) == 42
    check_output('SHOTS', {'shots': [{**SHOT, 'durationSeconds': 42}]}, value)
    with pytest.raises(ValueError):
        check_output('SHOTS', {'shots': [SHOT]}, value)
    assert story_context(value['script'])['creation']['videoType'] == 'BRAND_AD'
    assert story_context(value['script'])['structure'] == '视觉开场'


def test_adjacent_beats_share_a_request_without_changing_content_or_time() -> None:
    original = [Segment(content=f'事件{i}', durationSeconds=d) for i, d in enumerate([6, 6, 6, 7, 5, 40, 20, 60])]
    merged = coalesce_segments(original)
    assert [s.durationSeconds for s in merged] == [30, 60, 60]
    assert sum(s.durationSeconds for s in merged) == sum(s.durationSeconds for s in original)
    assert '\n\n'.join(s.content for s in merged) == '\n\n'.join(s.content for s in original)
    assert [s.durationSeconds for s in original] == [6, 6, 6, 7, 5, 40, 20, 60]


def test_repair_schema_fences_ids_count_and_total_time() -> None:
    schema = scoped_shot_repair([SHOT])
    assert schema.model_json_schema()['$defs']['ProductionShot']['properties']['id']['enum'] == ['s1']
    schema.model_validate({'shots': [SHOT]})
    for invalid in [[{**SHOT, 'id': 'other'}], [SHOT, SHOT], [{**SHOT, 'durationSeconds': 29}]]:
        with pytest.raises(ValueError):
            schema.model_validate({'shots': invalid})


def test_production_reads_complete_story_without_locking_outline_timing() -> None:
    script = {**snapshot('SHOTS')['script'], 'structure': '旧6秒段落', 'shots': [SHOT], 'assets': [ASSET]}
    result = story_context(script)
    assert result['story']['content'] == script['story']['content']
    assert 'beats' not in result['story']
    assert not {'structure', 'shots', 'assets'} & result.keys()
    assert script['story']['beats'] == [{'durationSeconds': 30}]

class Api:
    def __init__(self) -> None:self.calls:list[tuple[str,Any]]=[]
    async def call(self,method:str,path:str,value:Any=None) -> dict[str,Any]:
        self.calls.append((path,value));return {}

class Provider:
    def __init__(self) -> None:self.contexts:list[dict[str,Any]]=[]
    async def generate(self,stage:str,model:str,schema:Any,context:dict[str,Any],instruction:str) -> Any:
        self.contexts.append(context)
        return schema.model_validate({'summary':'事实与绑定核对通过','issues':[]} if stage=='PRODUCTION_REVIEW' else {'shotId':'s1','content':'固定特写，水倒入陶瓷杯。','assetIds':['cup']})

@pytest.mark.asyncio
async def test_prompt_only_receives_bound_assets_and_persists_real_content() -> None:
    api,provider=Api(),Provider()
    await run(api,provider,{'input':snapshot('PROMPT'),'output':None,'steps':[{'id':id,'status':'PENDING'} for id in ['SNAPSHOT','GENERATE','REVIEW','SAVE']]})  # type: ignore[arg-type]
    assert [a['id'] for a in provider.contexts[0]['assets']]==['cup']
    assert api.calls[-1][0]=='complete'
    assert api.calls[-1][1]['output']['content']=='固定特写，水倒入陶瓷杯。'

@pytest.mark.asyncio
async def test_completed_review_resumes_without_paid_generation() -> None:
    api,provider=Api(),Provider()
    output={'shotId':'s1','content':'固定特写，水倒入陶瓷杯。','assetIds':['cup']}
    await run(api,provider,{'input':snapshot('PROMPT'),'output':output,'steps':[{'id':id,'status':'SUCCEEDED'} for id in ['SNAPSHOT','GENERATE','REVIEW','SAVE']]})  # type: ignore[arg-type]
    assert not provider.contexts
    assert api.calls==[('complete',{'output':output})]

class LongProvider:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.fail_second = True

    async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
        self.calls.append(stage)
        if stage == 'PRODUCTION_PLAN':
            return schema.model_validate({'summary':'开场、使用、收束，各60秒', 'segments':[{'content':str(i),'durationSeconds':60} for i in range(3)]})
        if stage == 'PRODUCTION_SHOTS':
            if context['currentSegment']['content']=='1' and self.fail_second:
                raise TimeoutError('controlled timeout')
            return schema.model_validate({'shots':[{**SHOT,'durationSeconds':60}]})
        return schema.model_validate({'summary':'事实、连续性与引用通过','issues':[]})

@pytest.mark.asyncio
async def test_long_shots_resume_successful_chunks_without_regenerating_them() -> None:
    api, provider=Api(),LongProvider()
    data=snapshot('SHOTS');data['script']['story']['beats']=[{'durationSeconds':180}]
    claim={'input':data,'output':None,'steps':[{'id':id,'status':'PENDING'} for id in ['SNAPSHOT','PLAN','GENERATE','REVIEW','REPAIR','SAVE']]}
    with pytest.raises(TimeoutError):
        await run(api,provider,claim)  # type: ignore[arg-type]
    for path,body in api.calls:
        if path=='checkpoint':
            claim['steps']=[body['step'] if s['id']==body['step']['id'] else s for s in claim['steps']]
            if 'output' in body:claim['output']=body['output']
    assert set(claim['output']['chunks'])=={'0','2'}
    provider.fail_second=False
    await run(api,provider,claim)  # type: ignore[arg-type]
    assert provider.calls.count('PRODUCTION_PLAN')==1
    assert provider.calls.count('PRODUCTION_SHOTS')==4
    shots=api.calls[-1][1]['output']['shots']
    assert len({s['id'] for s in shots})==3
    assert sum(s['durationSeconds'] for s in shots)==180


def test_production_schemas_stay_in_sync() -> None:
    import json
    from pathlib import Path
    from customized_storyboard.production import Catalog, ShotList, Prompt, Plan, Audit
    root=Path(__file__).resolve().parents[3]
    for name, model in [('catalog',Catalog),('shots',ShotList),('prompt',Prompt),('plan',Plan),('audit',Audit)]:
        assert json.loads((root/'packages/contracts/schemas'/f'customized-production-{name}.schema.json').read_text(encoding='utf-8'))==model.model_json_schema()


@pytest.mark.asyncio
async def test_chunk_duration_drift_is_not_saved_as_a_successful_checkpoint() -> None:
    class DriftingProvider(LongProvider):
        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            if stage == 'PRODUCTION_SHOTS':
                return schema.model_validate({'shots': [{**SHOT, 'durationSeconds': 59.5}]})
            return await super().generate(stage, model, schema, context, instruction)

    api = Api()
    data = snapshot('SHOTS')
    data['script']['story']['beats'] = [{'durationSeconds': 180}]
    claim = {'input': data, 'output': None, 'steps': [{'id': id, 'status': 'PENDING'} for id in ['SNAPSHOT', 'PLAN', 'GENERATE', 'REVIEW', 'REPAIR', 'SAVE']]}
    with pytest.raises(ValueError, match='timing budget'):
        await run(api, DriftingProvider(), claim)  # type: ignore[arg-type]
    assert not any(body.get('output', {}).get('chunks') for path, body in api.calls if path == 'checkpoint')


@pytest.mark.asyncio
async def test_asset_planning_identifies_operation_and_does_not_split_shots() -> None:
    class AssetProvider:
        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            assert context.get('operation', context.get('input', {}).get('operation')) == 'ASSETS'
            if stage == 'PRODUCTION_PLAN':
                assert '不要创作镜头' in instruction
                assert all(set(a) == {'id', 'kind', 'name'} for a in context['existingDefinitions'])
                return schema.model_validate({'summary': '产品陶瓷杯；来源为简报', 'segments': []})
            if stage == 'PRODUCTION_ASSETS':
                return schema.model_validate({'assets': [ASSET]})
            assert '仅审校result.assets资产目录' in instruction
            assert 'imageRequirements' in instruction
            return schema.model_validate({'summary': '对象及依据通过', 'issues': []})

    api = Api()
    await run(api, AssetProvider(), {'input': snapshot('ASSETS'), 'output': None, 'steps': [{'id': id, 'status': 'PENDING'} for id in ['SNAPSHOT', 'PLAN', 'GENERATE', 'REVIEW', 'REPAIR', 'SAVE']]})  # type: ignore[arg-type]
    assert api.calls[-1][0] == 'complete'
    assert api.calls[-1][1]['output']['assets'][0]['id'] == 'cup'


@pytest.mark.asyncio
async def test_scoped_repair_preserves_unaffected_shots_and_rechecks_full_result() -> None:
    class RepairProvider:
        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            if stage == 'PRODUCTION_PLAN':
                return schema.model_validate({'summary': '两个连续事件', 'segments': [{'content': '倒水', 'durationSeconds': 15}, {'content': '阅读', 'durationSeconds': 15}]})
            if stage == 'PRODUCTION_SHOTS':
                assert context['currentSegment']['durationSeconds'] == 30
                return schema.model_validate({'shots': [{**SHOT, 'durationSeconds': 15}, {**SHOT, 'id': 's2', 'title': '阅读', 'durationSeconds': 15}]})
            if stage == 'PRODUCTION_REVIEW':
                return schema.model_validate({'summary': '第一镜需补足动作', 'issues': ['明确水流动作'], 'affectedIds': ['segment-1-shot-1']})
            if stage == 'PRODUCTION_REPAIR':
                assert [s['id'] for s in context['result']['shots']] == ['segment-1-shot-1']
                assert context['repairDurationSeconds'] == 15
                assert len(context['continuityContext']['shots']) == 2
                assert '不重新拆分故事' in instruction
                return schema.model_validate({'shots': [{**context['result']['shots'][0], 'visual': '水持续倒入杯中'}]})
            assert len(context['result']['shots']) == 2
            return schema.model_validate({'summary': '完整结果复核通过', 'issues': []})

    api = Api()
    await run(api, RepairProvider(), {'input': snapshot('SHOTS'), 'output': None, 'steps': [{'id': id, 'status': 'PENDING'} for id in ['SNAPSHOT', 'PLAN', 'GENERATE', 'REVIEW', 'REPAIR', 'SAVE']]})  # type: ignore[arg-type]
    shots = api.calls[-1][1]['output']['shots']
    assert len(shots) == 2 and sum(s['durationSeconds'] for s in shots) == 30
    assert shots[0]['visual'] == '水持续倒入杯中'
    assert shots[1]['visual'] == SHOT['visual']
