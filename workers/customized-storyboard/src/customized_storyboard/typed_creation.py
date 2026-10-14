"""Typed creation graph. Historical pipelines retain their original checkpoints."""
from __future__ import annotations

import asyncio
import logging
from typing import Annotated, Any, Literal, TYPE_CHECKING, Self
from pydantic import Field, model_validator, ValidationError
from ai_runtime.http import InternalApiError
from ai_runtime.responses import ProviderError, ProviderErrorType
from .models import Model, Concept, Story, Finding, Text, Id, Seconds
from .screenplay import ScreenplayDraft, review_context
from .video_script import video_script_issues
from .routes import STRATEGIES, VERSION, COMMERCE_VERSIONS, PRESENTER_VERSIONS, DRAMA_VERSIONS, strategy_for

if TYPE_CHECKING:
    from .pipeline import Pipeline


class EcommercePlan(Model):
    videoType: Literal['ECOMMERCE']
    buyingReason: Text
    audienceSituation: Text
    demonstration: Text
    progression: Text
    ending: Text


class LocalStorePlan(Model):
    videoType: Literal['LOCAL_STORE']
    visitReason: Text
    venueEvidence: Text
    experiencePath: Text
    serviceValue: Text
    ending: Text


class BrandPlan(Model):
    videoType: Literal['BRAND_AD']
    brandImpression: Text
    visualConcept: Text
    visualProgression: Text
    productConnection: Text
    ending: Text


class DramaPlan(Model):
    videoType: Literal['DRAMA']
    desire: Text
    obstacle: Text
    relationships: Text
    trigger: Text
    escalation: Text
    choice: Text
    consequence: Text
    productCausality: Text


class TypedConcept(Concept):
    plan: Annotated[EcommercePlan | LocalStorePlan | BrandPlan | DramaPlan, Field(discriminator='videoType')]


class Readiness(Model):
    status: Literal['READY', 'NEEDS_INFORMATION']
    reason: Text
    missing: Annotated[list[Id], Field(max_length=20)]


class TypedConcepts(Model):
    readiness: Readiness
    concepts: Annotated[list[TypedConcept], Field(max_length=5)]

    @model_validator(mode='after')
    def valid(self) -> Self:
        if self.readiness.status == 'NEEDS_INFORMATION':
            if self.concepts or not self.readiness.missing:
                raise ValueError('missing information requires explicit gaps and no invented concepts')
        elif not self.concepts or self.readiness.missing:
            raise ValueError('ready planning requires concepts and no unresolved gaps')
        for concept in self.concepts:
            if not all(getattr(concept, k).strip() for k in ('coreIdea', 'openingHook', 'productRole', 'memoryPoint')) or not all(v.strip() for v in concept.plan.model_dump().values()):
                raise ValueError('creative plan is incomplete')
        return self


class StructureMapping(Model):
    requirementId: Id
    beatIds: Annotated[list[Id], Field(min_length=1, max_length=60)]
    evidence: Id


class TypedStory(Story):
    structureMapping: Annotated[list[StructureMapping], Field(max_length=20)]


class TypedDraft(ScreenplayDraft):
    structureMapping: Annotated[list[StructureMapping], Field(max_length=20)]

    def story(self) -> TypedStory:
        return TypedStory(content='\n\n'.join(b.content.strip() for b in self.beats), **self.model_dump())


class TypedFinding(Finding):
    beatIds: Annotated[list[Id], Field(max_length=60)]


class TypedReview(Model):
    summary: Text
    findings: Annotated[list[TypedFinding], Field(max_length=1000)]


QUALITY_CRITERIA = {
    'ECOMMERCE': ('BUYING_REASON', 'VALUE_DEMONSTRATION', 'INFORMATION_CAPACITY'),
    'LOCAL_STORE': ('VENUE_EVIDENCE', 'VISIT_EXPERIENCE', 'TRUSTWORTHY_DETAIL'),
    'BRAND_AD': ('VISIBLE_CONCEPT', 'VISUAL_PROGRESSION', 'BRAND_MEMORY'),
    'DRAMA': ('CHARACTER_CAUSALITY', 'NATURAL_DIALOGUE', 'PRODUCT_CAUSALITY'),
}


QualityCriterion = Literal['BUYING_REASON', 'VALUE_DEMONSTRATION', 'INFORMATION_CAPACITY',
        'VENUE_EVIDENCE', 'VISIT_EXPERIENCE', 'TRUSTWORTHY_DETAIL',
        'VISIBLE_CONCEPT', 'VISUAL_PROGRESSION', 'BRAND_MEMORY',
        'CHARACTER_CAUSALITY', 'NATURAL_DIALOGUE', 'PRODUCT_CAUSALITY']


class QualityCheck(Model):
    criterion: QualityCriterion
    beatIds: Annotated[list[Id], Field(max_length=60)]
    evidence: Text
    reason: Text
    suggestion: Text
    verdict: Literal['PASS', 'FAIL', 'NOT_APPLICABLE']


class TypedReviewV4(TypedReview):
    routeId: Literal['ECOMMERCE', 'LOCAL_STORE', 'BRAND_AD', 'DRAMA']
    qualityChecks: Annotated[list[QualityCheck], Field(min_length=3, max_length=3)]

    @model_validator(mode='after')
    def valid_quality(self) -> Self:
        if tuple(c.criterion for c in self.qualityChecks) != QUALITY_CRITERIA[self.routeId]:
            raise ValueError('quality checks must follow the selected route')
        if any(c.verdict == 'NOT_APPLICABLE' and c.criterion != 'NATURAL_DIALOGUE' for c in self.qualityChecks):
            raise ValueError('only absent dialogue can be inapplicable')
        for check in self.qualityChecks:
            if check.verdict != 'NOT_APPLICABLE' and (not check.beatIds or len(check.evidence.strip()) < 8 or not check.reason.strip()):
                raise ValueError('quality check needs actual body evidence')
            if check.verdict == 'FAIL' and not check.suggestion.strip():
                raise ValueError('failed quality check needs directed correction')
        return self


class TypedRevision(Model):
    story: TypedDraft
    concept: TypedConcept


class BodyReplacement(Model):
    beatId: Id
    content: Text
    durationSeconds: Seconds
    reason: Id


class BodyMetadata(Model):
    field: Literal['title', 'opening', 'development', 'ending', 'dialoguePlan']
    value: Text


class TypedPatch(Model):
    reason: Id
    replacements: Annotated[list[BodyReplacement], Field(min_length=1, max_length=60)]
    metadata: Annotated[list[BodyMetadata], Field(max_length=5)]
    concept: TypedConcept
    structureMapping: Annotated[list[StructureMapping], Field(max_length=20)]


def apply_patch(story: TypedStory, patch: TypedPatch, requirements: list[dict[str, str]]) -> tuple[TypedStory, list[dict[str, str]]]:
    """Replace explicitly addressed body units; unaffected text and timing stay byte-identical."""
    ids = [b.id for b in story.beats]
    targets = [r.beatId for r in patch.replacements]
    fields = [m.field for m in patch.metadata]
    if len(set(targets)) != len(targets) or any(t not in ids for t in targets) or len(set(fields)) != len(fields):
        raise ValueError('invalid or duplicate body patch path')
    data = story.model_dump()
    changes: list[dict[str, str]] = []
    for replacement in patch.replacements:
        index = ids.index(replacement.beatId)
        original = story.beats[index]
        data['beats'][index] = {'id': original.id, 'content': replacement.content, 'durationSeconds': replacement.durationSeconds}
        changes.append({'before': original.content, 'after': replacement.content, 'reason': replacement.reason})
    for field in patch.metadata:
        data[field.field] = field.value
    data['structureMapping'] = [m.model_dump() for m in patch.structureMapping]
    data['content'] = '\n\n'.join(b['content'].strip() for b in data['beats'])
    revised = TypedStory.model_validate(data)
    if mapping_issues(revised, requirements):
        raise ValueError('patched body or structure mapping is invalid')
    return revised, changes


FORMAT = """输出完整可读正文，不能输出概述或镜头表。每个beats项是自然篇章或场次，连续id=P01/P02，content为“P01｜具体篇章标题\n\n实际画面、动作、变化，以及需要时的对白、旁白、画面文字和声音”。
不写逐镜景别运镜、图像Prompt或资产目录。辅助字段opening/development/ending/dialoguePlan仅作简短说明，正文只在beats中，不重复另一份content。
structureRequirements约束传播或叙事推进，不是正文标题；一个要求可以跨多个篇章，一个篇章可以体现相邻多个要求。structureMapping按R编号顺序逐项给出beatIds和从其中一段逐字摘取的短证据，不可漏项，不可编造引文；AI编排时为空数组。
每段durationSeconds按自然动作、口播读法、文字停留和理解容量估算，正数且全稿不超过3600秒。参考时长指导内容规模，允许合理浮动，但不能借软约束把30秒短片写成数分钟；优先聚焦关键事件与产品信息，不堆全部规格，不按秒数硬凑或空耗。
严格使用brief中已确认产品事实和品牌约束；未知性能、功效、认证、价格和真实评价不可编造。允许创作的人物情节和视觉设计不当作产品事实。
保持物理状态和因果连贯，允许清楚的剪辑省略；不能把仍插在电源上的充电器折脚收纳。"""
REVIEW = """独立审校当前完整正文。问题须具体给出正文引文、资料或创作依据和可执行建议，beatIds引用实际篇章，整体问题可为空；shotIds必须为空。
事实错误、结构未落实、物理/叙事因果矛盾、空泛概述、明显不符合所选类型、实际动作口播无法容纳于估时为ERROR；一般审美偏好为WARNING。不要把隐喻当真实功能，不要求穷尽卖点。
核对结构映射在语义上实际成立，不能仅因为模型提供了引文就通过。参考时长是软约束，不因秒数差异修订，仍检查内容规模和实际容量。
核对构思与实际正文一致，其他方案仅用于差异比较，不能把它们的内容当当前稿。没有问题给出具体检查结论。"""


def mapping_issues(story: TypedStory, requirements: list[dict[str, str]]) -> list[dict[str, Any]]:
    issues = video_script_issues(story, [])
    if len(story.structureMapping) != len(requirements):
        issues.append({'code': 'STRUCTURE_MAPPING_COUNT'})
    previous = -1
    ids = [b.id for b in story.beats]
    for i, item in enumerate(story.structureMapping):
        positions = [ids.index(b) if b in ids else -1 for b in item.beatIds]
        if (i >= len(requirements) or item.requirementId != requirements[i]['id'] or
                not positions or min(positions) < 0 or positions != sorted(set(positions)) or positions[0] < previous):
            issues.append({'code': 'STRUCTURE_MAPPING_REFERENCE'})
        if not item.evidence.strip() or not any(item.evidence in b.content for b in story.beats if b.id in item.beatIds):
            issues.append({'code': 'STRUCTURE_MAPPING_EVIDENCE'})
        if positions:
            previous = positions[0]
    return issues


def check_review(review: TypedReview, story: TypedStory) -> None:
    ids = {b.id for b in story.beats}
    if any(f.shotIds or any(b not in ids for b in f.beatIds) for f in review.findings):
        raise ValueError('review references unknown body units')
    if isinstance(review, TypedReviewV4):
        for check in review.qualityChecks:
            if any(b not in ids for b in check.beatIds):
                raise ValueError('quality check references unknown body unit')
            if check.verdict != 'NOT_APPLICABLE' and not any(
                check.evidence in b.content for b in story.beats if b.id in check.beatIds
            ):
                raise ValueError('quality check evidence is absent from cited body')


QUALITY_REVIEW = """先只阅读实际正文，再对照所选类型的创作计划。必须输出routeId和本类型严格按顺序排列的三个qualityChecks；每项给出PASS/FAIL、实际正文P编号、正文逐字引文（至少8字）、判断原因和失败时可执行修改。证据只能来自正文beats[].content，不能引用计划、标题、概述或你自己的评语。
带货依次检查BUYING_REASON购买动因是否由实际画面成立、VALUE_DEMONSTRATION呈现是否有可观看的价值、INFORMATION_CAPACITY听读量是否容纳于预计时长。
到店依次检查VENUE_EVIDENCE是否有真实场所依据、VISIT_EXPERIENCE是否展现值得亲访的体验、TRUSTWORTHY_DETAIL是否避免虚构服务与评价。
品牌依次检查VISIBLE_CONCEPT删除抽象形容词后是否仍有具体视觉机制、VISUAL_PROGRESSION机制在不同篇章是否发生有意义的变化、BRAND_MEMORY结尾是否由前文变化形成品牌记忆。只有开包、参数字卡、接线、拔离、收纳的操作次序，即使事实准确也应在前两项判FAIL。
剧情依次检查CHARACTER_CAUSALITY人物目标、选择和后果是否实际发生，NATURAL_DIALOGUE每句关键对白是否像此人此刻对对方说的话，PRODUCT_CAUSALITY产品是否参与因果而非仅让人物报告规格。无对白时NATURAL_DIALOGUE可标NOT_APPLICABLE且无需引文；其他项不能跳过。带数字的对白若只是向观众解释产品，应判FAIL，即使数字正确。
FAIL会成为需要修订的具体问题，不能因为创意计划优秀或事实无误就全部判PASS；一般审美偏好写WARNING。不要为了挑错虚构问题。"""


def materialize_quality_findings(review: TypedReviewV4) -> None:
    for check in review.qualityChecks:
        if check.verdict == 'FAIL' and not any(
            f.severity == 'ERROR' and f.beatIds == check.beatIds and f.evidence == check.evidence
            for f in review.findings
        ):
            review.findings.append(TypedFinding(severity='ERROR', category='STORY', shotIds=[],
                beatIds=check.beatIds, message=check.reason, evidence=check.evidence,
                suggestion=check.suggestion))


async def generate_review(p: Pipeline, stage: str, sid: str, context: dict[str, Any], instruction: str,
        story: TypedStory) -> TypedReview:
    if p.input['routeId'] == 'ECOMMERCE' and p.input['strategyVersions']['review'] in COMMERCE_VERSIONS:
        from .editorial_review import review_editorial
        return await review_editorial(p, stage, sid, context, story)
    if p.input['strategyVersions']['review'] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8'} and p.input['routeId'] in {'BRAND_AD', 'DRAMA'}:
        from .editorial_review import review_editorial
        return await review_editorial(p, stage, sid, context, story)
    if p.input['strategyVersions']['review'] not in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8', '2026-10-13.4', '2026-10-13.5', '2026-10-13.6', '2026-10-13.7'}:
        review = await p.generate(stage, sid, TypedReview, context, instruction)
        check_review(review, story)
        return review
    saved = p.checkpoints.get((stage, sid), {})
    if saved.get('status') == 'SUCCEEDED':
        modern = TypedReviewV4.model_validate(saved['output'])
    else:
        await p.step(stage, sid, 'RUNNING')
        if p.input['strategyVersions']['review'] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8', '2026-10-13.5', '2026-10-13.6', '2026-10-13.7'}:
            # A plan is not evidence of what the finished body actually achieves.
            context = {k: v for k, v in context.items() if k in {'story', 'otherConcepts', 'originalReview'}}
            instruction += '\n先逐字引用实际正文，再写判断理由，最后判定。不要反过来为通过结论寻找理由。产品操作的状态变化、参数标注的更新、轮廓线和高亮的装饰本身不等于品牌表达；判断它们是否改变观众对产品或品牌的理解。剧情对白中技术解释即使正确，也不能用“人物负责准确”替代对当前对话目的的核查。'
        from .review_evidence import EvidenceReview, evidence_context, resolve_evidence, EVIDENCE_INSTRUCTION
        indexed = p.input['strategyVersions']['review'] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8', '2026-10-13.6', '2026-10-13.7'}
        calibrated = p.input['strategyVersions']['review'] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8', '2026-10-13.7'}
        from .review_calibration import ObservedReview, resolve_observations, OBSERVATION_INSTRUCTION
        sources: dict[str, tuple[str, str]] = {}
        if indexed:
            body, sources = evidence_context(story)
            if calibrated:
                # Author-written summaries are not proof of the body's editorial quality.
                body = {'beats': body['beats']}
            context = {**context, 'story': body}
        review_context_input = context
        for attempt in range(2):
            if calibrated:
                observed = await p.model(stage, ObservedReview, review_context_input, instruction + '\n' + QUALITY_REVIEW + '\n' + EVIDENCE_INSTRUCTION + '\n' + OBSERVATION_INSTRUCTION)
                previous = observed.model_dump()
            elif indexed:
                decision = await p.model(stage, EvidenceReview, review_context_input, instruction + '\n' + QUALITY_REVIEW + '\n' + EVIDENCE_INSTRUCTION)
                previous = decision.model_dump()
            else:
                modern = await p.model(stage, TypedReviewV4, review_context_input, instruction + '\n' + QUALITY_REVIEW)
                previous = modern.model_dump()
            try:
                if calibrated:
                    modern = resolve_observations(observed, sources)
                elif indexed:
                    modern = resolve_evidence(decision, sources)
                if modern.routeId != p.input['routeId']:
                    raise ValueError('quality review route mismatch')
                check_review(modern, story)
                break
            except ValueError as error:
                # Only fixed validation messages; never log model output or source text.
                reason = 'quality review structure invalid' if isinstance(error, ValidationError) else str(error)
                logging.warning('typed_review_validation stage=%s attempt=%s reason=%s', stage, attempt + 1, reason)
                if attempt:
                    raise
                review_context_input = {**context, 'previousReview': previous,
                    'validationError': reason, 'expectedRoute': p.input['routeId'],
                    'correction': ('仅修正路线、检查项与evidenceId；选择当前正文excerpts中真实编号，保留实质问题。' if indexed else '仅修正路线、篇章引用与逐字证据。每项证据从一个所引篇章原文中复制连续片段，不拼接、省略或改写。保留实质问题，不能为了通过结构校验改成PASS。')}
        materialize_quality_findings(modern)
        await p.step(stage, sid, 'SUCCEEDED', modern.model_dump())
    if modern.routeId != p.input['routeId']:
        raise ValueError('quality review route mismatch')
    materialize_quality_findings(modern)
    check_review(modern, story)
    return modern


async def run(p: Pipeline) -> None:
    route = p.input['routeId']
    versions = [p.input.get('strategyVersions', {}).get(k) for k in ('concept', 'story', 'review', 'repair')]
    if route != p.input['settings']['videoType'] or route not in STRATEGIES or len(set(versions)) != 1 or versions[0] not in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8', '2026-10-13.1', '2026-10-13.2', '2026-10-13.3', '2026-10-13.4', '2026-10-13.5', '2026-10-13.6', '2026-10-13.7'}:
        raise ValueError('unsupported frozen creative strategy')
    if versions[0] in COMMERCE_VERSIONS and route != 'ECOMMERCE':
        raise ValueError('commerce strategy belongs to commerce route only')
    if versions[0] in DRAMA_VERSIONS and route != 'DRAMA':
        raise ValueError('drama strategy belongs to drama route only')
    p.context['strategyVersion'] = versions[0]
    strategy = strategy_for(route, versions[0])
    class ScopedConcepts(TypedConcepts):
        @model_validator(mode='after')
        def scope(self) -> Self:
            if self.readiness.status == 'READY' and (sorted(c.scriptId for c in self.concepts) != sorted(p.input['scriptIds']) or any(c.plan.videoType != route for c in self.concepts)):
                raise ValueError('concept scope mismatch')
            return self
    requirements = [{'id': f'R{i+1:02d}', 'title': title} for i, title in enumerate(p.input['settings'].get('structureSections', []))]
    p.context['structureRequirements'] = requirements
    for node, output in (
        ('SNAPSHOT', {'source': p.input['source'], 'brief': p.input['brief'], 'settings': p.input['settings']}),
        ('PREPARE', {'source': p.input['source'], 'requirements': requirements, 'brief': p.input['brief']}),
        ('ROUTE', {'routeId': route, 'graphVersion': p.input['graphVersion']}),
    ):
        if p.checkpoints.get((node, ''), {}).get('status') != 'SUCCEEDED':
            await p.step(node, '', 'SUCCEEDED', output)
    node = f'{route}_CONCEPT'
    proposal_context: dict[str, Any] = {}
    if versions[0] not in DRAMA_VERSIONS and not (versions[0] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1'} and route == 'BRAND_AD') and versions[0] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8'} and route in {'BRAND_AD', 'DRAMA'} and p.checkpoints.get((node, ''), {}).get('status') != 'SUCCEEDED':
        from .creative_options import CreativeSlate, INSTRUCTION
        partial = p.checkpoints.get((node, ''), {}).get('output') or {}
        development_instruction = ''
        if versions[0] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9'}:
            from .creative_options import DEVELOPMENT
            development_instruction = DEVELOPMENT
        if 'creativeOptions' in partial:
            slate = CreativeSlate.model_validate(partial['creativeOptions'])
        else:
            await p.step(node, '', 'RUNNING')
            from .creative_challenges import creative_challenges
            challenges = {'developmentQuestions': creative_challenges(route), 'developmentInstruction': '至少探索这些不同问题，可以提出更好的路径；每份候选用具体事件回答，不能全走同一个资源不足—使用—收回流程。问题不是必须照抄的故事结构。'} if versions[0] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11'} else {}
            slate = await p.model(node, CreativeSlate, {
                **challenges,
                'candidateCount': min(7, len(p.input['scriptIds']) + 2),
                'existingTitles': [c.get('name', '') for c in p.input['existingConcepts']],
            }, strategy.PLAN + '\n' + INSTRUCTION + development_instruction)
            await p.step(node, '', 'RUNNING', {'creativeOptions': slate.model_dump()})
        if len(slate.options) != min(7, len(p.input['scriptIds']) + 2):
            raise ValueError('creative candidate count mismatch')
        proposal_context = {'creativeOptions': slate.model_dump(),
            'selectionInstruction': '对照已有方案淘汰重复和薄弱候选，只深化足量的优选方向；保留其核心事件与视觉变化，不退回产品目录。可以修正弱点，不得重新照搬历史方案。'}
    if route == 'DRAMA' and versions[0] in DRAMA_VERSIONS:
        from .drama_development import develop_drama
        concepts = await develop_drama(p)
    elif route == 'ECOMMERCE' and versions[0] in PRESENTER_VERSIONS:
        from .presenter_development import develop
        concepts = await develop(p)
    elif route == 'ECOMMERCE' and versions[0] in COMMERCE_VERSIONS:
        from .commerce_development import develop_commerce
        concepts = await develop_commerce(p)
    elif versions[0] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1'} and route == 'BRAND_AD':
        from .brand_development import develop_brand
        concepts = await develop_brand(p)
    else:
        concepts = await p.generate(node, '', ScopedConcepts,
        {'scriptIds': p.input['scriptIds'], 'existingConcepts': p.input['existingConcepts'], **proposal_context},
        strategy.PLAN + (development_instruction if proposal_context else '') + (('\n用以下成稿门槛筛选候选，尚无正文时检查计划是否确实安排了承担这些标准的事件，不是凭命名许诺：\n' + strategy.REVIEW) if versions[0] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10'} and proposal_context else '') + '\n联合构思本次所有方案，身份与scriptIds一一对应。先判断资料足够支持本类型；足够时readiness=READY，missing为空；不足则NEEDS_INFORMATION，给出具体缺口和依据，concepts为空。已有方案仅避重，不照搬。每份写出coreIdea/openingHook/productRole/memoryPoint及本类型plan，各项具体充分；structureRequirements只约束推进，不机械复制为正文标题。构思不写秒级时间表、不提前分镜或安排机位；按参考时长选择可承载的内容规模，预计时长留给正文按实际容量估算。')
    if concepts.readiness.status == 'NEEDS_INFORMATION':
        if concepts.concepts or not concepts.readiness.missing:
            raise ValueError('invalid readiness result')
        await p.api.call('POST', 'finish', {'retryable': False})
        return
    if sorted(c.scriptId for c in concepts.concepts) != sorted(p.input['scriptIds']) or any(c.plan.videoType != route for c in concepts.concepts):
        raise ValueError('concept scope mismatch')
    pending = [c for c in concepts.concepts if c.scriptId not in p.completed and (p.retry_script_ids is None or c.scriptId in p.retry_script_ids)]
    if (route == 'DRAMA' and versions[0] in DRAMA_VERSIONS) or (route == 'ECOMMERCE' and versions[0] in {'2026-10-14-commerce.3', '2026-10-14-commerce.4', '2026-10-14-commerce.5', *PRESENTER_VERSIONS}):
        # Finish active scripts before queueing every later story ahead of their audits.
        slots = asyncio.Semaphore(2)
        async def bounded_create(concept: TypedConcept) -> None:
            async with slots:
                await create(p, concept, concepts, requirements)
        results = await asyncio.gather(*(bounded_create(c) for c in pending), return_exceptions=True)
    else:
        results = await asyncio.gather(*(create(p, c, concepts, requirements) for c in pending), return_exceptions=True)
    for result in results:
        if isinstance(result, InternalApiError):
            raise result
    retries = [c.scriptId for c, result in zip(pending, results) if isinstance(result, ProviderError) and result.retryable]
    await p.api.call('POST', 'finish', {'retryable': bool(retries), 'retryScriptIds': retries})


async def create(p: Pipeline, concept: TypedConcept, concepts: TypedConcepts, requirements: list[dict[str, str]]) -> None:
    sid, route = concept.scriptId, p.input['routeId']
    strategy = strategy_for(route, p.input['strategyVersions']['story'])
    body_format = FORMAT if p.input['strategyVersions']['story'] not in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8', '2026-10-13.7'} else FORMAT.replace('不能把仍插在电源上的充电器折脚收纳。', '设备、食物、服饰、工具及软件操作均遵守其实际状态和能力；不添加当前产品以外的品类示例。')
    stage = f'{route}_STORY'
    context = {'concept': concept.model_dump(), **({'dramaCommitment':p.drama_commitments[sid]} if sid in p.drama_commitments else {}), **({'commerceCommitment': p.commerce_commitments[sid]} if sid in p.commerce_commitments else {}), **({'brandCommitment': p.brand_commitments[sid]} if sid in p.brand_commitments else {}), 'otherConcepts': [
        {k: v for k, v in c.model_dump().items() if k in {'name', 'coreIdea', 'difference', 'productRole'}}
        for c in concepts.concepts if c.scriptId != sid]}
    try:
        saved = p.checkpoints.get((stage, sid), {})
        if saved.get('status') == 'SUCCEEDED':
            story = TypedStory.model_validate(saved['output'])
        else:
            partial = saved.get('output') or {}
            await p.step(stage, sid, 'RUNNING')
            if 'rejectedStory' in partial:
                story = TypedStory.model_validate(partial['rejectedStory'])
            else:
                from .typed_longform import generate_parts
                if partial.get('longform'):
                    story = await generate_parts(p, sid, stage, context, strategy.WRITE + body_format)
                else:
                    try:
                        story = (await p.model(stage, TypedDraft, context, strategy.WRITE + body_format)).story()
                    except ProviderError as exc:
                        if exc.error_type != ProviderErrorType.OUTPUT_TRUNCATED or p.input['strategyVersions']['story'] not in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8', '2026-10-13.3', '2026-10-13.4', '2026-10-13.5', '2026-10-13.6', '2026-10-13.7'}:
                            raise
                        story = await generate_parts(p, sid, stage, context, strategy.WRITE + body_format)
            issues = mapping_issues(story, requirements)
            if issues:
                if partial.get('correctionComplete'):
                    raise ValueError('body format correction exhausted')
                await p.step(stage, sid, 'RUNNING', {'rejectedStory': story.model_dump(), 'correctionComplete': False})
                story = (await p.model(stage, TypedDraft, {**context, 'story': review_context(story, True), 'validationIssues': issues}, strategy.WRITE + body_format + '仅修正所列机械结构与引用错误，保留有效正文。')).story()
                await p.step(stage, sid, 'RUNNING', {'rejectedStory': story.model_dump(), 'correctionComplete': True})
                if mapping_issues(story, requirements):
                    raise ValueError('body format correction exhausted')
            await p.step(stage, sid, 'SUCCEEDED', story.model_dump())
        stage = f'{route}_REVIEW'
        review = await generate_review(p, stage, sid, {**context, 'story': review_context(story, True)}, strategy.REVIEW + REVIEW, story)
        script: dict[str, Any] = {'id': sid, 'name': concept.name, 'synopsis': concept.synopsis, 'structure': concept.structure, 'productFocus': concept.productFocus, 'story': story.model_dump(), 'shots': [], 'assets': [], 'creation': {
            'videoType': route, 'referenceDurationSeconds': p.input['settings']['targetDurationSeconds'], 'structureSections': p.input['settings'].get('structureSections', [])}}
        stage = 'REPAIR'
        saved = p.checkpoints.get((stage, sid), {})
        if any(f.severity == 'ERROR' for f in review.findings):
            if saved.get('status') == 'SUCCEEDED':
                script = saved['output']['script']
            else:
                partial = saved.get('output') or {}
                await p.step(stage, sid, 'RUNNING')
                if p.input['strategyVersions']['repair'] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8', '2026-10-13.3', '2026-10-13.4', '2026-10-13.5', '2026-10-13.6', '2026-10-13.7'}:
                    capacity_note = ('\n逐项解决全部ERROR。容量不足时按修订后的实际对白、动作与停顿重新估时；参考时长不是总量上限，不必从其他正常篇章扣秒，也不能删少量文字后反而缩短该段估时。优先保留戏剧关键行为、删除重复解释。' if p.input['strategyVersions']['repair'] in {VERSION, *COMMERCE_VERSIONS, *DRAMA_VERSIONS, '2026-10-14.6', '2026-10-14.5', '2026-10-14.4', '2026-10-14.3', '2026-10-14.2', '2026-10-14.1', '2026-10-13.11', '2026-10-13.10', '2026-10-13.9', '2026-10-13.8', '2026-10-13.6', '2026-10-13.7'} else '')
                    if p.input['strategyVersions']['repair'] in COMMERCE_VERSIONS:
                        capacity_note = '\n逐项解决全部ERROR，保留核心购买动机与可观察结果；先删无关参数、重复旁白及不必要动作，再按真实容量估时，不能仅靠加秒数逃避短片聚焦。'
                    patch = TypedPatch.model_validate(partial['patch']) if 'patch' in partial else await p.model(stage, TypedPatch,
                        {**context, 'story': review_context(story, True), 'review': review.model_dump()},
                        strategy.WRITE + body_format + '\n仅返回需要修改的正文单元replacements，按原beatId替换其完整content和实际时长，不输出未改正文。不得新增、删除或重编号；必要的内容重组在原有篇章内完成。metadata只列确实变化的辅助字段。保留未受影响段落；同步concept和structureMapping，引用最终正文。不变更scriptId或视频类型。' + capacity_note)
                    await p.step(stage, sid, 'RUNNING', {'patch': patch.model_dump()})
                    revised, changes = apply_patch(story, patch, requirements)
                    updated_concept = patch.concept
                else:
                    revision = TypedRevision.model_validate(partial['revision']) if 'revision' in partial else await p.model(stage, TypedRevision,
                        {**context, 'story': review_context(story, True), 'review': review.model_dump()},
                        strategy.WRITE + body_format + '\n只针对具体ERROR定向修订，保留未受影响的创意与事实，同步concept与全文，不变更scriptId或视频类型；修订后按实际容量估时，不重复规格或空洞扩写。')
                    await p.step(stage, sid, 'RUNNING', {'revision': revision.model_dump()})
                    revised = revision.story.story()
                    updated_concept = revision.concept
                    changes = [{'before': story.content, 'after': revised.content, 'reason': review.summary}]
                if updated_concept.scriptId != sid or updated_concept.plan.videoType != route or mapping_issues(revised, requirements):
                    raise ValueError('invalid directed revision')
                script.update({k: v for k, v in updated_concept.model_dump().items() if k in {'name', 'synopsis', 'structure', 'productFocus'}})
                script['story'] = revised.model_dump()
                await p.step(stage, sid, 'SUCCEEDED', {'script': script, 'reason': review.summary, 'changes': changes})
            stage = 'RECHECK'
            revised = TypedStory.model_validate(script['story'])
            checked = await generate_review(p, stage, sid, {'story': review_context(revised, True), 'originalReview': review.model_dump(), 'concept': {k: script[k] for k in ('name', 'synopsis', 'structure', 'productFocus')}, 'otherConcepts': context['otherConcepts'], **({'brandCommitment': context['brandCommitment']} if 'brandCommitment' in context else {}), **({'commerceCommitment': context['commerceCommitment']} if 'commerceCommitment' in context else {})}, strategy.REVIEW + REVIEW + '独立核对修订全文，不能因已修改就默认通过。', revised)
            if any(f.severity == 'ERROR' for f in checked.findings):
                return
        else:
            await p.step('REPAIR', sid, 'SKIPPED', {'reason': '专项审校通过，无需修订'})
            await p.step('RECHECK', sid, 'SKIPPED', {'reason': '正文未修订，沿用已完成的专项审校'})
        stage = 'SAVE'
        await p.api.call('POST', 'scripts', {'script': script})
    except InternalApiError:
        raise
    except Exception:
        if stage != 'SAVE':
            await p.step(stage, sid, 'FAILED', p.checkpoints.get((stage, sid), {}).get('output'), error='本方案尚未完整完成，已保留内容，可恢复重试。')
        raise
