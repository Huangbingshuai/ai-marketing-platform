import json
from pathlib import Path
import pytest
from ai_runtime.responses import ProviderError
from customized_storyboard.brand_development import BrandDevelopment, BrandSelection, fact_catalog, validate_development, validate_selection
from customized_storyboard.pipeline import Pipeline
from customized_storyboard.brand_selection import LeanBrandSelection, expand_selection
from test_typed_creation import Provider, value
from test_story_only import Api


@pytest.mark.parametrize('product', ['青梅酱', '保湿霜', '充电器', '落地灯', '预约软件'])
async def test_brand_development_is_product_independent_and_keeps_commitments(product):
    data = value('BRAND_AD', 3)
    data['brief'] = {'productName': product, 'sellingPoints': ['简报明确的特点'], 'brandTone': '克制'}
    api, provider = Api(), Provider('BRAND_AD')
    p = Pipeline(api, provider, data, [], [])
    await p.run()
    assert len(p.checkpoints['BRAND_AD_IDEAS', '']['output']['ideas']) == 6
    assert len(p.brand_commitments) == 3
    assert len([v for path,v in api.calls if path == 'scripts']) == 3
    assert provider.calls.count('BRAND_AD_PROPOSITION') == 1


class Rejected(Provider):
    def __init__(self, always=False, interrupt=False):
        super().__init__('BRAND_AD')
        self.always, self.interrupt = always, interrupt
        self.decisions = 0
        self.developments = 0

    async def generate(self, stage, model, schema, context, instruction):
        if schema is BrandDevelopment:
            self.developments += 1
        if schema in (BrandSelection, LeanBrandSelection):
            self.decisions += 1
            if self.interrupt and self.decisions == 2:
                raise ProviderError('temporary outage', retryable=True)
        result = await super().generate(stage, model, schema, context, instruction)
        if schema in (BrandSelection, LeanBrandSelection) and (self.always or self.decisions == 1):
            data = result.model_dump()
            data.update(status='REWORK', reason='观看机制不成熟', concepts=[], commitments=[])
            data = {k:v for k,v in data.items() if k in schema.model_fields}
            return schema.model_validate(data)
        return result


async def test_weak_slate_redevelops_once_and_resumes_without_rebuying_development():
    provider, api = Rejected(interrupt=True), Api()
    p = Pipeline(api, provider, value(), [], [])
    with pytest.raises(ProviderError):
        await p.run()
    assert provider.developments == 2
    checkpoints = [{'nodeId': n, 'scriptId': sid, **s} for (n,sid),s in p.checkpoints.items()]
    await Pipeline(api, provider, value(), checkpoints, []).run()
    assert provider.developments == 2
    assert any(path == 'scripts' for path,_ in api.calls)


async def test_all_weak_ideas_do_not_publish_and_retry_does_not_reset_budget():
    provider, api = Rejected(always=True), Api()
    p = Pipeline(api, provider, value(), [], [])
    with pytest.raises(ValueError, match='budget exhausted'):
        await p.run()
    calls = len(provider.calls)
    checkpoints = [{'nodeId': n, 'scriptId': sid, **s} for (n,sid),s in p.checkpoints.items()]
    with pytest.raises(ValueError, match='budget exhausted'):
        await Pipeline(api, provider, value(), checkpoints, []).run()
    assert len(provider.calls) == calls
    assert not any(path == 'scripts' for path,_ in api.calls)


async def test_selected_idea_and_fact_references_are_validated():
    p = Pipeline(Api(), Provider('BRAND_AD'), value(), [], [])
    await p.run()
    development = BrandDevelopment.model_validate(p.checkpoints['BRAND_AD_IDEAS','']['output'])
    selection = BrandSelection.model_validate({k:v for k,v in p.checkpoints['BRAND_AD_CONCEPT','']['output'].items() if k in BrandSelection.model_fields})
    selection.commitments[0].ideaId = 'foreign'
    with pytest.raises(ValueError):
        validate_selection(selection, development, ['s0'], fact_catalog(value()['brief']))
    development.ideas[0].factIds = ['foreign']
    with pytest.raises(ValueError):
        validate_development(development, fact_catalog(value()['brief']), 6)


def test_shared_schemas_and_fact_identity_do_not_depend_on_field_order():
    directory = Path(__file__).resolve().parents[3] / 'packages' / 'contracts' / 'schemas'
    for model,name in [(BrandDevelopment,'customized-brand-development.schema.json'), (BrandSelection,'customized-brand-selection.schema.json')]:
        assert json.loads((directory/name).read_text('utf-8')) == model.model_json_schema()
    assert fact_catalog({'productName':'测试', 'sellingPoints':['特点']}) == fact_catalog({'sellingPoints':['特点'], 'productName':'测试'})

async def test_current_brand_history_preserves_all_synopses_without_repeated_metadata():
    class Capture(Provider):
        seen = []
        async def generate(self, stage, model, schema, context, instruction):
            if schema in (BrandDevelopment, BrandSelection, LeanBrandSelection):
                self.seen.append(context.get('existingConcepts'))
            return await super().generate(stage, model, schema, context, instruction)
    data = value()
    synopsis = '完整历史内容' * 200
    data['existingConcepts'] = [{'name':'旧稿', 'synopsis':synopsis, 'productFocus':'重复信息', 'structure':'重复结构'}]
    provider = Capture('BRAND_AD')
    await Pipeline(Api(), provider, data, [], []).run()
    assert len(provider.seen) == 2
    assert provider.seen == [None, [{'name':'旧稿', 'synopsis':synopsis}]]
    assert data['existingConcepts'][0]['productFocus'] == '重复信息'

async def test_lean_selection_keeps_original_candidate_and_rejects_unknown_reference():
    provider = Provider('BRAND_AD')
    data = value('BRAND_AD', 3)
    api = Api()
    p = Pipeline(api, provider, data, [], [])
    await p.run()
    development = BrandDevelopment.model_validate(p.checkpoints['BRAND_AD_IDEAS', '']['output'])
    selected = BrandSelection.model_validate({k:v for k,v in p.checkpoints['BRAND_AD_CONCEPT','']['output'].items() if k in BrandSelection.model_fields})
    for idea, concept in zip(development.ideas, selected.concepts):
        assert concept.name == idea.name
        assert concept.coreIdea == idea.mechanism
        assert concept.synopsis == '\n'.join(idea.keyImages)
        assert concept.plan.visualProgression == '\n'.join(idea.keyImages)
        assert concept.productFocus == idea.productRole
    lean = LeanBrandSelection.model_validate({k:v for k,v in selected.model_dump().items() if k != 'concepts'})
    lean.commitments[0].ideaId = 'unknown'
    with pytest.raises(ValueError, match='unknown brand idea'):
        expand_selection(lean, development)


def test_lean_selection_schema_has_no_duplicate_plan_and_matches_shared_schema():
    directory = Path(__file__).resolve().parents[3] / 'packages' / 'contracts' / 'schemas'
    assert json.loads((directory/'customized-brand-selection-lean.schema.json').read_text('utf-8')) == LeanBrandSelection.model_json_schema()
    assert 'concepts' not in LeanBrandSelection.model_fields
    assert 'TypedConcept' not in LeanBrandSelection.model_json_schema()['$defs']


@pytest.mark.parametrize('version', ['2026-10-14.5', '2026-10-14.6', '2026-10-14.7'])
async def test_brand_frozen_strategy_keeps_double_audit_and_refuses_failed_recheck(version):
    data = value()
    data['strategyVersions'] = dict.fromkeys(['concept', 'story', 'review', 'repair'], version)
    api = Api()
    provider = Provider('BRAND_AD', repair=True, recheck_error=True)
    pipeline = Pipeline(api, provider, data, [], [])
    await pipeline.run()
    assert provider.calls.count('BRAND_AD_REVIEW') == 2
    assert provider.calls.count('RECHECK') == 2
    assert provider.calls.count('REPAIR') == 1
    assert not any(path == 'scripts' for path, _ in api.calls)
    assert pipeline.checkpoints['REPAIR', 's0']['status'] == 'SUCCEEDED'
    assert pipeline.checkpoints['RECHECK', 's0']['status'] == 'SUCCEEDED'
    assert any(f['severity'] == 'ERROR' for f in pipeline.checkpoints['RECHECK', 's0']['output']['findings'])


@pytest.mark.parametrize('always_invalid', [False, True])
async def test_selection_identity_correction_is_bounded_and_reuses_development(always_invalid):
    class InvalidSelection(Provider):
        selections = 0
        async def generate(self, stage, model, schema, context, instruction):
            decision = await super().generate(stage, model, schema, context, instruction)
            if schema is LeanBrandSelection:
                self.selections += 1
                if self.selections == 1 or always_invalid:
                    decision.commitments[0].scriptId = 'foreign-script'
            return decision
    data, api, provider = value(), Api(), InvalidSelection('BRAND_AD')
    pipeline = Pipeline(api, provider, data, [], [])
    if always_invalid:
        with pytest.raises(ValueError):
            await pipeline.run()
        checkpoints = [{'nodeId': n, 'scriptId': sid, **step} for (n,sid),step in pipeline.checkpoints.items()]
        with pytest.raises(ValueError, match='correction exhausted'):
            await Pipeline(api, provider, data, checkpoints, []).run()
        assert not any(path == 'scripts' for path,_ in api.calls)
    else:
        await pipeline.run()
        assert len([path for path,_ in api.calls if path == 'scripts']) == 1
    assert provider.selections == 2
    assert provider.calls.count('BRAND_AD_PROPOSITION') == 1

@pytest.mark.parametrize('version, calibrated', [('2026-10-14.6', False), ('2026-10-14.7', True)])
async def test_brand_editorial_calibration_is_frozen_and_not_sent_to_fact_audit(version, calibrated):
    from customized_storyboard.brand_review_calibration import CALIBRATION, CREATIVE_STANDARD
    from customized_storyboard.review_calibration import OBSERVATION_INSTRUCTION
    class Capture(Provider):
        def __init__(self):
            super().__init__('BRAND_AD')
            self.observed = []
        async def generate(self, stage, model, schema, context, instruction):
            self.observed.append((stage, context.get('auditRole'), instruction))
            return await super().generate(stage, model, schema, context, instruction)
    data = value()
    data['strategyVersions'] = dict.fromkeys(['concept', 'story', 'review', 'repair'], version)
    provider = Capture()
    await Pipeline(Api(), provider, data, [], []).run()
    editorial = next(i for _, role, i in provider.observed if role == 'EDITORIAL')
    facts = next(i for _, role, i in provider.observed if role == 'FACTS')
    selection = next(i for _, role, i in provider.observed if role == 'IDEA_SELECTION')
    assert (CALIBRATION in editorial) is calibrated
    assert (OBSERVATION_INSTRUCTION in editorial) is calibrated
    assert (CREATIVE_STANDARD in selection) is calibrated
    assert CALIBRATION not in facts
