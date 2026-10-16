"""Short drama premises and independent selection, without user-facing subtypes."""
from __future__ import annotations
from typing import Annotated, Any, Literal, Self, TYPE_CHECKING
from pydantic import Field, model_validator
from .models import Model, Id
from .typed_creation import DramaPlan, Readiness, TypedConcept, TypedConcepts
from .brand_development import fact_catalog
from .development_runtime import checked_model
if TYPE_CHECKING:
    from .pipeline import Pipeline

Short = Annotated[str, Field(min_length=1, max_length=240)]


class DramaticPlan(DramaPlan):
    desire: Short
    obstacle: Short
    relationships: Short
    trigger: Short
    escalation: Short
    choice: Short
    consequence: Short
    productCausality: Short


class DramaIdea(Model):
    id: Id
    name: Id
    devices: Annotated[list[Short], Field(min_length=1, max_length=3)]
    plan: DramaticPlan
    viewingPromise: Short
    informationDesign: Short
    dialogueIntent: Short
    emotionalMovement: Short
    factIds: Annotated[list[Id], Field(min_length=1, max_length=30)]
    weakness: Short


class DramaDevelopment(Model):
    readiness: Readiness
    ideas: Annotated[list[DramaIdea], Field(max_length=7)]

    @model_validator(mode='after')
    def valid(self) -> Self:
        if self.readiness.status == 'READY':
            if not 3 <= len(self.ideas) <= 7 or self.readiness.missing:
                raise ValueError('ready drama development requires alternatives')
        elif self.ideas or not self.readiness.missing:
            raise ValueError('missing drama information requires explicit gaps')
        return self


class PremiseFirstDramaDevelopment(DramaDevelopment):
    """Same validated business data; only new strategies ask for the premise first."""

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
        schema = super().model_json_schema(*args, **kwargs)
        idea = schema['$defs']['DramaIdea']
        order = ('id', 'name', 'viewingPromise', 'informationDesign', 'emotionalMovement',
                 'weakness', 'devices', 'dialogueIntent', 'factIds', 'plan')
        idea['properties'] = {key: idea['properties'][key] for key in order}
        idea['required'] = list(order)
        return schema


class DramaEvaluation(Model):
    ideaId: Id
    verdict: Literal['ADVANCE', 'REJECT']
    reason: Short


class DramaChoice(Model):
    scriptId: Id
    ideaId: Id
    mustPreserve: Annotated[list[Short], Field(min_length=2, max_length=4)]


class DramaSelection(Model):
    status: Literal['READY', 'REWORK', 'NEEDS_INFORMATION']
    reason: Short
    missing: Annotated[list[Id], Field(max_length=20)]
    evaluations: Annotated[list[DramaEvaluation], Field(max_length=7)]
    choices: Annotated[list[DramaChoice], Field(max_length=5)]


def validate_development(value: DramaDevelopment, facts: list[dict[str,str]], count: int) -> None:
    if not value.readiness.reason.strip() or any(not v.strip() for v in value.readiness.missing):
        raise ValueError('drama readiness text is empty')
    if value.readiness.status == 'NEEDS_INFORMATION':
        return
    if len(value.ideas) != count or len({i.id for i in value.ideas}) != count or len({i.name for i in value.ideas}) != count:
        raise ValueError('drama candidate identity or count mismatch')
    known = {f['id'] for f in facts}
    for idea in value.ideas:
        texts = [idea.id,idea.name,idea.viewingPromise,idea.informationDesign,idea.dialogueIntent,
            idea.emotionalMovement,idea.weakness,*idea.devices,*idea.plan.model_dump().values()]
        if any(not t.strip() for t in texts) or any(ref not in known for ref in idea.factIds):
            raise ValueError('drama plan text or source reference mismatch')


def validate_selection(value: DramaSelection, development: DramaDevelopment, script_ids: list[str]) -> None:
    ids = {i.id for i in development.ideas}
    evaluations = {e.ideaId:e for e in value.evaluations}
    if not value.reason.strip() or any(not m.strip() for m in value.missing) or any(not e.reason.strip() for e in value.evaluations) or set(evaluations) != ids or len(evaluations) != len(value.evaluations):
        raise ValueError('drama evaluation coverage mismatch')
    if value.status != 'READY':
        if value.choices or value.status == 'NEEDS_INFORMATION' and not value.missing:
            raise ValueError('unready drama choice mismatch')
        return
    if development.readiness.status != 'READY' or value.missing or sorted(c.scriptId for c in value.choices) != sorted(script_ids) or len({c.ideaId for c in value.choices}) != len(script_ids):
        raise ValueError('drama selected script identity mismatch')
    if any(c.ideaId not in evaluations or evaluations[c.ideaId].verdict != 'ADVANCE' or any(not s.strip() for s in c.mustPreserve) for c in value.choices):
        raise ValueError('rejected or empty drama commitment')


def concept_for(idea: DramaIdea, script_id: str) -> TypedConcept:
    p = idea.plan
    return TypedConcept.model_validate({'scriptId':script_id,'name':idea.name,
        'synopsis':'\n'.join([p.trigger,p.escalation,p.consequence]),
        'structure':'\n'.join([p.trigger,p.choice,p.consequence]),'productFocus':p.productCausality,
        'difference':'、'.join(idea.devices)+'\n'+idea.informationDesign,'coreIdea':idea.viewingPromise,
        'openingHook':p.trigger,'productRole':p.productCausality,'memoryPoint':p.consequence,'plan':p.model_dump()})


async def develop_drama(p: Pipeline) -> TypedConcepts:
    from .routes import strategy_for
    strategy = strategy_for('DRAMA',p.input['strategyVersions']['concept'])
    development_schema = PremiseFirstDramaDevelopment if getattr(strategy, 'PREMISE_FIRST', False) else DramaDevelopment
    node, count = 'DRAMA_CONCEPT', min(7,len(p.input['scriptIds'])+2)
    facts = fact_catalog(p.input['brief'])
    saved = p.checkpoints.get((node,''),{})
    partial: dict[str,Any] = dict(saved.get('output') or {})
    context = {'candidateCount':count,'factCatalog':facts,'existingTitles':[v['name'] for v in p.input['existingConcepts']]}
    if getattr(strategy, 'DEVELOPMENT_HISTORY', False):
        context['existingConcepts'] = p.input['existingConcepts']
    development_facts = facts
    if hasattr(strategy, 'DEVELOPMENT_BRIEF_FIELDS'):
        context['brief'] = {k:v for k,v in p.input['brief'].items() if k in strategy.DEVELOPMENT_BRIEF_FIELDS}
        development_facts = [f for f in facts if f['field'] in strategy.DEVELOPMENT_FACT_FIELDS]
        context['factCatalog'] = development_facts
    if saved.get('status') == 'SUCCEEDED':
        development = DramaDevelopment.model_validate(partial['development'])
        selection = DramaSelection.model_validate({k:v for k,v in partial.items() if k in DramaSelection.model_fields})
    else:
        if partial.get('exhausted'):
            raise ValueError('drama redevelopment budget exhausted')
        development = await checked_model(p,node,'developmentResult',development_schema,context,strategy.DEVELOP,partial,
            lambda v:validate_development(v,development_facts,count))
        if development.readiness.status == 'NEEDS_INFORMATION':
            selection = DramaSelection(status='NEEDS_INFORMATION',reason=development.readiness.reason[:240],missing=development.readiness.missing,evaluations=[],choices=[])
        else:
            for attempt in range(2):
                if attempt:
                    development = await checked_model(p,node,'redevelopmentResult',development_schema,
                        {**context,'previousDevelopment':development.model_dump(),'rejectedSelection':selection.model_dump()},strategy.DEVELOP,partial,
                        lambda v:validate_development(v,development_facts,count))
                selection = await checked_model(p,node,'selectionResult' if not attempt else 'secondSelectionResult',DramaSelection,
                    {'auditRole':'DRAMA_SELECTION','development':development.model_dump(),'factCatalog':facts,
                        'scriptIds':p.input['scriptIds'],'selectionCount':len(p.input['scriptIds']),'existingConcepts':p.input['existingConcepts']},
                    strategy.SELECT,partial,lambda v:validate_selection(v,development,p.input['scriptIds']))
                if selection.status != 'REWORK':
                    break
                if attempt:
                    partial['exhausted'] = True
                    await p.step(node,'','FAILED',partial,'两组剧情候选仍未达到创作要求，已保留取舍依据。')
                    raise ValueError('drama redevelopment budget exhausted')
    validate_development(development,facts,count)
    validate_selection(selection,development,p.input['scriptIds'])
    concepts = [concept_for(next(i for i in development.ideas if i.id == c.ideaId),c.scriptId) for c in selection.choices]
    readiness = Readiness(status='READY' if selection.status == 'READY' else 'NEEDS_INFORMATION',reason=selection.reason,missing=selection.missing)
    final = {**selection.model_dump(),'development':development.model_dump(),'readiness':readiness.model_dump(),'concepts':[c.model_dump() for c in concepts]}
    if 'redevelopmentResult' in partial:
        final['initialDevelopment'] = partial['developmentResult']['value']
        final['initialSelection'] = partial['selectionResult']['value']
    if saved.get('status') != 'SUCCEEDED':
        await p.step(node,'','SUCCEEDED',final)
    p.drama_commitments = {c.scriptId:{**c.model_dump(),'idea':next(i.model_dump() for i in development.ideas if i.id == c.ideaId)} for c in selection.choices}
    return TypedConcepts(readiness=readiness,concepts=concepts)
