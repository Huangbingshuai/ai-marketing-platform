import copy
from typing import Any
import pytest
from customized_production_runtime.asset_pipeline import run_assets, align_inventory, apply_repair, definition_schema, scope_definitions
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

class InvalidInventoryProvider(Provider):
    def __init__(self, *, correction_fails: bool = False, invalid_parent: bool = False) -> None:
        super().__init__()
        self.correction_fails = correction_fails
        self.invalid_parent = invalid_parent

    async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
        if stage == 'ASSET_VALIDATE_INVENTORY':
            self.calls.append(stage)
            data = copy.deepcopy(context['candidate'])
            if not self.correction_fails:
                data['objects'][0]['sources'][0]['quote'] = 'G65，灰色外壳。'
                if self.invalid_parent:
                    assert set(context['validationErrors']) == {'asset evidence quote not found', 'invalid detail parent'}
                    data['objects'][2].update(treatment='INDEPENDENT', parentKey=None)
            return schema.model_validate(data)
        result = await super().generate(stage, model, schema, context, instruction)
        if stage == 'ASSET_INVENTORY':
            data = result.model_dump()
            data['objects'][0]['sources'][0]['quote'] = '不是原文的产品说明'
            if self.invalid_parent:
                data['objects'][2].update(treatment='SCENE_DETAIL', parentKey='0')
            return schema.model_validate(data)
        return result


@pytest.mark.asyncio
async def test_inventory_reference_is_corrected_once_before_defining_assets() -> None:
    claim = fixture(); api = Api(claim); provider = InvalidInventoryProvider()
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert api.completed is not None
    assert provider.calls.count('ASSET_INVENTORY') == 1
    assert provider.calls.count('ASSET_VALIDATE_INVENTORY') == 1
    assert claim['output']['inventoryValidationError'] == 'asset evidence quote not found'


@pytest.mark.asyncio
async def test_inventory_correction_receives_all_mechanical_errors_in_one_call() -> None:
    claim = fixture(); api = Api(claim); provider = InvalidInventoryProvider(invalid_parent=True)
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert api.completed is not None
    assert provider.calls.count('ASSET_VALIDATE_INVENTORY') == 1
    assert len(claim['output']['inventoryValidationErrors']) == 2


@pytest.mark.asyncio
async def test_failed_inventory_correction_keeps_candidates_and_never_repeats_paid_work() -> None:
    claim = fixture(); api = Api(claim); provider = InvalidInventoryProvider(correction_fails=True)
    with pytest.raises(ValueError, match='quote'):
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert claim['output']['inventoryRaw']
    assert claim['output']['inventoryCorrectionAttempted']
    assert api.completed is None
    retry = InvalidInventoryProvider()
    with pytest.raises(ValueError, match='quote'):
        await run_assets(api, retry, claim)  # type: ignore[arg-type]
    assert retry.calls == []


class InvalidEvidenceProvider(Provider):
    def __init__(self, *, correction_fails: bool = False) -> None:
        super().__init__()
        self.correction_fails = correction_fails

    async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
        if stage == 'ASSET_VALIDATE_PRODUCT':
            self.calls.append(stage)
            data = copy.deepcopy(context['candidate'])
            if not self.correction_fails:
                data[0]['preparation']['sources'] = context['objects'][0]['sources']
            return schema.model_validate({'assets': data})
        result = await super().generate(stage, model, schema, context, instruction)
        if stage == 'ASSET_DEFINE_PRODUCT':
            data = result.model_dump()
            data['assets'][0]['preparation']['sources'][0]['quote'] = '改写后而非原文的内容'
            return schema.model_validate(data)
        return result

@pytest.mark.asyncio
async def test_bad_definition_evidence_is_corrected_once_without_regenerating_other_categories() -> None:
    claim = fixture(); api = Api(claim); provider = InvalidEvidenceProvider()
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert api.completed is not None
    assert provider.calls.count('ASSET_DEFINE_PRODUCT') == 1
    assert provider.calls.count('ASSET_VALIDATE_PRODUCT') == 1
    assert claim['output']['definitionCorrections']['PRODUCT:0'] == 'asset evidence quote not found'

@pytest.mark.asyncio
async def test_failed_definition_correction_keeps_candidate_and_does_not_pay_again_on_resume() -> None:
    claim = fixture(); api = Api(claim); provider = InvalidEvidenceProvider(correction_fails=True)
    with pytest.raises(ValueError, match='quote'):
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert claim['output']['definitionCandidates']['PRODUCT:0']
    assert api.completed is None
    retry = InvalidEvidenceProvider()
    with pytest.raises(ValueError, match='quote'):
        await run_assets(api, retry, claim)  # type: ignore[arg-type]
    assert retry.calls == []

def test_batch_schema_restricts_output_count_category_and_exact_identity() -> None:
    schema = definition_schema([{'id': 'product-one', 'kind': 'PRODUCT'}]).model_json_schema()
    assert schema['properties']['assets']['minItems'] == 1
    assert schema['properties']['assets']['maxItems'] == 1
    assert schema['$defs']['AssetDefinition']['properties']['id']['enum'] == ['product-one']
    assert schema['$defs']['AssetDefinition']['properties']['kind']['enum'] == ['PRODUCT']

def test_overbroad_checkpoint_is_scoped_by_exact_ids_and_rejects_unknown_or_duplicate_ids() -> None:
    batch = [{'id': 'product', 'kind': 'PRODUCT'}]
    inventory = batch + [{'id': 'person', 'kind': 'CHARACTER'}]
    assert scope_definitions(inventory, batch, inventory) == batch
    for invalid in [inventory + [inventory[0]], batch + [{'id': 'invented'}], inventory[1:]]:
        with pytest.raises(ValueError, match='identities'):
            scope_definitions(invalid, batch, inventory)

@pytest.mark.asyncio
async def test_recheck_receives_original_suggestions_as_well_as_required_findings() -> None:
    class ReviewProvider(Provider):
        def __init__(self) -> None:
            super().__init__(repair=True)
            self.previous: list[dict[str, Any]] = []

        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            value = await super().generate(stage, model, schema, context, instruction)
            if stage == 'ASSET_REVIEW':
                data = value.model_dump()
                data['findings'].append({'assetId': context['assets'][2]['id'], 'field': 'designNotes',
                    'issue': '可选的场景美术优化', 'basis': '允许创作的场景', 'severity': 'SUGGESTION'})
                return schema.model_validate(data)
            if stage == 'ASSET_RECHECK':
                self.previous = context['previousFindings']
            return value

    claim = fixture(); api = Api(claim); provider = ReviewProvider()
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert api.completed is not None
    assert {f['severity'] for f in provider.previous} == {'REQUIRED', 'SUGGESTION'}
    assert api.completed['assets'][2]['designNotes'] == '允许设计'


@pytest.mark.asyncio
@pytest.mark.parametrize('protection', [None, [], ['description']])
async def test_script_seed_can_be_repaired_without_unlocking_legacy_or_manual_assets(protection: list[str] | None) -> None:
    seed = {'id': 'script-product', 'kind': 'PRODUCT', 'name': 'G65', 'description': '脚本中的产品',
            'knownFacts': '', 'designNotes': '', 'sourceText': '脚本资产定义，使用前请核对'}
    if protection is not None:
        seed['manualFields'] = protection
    claim = fixture()
    claim['input']['document']['assets'] = [seed]

    class SeedProvider(Provider):
        async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
            result = await super().generate(stage, model, schema, context, instruction)
            if stage == 'ASSET_INVENTORY':
                value = result.model_dump()
                value['objects'][0]['existingId'] = seed['id']
                return schema.model_validate(value)
            return result

    api = Api(claim)
    provider = SeedProvider(repair=True)
    if protection == []:
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
        assert api.completed['assets'][0]['description'] == '灰色外壳'
        assert 'ASSET_REPAIR' in provider.calls
        assert 'ASSET_RECHECK' in provider.calls
    else:
        with pytest.raises(ValueError, match='protected'):
            await run_assets(api, provider, claim)  # type: ignore[arg-type]
        assert api.completed is None
        assert 'ASSET_REPAIR' not in provider.calls
        assert claim['output']['batches']['PRODUCT:0'][0]['description'] == seed['description']
    assert seed['description'] == '脚本中的产品'
