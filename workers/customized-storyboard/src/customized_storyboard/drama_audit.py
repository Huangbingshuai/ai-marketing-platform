"""AI diagnoses the narrative mechanism; code preserves its structural verdicts."""
from typing import Annotated, Any, Literal, Self
from pydantic import Field, model_validator
from .models import Model, Id, Text
from .review_calibration import EditorialReview, resolve_observations
from .typed_creation import TypedReviewV4

Diagnosis = Annotated[str, Field(min_length=1, max_length=500)]
Edit = Annotated[str, Field(max_length=500)]


class DramaMechanism(Model):
    mainLine: Diagnosis
    dialogueMode: Literal['DRAMATIC_EXCHANGE', 'EXPOSITORY_SPINE', 'NO_DIALOGUE']
    dialogueEvidenceIds: Annotated[list[Id], Field(max_length=6)]
    dialogueReason: Diagnosis
    dialogueRevision: Edit
    endingMode: Literal['DEVELOPED_PAYOFF', 'EMOTIONAL_COVER', 'OPEN_OR_UNRESOLVED']
    endingSetupEvidenceId: Text
    endingEvidenceId: Id
    endingReason: Diagnosis
    endingRevision: Edit


class DramaEditorialReview(EditorialReview):
    mechanism: DramaMechanism

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
        schema = super().model_json_schema(*args, **kwargs)
        order = ('routeId', 'mechanism', 'qualityChecks', 'findings', 'summary')
        keys = (*order, *(key for key in schema['properties'] if key not in order))
        schema['properties'] = {key: schema['properties'][key] for key in keys}
        schema['required'] = list(keys)
        return schema


def resolve_drama_audit(review: DramaEditorialReview, sources: dict[str, tuple[str, str]]) -> TypedReviewV4:
    if review.routeId != 'DRAMA':
        raise ValueError('drama mechanism route mismatch')
    mechanism = review.mechanism
    citations = [*mechanism.dialogueEvidenceIds, mechanism.endingEvidenceId]
    if mechanism.endingSetupEvidenceId:
        citations.append(mechanism.endingSetupEvidenceId)
    if any(ref not in sources for ref in citations):
        raise ValueError('drama mechanism references unknown evidence')
    if len(set(mechanism.dialogueEvidenceIds)) != len(mechanism.dialogueEvidenceIds):
        raise ValueError('drama mechanism has duplicate evidence')
    if mechanism.dialogueMode != 'NO_DIALOGUE' and not mechanism.dialogueEvidenceIds:
        raise ValueError('drama dialogue diagnosis needs evidence')
    if mechanism.endingMode == 'DEVELOPED_PAYOFF' and not mechanism.endingSetupEvidenceId:
        raise ValueError('drama ending payoff needs setup evidence')
    if mechanism.dialogueMode == 'EXPOSITORY_SPINE' and not mechanism.dialogueRevision.strip():
        raise ValueError('drama lecture diagnosis needs correction')
    if mechanism.endingMode == 'EMOTIONAL_COVER' and not mechanism.endingRevision.strip():
        raise ValueError('drama ending diagnosis needs correction')

    # Public DTO remains unchanged. Never promote an existing FAIL from the other checks.
    result = resolve_observations(EditorialReview.model_validate(review.model_dump(exclude={'mechanism'})), sources)
    natural = result.qualityChecks[1]
    if (mechanism.dialogueMode == 'NO_DIALOGUE') != (natural.verdict == 'NOT_APPLICABLE'):
        raise ValueError('drama dialogue absence decisions conflict')
    if mechanism.dialogueMode == 'EXPOSITORY_SPINE':
        refs = mechanism.dialogueEvidenceIds
        natural.verdict = 'FAIL'
        natural.beatIds = list(dict.fromkeys(sources[ref][0] for ref in refs))
        natural.evidence = sources[refs[0]][1]
        natural.reason = '正文主线：' + mechanism.mainLine + '\n对白机制：' + mechanism.dialogueReason
        natural.suggestion = mechanism.dialogueRevision
    if mechanism.endingMode == 'EMOTIONAL_COVER':
        cause = result.qualityChecks[0]
        refs = [ref for ref in (mechanism.endingSetupEvidenceId, mechanism.endingEvidenceId) if ref]
        cause.verdict = 'FAIL'
        cause.beatIds = list(dict.fromkeys(sources[ref][0] for ref in refs))
        cause.evidence = sources[mechanism.endingEvidenceId][1]
        cause.reason = '正文主线：' + mechanism.mainLine + '\n收束机制：' + mechanism.endingReason
        cause.suggestion = mechanism.endingRevision
    result.summary = ('正文主线：' + mechanism.mainLine + '\n对白机制：' + mechanism.dialogueReason +
                      '\n收束机制：' + mechanism.endingReason + '\n结论：' +
                      ('存在实质创作问题，需要定向修订。' if any(q.verdict == 'FAIL' for q in result.qualityChecks) or
                       any(f.severity == 'ERROR' for f in result.findings) else '未发现实质创作缺陷。'))
    # Re-run mechanical validation after projecting the model's structural diagnoses.
    return TypedReviewV4.model_validate(result.model_dump())


class DramaViewingValue(Model):
    viewingEvent: Diagnosis
    classification: Literal['DRAMA_DRIVEN', 'EXPLANATION_WITH_PLOT_WRAP']
    evidenceId: Id
    reason: Diagnosis
    revision: Edit


class DramaMeritReview(DramaEditorialReview):
    viewingValue: DramaViewingValue

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
        schema = super().model_json_schema(*args, **kwargs)
        order = ('routeId', 'viewingValue', 'mechanism', 'qualityChecks', 'findings', 'summary')
        schema['properties'] = {key: schema['properties'][key] for key in order}
        schema['required'] = list(order)
        return schema


def resolve_drama_merit(review: DramaMeritReview, sources: dict[str, tuple[str, str]]) -> TypedReviewV4:
    merit = review.viewingValue
    if merit.evidenceId not in sources:
        raise ValueError('drama viewing value references unknown evidence')
    if merit.classification == 'EXPLANATION_WITH_PLOT_WRAP' and not merit.revision.strip():
        raise ValueError('drama viewing value needs correction')
    result = resolve_drama_audit(DramaEditorialReview.model_validate(review.model_dump(exclude={'viewingValue'})), sources)
    if merit.classification == 'EXPLANATION_WITH_PLOT_WRAP':
        cause = result.qualityChecks[0]
        if cause.verdict != 'FAIL':
            cause.evidence = sources[merit.evidenceId][1]
        cause.verdict = 'FAIL'
        cause.beatIds = list(dict.fromkeys([*cause.beatIds, sources[merit.evidenceId][0]]))
        cause.reason += '\n观看体验：' + merit.viewingEvent + '\n创作质量：' + merit.reason
        cause.suggestion = '\n'.join(v for v in (cause.suggestion, merit.revision) if v)
    result.summary = ('观看体验：' + merit.viewingEvent + '\n创作质量：' + merit.reason + '\n' +
                      result.summary.rsplit('\n结论：', 1)[0] + '\n结论：' +
                      ('存在实质创作问题，需要定向修订。' if any(q.verdict == 'FAIL' for q in result.qualityChecks) or
                       any(f.severity == 'ERROR' for f in result.findings) else '未发现实质创作缺陷。'))
    return TypedReviewV4.model_validate(result.model_dump())


def scoped_drama_merit(evidence_ids: list[str]) -> type[DramaMeritReview]:
    """Constrain provider citations to this body; never guess a semantic reference."""
    allowed = frozenset(evidence_ids)
    if not allowed:
        raise ValueError('drama merit requires body evidence')

    class ScopedDramaMeritReview(DramaMeritReview):
        @classmethod
        def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
            schema = super().model_json_schema(*args, **kwargs)
            definitions = schema['$defs']
            definitions['DramaViewingValue']['properties']['evidenceId']['enum'] = sorted(allowed)
            mechanism = definitions['DramaMechanism']['properties']
            mechanism['dialogueEvidenceIds']['items']['enum'] = sorted(allowed)
            mechanism['endingSetupEvidenceId']['enum'] = ['', *sorted(allowed)]
            mechanism['endingEvidenceId']['enum'] = sorted(allowed)
            definitions['ObservedDecision']['properties']['evidenceId']['enum'] = ['', *sorted(allowed)]
            return schema

        @model_validator(mode='after')
        def known_evidence(self) -> Self:
            refs = [self.viewingValue.evidenceId, *self.mechanism.dialogueEvidenceIds,
                    self.mechanism.endingEvidenceId]
            refs.extend(ref for ref in [self.mechanism.endingSetupEvidenceId,
                                       *(q.evidenceId for q in self.qualityChecks)] if ref)
            if any(ref not in allowed for ref in refs):
                raise ValueError('drama merit references unknown evidence')
            return self

    return ScopedDramaMeritReview
