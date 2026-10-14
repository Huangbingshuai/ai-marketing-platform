"""Independent creative and factual audits, bounded by the shared provider semaphore."""
from __future__ import annotations
import asyncio
from typing import Any, TYPE_CHECKING
from pydantic import ValidationError
from .review_calibration import ObservedReview, EditorialReview, resolve_observations, OBSERVATION_INSTRUCTION
from .review_evidence import evidence_context, EVIDENCE_INSTRUCTION
from .typed_creation import TypedStory, TypedReview, TypedReviewV4, check_review, materialize_quality_findings
from .routes import strategy_for

if TYPE_CHECKING:
    from .pipeline import Pipeline


FACT_REVIEW = """核查正文的产品事实、已确认约束、自定义结构实际落实、物理状态和动作/对白/文字的真实时长容量。
只审以上可核对问题，不评价创意好坏、人物说教或品牌表现力，另一独立审校负责。产品事实准确不要求全部上屏；参考时长是软约束。ERROR必须给出具体原文及依据、beatIds和可执行建议，shotIds为空；无问题给出简短实际结论。
逐项核对实际动作所依赖的能力和连接关系，不只是数字抄对。例如供电不等于传输数据/控制设备，容纳不等于防护，涂抹不等于即时疗效，软件展示不等于拥有外部权限。若正文省略了必要操作且造成错误因果，要明确指出；正常可理解的剪辑省略不挑错。对白逐段按实际说话与反应时间估算，主要动作/字幕是否还能容纳，不接受用一个总秒数掩盖多段明显装不下。
不得把艺术隐喻当作已知产品功能；明确的非写实设计可用，但不应误导真实功效。复核仍重读全文，旧问题仅作核对清单，不能默认修改后通过。"""


async def review_editorial(p: Pipeline, stage: str, sid: str, context: dict[str, Any], story: TypedStory) -> TypedReviewV4:
    saved = p.checkpoints.get((stage, sid), {})
    if saved.get('status') == 'SUCCEEDED':
        result = TypedReviewV4.model_validate(saved['output'])
        check_review(result, story)
        return result
    partial = dict(saved.get('output') or {})
    # A retry is scoped to this task and frozen body; never reuse another script's sub-audit.
    import hashlib
    body_hash = hashlib.sha256(story.model_dump_json().encode()).hexdigest()
    if partial.get('bodyHash') != body_hash:
        partial = {'bodyHash': body_hash}
    lock = asyncio.Lock()

    async def checkpoint(key: str, result: dict[str, Any]) -> None:
        async with lock:
            partial[key] = result
            await p.step(stage, sid, 'RUNNING', dict(partial))

    async def facts() -> TypedReview:
        if 'factReview' in partial:
            result = TypedReview.model_validate(partial['factReview'])
        else:
            result = await p.model(stage, TypedReview, {
                'auditRole': 'FACTS', 'story': story.model_dump(exclude={'content'}),
                'originalReview': context.get('originalReview'),
            }, FACT_REVIEW)
            check_review(result, story)
            await checkpoint('factReview', result.model_dump())
        check_review(result, story)
        return result

    async def creative() -> TypedReviewV4:
        if 'editorialReview' in partial:
            result = TypedReviewV4.model_validate(partial['editorialReview'])
            check_review(result, story)
            return result
        body, sources = evidence_context(story)
        # The separate factual audit retains the full Brief. This call cannot mistake spec coverage for creativity.
        brief = {k: p.input['brief'].get(k, '') for k in ('brandName', 'brandTone', 'productName', 'targetAudience')}
        evaluation = {'auditRole': 'EDITORIAL', 'brief': brief, 'story': {'beats': body['beats']},
            'settings': {'videoType': p.input['routeId']}, 'structureRequirements': [],
            'otherConcepts': context.get('otherConcepts', [])}
        strategy = strategy_for(p.input['routeId'], p.input['strategyVersions']['review'])
        modern_brand = p.input['routeId'] == 'BRAND_AD' and p.input['strategyVersions']['review'] in {'2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'}
        observation = OBSERVATION_INSTRUCTION
        if modern_brand:
            observation = observation[:observation.index('品牌片先用普通动词')] + '\n三项标准按当前表达方式验收，证据必须来自正文，不能把计划当实现；不强制反转或隐喻。结构性缺陷与局部偏好的映射保持不变。'
            if p.input['strategyVersions']['review'] == '2026-10-14.7':
                observation = OBSERVATION_INSTRUCTION
            evaluation.update({'brandProposition': p.context.get('brandProposition'), 'brandCommitment': context.get('brandCommitment'), 'brandFactCatalog': []})
        instruction = (strategy.REVIEW + '\n' + EVIDENCE_INSTRUCTION + '\n' + observation +
            '\n只验收叙事/品牌表达，事实和技术正确性由独立检查处理，不能拿规格完整、操作正确作为创意证据。'
            '不要求看遍卖点，不重评产品值不值得买。拒绝依据须来自实际正文；findings只列额外的实质创意问题。')
        if not modern_brand and p.input['strategyVersions']['review'] in {'2026-10-13.9', '2026-10-13.10', '2026-10-13.11', '2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'}:
            instruction += '\nfindings.shotIds必须为空数组，本节点没有镜头；findings.beatIds只填实际篇章id如P01，不填P01:E01原文编号。品牌先区分常规功能演示的状态变化与实际表达关系，不把减少未使用数量、完成使用、恢复原状本身当作额外创意。'
        current = evaluation
        for attempt in range(2):
            decision = await p.model(stage, EditorialReview if p.input['strategyVersions']['review'] in {'2026-10-13.9', '2026-10-13.10', '2026-10-13.11', '2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'} else ObservedReview, current, instruction)
            try:
                result = resolve_observations(decision, sources)
                if result.routeId != p.input['routeId']:
                    raise ValueError('quality route mismatch')
                check_review(result, story)
                materialize_quality_findings(result)
                await checkpoint('editorialReview', result.model_dump())
                return result
            except ValueError as error:
                if attempt:
                    raise
                current = {**evaluation, 'previousReview': decision.model_dump(),
                    'validationError': 'invalid quality structure' if isinstance(error, ValidationError) else str(error),
                    'correction': '仅修正路线、检查项、原文编号及缺失字段，保留实质问题。'}
        raise ValueError('editorial audit incomplete')

    await p.step(stage, sid, 'RUNNING', partial)
    outputs = await asyncio.gather(facts(), creative(), return_exceptions=True)
    for output in outputs:
        if isinstance(output, BaseException):
            raise output
    factual, editorial = outputs
    assert isinstance(factual, TypedReview) and isinstance(editorial, TypedReviewV4)
    merged = editorial.model_copy(deep=True)
    merged.summary = '创作审校：' + editorial.summary + '\n事实与执行核查：' + factual.summary
    merged.findings.extend(factual.findings)
    materialize_quality_findings(merged)
    check_review(merged, story)
    await p.step(stage, sid, 'SUCCEEDED', merged.model_dump())
    return merged
