"""Brand-only development, independent selection and resumable creative commitments."""
from __future__ import annotations

from typing import Annotated, Any, Literal, TYPE_CHECKING, Self
from pydantic import Field, model_validator, ValidationError
from ai_runtime.responses import ProviderError
from .models import Model, Id
from .typed_creation import TypedConcepts, TypedConcept, Readiness

if TYPE_CHECKING:
    from .pipeline import Pipeline

Short = Annotated[str, Field(min_length=1, max_length=320)]
ExpressionMode = Literal['LIFE_OBSERVATION', 'PRODUCT_DESIGN', 'VISUAL_EXPRESSION', 'DOCUMENTARY', 'OTHER']


class BrandProposition(Model):
    message: Short
    audienceObservation: Short
    observationBasis: Literal['BRIEF', 'CREATIVE_HYPOTHESIS']
    supportingFactIds: Annotated[list[Id], Field(min_length=1, max_length=30)]
    requiredFactIds: Annotated[list[Id], Field(max_length=30)]
    requiredReason: Short


class BrandIdea(Model):
    id: Id
    name: Id
    approach: ExpressionMode
    viewingHook: Short
    mechanism: Short
    keyImages: Annotated[list[Id], Field(min_length=2, max_length=4)]
    productRole: Short
    factIds: Annotated[list[Id], Field(min_length=1, max_length=30)]
    memory: Short
    risk: Short


class BrandDevelopment(Model):
    proposition: BrandProposition
    ideas: Annotated[list[BrandIdea], Field(min_length=6, max_length=8)]


class BrandEvaluation(Model):
    ideaId: Id
    attraction: Annotated[int, Field(ge=1, le=5)]
    productConnection: Annotated[int, Field(ge=1, le=5)]
    clarity: Annotated[int, Field(ge=1, le=5)]
    distinctiveness: Annotated[int, Field(ge=1, le=5)]
    verdict: Literal['ADVANCE', 'REJECT']
    reason: Short


class BrandCommitment(Model):
    scriptId: Id
    ideaId: Id
    approach: ExpressionMode
    mustPreserve: Annotated[list[Id], Field(min_length=2, max_length=5)]
    essentialFactIds: Annotated[list[Id], Field(min_length=1, max_length=30)]
    reason: Short


class BrandSelection(Model):
    status: Literal['READY', 'REWORK', 'NEEDS_INFORMATION']
    reason: Short
    missing: Annotated[list[Id], Field(max_length=20)]
    evaluations: Annotated[list[BrandEvaluation], Field(min_length=6, max_length=8)]
    concepts: Annotated[list[TypedConcept], Field(max_length=5)]
    commitments: Annotated[list[BrandCommitment], Field(max_length=5)]

    @model_validator(mode='after')
    def decision(self) -> Self:
        if self.status == 'READY':
            if not self.concepts or self.missing or len(self.concepts) != len(self.commitments):
                raise ValueError('ready brand selection is incomplete')
        elif self.concepts or self.commitments or (self.status == 'NEEDS_INFORMATION' and not self.missing):
            raise ValueError('unselected ideas cannot become scripts')
        return self


def fact_catalog(brief: dict[str, Any]) -> list[dict[str, str]]:
    facts: list[dict[str, str]] = []
    for field, value in sorted(brief.items()):
        for text in value if isinstance(value, list) else [value]:
            if isinstance(text, str) and text.strip():
                facts.append({'id': f'F{len(facts)+1:02d}', 'field': field, 'text': text})
    return facts


def validate_development(result: BrandDevelopment, facts: list[dict[str, str]], count: int) -> None:
    known = {f['id'] for f in facts}
    refs = result.proposition.supportingFactIds + result.proposition.requiredFactIds
    refs += [ref for idea in result.ideas for ref in idea.factIds]
    if any(ref not in known for ref in refs) or len(result.ideas) != count or len({i.id for i in result.ideas}) != count:
        raise ValueError('brand development identity or source mismatch')


def validate_selection(result: BrandSelection, development: BrandDevelopment, script_ids: list[str], facts: list[dict[str, str]]) -> None:
    ids = {i.id for i in development.ideas}
    evaluations = {e.ideaId: e for e in result.evaluations}
    if len(evaluations) != len(result.evaluations) or set(evaluations) != ids:
        raise ValueError('brand evaluation coverage mismatch')
    if result.status != 'READY':
        return
    if sorted(c.scriptId for c in result.concepts) != sorted(script_ids) or any(c.plan.videoType != 'BRAND_AD' for c in result.concepts):
        raise ValueError('brand selected script scope mismatch')
    if sorted(c.scriptId for c in result.commitments) != sorted(script_ids) or len({c.ideaId for c in result.commitments}) != len(script_ids):
        raise ValueError('brand selection identity mismatch')
    known = {f['id'] for f in facts}
    for c in result.commitments:
        if c.ideaId not in ids or evaluations[c.ideaId].verdict != 'ADVANCE' or any(ref not in known for ref in c.essentialFactIds):
            raise ValueError('rejected or ungrounded brand idea selected')


DEVELOP = """你负责品牌广告的前期开发，输出传播命题和短创意，暂不写完整脚本。
先从简报判断观众看完最应记住的一件事，message具体清楚，不仅是“高级、从容、有序”。audienceObservation写一个可用的受众观察；非简报明确内容必须标CREATIVE_HYPOTHESIS，不能宣称做过调研。supportingFactIds选真实依据；requiredFactIds仅列简报明确要求必须展示的事实，其余是准确性边界，不是必拍目录。requiredReason说明为何必展示或为何暂无强制项。
生成candidateCount个短创意，分别从生活观察、产品设计与感官、视觉表达、纪实证明等适合当前产品的方式探索；这些是开发角度而非配额。不同点子改变观看机制，不只换标题/人物/地点。每份每个字段尽量40至100字，keyImages只写2至4个关键画面，不展开完整开场发展结尾，不排列全部使用步骤或规格。不要为了凑数给同一个使用流程起不同名字。
产品设计片可以用形态、材质、声音、节奏、构图和重复变化成立，无需剧情反转或隐喻。生活观察可以幽默或安静，人物需自然；纪实证明必须有真实依据。允许美术形式创作，但不虚构产品功能、功效、认证或测试结论。产品不能成为泛泛人生道理的教具。请让观众有值得看的东西，同时看得出为何与本产品有关。
factIds只引用factCatalog已有编号，不补造。已有方案仅作避重，不作为好创意示范。若提供rejectedSelection，重新开发替代整组弱案，不只换措辞。遵守品牌约束与结构要求，正文时长留给下一阶段估算。"""

SELECT = """你是未参与前期开发的独立品牌创意总监。逐个比较全部短创意，再选择本次scriptIds数量的不同成熟方案。
按attraction值得看、productConnection产品参与自然、clarity表达清楚、distinctiveness观看体验与本批及历史有区别给1至5分及具体理由。分数只辅助比较，不用平均分掩盖结构性缺陷；verdict决定是否值得展开。不能因为事实正确、标题好听、首尾闭环就放行普通操作目录，也不能因为没有反转/人物故事而否定成熟产品设计片。
先验证传播命题、受众观察依据标记和requiredFactIds是否确有简报支持。把创作假设当事实、虚构性能或误把全部规格强制上屏的方案应REWORK。真正缺少关键资料才NEEDS_INFORMATION；点子普通属于REWORK，不让用户为系统创意弱补写创作要求。
READY时从ADVANCE中选择足量且机制不同的点子，concepts沿原BrandPlan字段给出精炼可执行的创作计划，每份绑定scriptId。commitments绑定原ideaId，写出2至5条正文必须兑现的画面/表达，以及必要事实引用。不要新增一段与原点子无关的完整功能演示。没有足量成熟点子则REWORK，concepts/commitments为空，明确共同缺陷；不要硬挑最不差的。允许同类品牌共享功能，不要求独占技术，但必须有清楚的产品身份与表达组织。只输出业务评估结论，不输出内部推理。"""


async def develop_brand(p: Pipeline) -> TypedConcepts:
    node = 'BRAND_AD_CONCEPT'
    develop_instruction, select_instruction = DEVELOP, SELECT
    if p.input['strategyVersions']['concept'] in {'2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'}:
        from .brand_development_v2 import DEVELOPMENT_CALIBRATION, SELECTION_CALIBRATION
        develop_instruction += DEVELOPMENT_CALIBRATION
        select_instruction += SELECTION_CALIBRATION
    history = p.input['existingConcepts']
    if p.input['strategyVersions']['concept'] in {'2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'}:
        from .brand_development_v3 import DEVELOP as DEVELOPMENT, SELECT as SELECTION
        develop_instruction += DEVELOPMENT
        select_instruction += SELECTION
        # Preserve every historical concept's actual story; omit repeated metadata, not prose slices.
        history = [{k: c[k] for k in ('name', 'synopsis', 'memoryPoint') if k in c} for c in history]
    lean = p.input['strategyVersions']['concept'] in {'2026-10-14.5', '2026-10-14.6', '2026-10-14.7'}
    if lean:
        from .brand_selection import LeanBrandSelection, expand_selection, INSTRUCTION
        select_instruction = select_instruction.replace('concepts沿原BrandPlan字段给出精炼可执行的创作计划，每份绑定scriptId。', '').replace('concepts/commitments为空', 'commitments为空') + INSTRUCTION
        develop_instruction += '\n本轮只开发新点子。existingTitles仅是历史标题的弱避重线索，完整历史故事由独立择优检查；不要猜测标题背后的故事。每个字段使用一两句清楚的具体画面，避免同一机制在多个字段重复解释。'
    if p.input['strategyVersions']['concept'] in {'2026-10-14.6', '2026-10-14.7'}:
        from .brand_development_v6 import DEVELOP as develop_instruction, SELECT as select_instruction
    if p.input['strategyVersions']['concept'] == '2026-10-14.7':
        from .brand_review_calibration import CREATIVE_STANDARD
        develop_instruction += '\n' + CREATIVE_STANDARD
        select_instruction += '\n' + CREATIVE_STANDARD
    facts = fact_catalog(p.input['brief'])
    count = min(8, max(6, len(p.input['scriptIds']) + 3))
    saved = p.checkpoints.get((node, ''), {})
    if saved.get('status') == 'SUCCEEDED':
        selection = BrandSelection.model_validate({k: v for k, v in saved['output'].items() if k in BrandSelection.model_fields})
        source = saved['output'].get('redevelopment') or p.checkpoints['BRAND_AD_IDEAS', '']['output']
        development = BrandDevelopment.model_validate(source)
        validate_development(development, facts, count)
        validate_selection(selection, development, p.input['scriptIds'], facts)
    else:
        proposition = p.checkpoints.get(('BRAND_AD_PROPOSITION', ''), {})
        if proposition.get('status') == 'SUCCEEDED':
            development = BrandDevelopment.model_validate(proposition['output'])
        else:
            await p.step('BRAND_AD_PROPOSITION', '', 'RUNNING')
            development = await p.model('BRAND_AD_PROPOSITION', BrandDevelopment, {
                'factCatalog': facts, 'candidateCount': count,
                'existingTitles': [c['name'] for c in p.input['existingConcepts']],
                **({'existingConcepts': history} if p.input['strategyVersions']['concept'] in {'2026-10-14.3', '2026-10-14.4'} else {}),
            }, develop_instruction)
            validate_development(development, facts, count)
            # Persist both returned products before exposing the next stage.
            await p.step('BRAND_AD_PROPOSITION', '', 'SUCCEEDED', development.model_dump())
        validate_development(development, facts, count)
        if p.checkpoints.get(('BRAND_AD_IDEAS', ''), {}).get('status') != 'SUCCEEDED':
            await p.step('BRAND_AD_IDEAS', '', 'RUNNING')
            await p.step('BRAND_AD_IDEAS', '', 'SUCCEEDED', development.model_dump())
        partial = dict(saved.get('output') or {})
        if partial.get('exhausted'):
            raise ValueError('brand selection budget exhausted')
        await p.step(node, '', 'RUNNING', partial)
        for round_index in range(2):
            if round_index and 'redevelopment' in partial:
                development = BrandDevelopment.model_validate(partial['redevelopment'])
            decision_key = 'selection' if round_index == 0 else 'secondSelection'
            if decision_key in partial:
                selection = BrandSelection.model_validate(partial[decision_key])
            else:
                selection_context = {
                    'auditRole': 'IDEA_SELECTION', 'development': development.model_dump(), 'factCatalog': facts,
                    'scriptIds': p.input['scriptIds'], 'existingConcepts': history,
                    **({'selectionCount': len(p.input['scriptIds'])} if p.input['strategyVersions']['concept'] in {'2026-10-14.6', '2026-10-14.7'} else {}),
                }
                if lean:
                    correction_key = decision_key + 'Correction'
                    correction = partial.get(correction_key, {})
                    if correction.get('corrected'):
                        decision = LeanBrandSelection.model_validate(correction['corrected'])
                    elif correction.get('invalid'):
                        decision = LeanBrandSelection.model_validate(correction['invalid'])
                    else:
                        decision = await p.model(node, LeanBrandSelection, selection_context, select_instruction)
                    try:
                        selection = expand_selection(decision, development)
                        validate_selection(selection, development, p.input['scriptIds'], facts)
                    except ValueError as error:
                        if correction.get('exhausted'):
                            raise ValueError('brand selection identity correction exhausted')
                        if p.input['strategyVersions']['concept'] not in {'2026-10-14.6', '2026-10-14.7'}:
                            raise
                        # Persist the invalid business response; retries never repurchase the development.
                        validation_code = 'invalid selection record shape' if isinstance(error, ValidationError) else str(error)
                        partial[correction_key] = {'invalid': decision.model_dump(), 'validationCode': validation_code}
                        await p.step(node, '', 'RUNNING', partial)
                        decision = await p.model(node, LeanBrandSelection, {
                            **selection_context, 'previousDecision': decision.model_dump(),
                            'validationError': validation_code,
                        }, select_instruction + '\n仅修正身份、覆盖和决策结构：完整覆盖原ideaId，每个一次；READY的scriptId与输入完全对应且只选ADVANCE，引用已有factId；REWORK/NEEDS_INFORMATION的commitments为空，NEEDS_INFORMATION必须有missing。保留实质评价，不把拒绝改通过，不重新创作点子。')
                        partial[correction_key]['exhausted'] = True
                        partial[correction_key]['corrected'] = decision.model_dump()
                        await p.step(node, '', 'RUNNING', partial)
                        selection = expand_selection(decision, development)
                        validate_selection(selection, development, p.input['scriptIds'], facts)
                else:
                    selection = await p.model(node, BrandSelection, selection_context, select_instruction)
                validate_selection(selection, development, p.input['scriptIds'], facts)
                partial[decision_key] = selection.model_dump()
                await p.step(node, '', 'RUNNING', partial)
            validate_selection(selection, development, p.input['scriptIds'], facts)
            if selection.status != 'REWORK':
                break
            if round_index:
                partial['exhausted'] = True
                await p.step(node, '', 'FAILED', partial, '短创意仍未达到展开要求，已保留取舍依据，本次未生成脚本。')
                raise ValueError('brand selection budget exhausted')
            if 'redevelopment' not in partial:
                partial['redevelopmentStarted'] = True
                await p.step(node, '', 'RUNNING', partial)
                try:
                    development = await p.model(node, BrandDevelopment, {
                        'factCatalog': facts, 'candidateCount': count, 'rejectedSelection': selection.model_dump(),
                        'previousDevelopment': development.model_dump(),
                    }, develop_instruction)
                    validate_development(development, facts, count)
                except ProviderError as error:
                    if not error.retryable:
                        partial['exhausted'] = True
                        await p.step(node, '', 'FAILED', partial, '替代创意开发未完整完成，已保留已有结果。')
                    raise
                partial['redevelopment'] = development.model_dump()
                await p.step(node, '', 'RUNNING', partial)
        final = selection.model_dump()
        final['readiness'] = {'status': 'READY' if selection.status == 'READY' else 'NEEDS_INFORMATION', 'reason': selection.reason, 'missing': selection.missing}
        if 'redevelopment' in partial:
            final['redevelopment'] = partial['redevelopment']
            final['initialSelection'] = partial['selection']
        await p.step(node, '', 'SUCCEEDED', final)
    p.context['brandProposition'] = development.proposition.model_dump()
    p.context['brandFactCatalog'] = facts
    p.brand_commitments = {c.scriptId: c.model_dump() for c in selection.commitments}
    return TypedConcepts(readiness=Readiness(status='READY' if selection.status == 'READY' else 'NEEDS_INFORMATION', reason=selection.reason, missing=selection.missing), concepts=selection.concepts)
