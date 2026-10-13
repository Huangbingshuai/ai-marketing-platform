import copy
from typing import Any
import pytest
from customized_production_runtime.asset_pipeline import run_assets, align_inventory, apply_repair
from customized_production_runtime.asset_models import DETAIL_KEYS

STEPS = ['SNAPSHOT', 'INVENTORY', 'IDENTITY', 'PRODUCT', 'CHARACTER', 'SCENE', 'PROP', 'IMAGE_PLAN', 'REVIEW', 'REPAIR', 'SAVE']

def fixture() -> dict[str, Any]:
    return {'input': {'assetWorkflowVersion': 2, 'identitySeed': 'test', 'operation': 'ASSETS', 'targetAssetId': None,
        'script': {'name': '车站出发', 'story': {'content': '周越在候车区使用充电器。'}},
        'brief': {'product': 'G65，灰色外壳。'}, 'document': {'assets': [], 'shots': []},
        'models': {'creative': 'controlled', 'detail': 'controlled'}},
        'steps': [{'id': k, 'status': 'PENDING'} for k in STEPS], 'output': None}

class Api:
    def __init__(self, claim: dict[str, Any]) -> None:
        self.claim = claim
        self.completed: Any = None

    async def call(self, method: str, path: str, value: Any = None) -> Any:
        if path == 'checkpoint':
            step = value['step']
            self.claim['steps'] = [copy.deepcopy(step) if s['id'] == step['id'] else s for s in self.claim['steps']]
            self.claim['output'] = copy.deepcopy(value['output'])
        elif path == 'complete':
            self.completed = copy.deepcopy(value['output'])
        return {}

class Provider:
    def __init__(self, *, fail_kind: str = '', repair: bool = False, recheck_fail: bool = False) -> None:
        self.calls: list[str] = []
        self.fail_kind = fail_kind
        self.repair = repair
        self.recheck_fail = recheck_fail

    async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
        self.calls.append(stage)
        if stage == 'ASSET_INVENTORY':
            values = []
            for i, (kind, name, source, path, quote) in enumerate([
                ('PRODUCT', 'G65', 'BRIEF', '/product', 'G65，灰色外壳。'),
                ('CHARACTER', '周越', 'SCRIPT', '/story/content', '周越在候车区使用充电器。'),
                ('SCENE', '候车区', 'SCRIPT', '/story/content', '周越在候车区使用充电器。')]):
                values.append({'key': str(i), 'existingId': None, 'name': name, 'kind': kind, 'aliases': [], 'usage': '实际出场', 'treatment': 'INDEPENDENT', 'parentKey': None, 'sources': [{'source': source, 'path': path, 'quote': quote, 'field': 'knownFacts'}]})
            target = context.get('targetAssetId')
            if target:
                old = next(a for a in context['existingIdentities'] if a['id']==target)
                values = [{**next(a for a in values if a['kind']==old['kind']), 'existingId': target}]
            data: Any = {'objects': values}
        elif stage.startswith('ASSET_DEFINE_'):
            kind = stage.removeprefix('ASSET_DEFINE_')
            if kind == self.fail_kind:
                raise RuntimeError('controlled transient failure')
            data = {'assets': [{'id': a['id'], 'kind': a['kind'], 'name': a['name'], 'description': '公共形象', 'knownFacts': '资料所述', 'designNotes': '允许设计', 'sourceText': a['sources'][0]['quote'], 'imageRequirements': '基础参考图',
                'preparation': {'aliases': a['aliases'], 'usage': a['usage'], 'treatment': a['treatment'], 'parentId': a['parentId'], 'sources': a['sources'], 'details': [{'key': k, 'value': '待确认'} for k in DETAIL_KEYS[kind]], 'questions': [], 'images': []}} for a in context['objects']]}
        elif stage in ('ASSET_REVIEW', 'ASSET_RECHECK'):
            findings = [{'assetId': context['assets'][0]['id'], 'field': 'description', 'issue': '外观描述不准确', 'basis': '灰色外壳', 'severity': 'REQUIRED'}] if (self.repair and stage=='ASSET_REVIEW') or (self.recheck_fail and stage=='ASSET_RECHECK') else []
            data = {'summary': '检查实际对象及事实', 'findings': findings}
        elif stage == 'ASSET_REPAIR':
            data = {'patches': [{'assetId': context['findings'][0]['assetId'], 'field': 'description', 'text': '灰色外壳', 'preparation': None}]}
        else:
            raise AssertionError(stage)
        return schema.model_validate(data)

@pytest.mark.asyncio
async def test_full_pipeline_has_real_category_checkpoints_and_no_empty_category_model() -> None:
    claim = fixture(); api = Api(claim); provider = Provider()
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert len(api.completed['assets']) == 3
    assert 'ASSET_DEFINE_PROP' not in provider.calls
    assert all(s['status']=='SUCCEEDED' for s in claim['steps'] if s['id']!='SAVE')
    assert '无需此类对象' in next(s['content'] for s in claim['steps'] if s['id']=='PROP')

@pytest.mark.asyncio
async def test_partial_failure_reuses_successful_batches_without_regenerating_inventory() -> None:
    claim = fixture(); api = Api(claim); provider = Provider(fail_kind='CHARACTER')
    with pytest.raises(RuntimeError):
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert api.completed is None
    retry = Provider()
    await run_assets(api, retry, claim)  # type: ignore[arg-type]
    assert retry.calls == ['ASSET_DEFINE_CHARACTER', 'ASSET_REVIEW']

@pytest.mark.asyncio
async def test_field_repair_preserves_other_assets_and_does_not_repeat_failed_recheck() -> None:
    claim = fixture(); api = Api(claim); provider = Provider(repair=True, recheck_fail=True)
    with pytest.raises(ValueError, match='unresolved'):
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert claim['output']['revised'][0]['description']=='灰色外壳'
    assert claim['output']['revised'][1]['description']=='公共形象'
    assert '修改前：公共形象' in next(s['content'] for s in claim['steps'] if s['id']=='REPAIR')
    assert '修改后：灰色外壳' in next(s['content'] for s in claim['steps'] if s['id']=='REPAIR')
    retry = Provider()
    with pytest.raises(ValueError, match='unresolved'):
        await run_assets(api, retry, claim)  # type: ignore[arg-type]
    assert retry.calls == []

@pytest.mark.asyncio
async def test_single_item_preserves_manual_field() -> None:
    claim = fixture(); api = Api(claim); provider = Provider()
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    old = api.completed['assets'][1]
    old.update(description='用户指定的角色形象', manualFields=['description'])
    target = fixture(); target['input']['document']['assets'] = [old]; target['input']['targetAssetId'] = old['id']
    target_api = Api(target)
    await run_assets(target_api, Provider(), target)  # type: ignore[arg-type]
    assert len(target_api.completed['assets'])==1
    assert target_api.completed['assets'][0]['description']=='用户指定的角色形象'

@pytest.mark.asyncio
async def test_evidence_and_repair_scope_are_mechanically_checked() -> None:
    claim = fixture(); api = Api(claim)
    await run_assets(api, Provider(), claim)  # type: ignore[arg-type]
    inventory = copy.deepcopy(claim['output']['inventoryRaw'])
    inventory['objects'][0]['sources'][0]['quote']='并不存在的认证'
    with pytest.raises(ValueError, match='quote'):
        align_inventory(inventory, claim['input'])
    assets = api.completed['assets']
    with pytest.raises(ValueError, match='outside'):
        apply_repair(assets, {'patches':[{'assetId':assets[1]['id'], 'field':'description', 'text':'改他人', 'preparation':None}]},
            {'findings':[{'assetId':assets[0]['id'], 'field':'description', 'severity':'REQUIRED'}]}, claim['input'])
