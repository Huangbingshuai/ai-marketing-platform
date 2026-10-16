"""Mechanical projection of AI diagnoses, not keyword-based creativity judgments."""
import pytest
from customized_storyboard.drama_audit import DramaEditorialReview, resolve_drama_audit
from customized_storyboard.review_calibration import EditorialReview
from customized_storyboard.routes import DRAMA_VERSION, strategy_for
from customized_storyboard.typed_creation import materialize_quality_findings
from customized_storyboard.pipeline import Pipeline
from test_drama_development import drama_value, DramaProvider
from test_story_only import Api

SOURCES = {'P01:E01': ('P01', '角色在开头留下一个尚未回答的问题。'),
           'P02:E01': ('P02', '角色轮流解释产品特点，对方点头等候。'),
           'P03:E01': ('P03', '结尾有人说他帮助了陌生人，大家感谢他。')}


def diagnosis():
    return {'routeId':'DRAMA', 'summary':'总体好评不能冲掉具体缺陷', 'findings':[],
        'qualityChecks':[{'criterion':c,'evidenceId':'P01:E01','observed':'有动作和交谈',
            'limitation':'','suggestion':'','assessment':'DEMONSTRATED','defectScope':'NONE'}
            for c in ('CHARACTER_CAUSALITY','NATURAL_DIALOGUE','PRODUCT_CAUSALITY')],
        'mechanism': {'mainLine':'问答特点，展示功能，最后得到感谢',
            'dialogueMode':'EXPOSITORY_SPINE','dialogueEvidenceIds':['P02:E01'],
            'dialogueReason':'主要对白只承担解释产品','dialogueRevision':'重写问答段为角色的实际交锋',
            'endingMode':'EMOTIONAL_COVER','endingSetupEvidenceId':'P01:E01','endingEvidenceId':'P03:E01',
            'endingReason':'后补的善举没有接续前面的人物行为','endingRevision':'回收前面真实建立的线索或行动'}}


@pytest.mark.parametrize('product',['青梅酱','面霜','预约软件','充电器','落地灯'])
def test_structural_diagnoses_override_positive_labels_without_product_matching(product):
    data=diagnosis()
    data['mechanism']['mainLine']=product+'参与问答，最后突然得到感谢'
    review=resolve_drama_audit(DramaEditorialReview.model_validate(data), SOURCES)
    assert [q.verdict for q in review.qualityChecks] == ['FAIL','FAIL','PASS']
    assert review.qualityChecks[1].evidence == SOURCES['P02:E01'][1]
    assert review.qualityChecks[0].beatIds == ['P01','P03']
    assert review.qualityChecks[0].evidence == SOURCES['P03:E01'][1]
    assert '需要定向修订' in review.summary
    materialize_quality_findings(review)
    assert len([f for f in review.findings if f.severity=='ERROR']) == 2


@pytest.mark.parametrize('text',['善意、感谢、亲情和温情','荒诞、幻想、拟人和离谱'])
def test_established_warmth_or_fantasy_is_not_rejected_by_words(text):
    data=diagnosis()
    data['mechanism'].update(mainLine=text,dialogueMode='DRAMATIC_EXCHANGE',endingMode='DEVELOPED_PAYOFF')
    result=resolve_drama_audit(DramaEditorialReview.model_validate(data), SOURCES)
    assert all(q.verdict=='PASS' for q in result.qualityChecks)


@pytest.mark.parametrize('field,value',[
    ('dialogueEvidenceIds',['foreign']),('endingSetupEvidenceId','foreign'),
    ('endingEvidenceId','foreign'),('dialogueEvidenceIds',[]),
    ('dialogueEvidenceIds',['P02:E01','P02:E01']),('dialogueRevision',''),('endingRevision','')])
def test_invalid_diagnosis_cannot_become_a_successful_review(field,value):
    data=diagnosis();data['mechanism'][field]=value
    with pytest.raises(ValueError):
        resolve_drama_audit(DramaEditorialReview.model_validate(data), SOURCES)


def test_nonapplicable_dialogue_requires_consistent_explicit_absence():
    data=diagnosis()
    data['mechanism'].update(dialogueMode='NO_DIALOGUE',dialogueEvidenceIds=[],endingMode='OPEN_OR_UNRESOLVED')
    with pytest.raises(ValueError,match='absence'):
        resolve_drama_audit(DramaEditorialReview.model_validate(data), SOURCES)
    data['qualityChecks'][1].update(assessment='NOT_APPLICABLE',evidenceId='')
    output=resolve_drama_audit(DramaEditorialReview.model_validate(data), SOURCES)
    assert output.qualityChecks[1].verdict=='NOT_APPLICABLE'
    data['mechanism'].update(endingMode='DEVELOPED_PAYOFF',endingSetupEvidenceId='')
    with pytest.raises(ValueError,match='setup'):
        resolve_drama_audit(DramaEditorialReview.model_validate(data), SOURCES)


def test_new_schema_starts_with_mechanism_and_keeps_legacy_schema_unchanged():
    assert list(DramaEditorialReview.model_json_schema()['properties'])[:3] == ['routeId','mechanism','qualityChecks']
    assert 'mechanism' not in EditorialReview.model_json_schema()['properties']
    assert not hasattr(strategy_for('DRAMA','2026-10-16-drama.9'),'MECHANISM_AUDIT')


@pytest.mark.parametrize('still_invalid',[False,True])
async def test_mechanism_failure_uses_existing_repair_budget_and_cannot_publish_failed_recheck(still_invalid):
    class MechanismProvider(DramaProvider):
        async def generate(self,stage,model,schema,context,instruction):
            result=await super().generate(stage,model,schema,context,instruction)
            if issubclass(schema, DramaEditorialReview) and (stage=='DRAMA_REVIEW' or still_invalid):
                result.mechanism.dialogueMode='EXPOSITORY_SPINE'
                result.mechanism.dialogueReason='主导对白只是在解释说明书'
                result.mechanism.dialogueRevision='将问答改成具体交锋与行动'
            return result
    provider,api=MechanismProvider(),Api()
    pipeline=Pipeline(api,provider,drama_value(),[],[])
    await pipeline.run()
    assert len(provider.calls)==8
    assert pipeline.checkpoints['DRAMA_REVIEW','s0']['output']['qualityChecks'][1]['verdict']=='FAIL'
    published=[v for path,v in api.calls if path=='scripts']
    assert bool(published) is not still_invalid
    checkpoints=[{'nodeId':n,'scriptId':sid,**v} for (n,sid),v in pipeline.checkpoints.items()]
    await Pipeline(Api(),provider,drama_value(),checkpoints,[]).run()
    assert len(provider.calls)==8


async def test_drama9_does_not_use_new_diagnosis_or_purchase_extra_review():
    data,provider=drama_value(),DramaProvider()
    data['strategyVersions']=dict.fromkeys(data['strategyVersions'],'2026-10-16-drama.9')
    await Pipeline(Api(),provider,data,[],[]).run()
    assert len(provider.calls)==5
    assert not any(s is DramaEditorialReview for _,s,_,_ in provider.contexts)


@pytest.mark.parametrize('classification,expected',[('DRAMA_DRIVEN','PASS'),('EXPLANATION_WITH_PLOT_WRAP','FAIL')])
def test_ai_viewing_value_is_separate_from_causal_coherence(classification,expected):
    from customized_storyboard.drama_audit import DramaMeritReview, resolve_drama_merit
    data=diagnosis()
    data['mechanism'].update(dialogueMode='DRAMATIC_EXCHANGE',endingMode='DEVELOPED_PAYOFF')
    data['viewingValue']={'viewingEvent':'解释参数后完成任务，最后感谢同事',
        'classification':classification,'evidenceId':'P02:E01','reason':'因果完整不等于独立的剧情体验',
        'revision':'实际重写主线为有具体误导、变化或交锋的事件'}
    result=resolve_drama_merit(DramaMeritReview.model_validate(data),SOURCES)
    assert result.qualityChecks[0].verdict==expected
    assert result.qualityChecks[1].verdict=='PASS'
    assert result.qualityChecks[2].verdict=='PASS'
    if expected=='FAIL':
        assert result.qualityChecks[0].evidence==SOURCES['P02:E01'][1]
        assert '需要定向修订' in result.summary
    assert 'viewingValue' not in result.model_dump()


def test_mechanism_and_viewing_value_defects_preserve_both_reasons_and_citations():
    from customized_storyboard.drama_audit import DramaMeritReview, resolve_drama_merit
    data=diagnosis()
    data['viewingValue']={'viewingEvent':'只有功能演示','classification':'EXPLANATION_WITH_PLOT_WRAP',
        'evidenceId':'P02:E01','reason':'缺少实际剧情看点','revision':'改变主要推进'}
    result=resolve_drama_merit(DramaMeritReview.model_validate(data),SOURCES)
    cause=result.qualityChecks[0]
    assert cause.verdict=='FAIL' and set(cause.beatIds)=={'P01','P02','P03'}
    assert cause.evidence==SOURCES['P03:E01'][1]
    assert '后补的善举' in cause.reason and '缺少实际剧情看点' in cause.reason
    assert '回收前面' in cause.suggestion and '改变主要推进' in cause.suggestion
    assert list(DramaMeritReview.model_json_schema()['properties'])[:3]==['routeId','viewingValue','mechanism']
    assert 'viewingValue' not in DramaEditorialReview.model_json_schema()['properties']


async def test_drama10_keeps_frozen_mechanism_without_new_merit_fields():
    from customized_storyboard.drama_audit import DramaMeritReview
    data,provider=drama_value(),DramaProvider()
    data['strategyVersions']=dict.fromkeys(data['strategyVersions'],'2026-10-16-drama.10')
    await Pipeline(Api(),provider,data,[],[]).run()
    assert len(provider.calls)==5
    assert any(s is DramaEditorialReview for _,s,_,_ in provider.contexts)
    assert not any(s is DramaMeritReview for _,s,_,_ in provider.contexts)


def test_scoped_citations_reject_combined_or_foreign_ids_before_semantic_projection():
    from customized_storyboard.drama_audit import scoped_drama_merit
    schema=scoped_drama_merit(list(SOURCES))
    properties=schema.model_json_schema()['$defs']['DramaMechanism']['properties']
    assert properties['endingSetupEvidenceId']['enum']==['',*sorted(SOURCES)]
    data=diagnosis()
    data['viewingValue']={'viewingEvent':'具体事件','classification':'DRAMA_DRIVEN',
        'evidenceId':'P01:E01','reason':'具有实际发展','revision':''}
    assert schema.model_validate(data).viewingValue.evidenceId=='P01:E01'
    data['mechanism']['endingSetupEvidenceId']='P01:E01,P02:E01'
    with pytest.raises(ValueError,match='unknown evidence'):
        schema.model_validate(data)
    with pytest.raises(ValueError,match='requires body evidence'):
        scoped_drama_merit([])
