from typing import Any
import pytest
from customized_storyboard.pipeline import Pipeline
from customized_storyboard.models import Concept,Concepts

class Api:
    def __init__(self) -> None:self.calls:list[tuple[str,Any]]=[]
    async def call(self,method:str,path:str,value:Any=None) -> dict[str,Any]:
        self.calls.append((path,value));return {}

class Provider:
    def __init__(self) -> None:self.stages:list[str]=[]
    async def generate(self,stage:str,model:str,schema:Any,context:Any,instruction:str) -> Any:
        self.stages.append(stage)
        return schema.model_validate({'title':'清晨','content':'开窗后倒水，坐下阅读。','opening':'开窗','development':'倒水','ending':'阅读','dialoguePlan':'无对白','beats':[{'id':'b1','content':'完整故事','durationSeconds':30}]} if stage=='STORY' else {'summary':'审校通过','findings':[]})

@pytest.mark.asyncio
async def test_story_creation_does_not_generate_assets_or_shots() -> None:
    api,provider=Api(),Provider()
    p=Pipeline(api,provider,{'outputMode':'STORY_ONLY','brief':{},'settings':{'targetDurationSeconds':30},'existingConcepts':[],'models':{'creative':'controlled','detail':'controlled'}},[],[])  # type: ignore[arg-type]
    c=Concept(scriptId='s',name='清晨',synopsis='开窗倒水',productFocus='陶瓷杯',structure='日常',difference='清晨叙事')
    await p.script(c,Concepts(concepts=[c]))
    assert provider.stages==['STORY','REVIEW']
    result=api.calls[-1][1]['script']
    assert result['story']['content']=='开窗后倒水，坐下阅读。'
    assert result['shots']==[] and result['assets']==[]


def test_ai_structure_excludes_inactive_structure_and_history_from_story_context() -> None:
    value = {'brief': {}, 'settings': {'structureMode': 'AI', 'structure': '旧长片六段结构'}, 'existingConcepts': [{'name': '旧片', 'synopsis': '历史情节'}]}
    p = Pipeline(Api(), Provider(), value, [], [])  # type: ignore[arg-type]
    assert p.context['settings']['structure'] == ''
    assert 'existingConcepts' not in p.context
    assert value['settings']['structure'] == '旧长片六段结构'


def test_explicit_structure_is_kept_in_story_context() -> None:
    value = {'brief': {}, 'settings': {'structureMode': 'CUSTOM', 'structure': '悬念、揭示、收束'}, 'existingConcepts': []}
    p = Pipeline(Api(), Provider(), value, [], [])  # type: ignore[arg-type]
    assert p.context['settings']['structure'] == '悬念、揭示、收束'


@pytest.mark.asyncio
async def test_story_repair_updates_overview_and_rechecks_the_same_content() -> None:
    class RepairProvider(Provider):
        async def generate(self, stage: str, model: str, schema: Any, context: Any, instruction: str) -> Any:
            if stage == 'REVIEW':
                return schema.model_validate({'summary': '移除不必要的旅行情节', 'findings': [{'severity': 'ERROR', 'category': 'STORY', 'message': '情节过多', 'evidence': '30秒', 'suggestion': '集中阅读场景', 'shotIds': []}]})
            if stage == 'REPAIR':
                return schema.model_validate({'concept': {**context['concept'], 'name': '阅读时刻', 'synopsis': '倒水后阅读', 'structure': '倒水、阅读', 'productFocus': '握杯阅读'}, 'story': {'title': '阅读时刻', 'content': '倒水后坐下阅读。', 'opening': '倒水', 'development': '落座', 'ending': '阅读', 'dialoguePlan': '无对白', 'beats': [{'id': 'b1', 'content': '倒水阅读', 'durationSeconds': 30}]}})
            if stage == 'RECHECK':
                assert context['concept']['synopsis'] == '倒水后阅读'
                assert context['story']['content'] == '倒水后坐下阅读。'
                return schema.model_validate({'summary': '正文与概述一致', 'findings': []})
            return await super().generate(stage, model, schema, context, instruction)

    api = Api()
    p = Pipeline(api, RepairProvider(), {'outputMode': 'STORY_ONLY', 'brief': {}, 'settings': {'targetDurationSeconds': 30}, 'existingConcepts': [], 'models': {'creative': 'controlled', 'detail': 'controlled'}}, [], [])  # type: ignore[arg-type]
    c = Concept(scriptId='s', name='出行', synopsis='旧旅行情节', productFocus='旧重点', structure='旧结构', difference='清晨叙事')
    await p.script(c, Concepts(concepts=[c]))
    script = api.calls[-1][1]['script']
    assert script['name'] == '阅读时刻'
    assert script['synopsis'] == '倒水后阅读'
    assert script['structure'] == '倒水、阅读'
    assert script['productFocus'] == '握杯阅读'
