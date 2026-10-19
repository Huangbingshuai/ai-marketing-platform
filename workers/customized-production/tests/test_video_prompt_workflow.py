from __future__ import annotations
from typing import Any
import json
from pathlib import Path
import pytest
from customized_production_runtime.video_prompt import reference_header, time_windows, validate_prompt_presentation, validate_prompt_audit_evidence
from customized_production_runtime.video_models import PromptAudit, PromptScopedAudit
from customized_production_runtime.video_pipeline import run_video
from test_video_v2 import FakeApi, snapshot, clean_audit


def test_readable_reference_header_and_exact_fractional_time_windows() -> None:
    assets=[{'id':'x','kind':'PRODUCT','name':'弧电G65'},{'id':'y','kind':'SCENE','name':'通勤桌面'}]
    assert reference_header(assets)=='产品：@弧电G65；场景：@通勤桌面。'
    assert time_windows(6.125)==[{'startSeconds':0,'endSeconds':3},{'startSeconds':3,'endSeconds':6},{'startSeconds':6,'endSeconds':6.125}]


def test_actual_mentions_are_a_subset_and_audio_times_are_not_extra_picture_windows() -> None:
    context={'referenceHeader':'产品：@杯；场景：@房间。','timeWindows':time_windows(5), 'clip':{'id':'clip-a','title':'杯'},'shots':[], 'cues':[], 'assets':[{'id':'cup','kind':'PRODUCT','name':'杯'},{'id':'room','kind':'SCENE','name':'房间'}]}
    value={'assetIds':['cup'], 'content':'产品：@杯。\n0–3秒：@杯特写。\n3–5秒：保持静止。\n声音与画面文字安排\n0–5秒：旁白完整保留。'}
    validate_prompt_presentation(value, context)
    with pytest.raises(ValueError, match='exactly match'):
        validate_prompt_presentation(value | {'assetIds':['cup','room']}, context)
    with pytest.raises(ValueError, match='full readable'):
        validate_prompt_presentation(value | {'content':value['content']+'@未知素材'}, context)


@pytest.mark.asyncio
@pytest.mark.parametrize('use_scene', [True, False])
@pytest.mark.parametrize('version', [2, 3])
async def test_prompt_workflow_uses_two_calls_and_readable_timed_output(use_scene: bool, version: int) -> None:
    data=snapshot()
    data.update(operation='PROMPT',promptWorkflowVersion=version,target={'kind':'CLIP','id':'clip-b'})
    class Provider:
        def __init__(self) -> None:
            self.calls:list[str]=[]
        async def generate(self,stage:str,model:str,schema:Any,context:dict[str,Any],instruction:str)->Any:
            self.calls.append(stage)
            if stage=='VIDEO_PROMPT':
                assert [s['id'] for s in context['shots']]==['shot-c']
                assert context['referenceHeader']=='产品：@陶瓷杯；场景：@阅读室。'
                assert context['cues'][0]['sourceText']=='一杯清晨'
                return schema.model_validate({'target':data['target'],'assetIds':['cup','room'] if use_scene else ['cup'],'content':(context['referenceHeader'] if use_scene else '产品：@陶瓷杯。')+'\n0–3秒：'+('@阅读室，' if use_scene else '')+'@陶瓷杯的独立产品定版。\n3–5秒：保持杯身近景。\n声音与画面文字安排\n屏显（0–5秒）：一杯清晨'})
            assert stage=='VIDEO_REVIEW'
            if version==3:
                assert 'immutableSourceUnits' not in context and 'brief' not in context
                assert '独立审阅实际result' not in instruction
                assert context['result']['brief'] and context['result']['cues']
            return schema.model_validate(clean_audit() | ({'promptEvidence':[]} if version==3 else {}))
    api,provider=FakeApi(),Provider()
    await run_video(api,provider,api.claim(data))  # type: ignore[arg-type]
    assert provider.calls==['VIDEO_PROMPT','VIDEO_REVIEW']
    assert api.completed is not None
    assert api.output['plan']['timeWindows']==time_windows(5)
    assert api.completed['target']==data['target']
    assert data['document']==snapshot()['document']


@pytest.mark.asyncio
@pytest.mark.parametrize('version', [2, 3])
async def test_prompt_repairs_only_current_prompt_then_rechecks_with_original_findings(version: int) -> None:
    data=snapshot()
    data.update(operation='PROMPT',promptWorkflowVersion=version,target={'kind':'CLIP','id':'clip-b'})
    evidence=[{'entity':'PROMPT','id':'clip-b','field':'content'}]
    issue={'id':'screen-window','severity':'ERROR','category':'STATE','title':'屏显时间冲突','impact':'前后时间不一致','evidence':evidence,'affectedShotIds':['shot-c'],'affectedClipIds':['clip-b'],'suggestedFix':'对齐已确认屏显窗口','repairKind':'FIELDS'}
    class Provider:
        def __init__(self) -> None:
            self.calls:list[str]=[]
        async def generate(self,stage:str,model:str,schema:Any,context:dict[str,Any],instruction:str)->Any:
            self.calls.append(stage)
            if stage in ('VIDEO_PROMPT','VIDEO_PROMPT_REPAIR'):
                return schema.model_validate({'target':data['target'],'assetIds':['cup'],'content':'产品：@陶瓷杯。\n0–3秒：@陶瓷杯近景。\n3–5秒：保持画面。\n声音与画面文字安排\n屏显（0–5秒）：一杯清晨'})
            if stage=='VIDEO_REVIEW':
                return schema.model_validate(clean_audit() | {'findings':[issue]} | ({'promptEvidence':[{'issueId':issue['id'],'excerpt':'0–3秒：@陶瓷杯近景。'}]} if version==3 else {}))
            assert stage=='VIDEO_RECHECK'
            assert context['previousFindings']==[issue]
            return schema.model_validate(clean_audit() | {'severityChanges':[], 'resolutions':[{'issueId':issue['id'],'status':'RESOLVED','evidence':evidence,'explanation':'实际画面与已确认屏显窗口一致'}]} | ({'promptEvidence':[]} if version==3 else {}))
    api,provider=FakeApi(),Provider()
    await run_video(api,provider,api.claim(data))  # type: ignore[arg-type]
    assert provider.calls==['VIDEO_PROMPT','VIDEO_REVIEW','VIDEO_PROMPT_REPAIR','VIDEO_RECHECK']
    assert api.completed is not None
    assert api.completed['assetIds']==['cup']
    assert data['document']==snapshot()['document']


def test_prompt_review_cannot_quote_upstream_visual_as_current_prompt_error() -> None:
    prompt={'content':'0–3秒：产品近景。\n屏显（2–14秒）：正确文字'}
    audit={'findings':[{'id':'F1','repairKind':'FIELDS'}], 'promptEvidence':[{'issueId':'F1','excerpt':'手离开、镜头微推后文字才浮现'}]}
    with pytest.raises(ValueError, match='current prompt.content'):
        validate_prompt_audit_evidence(audit,prompt)
    validate_prompt_audit_evidence(audit | {'promptEvidence':[{'issueId':'F1','excerpt':'0–3秒：产品近景。'}]},prompt)
    with pytest.raises(ValueError, match='exact current'):
        validate_prompt_audit_evidence(audit | {'promptEvidence':[]},prompt)


@pytest.mark.parametrize('name,model',[('prompt-audit',PromptAudit),('prompt-scoped-audit',PromptScopedAudit)])
def test_prompt_review_schema_matches_contract(name:str,model:Any)->None:
    path=Path(__file__).resolve().parents[3]/f'packages/contracts/schemas/customized-video-{name}-v3.schema.json'
    assert json.loads(path.read_text(encoding='utf-8'))==model.model_json_schema()


@pytest.mark.parametrize('bad', ['无引用\n0–3秒：画面\n3–5秒：画面','产品：@杯。\n0–5秒：画面','产品：@杯。\n0–3秒：REF1\n3–5秒：画面'])
def test_presentation_rejects_missing_header_missing_windows_and_internal_aliases(bad:str)->None:
    context={'referenceHeader':'产品：@杯。','timeWindows':time_windows(5),'clip':{'id':'long-clip-identity-0000000','title':'杯子'},'shots':[],'cues':[],'assets':[{'id':'cup','kind':'PRODUCT','name':'杯'}]}
    with pytest.raises(ValueError):
        validate_prompt_presentation({'content':bad, 'assetIds':['cup']},context)
