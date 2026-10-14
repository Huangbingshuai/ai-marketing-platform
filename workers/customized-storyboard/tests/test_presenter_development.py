import json
from pathlib import Path
import pytest
from customized_storyboard.commerce_development import CommerceDevelopment, concept_for
from customized_storyboard.pipeline import Pipeline
from customized_storyboard.routes import COMMERCE_VERSION
from customized_storyboard.routes.commerce_presenter import DEVELOPMENT
from test_commerce_development import CommerceProvider, commerce_value
from test_story_only import Api


def presenter_value(count=1, product='充电器'):
    data = commerce_value(count, product)
    data['strategyVersions'] = dict.fromkeys(data['strategyVersions'], COMMERCE_VERSION)
    return data


class PresenterProvider(CommerceProvider):
    async def generate(self, stage, model, schema, context, instruction):
        if schema is DEVELOPMENT:
            base = await super().generate(stage, model, CommerceDevelopment, context, instruction)
            self.contexts[-1] = (stage, schema, context, instruction)
            return schema.model_validate({**base.model_dump(), 'opportunities': [
                {**o.model_dump(), 'creativeIdea': f'具体观察吸引点{i}', 'approach': {
                    'speaker': '讲述者面对有此需要的观众，自然推荐',
                    'recommendation': '先提出选择疑问，再解释真实利益',
                    'speechAndVisual': '人物说完整口播，产品近景支持说到的依据'}}
                for i, o in enumerate(base.opportunities)]})
        return await super().generate(stage, model, schema, context, instruction)


@pytest.mark.parametrize('product', ['青梅酱', '保湿霜', '充电器', '落地灯', '预约软件'])
@pytest.mark.parametrize('count', [1, 3, 5])
async def test_presenter_is_product_independent_with_separate_actual_body_audits(product, count):
    data = presenter_value(count, product)
    data['models'] = {'creative': 'pro', 'detail': 'turbo'}
    provider, api = PresenterProvider(), Api()
    p = Pipeline(api, provider, data, [], [])
    await p.run()
    assert len(provider.calls) == 2 + 3 * count
    assert len([v for path, v in api.calls if path == 'scripts']) == count
    for _, schema, context, instruction in provider.contexts:
        if schema is DEVELOPMENT or 'commerceCommitment' in context and context.get('auditRole') is None:
            assert '能源、连接、输入材料或权限' in instruction
        if context.get('auditRole') == 'EDITORIAL':
            assert 'BUYING_REASON' in instruction and '自然推荐' in instruction
            assert 'commerceCommitment' not in context
            assert 'approach' not in context and 'creativeIdea' not in context
            assert set(context['reviewScope']) == {'purchaseQuestion'}
            assert context['reviewScope']['purchaseQuestion'] in [f'如何选择{i+1}' for i in range(count)]
        if context.get('auditRole') == 'FACTS':
            assert context['brief'] == data['brief']
            assert 'targetDurationSeconds' not in context['settings']
        if schema is not DEVELOPMENT and 'commerceCommitment' in context:
            assert context['commerceCommitment']['opportunity']['approach']['speaker']
    development = DEVELOPMENT.model_validate(p.checkpoints['ECOMMERCE_MOTIVATION', '']['output'])
    assert p.checkpoints['ECOMMERCE_CONCEPT', '']['output']['concepts'][0] == concept_for(development.opportunities[0], 's0').model_dump()
    checkpoints = [{'nodeId': n, 'scriptId': sid, **v} for (n, sid), v in p.checkpoints.items()]
    calls = len(provider.calls)
    await Pipeline(Api(), provider, data, checkpoints, []).run()
    assert len(provider.calls) == calls


def test_presenter_schema_matches_contract_file_and_requires_approach():
    directory = Path(__file__).resolve().parents[3] / 'packages/contracts/schemas'
    assert json.loads((directory / 'customized-presenter-development.schema.json').read_text('utf-8')) == DEVELOPMENT.model_json_schema()


async def test_presenter_repair_uses_shared_bounded_dual_recheck():
    provider, api = PresenterProvider(repair=True), Api()
    p = Pipeline(api, provider, presenter_value(), [], [])
    await p.run()
    assert len(provider.calls) == 8
    assert p.checkpoints['RECHECK', 's0']['status'] == 'SUCCEEDED'
    assert len([v for path, v in api.calls if path == 'scripts']) == 1


async def test_presenter_v1_remains_frozen_while_v2_checks_spoken_units():
    from customized_storyboard.routes import strategy_for
    assert '逐段试读' not in strategy_for('ECOMMERCE', '2026-10-14-presenter.1').REVIEW
    assert '逐段试读' in strategy_for('ECOMMERCE', COMMERCE_VERSION).REVIEW
    assert '真实工作前提' in strategy_for('ECOMMERCE', COMMERCE_VERSION).WRITE
    assert '真实工作前提' not in strategy_for('ECOMMERCE', '2026-10-14-presenter.2').WRITE
    data = presenter_value()
    data['strategyVersions'] = dict.fromkeys(data['strategyVersions'], '2026-10-14-presenter.1')
    provider = PresenterProvider()
    await Pipeline(Api(), provider, data, [], []).run()
    assert len(provider.calls) == 5
