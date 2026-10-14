"""Commerce-specific motivation and demonstration plans, with bounded resumable selection."""
from __future__ import annotations

from typing import Annotated, Any, Literal, Self, TYPE_CHECKING
from pydantic import Field, model_validator
from .models import Model, Id
from .typed_creation import Readiness, TypedConcept, TypedConcepts
from .brand_development import fact_catalog

if TYPE_CHECKING:
    from .pipeline import Pipeline
    from .presenter_development import Development

Short = Annotated[str, Field(min_length=1, max_length=240)]


class Demonstration(Model):
    setup: Short
    action: Short
    observableResult: Short
    claimBoundary: Short


class CommerceOpportunity(Model):
    id: Short
    name: Id
    audienceSituation: Short
    situationBasis: Literal['BRIEF', 'CREATIVE_HYPOTHESIS']
    buyingReason: Short
    purchaseQuestion: Short
    factIds: Annotated[list[Id], Field(min_length=1, max_length=30)]
    demonstration: Demonstration
    progression: Short
    ending: Short


class CommerceDevelopment(Model):
    readiness: Readiness
    opportunities: Annotated[list[CommerceOpportunity], Field(max_length=6)]

    @model_validator(mode='after')
    def valid(self) -> Self:
        if self.readiness.status == 'READY':
            if len(self.opportunities) != 6 or self.readiness.missing:
                raise ValueError('ready commerce planning requires six opportunities')
        elif self.opportunities or not self.readiness.missing:
            raise ValueError('missing information cannot produce opportunities')
        return self


class CommerceEvaluation(Model):
    opportunityId: Short
    verdict: Literal['ADVANCE', 'REJECT']
    reason: Short


class CommerceChoice(Model):
    scriptId: Id
    opportunityId: Short
    mustPreserve: Annotated[list[Short], Field(min_length=2, max_length=4)]


class CommerceSelection(Model):
    status: Literal['READY', 'REWORK', 'NEEDS_INFORMATION']
    reason: Short
    missing: Annotated[list[Id], Field(max_length=20)]
    evaluations: Annotated[list[CommerceEvaluation], Field(max_length=6)]
    choices: Annotated[list[CommerceChoice], Field(max_length=5)]


def validate_development(value: CommerceDevelopment, facts: list[dict[str, str]]) -> None:
    if not value.readiness.reason.strip() or any(not v.strip() for v in value.readiness.missing):
        raise ValueError('commerce readiness text is empty')
    for opportunity in value.opportunities:
        fields = opportunity.model_dump(exclude={'factIds', 'demonstration'})
        if any(not v.strip() for v in [*fields.values(), *opportunity.demonstration.model_dump().values()]):
            raise ValueError('commerce planning text is empty')
    ids = [o.id for o in value.opportunities]
    known = {f['id'] for f in facts}
    if len(set(ids)) != len(ids) or any(ref not in known for o in value.opportunities for ref in o.factIds):
        raise ValueError('commerce opportunity identity or fact reference mismatch')


def validate_selection(value: CommerceSelection, development: CommerceDevelopment | Development[Any], script_ids: list[str]) -> None:
    known = {o.id for o in development.opportunities}
    evaluations = {e.opportunityId: e for e in value.evaluations}
    if set(evaluations) != known or len(evaluations) != len(value.evaluations):
        raise ValueError('commerce evaluation coverage mismatch')
    if value.status != 'READY':
        if value.choices or (value.status == 'NEEDS_INFORMATION' and not value.missing):
            raise ValueError('unready commerce choice mismatch')
        return
    if value.missing or sorted(c.scriptId for c in value.choices) != sorted(script_ids) or len({c.opportunityId for c in value.choices}) != len(script_ids):
        raise ValueError('commerce selection script identity mismatch')
    if any(c.opportunityId not in evaluations or evaluations[c.opportunityId].verdict != 'ADVANCE' for c in value.choices):
        raise ValueError('rejected commerce opportunity selected')


def concept_for(opportunity: CommerceOpportunity, script_id: str) -> TypedConcept:
    d = opportunity.demonstration
    return TypedConcept.model_validate({
        'scriptId': script_id, 'name': opportunity.name,
        'synopsis': '\n'.join([d.setup, d.action, d.observableResult]),
        'productFocus': opportunity.buyingReason, 'structure': opportunity.progression,
        'difference': opportunity.purchaseQuestion + ('\n' + str(getattr(opportunity, 'creativeIdea')) if hasattr(opportunity, 'creativeIdea') else ''),
        'coreIdea': getattr(opportunity, 'creativeIdea', opportunity.buyingReason),
        'openingHook': d.setup, 'productRole': d.action, 'memoryPoint': d.observableResult,
        'plan': {'videoType': 'ECOMMERCE', 'buyingReason': opportunity.buyingReason,
            'audienceSituation': opportunity.audienceSituation,
            'demonstration': '\n'.join([d.setup, d.action, d.observableResult, '表达边界：' + d.claimBoundary]),
            'progression': opportunity.progression, 'ending': opportunity.ending},
    })


DEVELOP = """负责电商带货前期策划，暂不写长稿。先从factCatalog中的确认事实判断：谁在什么具体情况下有购买需要，为什么这个特点对其有用，又要看到什么才能理解。不是制造人人都有的焦虑。
开发恰好6份短方案，每个字段只写一两句具体安排，尽量不超过80字。audienceSituation写处境；未在简报明确的处境标CREATIVE_HYPOTHESIS，不冒充用户调查或证言。buyingReason连接需要与一个真实利益，purchaseQuestion写这份视频解决的具体购买疑问。factIds只引用已给的准确编号，事实能支持到什么程度由演示说明，不以编号替代依据。
demonstration由setup实际起点、action实际动作、observableResult观众能看见/听见并理解的结果、claimBoundary不能据此推导的效果构成。结果不能只有“轻松、方便、安心”或字幕宣称；也不等于把产品用完了。规格解释可以服务一个真实选择问题，但不是搬出全规格教学。progression说明观察如何推进，ending回应本片购买理由，不凭空催促下单。
不同方案改变购买问题、观察对象或演示方式，不仅换地点、人物、标题。可以直接演示、使用情境、真实依据解释、合规对照，不强制短剧、隐喻或反转。适用于食品、护肤、硬件、家居和软件：可以呈现已知口感/质地/结构/操作/任务体验，不得把形态变化包装成未确认疗效或性能。不能编造价格优惠、竞品、测试成绩、认证、真实评价、即时功效；食物不能变成药品，软件不能自动获得未知外部权限。缺少效果依据时选择真正能呈现的价值，不要求用户补创意。
简报的全部事实是准确性边界，只有明确强制展示项才必须进入每稿。参考时长指导聚焦，不堆全部参数。existingTitles仅是历史避重线索；已有稿不是质量范本。若有rejectedSelection，针对共同缺陷重新开发整组。确实缺少决定性产品依据才返回NEEDS_INFORMATION、具体missing且opportunities为空；创意普通不属于缺资料。"""

SELECT = """你是独立的电商内容策划，未参与短方案开发。逐个评价全部opportunities，只选择selectionCount份，绑定给定scriptIds各一次。只输出短评估和选择，不重写方案，不提前写脚本。
验收：购买动机是否是目标人群具体需要，事实与利益是否真正相关；演示是否能让观众凭实际画面理解该利益或解决购买疑问，结果有没有越过事实边界；参考时长能否容纳；不同选择与已有概述的购买问题/呈现方式是否有区别。拒绝虚构焦虑、假测评/证言、无依据前后对比、把全部参数轮流上屏和以旁白代替可见价值。简单功能演示如果证明了一个真实购买利益可以成熟，无需品牌广告式隐喻或剧情。
不能因为事实准确就自动ADVANCE，也不能为区别于品牌而强制浮夸。只有观众所需利益与观察结果均安排清楚才ADVANCE；理由指出具体依据或缺陷。READY必须足量选择ADVANCE且身份不重复；每份mustPreserve列2至4个需要在正文兑现的真实行为、观察及表达边界。成熟案不足则REWORK并choices为空，不硬选最不差的；只有简报缺真正必要事实才NEEDS_INFORMATION并给missing。不把弱创意作为资料缺失。"""

from .development_runtime import checked_model as checked_model

async def develop_commerce(p: Pipeline) -> TypedConcepts:
    develop_instruction, select_instruction = DEVELOP, SELECT
    if p.input['strategyVersions']['concept'] in {'2026-10-14-commerce.2', '2026-10-14-commerce.3', '2026-10-14-commerce.4', '2026-10-14-commerce.5'}:
        from .routes.ecommerce_v2 import DEVELOP_ADDITION, SELECT_ADDITION
        develop_instruction += DEVELOP_ADDITION
        select_instruction += SELECT_ADDITION
    compact_development = p.input['strategyVersions']['concept'] in {'2026-10-14-commerce.3', '2026-10-14-commerce.4', '2026-10-14-commerce.5'}
    facts = fact_catalog(p.input['brief'])
    node = 'ECOMMERCE_MOTIVATION'
    saved = p.checkpoints.get((node, ''), {})
    if saved.get('status') == 'SUCCEEDED':
        development = CommerceDevelopment.model_validate(saved['output'])
    else:
        development = await checked_model(p, node, 'development', CommerceDevelopment,
            {'candidateCount': 6, 'factCatalog': facts, 'existingTitles': [c['name'] for c in p.input['existingConcepts']]}, develop_instruction,
            dict(saved.get('output') or {}), lambda v: validate_development(v, facts), detail=compact_development)
        await p.step(node, '', 'SUCCEEDED', development.model_dump())
    validate_development(development, facts)
    node = 'ECOMMERCE_CONCEPT'
    saved = p.checkpoints.get((node, ''), {})
    partial = dict(saved.get('output') or {})
    if saved.get('status') == 'SUCCEEDED':
        development = CommerceDevelopment.model_validate(partial.get('redevelopment') or development.model_dump())
        validate_development(development, facts)
        selection = CommerceSelection.model_validate({k: v for k, v in partial.items() if k in CommerceSelection.model_fields})
    elif development.readiness.status == 'NEEDS_INFORMATION':
        selection = CommerceSelection(status='NEEDS_INFORMATION', reason=development.readiness.reason,
            missing=development.readiness.missing, evaluations=[], choices=[])
    else:
        if partial.get('exhausted'):
            raise ValueError('commerce redevelopment budget exhausted')
        for index in range(2):
            if index:
                development = await checked_model(p, node, 'redevelopmentResult', CommerceDevelopment,
                    {'candidateCount': 6, 'factCatalog': facts, 'rejectedSelection': selection.model_dump(), 'previousDevelopment': development.model_dump()},
                    develop_instruction, partial, lambda v: validate_development(v, facts), detail=compact_development)
                partial['redevelopment'] = development.model_dump()
                await p.step(node, '', 'RUNNING', partial)
            selection = await checked_model(p, node, 'selection' if not index else 'secondSelection', CommerceSelection,
                {'auditRole': 'COMMERCE_SELECTION', 'development': development.model_dump(), 'factCatalog': facts,
                    'scriptIds': p.input['scriptIds'], 'selectionCount': len(p.input['scriptIds']),
                    'existingConcepts': [{k: c[k] for k in ('name', 'synopsis') if k in c} for c in p.input['existingConcepts']]},
                select_instruction, partial, lambda v: validate_selection(v, development, p.input['scriptIds']))
            if selection.status != 'REWORK':
                break
            if index:
                partial['exhausted'] = True
                await p.step(node, '', 'FAILED', partial, '候选演示仍未形成有依据的购买理由，已保留取舍依据。')
                raise ValueError('commerce redevelopment budget exhausted')
    validate_selection(selection, development, p.input['scriptIds'])
    concepts = [concept_for(next(o for o in development.opportunities if o.id == c.opportunityId), c.scriptId) for c in selection.choices]
    readiness = Readiness(status='READY' if selection.status == 'READY' else 'NEEDS_INFORMATION', reason=selection.reason, missing=selection.missing)
    final = {**selection.model_dump(), 'readiness': readiness.model_dump(), 'concepts': [c.model_dump() for c in concepts]}
    if 'redevelopment' in partial:
        final['redevelopment'] = partial['redevelopment']
        final['initialSelection'] = partial.get('initialSelection') or partial['selection']['value']
    if saved.get('status') != 'SUCCEEDED':
        await p.step(node, '', 'SUCCEEDED', final)
    p.commerce_commitments = {c.scriptId: {**c.model_dump(), 'opportunity': next(o.model_dump() for o in development.opportunities if o.id == c.opportunityId)} for c in selection.choices}
    return TypedConcepts(readiness=readiness, concepts=concepts)
