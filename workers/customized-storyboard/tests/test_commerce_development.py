import json
from pathlib import Path
import pytest
from ai_runtime.responses import ProviderError
from customized_storyboard.commerce_development import (
    CommerceDevelopment, CommerceSelection, concept_for, validate_development, validate_selection,
)
from customized_storyboard.pipeline import Pipeline
from customized_storyboard.routes import COMMERCE_VERSION, VERSION, strategy_for
from test_typed_creation import Provider as ExistingProvider, value
from test_story_only import Api


def commerce_value(count=1, product='充电器'):
    data = value('ECOMMERCE', count)
    data['strategyVersions'] = dict.fromkeys(['concept', 'story', 'review', 'repair'], '2026-10-14-commerce.5')
    fact = {'青梅酱': '含青梅果肉，酸甜口味，可搭配酸奶', '保湿霜': '乳霜质地，无添加香精',
        '充电器': '2个USB-C和1个USB-A，折叠插脚', '落地灯': '上照式灯头，三级亮度可调',
        '预约软件': '创建预约时段和手动登记预约记录'}[product]
    data['brief'] = {'productName': product, 'sellingPoints': [fact], 'targetAudience': '简报中的使用者'}
    return data


class CommerceProvider(ExistingProvider):
    def __init__(self, **kwargs):
        super().__init__('ECOMMERCE', **kwargs)
        self.contexts = []

    async def generate(self, stage, model, schema, context, instruction):
        self.contexts.append((stage, schema, context, instruction))
        if schema is CommerceDevelopment:
            self.calls.append(stage)
            return schema.model_validate({'readiness': {'status': 'READY', 'reason': '可依据产品资料设计演示', 'missing': []},
                'opportunities': [{'id': f'O{i+1:02d}', 'name': f'购买问题{i+1}', 'audienceSituation': '需要完成具体任务',
                    'situationBasis': 'CREATIVE_HYPOTHESIS', 'buyingReason': f'已知特点支持需要{i+1}', 'purchaseQuestion': f'如何选择{i+1}', 'factIds': ['F02'],
                    'demonstration': {'setup': '实际任务尚未完成', 'action': '产品按已知方式参与', 'observableResult': '看见任务中的具体改变', 'claimBoundary': '不据此推导未知性能'},
                    'progression': '观察需要、产品参与、看到价值', 'ending': '回应这个购买问题'} for i in range(6)]})
        if schema is CommerceSelection:
            self.calls.append(stage)
            return schema.model_validate({'status': 'READY', 'reason': '独立检查动机和演示', 'missing': [],
                'evaluations': [{'opportunityId': o['id'], 'verdict': 'ADVANCE', 'reason': '具体利益有可见过程与边界'} for o in context['development']['opportunities']],
                'choices': [{'scriptId': sid, 'opportunityId': context['development']['opportunities'][i]['id'],
                    'mustPreserve': ['具体购买需要', '实际观察结果']} for i, sid in enumerate(context['scriptIds'])]})
        return await super().generate(stage, model, schema, context, instruction)


@pytest.mark.parametrize('product', ['青梅酱', '保湿霜', '充电器', '落地灯', '预约软件'])
@pytest.mark.parametrize('count', [1, 3, 5])
async def test_commerce_route_is_product_independent_and_commits_selected_original_plan(product, count):
    api, provider = Api(), CommerceProvider()
    pipeline = Pipeline(api, provider, commerce_value(count, product), [], [])
    await pipeline.run()
    assert len(provider.calls) == 2 + 3 * count
    assert len([v for path, v in api.calls if path == 'scripts']) == count
    assert len(pipeline.commerce_commitments) == count
    assert provider.calls.count('ECOMMERCE_MOTIVATION') == 1
    for _, schema, context, instruction in provider.contexts:
        assert 'brandReferences' not in context
        if context.get('auditRole') == 'EDITORIAL':
            assert context['brief']['productName'] == product
            assert 'sellingPoints' not in context['brief']
            assert 'brandCommitment' not in context and 'commerceCommitment' not in context
            assert '品牌片先用普通动词' not in instruction
            assert 'BUYING_REASON' in instruction
        if context.get('auditRole') == 'FACTS':
            assert context['brief']['sellingPoints'] == commerce_value(product=product)['brief']['sellingPoints']
    selected = pipeline.checkpoints['ECOMMERCE_CONCEPT', '']['output']
    development = CommerceDevelopment.model_validate(pipeline.checkpoints['ECOMMERCE_MOTIVATION', '']['output'])
    assert selected['concepts'][0] == concept_for(development.opportunities[0], 's0').model_dump()


@pytest.mark.parametrize('always', [False, True])
async def test_weak_commerce_slate_redevelopment_budget_survives_resume(always):
    class Weak(CommerceProvider):
        choices = 0
        async def generate(self, stage, model, schema, context, instruction):
            result = await super().generate(stage, model, schema, context, instruction)
            if schema is CommerceSelection:
                self.choices += 1
                if always or self.choices == 1:
                    result.status, result.reason, result.choices = 'REWORK', '只是重复规格没有购买利益', []
            return result
    data, provider, api = commerce_value(), Weak(), Api()
    p = Pipeline(api, provider, data, [], [])
    if always:
        with pytest.raises(ValueError, match='budget exhausted'):
            await p.run()
    else:
        await p.run()
    assert provider.choices == 2
    calls = len(provider.calls)
    checkpoints = [{'nodeId': n, 'scriptId': sid, **v} for (n, sid), v in p.checkpoints.items()]
    if always:
        with pytest.raises(ValueError, match='budget exhausted'):
            await Pipeline(Api(), provider, data, checkpoints, []).run()
        assert not any(path == 'scripts' for path, _ in api.calls)
    else:
        await Pipeline(Api(), provider, data, checkpoints, []).run()
    assert len(provider.calls) == calls


async def test_partial_audit_failure_persists_completed_side_in_actual_failed_callback():
    class Temporary(CommerceProvider):
        outages = 0
        async def generate(self, stage, model, schema, context, instruction):
            if context.get('auditRole') == 'FACTS' and not self.outages:
                self.outages += 1
                raise ProviderError('temporary test outage', retryable=True)
            return await super().generate(stage, model, schema, context, instruction)
    api, provider, data = Api(), Temporary(), commerce_value()
    p = Pipeline(api, provider, data, [], [])
    await p.run()
    callbacks = [v for path, v in api.calls if path == 'steps' and v['nodeId'] == 'ECOMMERCE_REVIEW']
    assert callbacks[-1]['status'] == 'FAILED'
    assert callbacks[-1]['output']['editorialReview']['routeId'] == 'ECOMMERCE'
    # Reconstruct from sent callbacks, not the Pipeline's in-memory checkpoint cache.
    durable = {}
    for path, v in api.calls:
        if path == 'steps': durable[v['nodeId'], v['scriptId']] = v
    callbacks = list(durable.values())
    provider.calls.clear()
    await Pipeline(Api(), provider, data, callbacks, []).run()
    assert provider.calls == ['ECOMMERCE_REVIEW']


@pytest.mark.parametrize('failed', [False, True])
async def test_commerce_quality_failure_repairs_once_and_refuses_failed_recheck(failed):
    data, provider, api = commerce_value(), CommerceProvider(quality_fail=True, recheck_error=failed), Api()
    p = Pipeline(api, provider, data, [], [])
    await p.run()
    assert provider.calls.count('REPAIR') == 1
    assert provider.calls.count('RECHECK') == 2
    assert any(f['severity'] == 'ERROR' for f in p.checkpoints['ECOMMERCE_REVIEW', 's0']['output']['findings'])
    assert any(path == 'scripts' for path, _ in api.calls) is not failed


@pytest.mark.parametrize('always_invalid', [False, True])
async def test_selection_identity_correction_is_bounded(always_invalid):
    class Invalid(CommerceProvider):
        decisions = 0
        async def generate(self, stage, model, schema, context, instruction):
            result = await super().generate(stage, model, schema, context, instruction)
            if schema is CommerceSelection:
                self.decisions += 1
                if self.decisions == 1 or always_invalid: result.choices[0].scriptId = 'foreign'
            return result
    provider, data = Invalid(), commerce_value()
    p = Pipeline(Api(), provider, data, [], [])
    if always_invalid:
        with pytest.raises(ValueError): await p.run()
        checkpoints = [{'nodeId': n, 'scriptId': sid, **v} for (n, sid), v in p.checkpoints.items()]
        with pytest.raises(ValueError, match='correction exhausted'):
            await Pipeline(Api(), provider, data, checkpoints, []).run()
    else:
        await p.run()
    assert provider.decisions == 2


async def test_missing_real_product_evidence_stops_without_buying_body():
    class Missing(CommerceProvider):
        async def generate(self, stage, model, schema, context, instruction):
            if schema is CommerceDevelopment:
                self.calls.append(stage)
                return schema.model_validate({'readiness': {'status': 'NEEDS_INFORMATION', 'reason': '资料没有可核对的产品特点', 'missing': ['实际产品特点']}, 'opportunities': []})
            return await super().generate(stage, model, schema, context, instruction)
    provider, api = Missing(), Api()
    await Pipeline(api, provider, commerce_value(), [], []).run()
    assert provider.calls == ['ECOMMERCE_MOTIVATION']
    assert not any(path == 'scripts' for path, _ in api.calls)


async def test_old_commerce_graph_and_brand_strategy_remain_frozen():
    provider = ExistingProvider('ECOMMERCE')
    await Pipeline(Api(), provider, value('ECOMMERCE'), [], []).run()
    assert provider.calls == ['ECOMMERCE_CONCEPT', 'ECOMMERCE_STORY', 'ECOMMERCE_REVIEW']
    assert strategy_for('BRAND_AD', VERSION).__name__.endswith('brand_ad_v14_7')
    data = commerce_value(); data['routeId'] = data['settings']['videoType'] = 'BRAND_AD'
    with pytest.raises(ValueError, match='belongs to commerce'):
        await Pipeline(Api(), provider, data, [], []).run()


def test_commerce_schemas_are_shared_and_fact_references_are_checked():
    directory = Path(__file__).resolve().parents[3] / 'packages' / 'contracts' / 'schemas'
    for model, name in [(CommerceDevelopment, 'development'), (CommerceSelection, 'selection')]:
        assert json.loads((directory / f'customized-commerce-{name}.schema.json').read_text('utf-8')) == model.model_json_schema()
    data = CommerceDevelopment.model_validate(json.loads((directory.parent / 'fixtures/customized-commerce-creation.json').read_text('utf-8'))['development'])
    data.opportunities[0].factIds = ['foreign']
    with pytest.raises(ValueError, match='reference'):
        validate_development(data, [{'id': 'F02'}])


@pytest.mark.parametrize('version', ['2026-10-14-commerce.1', '2026-10-14-commerce.2', '2026-10-14-commerce.3', '2026-10-14-commerce.4', '2026-10-14-commerce.5'])
async def test_model_stage_is_running_before_call_and_each_frozen_route_resumes(version):
    api = Api()
    class Inspect(CommerceProvider):
        async def generate(self, stage, model, schema, context, instruction):
            if schema in (CommerceDevelopment, CommerceSelection):
                callbacks = [v for path, v in api.calls if path == 'steps' and v['nodeId'] == stage]
                assert callbacks[-1]['status'] == 'RUNNING'
            return await super().generate(stage, model, schema, context, instruction)
    data = commerce_value()
    data['strategyVersions'] = dict.fromkeys(data['strategyVersions'], version)
    provider, pipeline = Inspect(), None
    pipeline = Pipeline(api, provider, data, [], [])
    await pipeline.run()
    checkpoints = [{'nodeId': n, 'scriptId': sid, **v} for (n, sid), v in pipeline.checkpoints.items()]
    provider.calls.clear()
    await Pipeline(api, provider, data, checkpoints, []).run()
    assert provider.calls == []


async def test_v3_uses_turbo_only_for_short_development_and_pro_for_quality_decisions():
    data = commerce_value()
    data['models'] = {'creative': 'review-pro', 'detail': 'planning-turbo'}
    class Capture(CommerceProvider):
        async def generate(self, stage, model, schema, context, instruction):
            assert model == ('planning-turbo' if schema is CommerceDevelopment else 'review-pro')
            if context.get('auditRole') == 'EDITORIAL':
                assert context['reviewScope'] == {'purchaseQuestion': '如何选择1'}
                assert '每份只需成立一个具体购买理由' in instruction
                assert '不能凭策划问题清楚而放行' in instruction
            return await super().generate(stage, model, schema, context, instruction)
    await Pipeline(Api(), Capture(), data, [], []).run()


@pytest.mark.parametrize('version', ['2026-10-14-commerce.4', '2026-10-14-commerce.5'])
async def test_soft_reference_duration_is_excluded_only_from_new_factual_audits(version):
    from copy import deepcopy
    data = commerce_value()
    data['strategyVersions'] = dict.fromkeys(data['strategyVersions'], version)
    original_settings = deepcopy(data['settings'])
    provider = CommerceProvider()
    await Pipeline(Api(), provider, data, [], []).run()
    assert data['settings'] == original_settings
    for stage, _, context, _ in provider.contexts:
        if context.get('auditRole') == 'FACTS':
            assert ('targetDurationSeconds' in context['settings']) == version.endswith('.4')
            assert all(beat['durationSeconds'] > 0 for beat in context['story']['beats'])
            if version.endswith('.5'):
                assert '不以任何参考总时长' in context['durationPolicy']
        elif stage == 'ECOMMERCE_STORY':
            assert context['settings']['targetDurationSeconds'] == original_settings['targetDurationSeconds']


async def test_v3_finishes_active_scripts_before_starting_every_later_story(monkeypatch):
    import asyncio
    from customized_storyboard import typed_creation
    active, started = set(), []
    releases = {f's{i}': asyncio.Event() for i in range(3)}
    two_started, third_started = asyncio.Event(), asyncio.Event()
    async def controlled_create(p, concept, concepts, requirements):
        active.add(concept.scriptId); started.append(concept.scriptId)
        assert len(active) <= 2
        if len(started) == 2: two_started.set()
        if concept.scriptId == 's2': third_started.set()
        await releases[concept.scriptId].wait()
        active.remove(concept.scriptId)
    monkeypatch.setattr(typed_creation, 'create', controlled_create)
    task = asyncio.create_task(Pipeline(Api(), CommerceProvider(), commerce_value(3), [], []).run())
    await asyncio.wait_for(two_started.wait(), 3)
    assert started == ['s0', 's1']
    releases['s0'].set()
    await asyncio.wait_for(third_started.wait(), 3)
    releases['s1'].set(); releases['s2'].set()
    await asyncio.wait_for(task, 3)
