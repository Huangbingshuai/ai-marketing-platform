"""Resumable presenter recommendation development and independent selection."""
from __future__ import annotations
from typing import Annotated, Any, Generic, Self, TypeVar, TYPE_CHECKING
from pydantic import Field, model_validator
from .models import Model
from .typed_creation import Readiness, TypedConcepts
from .commerce_development import (
    Short, CommerceOpportunity, CommerceDevelopment, CommerceSelection,
    checked_model, validate_development, validate_selection, concept_for,
)
from .brand_development import fact_catalog

if TYPE_CHECKING:
    from .pipeline import Pipeline

T = TypeVar('T', bound=Model)


class Opportunity(CommerceOpportunity, Generic[T]):
    creativeIdea: Short
    approach: T


class Development(Model, Generic[T]):
    readiness: Readiness
    opportunities: Annotated[list[Opportunity[T]], Field(max_length=6)]

    @model_validator(mode='after')
    def valid(self) -> Self:
        if self.readiness.status == 'READY':
            if len(self.opportunities) != 6 or self.readiness.missing:
                raise ValueError('ready commerce planning requires six opportunities')
        elif self.opportunities or not self.readiness.missing:
            raise ValueError('missing information cannot produce opportunities')
        return self


DEVELOP_CORE = """联合开发恰好6份本类型短方案，只创作人物直接向观众推荐的口播，不改成纯旁白静物、剧情带货或促销。每个短字段一两句，优先80字内。readiness判断资料依据，足够则READY、missing为空；只有缺决定性产品/活动依据才NEEDS_INFORMATION、给具体missing、opportunities为空，创意普通不算缺资料。
每份写清具体受众处境audienceSituation、situationBasis（资料明确BRIEF，否则CREATIVE_HYPOTHESIS，不冒充受众调研）、真实购买理由buyingReason、买前疑问purchaseQuestion、准确factIds。demonstration写起点setup、产品参与action、可看见或听懂的observableResult和不可外推的claimBoundary；progression写推进，ending回应需要。creativeIdea必须是具体吸引点、发展方式及实际兑现，不能只是“高级/创新”标签。参考时长指导聚焦，不堆全部卖点。
同类型六份改变购买角度、讲述关系、观察或创意机制，不只换标题人名地点。已有稿仅避重，弱稿不是范本；被拒后针对共同问题替代整组。允许直接解释真实依据，不强制每个卖点做实验或剧情反转。不能编造优惠、价格、认证、测试、竞品、用户证言、功效或外部能力。适用于食品、护肤、硬件、家居和软件，不根据品类套固定创意。暂不写长稿或分镜。"""
SELECT_CORE = """独立评估全部候选，选择selectionCount份，scriptIds各绑定一次，不重写原方案或长稿。购买理由、具体创意和本类型安排都须有实际可执行内容，不能因事实正确或标题好听放行。比较与已有稿及本次其他选择的实质区别，不只换人名地点。每份mustPreserve列2至4条正文必须兑现的创意行为、讲述关系、观察与边界。
成熟案足量才READY、missing为空；不足REWORK且choices为空，只有缺决定性事实才NEEDS_INFORMATION并missing。每个机会给ADVANCE/REJECT和具体原因，不为凑数量硬选。不能要求全部卖点入稿或虚构实测来增强说服力。"""
WRITE_CORE = """按选中的本类型策略和commerceCommitment创作完整正文，兑现具体创意与mustPreserve。自然篇章、完整可说出口的对白/口播及其对应实际画面，不列镜头表、不只写意图。创意要在正文发生，不停留在标题；产品参与支撑真实购买需要，不套人生道理。画面、口播和短文字互补，避免重复动作解说和全参数罗列。
允许设计讲述者及情境，不冒充真实用户亲测、专家背书、销量或购买经历。不得编造价格优惠、竞品、功效、认证和未知能力。按品牌与受众组织自然语言，不强制模板叫卖。按实际对白、动作、停顿和阅读估时，参考时长软约束，先取舍无关内容，不用空停顿或大量加秒逃避聚焦。修订保留所选类型、有效创意和未受影响段落，只解决实质问题。"""



async def develop(p: Pipeline) -> TypedConcepts:
    from .routes import strategy_for
    strategy = strategy_for('ECOMMERCE', p.input['strategyVersions']['concept'])
    schema: type[Development[Any]] = strategy.DEVELOPMENT
    facts = fact_catalog(p.input['brief'])

    def check(value: Development[Any]) -> None:
        base = CommerceDevelopment.model_validate({'readiness': value.readiness.model_dump(),
            'opportunities': [o.model_dump(exclude={'creativeIdea', 'approach'}) for o in value.opportunities]})
        validate_development(base, facts)
        if any(not o.creativeIdea.strip() or any(not v.strip() for v in o.approach.model_dump().values()) for o in value.opportunities):
            raise ValueError('commerce strategy text is empty')

    motivation, concept = 'ECOMMERCE_MOTIVATION', 'ECOMMERCE_CONCEPT'
    saved = p.checkpoints.get((motivation, ''), {})
    context = {'candidateCount': 6, 'factCatalog': facts,
        'existingTitles': [v['name'] for v in p.input['existingConcepts']]}
    if saved.get('status') == 'SUCCEEDED':
        development = schema.model_validate(saved['output'])
    else:
        development = await checked_model(p, motivation, 'development', schema, context,
            strategy.DEVELOP, dict(saved.get('output') or {}), check, detail=True)
        await p.step(motivation, '', 'SUCCEEDED', development.model_dump())
    check(development)
    saved = p.checkpoints.get((concept, ''), {})
    partial = dict(saved.get('output') or {})
    if saved.get('status') == 'SUCCEEDED':
        development = schema.model_validate(partial.get('redevelopment') or development.model_dump())
        check(development)
        selection = CommerceSelection.model_validate({k: v for k, v in partial.items() if k in CommerceSelection.model_fields})
    elif development.readiness.status == 'NEEDS_INFORMATION':
        selection = CommerceSelection(status='NEEDS_INFORMATION', reason=development.readiness.reason,
            missing=development.readiness.missing, evaluations=[], choices=[])
    else:
        if partial.get('exhausted'):
            raise ValueError('commerce redevelopment budget exhausted')
        for attempt in range(2):
            if attempt:
                development = await checked_model(p, concept, 'redevelopmentResult', schema,
                    {**context, 'rejectedSelection': selection.model_dump(), 'previousDevelopment': development.model_dump()},
                    strategy.DEVELOP, partial, check, detail=True)
                partial['redevelopment'] = development.model_dump()
                await p.step(concept, '', 'RUNNING', partial)
            selection = await checked_model(p, concept, 'selection' if not attempt else 'secondSelection', CommerceSelection,
                {'auditRole': 'COMMERCE_SELECTION', 'development': development.model_dump(),
                    'factCatalog': facts, 'scriptIds': p.input['scriptIds'], 'selectionCount': len(p.input['scriptIds']),
                    'existingConcepts': p.input['existingConcepts']}, strategy.SELECT, partial,
                lambda v: validate_selection(v, development, p.input['scriptIds']))
            if selection.status != 'REWORK':
                break
            if attempt:
                partial['exhausted'] = True
                await p.step(concept, '', 'FAILED', partial, '候选仍未达到本类型创作要求，已保留取舍依据。')
                raise ValueError('commerce redevelopment budget exhausted')
    validate_selection(selection, development, p.input['scriptIds'])
    concepts = [concept_for(next(o for o in development.opportunities if o.id == c.opportunityId), c.scriptId) for c in selection.choices]
    readiness = Readiness(status='READY' if selection.status == 'READY' else 'NEEDS_INFORMATION', reason=selection.reason, missing=selection.missing)
    final = {**selection.model_dump(), 'readiness': readiness.model_dump(), 'concepts': [v.model_dump() for v in concepts]}
    if 'redevelopment' in partial:
        final.update(redevelopment=partial['redevelopment'], initialSelection=partial['selection']['value'])
    if saved.get('status') != 'SUCCEEDED':
        await p.step(concept, '', 'SUCCEEDED', final)
    p.commerce_commitments = {c.scriptId: {**c.model_dump(), 'opportunity': next(o.model_dump() for o in development.opportunities if o.id == c.opportunityId)} for c in selection.choices}
    return TypedConcepts(readiness=readiness, concepts=concepts)
