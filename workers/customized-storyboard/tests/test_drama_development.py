import json
from pathlib import Path
import pytest
from customized_storyboard.pipeline import Pipeline
from customized_storyboard.drama_development import DramaDevelopment, DramaSelection, concept_for
from customized_storyboard.routes import DRAMA_VERSION, strategy_for
from test_typed_creation import Provider, value
from test_story_only import Api


def drama_value(count=1, product='充电器'):
    data = value('DRAMA', count)
    data['brief']['productName'] = product
    data['strategyVersions'] = dict.fromkeys(data['strategyVersions'], DRAMA_VERSION)
    return data


class DramaProvider(Provider):
    def __init__(self, repair=False, weak=False, missing=False):
        super().__init__('DRAMA', repair=repair)
        self.contexts = []
        self.weak, self.missing = weak, missing

    async def generate(self, stage, model, schema, context, instruction):
        self.contexts.append((stage, schema, context, instruction))
        if issubclass(schema, DramaDevelopment):
            self.calls.append(stage)
            return schema.model_validate({'readiness': {'status':'NEEDS_INFORMATION' if self.missing else 'READY',
                'reason':'缺关键产品资料' if self.missing else '已有资料足够', 'missing':['产品特征'] if self.missing else []},
                'ideas': [] if self.missing else [{'id':f'I{i}', 'name':f'人物选择{i}', 'devices':['对话试探','信息反转'],
                    'viewingPromise':'包里留下的东西是谁放的', 'informationDesign':'观众先看到标记，人物稍后发现',
                    'dialogueIntent':'试探对方有没有改变决定', 'emotionalMovement':'由防备到发现被默默理解',
                    'weakness':'避免对白提前说破', 'factIds':[context['factCatalog'][0]['id']],
                    'plan': {'videoType':'DRAMA', **{k:f'具体人物行动{i}' for k in ['desire','obstacle','relationships','trigger','escalation','choice','consequence','productCausality']}}}
                    for i in range(context['candidateCount'])]})
        if schema is DramaSelection:
            self.calls.append(stage)
            return schema.model_validate({'status':'REWORK' if self.weak else 'READY','reason':'人物选择有实际后果', 'missing':[],
                'evaluations':[{'ideaId':i['id'],'verdict':'ADVANCE','reason':'伏笔有实际回收'} for i in context['development']['ideas']],
                'choices': [] if self.weak else [{'scriptId':sid,'ideaId':context['development']['ideas'][i]['id'],
                    'mustPreserve':['先出现具体伏笔','人物选择带来不同结果']} for i,sid in enumerate(context['scriptIds'])]})
        return await super().generate(stage,model,schema,context,instruction)


@pytest.mark.parametrize('product',['青梅酱','保湿霜','充电器','落地灯','预约软件'])
@pytest.mark.parametrize('count',[1,3,5])
async def test_drama_develops_selects_and_audits_actual_body(product,count):
    data, provider, api = drama_value(count,product), DramaProvider(), Api()
    pipeline = Pipeline(api,provider,data,[],[])
    await pipeline.run()
    assert len(provider.calls) == 2+3*count
    assert len([v for path,v in api.calls if path=='scripts']) == count
    result = pipeline.checkpoints['DRAMA_CONCEPT','']['output']
    development = DramaDevelopment.model_validate(result['development'])
    assert len(development.ideas)==min(7,count+2)
    assert result['concepts'][0] == concept_for(development.ideas[0],'s0').model_dump()
    for _,schema,ctx,instruction in provider.contexts:
        if issubclass(schema, DramaDevelopment):
            assert '五选一或配额' in instruction and '反转须有前置线索' in instruction
        if 'dramaCommitment' in ctx:
            assert ctx['dramaCommitment']['idea']['informationDesign']
        if ctx.get('auditRole')=='EDITORIAL':
            assert 'dramaCommitment' not in ctx and 'concept' not in ctx
            assert all(criterion in instruction for criterion in ('CHARACTER_CAUSALITY', 'NATURAL_DIALOGUE', 'PRODUCT_CAUSALITY'))
        if ctx.get('auditRole')=='FACTS':
            assert ctx['brief']==data['brief']
            assert 'targetDurationSeconds' not in ctx['settings']
    checkpoints = [{'nodeId':n,'scriptId':sid,**v} for (n,sid),v in pipeline.checkpoints.items()]
    calls=len(provider.calls)
    await Pipeline(Api(),provider,data,checkpoints,[]).run()
    assert len(provider.calls)==calls


async def test_drama_weak_candidates_have_durable_bounded_redevelopment():
    provider,api=DramaProvider(weak=True),Api()
    pipeline=Pipeline(api,provider,drama_value(),[],[])
    with pytest.raises(ValueError,match='budget exhausted'):
        await pipeline.run()
    assert len(provider.calls)==4
    assert not any(path=='scripts' for path,_ in api.calls)
    checkpoints=[{'nodeId':n,'scriptId':sid,**v} for (n,sid),v in pipeline.checkpoints.items()]
    with pytest.raises(ValueError,match='budget exhausted'):
        await Pipeline(Api(),provider,drama_value(),checkpoints,[]).run()
    assert len(provider.calls)==4


async def test_drama_missing_product_information_does_not_generate_story():
    provider,api=DramaProvider(missing=True),Api()
    await Pipeline(api,provider,drama_value(),[],[]).run()
    assert len(provider.calls)==1
    assert not any(path=='scripts' for path,_ in api.calls)


async def test_drama_repairs_once_and_rechecks_independently():
    provider,api=DramaProvider(repair=True),Api()
    await Pipeline(api,provider,drama_value(),[],[]).run()
    assert len(provider.calls)==8
    assert len([v for path,v in api.calls if path=='scripts'])==1


async def test_drama_reuses_development_after_selection_transport_failure():
    class Interrupted(DramaProvider):
        async def generate(self,stage,model,schema,context,instruction):
            if schema is DramaSelection:
                raise RuntimeError('controlled transport interruption')
            return await super().generate(stage,model,schema,context,instruction)
    provider=Interrupted()
    pipeline=Pipeline(Api(),provider,drama_value(),[],[])
    with pytest.raises(RuntimeError,match='interruption'):
        await pipeline.run()
    checkpoints=[{'nodeId':n,'scriptId':sid,**v} for (n,sid),v in pipeline.checkpoints.items()]
    resumed=DramaProvider()
    await Pipeline(Api(),resumed,drama_value(),checkpoints,[]).run()
    assert not any(issubclass(schema, DramaDevelopment) for _,schema,_,_ in resumed.contexts)
    assert len(resumed.calls)==4


async def test_drama_cannot_publish_a_structurally_failed_recheck():
    provider=DramaProvider(repair=True)
    provider.recheck_error=True
    api=Api()
    await Pipeline(api,provider,drama_value(),[],[]).run()
    assert not any(path=='scripts' for path,_ in api.calls)


@pytest.mark.parametrize('version', ['2026-10-14-drama.3', DRAMA_VERSION])
async def test_development_history_is_scoped_to_new_strategy_without_changing_resume(version):
    data = drama_value()
    data['strategyVersions'] = dict.fromkeys(data['strategyVersions'], version)
    data['existingConcepts'] = [{'name': '留下的饭', 'synopsis': '室友已离开，却提前留下不放香菜的一份饭。'}]
    provider, api = DramaProvider(), Api()
    pipeline = Pipeline(api, provider, data, [], [])
    await pipeline.run()
    development_context = next(ctx for _, schema, ctx, _ in provider.contexts if issubclass(schema, DramaDevelopment))
    assert development_context['existingTitles'] == ['留下的饭']
    if version == DRAMA_VERSION:
        assert development_context['existingConcepts'] == data['existingConcepts']
    else:
        assert 'existingConcepts' not in development_context
    assert len(provider.calls) == 5
    checkpoints = [{'nodeId': n, 'scriptId': sid, **v} for (n, sid), v in pipeline.checkpoints.items()]
    await Pipeline(Api(), provider, data, checkpoints, []).run()
    assert len(provider.calls) == 5


@pytest.mark.parametrize('version', ['2026-10-16-drama.4', '2026-10-16-drama.5', '2026-10-16-drama.6', '2026-10-16-drama.7', DRAMA_VERSION])
async def test_human_development_scopes_inputs_but_writing_and_facts_keep_full_source(version):
    data, provider = drama_value(), DramaProvider()
    data['strategyVersions'] = dict.fromkeys(data['strategyVersions'], version)
    data['brief'].update(brandName='测试品牌', productSpecifications='规格来源完整保留', productAppearance='外观来源完整保留')
    await Pipeline(Api(), provider, data, [], []).run()
    development = next(c for _, schema, c, _ in provider.contexts if issubclass(schema, DramaDevelopment))
    if version in {'2026-10-16-drama.5', '2026-10-16-drama.7', DRAMA_VERSION}:
        assert 'productSpecifications' not in development['brief']
        assert ('productAppearance' in development['brief']) is (version != '2026-10-16-drama.5')
        allowed = {'productName','productDescription','sellingPoints'} | ({'productAppearance'} if version != '2026-10-16-drama.5' else set())
        assert all(f['field'] in allowed for f in development['factCatalog'])
        assert development['factCatalog'][0]['id'] != 'F01'
    else:
        assert development['brief'] == data['brief']
    for stage, _, context, _ in provider.contexts:
        if stage == 'DRAMA_STORY' or context.get('auditRole') == 'FACTS':
            assert context['brief'] == data['brief']
@pytest.mark.parametrize('still_invalid', [False, True])
async def test_language_error_repairs_only_affected_body_and_failed_recheck_cannot_publish(still_invalid):
    from customized_storyboard.typed_creation import TypedPatch
    original = '父亲避开花她的目光，将饭盒推到桌边。'
    corrected = '父亲避开她的目光，将饭盒推到桌边。'
    unaffected = 'P02｜楼道\n\n她回头，父亲已经把门留了一道缝。'

    class LanguageProvider(DramaProvider):
        async def generate(self, stage, model, schema, context, instruction):
            result = await super().generate(stage, model, schema, context, instruction)
            if stage == 'DRAMA_STORY':
                result.beats[0].content = 'P01｜餐桌\n\n' + original
                result.beats.append(type(result.beats[0])(id='P02', content=unaffected, durationSeconds=12))
                for mapping in result.structureMapping:
                    mapping.evidence = original
            elif schema is TypedPatch:
                result.replacements[0].content = 'P01｜餐桌\n\n' + (original if still_invalid else corrected)
                for mapping in result.structureMapping:
                    mapping.evidence = original if still_invalid else corrected
            elif context.get('auditRole') == 'EDITORIAL':
                from customized_storyboard.review_calibration import EditorialFinding
                quote = context['story']['beats'][0]['excerpts'][0]['text']
                if stage == 'DRAMA_REVIEW' or still_invalid:
                    result.findings.append(EditorialFinding(severity='ERROR', category='STORY', shotIds=[], beatIds=['P01'],
                        message='多出的字破坏句意', evidence=quote, suggestion='删除多出的“花”字'))
            return result

    provider, api = LanguageProvider(), Api()
    pipeline = Pipeline(api, provider, drama_value(), [], [])
    await pipeline.run()
    review = pipeline.checkpoints['DRAMA_REVIEW', 's0']['output']
    assert all(check['verdict'] == 'PASS' for check in review['qualityChecks'])
    assert any(f['severity'] == 'ERROR' for f in review['findings'])
    repair = pipeline.checkpoints['REPAIR', 's0']['output']
    assert repair['script']['story']['beats'][1]['content'] == unaffected
    assert len(repair['changes']) == 1
    repair_instruction = next(i for stage, _, _, i in provider.contexts if stage == 'REPAIR')
    assert strategy_for('DRAMA', DRAMA_VERSION).REPAIR_CAPACITY in repair_instruction
    assert len(provider.calls) == 8
    published = [v for path, v in api.calls if path == 'scripts']
    assert bool(published) is not still_invalid
    if published:
        assert published[0]['script']['story']['beats'][0]['content'].endswith(corrected)
    checkpoints = [{'nodeId': n, 'scriptId': sid, **v} for (n, sid), v in pipeline.checkpoints.items()]
    await Pipeline(Api(), provider, drama_value(), checkpoints, []).run()
    assert len(provider.calls) == 8


def test_drama_old_strategy_stays_frozen_and_shared_schemas_match():
    assert 'dramaCommitment' not in strategy_for('DRAMA','2026-10-14.7').WRITE
    assert '情节完整的功能演示' not in strategy_for('DRAMA','2026-10-14-drama.1').SELECT
    assert '推断链' not in strategy_for('DRAMA','2026-10-14-drama.2').SELECT
    directory=Path(__file__).resolve().parents[3]/'packages/contracts/schemas'
    for name,schema in [('development',DramaDevelopment),('selection',DramaSelection)]:
        assert json.loads((directory/f'customized-drama-{name}.schema.json').read_text('utf-8'))==schema.model_json_schema()


async def test_free_creation_keeps_sources_and_revision_uses_actual_issues_without_positive_reviews():
    from customized_storyboard.typed_creation import TypedPatch
    data, provider, api = drama_value(), DramaProvider(repair=True), Api()
    data['brief'].update(productSpecifications='已确认的规格', productAppearance='已确认的外观')
    pipeline = Pipeline(api, provider, data, [], [])
    await pipeline.run()
    development = next(c for _, schema, c, _ in provider.contexts if issubclass(schema, DramaDevelopment))
    strategy = strategy_for('DRAMA', DRAMA_VERSION)
    assert development['brief'] == {k:v for k,v in data['brief'].items() if k in strategy.DEVELOPMENT_BRIEF_FIELDS}
    initial = pipeline.checkpoints['DRAMA_REVIEW', 's0']['output']
    repair = next((c, instruction) for _, schema, c, instruction in provider.contexts if schema is TypedPatch)
    assert repair[0]['review'] == {'findings': [f for f in initial['findings'] if f['severity'] == 'ERROR']}
    assert '完整brief' not in repair[1]  # Dedicated editing instruction, not a repeated writing job.
    strategy = strategy_for('DRAMA', DRAMA_VERSION)
    assert strategy.REPAIR in repair[1]
    factual = next((c, instruction) for stage, _, c, instruction in provider.contexts if stage == 'RECHECK' and c.get('auditRole') == 'FACTS')
    assert factual[0]['originalReview'] == {'findings': initial['findings']}
    assert factual[0]['brief'] == data['brief']
    assert factual[1] == strategy.FACT_REVIEW
    assert len(provider.calls) == 8
    assert len([v for path,v in api.calls if path == 'scripts']) == 1


def test_previous_human_event_strategy_remains_separately_frozen():
    from customized_storyboard.routes import drama_v16_5, drama_v16_6
    assert strategy_for('DRAMA', '2026-10-16-drama.5') is drama_v16_5
    assert not hasattr(drama_v16_5, 'FOCUSED_REVIEW')
    assert strategy_for('DRAMA', '2026-10-16-drama.6') is drama_v16_6


@pytest.mark.parametrize('version', ['2026-10-16-drama.7', DRAMA_VERSION])
async def test_screenplay_estimates_do_not_become_shot_timing_obligations(version):
    data, provider, api = drama_value(), DramaProvider(), Api()
    data['strategyVersions'] = dict.fromkeys(data['strategyVersions'], version)
    pipeline = Pipeline(api, provider, data, [], [])
    await pipeline.run()
    factual = next(c for _,_,c,_ in provider.contexts if c.get('auditRole') == 'FACTS')
    assert factual['brief'] == data['brief']
    assert ('auditScope' in factual) is (version == DRAMA_VERSION)
    assert ('durationSeconds' in factual['story']['beats'][0]) is (version != DRAMA_VERSION)
    assert pipeline.checkpoints['DRAMA_STORY','s0']['output']['beats'][0]['durationSeconds'] > 0
    published = next(v['script'] for path,v in api.calls if path == 'scripts')
    assert published['story']['beats'][0]['durationSeconds'] > 0


@pytest.mark.parametrize('mode', ['AI', 'CUSTOM'])
async def test_ai_structure_repair_canonicalizes_invented_mappings_and_does_not_force_warnings(mode):
    from customized_storyboard.typed_creation import TypedPatch
    from customized_storyboard.review_calibration import EditorialFinding

    class MappingProvider(DramaProvider):
        async def generate(self, stage, model, schema, context, instruction):
            result = await super().generate(stage, model, schema, context, instruction)
            if context.get('auditRole') == 'EDITORIAL' and stage == 'DRAMA_REVIEW':
                result.findings.append(EditorialFinding(severity='WARNING', category='STORY', shotIds=[], beatIds=['P01'],
                    message='可选的局部偏好', evidence='轮廓', suggestion='不应强制为此重写'))
            if schema is TypedPatch:
                from customized_storyboard.typed_creation import StructureMapping
                result.structureMapping = [StructureMapping(requirementId='INVENTED', beatIds=['P01'], evidence='not a body quote')]
            return result

    data, provider, api = drama_value(), MappingProvider(repair=True), Api()
    data['settings']['structureMode'] = mode
    if mode == 'AI':
        data['settings']['structureSections'] = []
    pipeline = Pipeline(api, provider, data, [], [])
    await pipeline.run()
    if mode == 'CUSTOM':
        assert len(provider.calls) == 6
        assert pipeline.checkpoints['REPAIR','s0']['status'] == 'FAILED'
        assert not any(path == 'scripts' for path,_ in api.calls)
        return
    assert len(provider.calls) == 8
    repaired = pipeline.checkpoints['REPAIR','s0']['output']['script']['story']
    assert repaired['structureMapping'] == []
    assert repaired['beats'][0]['content'] == pipeline.checkpoints['DRAMA_STORY','s0']['output']['beats'][0]['content']
    assert len([v for path,v in api.calls if path == 'scripts']) == 1
    assert any(f['severity'] == 'WARNING' for f in pipeline.checkpoints['DRAMA_REVIEW','s0']['output']['findings'])
    repair_context = next(c for _,schema,c,_ in provider.contexts if schema is TypedPatch)
    assert all(f['severity'] == 'ERROR' for f in repair_context['review']['findings'])


async def test_premise_first_schema_changes_generation_order_without_changing_data_or_resume():
    from customized_storyboard.drama_development import PremiseFirstDramaDevelopment
    data, provider, api = drama_value(), DramaProvider(), Api()
    pipeline = Pipeline(api, provider, data, [], [])
    await pipeline.run()
    _, schema, _, _ = next(v for v in provider.contexts if issubclass(v[1], DramaDevelopment))
    assert schema is PremiseFirstDramaDevelopment
    old = DramaDevelopment.model_json_schema()['$defs']['DramaIdea']
    current = schema.model_json_schema()['$defs']['DramaIdea']
    assert list(old['properties']).index('plan') < list(old['properties']).index('viewingPromise')
    assert list(current['properties']).index('viewingPromise') < list(current['properties']).index('plan')
    assert old['properties'] == current['properties']
    assert set(old['required']) == set(current['required'])
    saved = pipeline.checkpoints['DRAMA_CONCEPT', '']['output']
    assert DramaDevelopment.model_validate(saved['development']).model_dump() == saved['development']
    assert len(provider.calls) == 5
    frozen = [{'nodeId':n, 'scriptId':sid, **v} for (n,sid),v in pipeline.checkpoints.items()]
    await Pipeline(Api(), provider, data, frozen, []).run()
    assert len(provider.calls) == 5


async def test_previous_drama8_still_uses_original_schema_and_strategy():
    from customized_storyboard.routes import drama_v16_8
    data, provider = drama_value(), DramaProvider()
    data['strategyVersions'] = dict.fromkeys(data['strategyVersions'], '2026-10-16-drama.8')
    await Pipeline(Api(), provider, data, [], []).run()
    schema = next(s for _,s,_,_ in provider.contexts if issubclass(s, DramaDevelopment))
    assert schema is DramaDevelopment
    assert strategy_for('DRAMA', '2026-10-16-drama.8') is drama_v16_8
    assert not hasattr(drama_v16_8, 'PREMISE_FIRST')
