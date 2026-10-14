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
        if schema is DramaDevelopment:
            self.calls.append(stage)
            return schema.model_validate({'readiness': {'status':'NEEDS_INFORMATION' if self.missing else 'READY',
                'reason':'缺关键产品资料' if self.missing else '已有资料足够', 'missing':['产品特征'] if self.missing else []},
                'ideas': [] if self.missing else [{'id':f'I{i}', 'name':f'人物选择{i}', 'devices':['对话试探','信息反转'],
                    'viewingPromise':'包里留下的东西是谁放的', 'informationDesign':'观众先看到标记，人物稍后发现',
                    'dialogueIntent':'试探对方有没有改变决定', 'emotionalMovement':'由防备到发现被默默理解',
                    'weakness':'避免对白提前说破', 'factIds':['F01'],
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
        if schema is DramaDevelopment:
            assert '五选一或配额' in instruction and '反转须有前置线索' in instruction
        if 'dramaCommitment' in ctx:
            assert ctx['dramaCommitment']['idea']['informationDesign']
        if ctx.get('auditRole')=='EDITORIAL':
            assert 'dramaCommitment' not in ctx and 'concept' not in ctx
            assert '观看期待' in instruction and 'NATURAL_DIALOGUE' in instruction
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
    assert not any(schema is DramaDevelopment for _,schema,_,_ in resumed.contexts)
    assert len(resumed.calls)==4


async def test_drama_cannot_publish_a_structurally_failed_recheck():
    provider=DramaProvider(repair=True)
    provider.recheck_error=True
    api=Api()
    await Pipeline(api,provider,drama_value(),[],[]).run()
    assert not any(path=='scripts' for path,_ in api.calls)


def test_drama_old_strategy_stays_frozen_and_shared_schemas_match():
    assert 'dramaCommitment' not in strategy_for('DRAMA','2026-10-14.7').WRITE
    assert '情节完整的功能演示' not in strategy_for('DRAMA','2026-10-14-drama.1').SELECT
    assert '情节完整的功能演示' in strategy_for('DRAMA',DRAMA_VERSION).SELECT
    assert '推断链' not in strategy_for('DRAMA','2026-10-14-drama.2').SELECT
    assert '推断链' in strategy_for('DRAMA',DRAMA_VERSION).SELECT
    directory=Path(__file__).resolve().parents[3]/'packages/contracts/schemas'
    for name,schema in [('development',DramaDevelopment),('selection',DramaSelection)]:
        assert json.loads((directory/f'customized-drama-{name}.schema.json').read_text('utf-8'))==schema.model_json_schema()
