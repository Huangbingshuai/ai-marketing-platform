"""Resolve AI-selected source references without asking a model to recopy prose."""
from typing import Annotated, Any, Literal
from pydantic import Field
from .models import Model, Text
from .typed_creation import TypedFinding, TypedStory, TypedReviewV4, QualityCriterion


class EvidenceDecision(Model):
    criterion: QualityCriterion
    evidenceId: Text
    reason: Text
    suggestion: Text
    verdict: Literal['PASS', 'FAIL', 'NOT_APPLICABLE']


class EvidenceReview(Model):
    summary: Text
    findings: Annotated[list[TypedFinding], Field(max_length=1000)]
    routeId: Literal['ECOMMERCE', 'LOCAL_STORE', 'BRAND_AD', 'DRAMA']
    qualityChecks: Annotated[list[EvidenceDecision], Field(min_length=3, max_length=3)]


def evidence_context(story: TypedStory) -> tuple[dict[str, Any], dict[str, tuple[str, str]]]:
    context = story.model_dump(exclude={'content', 'beats'})
    sources: dict[str, tuple[str, str]] = {}
    beats = []
    for beat in story.beats:
        heading, _, body = beat.content.partition('\n\n')
        excerpts = []
        for index, paragraph in enumerate(body.split('\n\n'), 1):
            if not paragraph.strip():
                continue
            key = f'{beat.id}:E{index:02d}'
            sources[key] = (beat.id, paragraph)
            excerpts.append({'id': key, 'text': paragraph})
        beats.append({'id': beat.id, 'heading': heading, 'durationSeconds': beat.durationSeconds, 'excerpts': excerpts})
    context['beats'] = beats
    return context, sources


def resolve_evidence(review: EvidenceReview, sources: dict[str, tuple[str, str]]) -> TypedReviewV4:
    data = review.model_dump(exclude={'qualityChecks'})
    checks = []
    for check in review.qualityChecks:
        if check.verdict == 'NOT_APPLICABLE':
            if check.evidenceId:
                raise ValueError('inapplicable quality check must not cite evidence')
            beat_ids, evidence = [], ''
        else:
            if check.evidenceId not in sources:
                raise ValueError('quality check references unknown evidence')
            beat_id, evidence = sources[check.evidenceId]
            beat_ids = [beat_id]
        checks.append({**check.model_dump(exclude={'evidenceId'}), 'beatIds': beat_ids, 'evidence': evidence})
    return TypedReviewV4.model_validate({**data, 'qualityChecks': checks})


EVIDENCE_INSTRUCTION = """当前正文按篇章列出excerpts，text是原始正文，没有删减。qualityChecks不用抄写引文或填写beatIds：每项选择最能支持判断的一条真实evidenceId（例如P02:E01），系统会原样展示其正文作为依据；引用对象名、篇章名或不存在编号无效。仍须阅读全部正文，选一条证据不代表只评这一段。仅无对白时NATURAL_DIALOGUE可NOT_APPLICABLE，evidenceId为空。先选择证据、说明具体理由，最后给verdict；实质问题不能为通过格式校验而消失。"""
