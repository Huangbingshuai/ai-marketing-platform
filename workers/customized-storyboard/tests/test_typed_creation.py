import json
from pathlib import Path
from typing import Any
import pytest
from customized_storyboard.pipeline import Pipeline
from customized_storyboard.typed_creation import (
    TypedConcepts, TypedDraft, TypedReview, TypedReviewV4, TypedRevision, TypedPatch,
    QUALITY_CRITERIA, apply_patch, mapping_issues,
)
from customized_storyboard.routes import STRATEGIES, VERSION, strategy_for
from customized_storyboard.review_evidence import EvidenceReview, evidence_context, resolve_evidence
from customized_storyboard.review_calibration import ObservedReview, EditorialReview, resolve_observations
from customized_storyboard.drama_audit import DramaEditorialReview, DramaMeritReview
from customized_storyboard.creative_options import CreativeSlate
from customized_storyboard.brand_development import BrandDevelopment, BrandSelection
from customized_storyboard.brand_selection import LeanBrandSelection
from test_story_only import Api


def value(route: str = 'BRAND_AD', count: int = 1) -> dict[str, Any]:
    return {'schemaVersion': 1, 'outputMode': 'STORY_ONLY', 'storyFormat': 'VIDEO_SCRIPT_V3',
        'graphVersion': 'TYPED_CREATION_V1', 'routeId': route,
        'strategyVersions': dict.fromkeys(['concept', 'story', 'review', 'repair'], VERSION),
        'source': {'artifactId': 'brief', 'revision': 1, 'fingerprint': 'fixed'}, 'brief': {'productName': '测试产品', 'sellingPoints': ['资料中的真实特点']},
        'settings': {'videoType': route, 'targetDurationSeconds': 30, 'variantCount': count, 'structureMode': 'CUSTOM', 'structureSections': ['吸引注意', '价值兑现'], 'instructions': 'unused'},
        'scriptIds': [f's{i}' for i in range(count)], 'existingConcepts': [], 'models': {'creative': 'controlled', 'detail': 'controlled'}}


def draft() -> dict[str, Any]:
    return {'title': '晨光', 'opening': '', 'development': '', 'ending': '', 'dialoguePlan': '',
        'beats': [{'id': 'P01', 'content': 'P01｜桌边的晨光\n\n轮廓随晨光显现，橙色端口从阴影中显露。', 'durationSeconds': 32}],
        'structureMapping': [{'requirementId': r, 'beatIds': ['P01'], 'evidence': '橙色端口从阴影中显露'} for r in ['R01', 'R02']]}


class Provider:
    def __init__(self, route: str, repair: bool = False, blocked: bool = False,
                 recheck_error: bool = False, quality_fail: bool = False) -> None:
        self.route, self.repair, self.blocked = route, repair, blocked
        self.recheck_error, self.quality_fail = recheck_error, quality_fail
        self.calls: list[str] = []

    async def generate(self, stage: str, model: str, schema: Any, context: Any, instruction: str) -> Any:
        self.calls.append(stage)
        assert 'instructions' not in context['settings']
        assert 'brandReferences' not in context
        strategy = strategy_for(self.route, context.get('strategyVersion', VERSION))
        if schema is BrandDevelopment:
            return schema.model_validate({'proposition': {'message': '体现产品特点', 'audienceObservation': '一个创作观察', 'observationBasis': 'CREATIVE_HYPOTHESIS', 'supportingFactIds': ['F01'], 'requiredFactIds': [], 'requiredReason': '未要求全部展示'},
                'ideas': [{'id': f'C{i+1:02d}', 'name': f'短创意{i}', 'approach': 'PRODUCT_DESIGN', 'viewingHook': '可见轮廓', 'mechanism': '光线节奏', 'keyImages': ['建立轮廓', '橙色显现'], 'productRole': '真实特点参与', 'factIds': ['F01'], 'memory': '识别产品', 'risk': '避免抽象'} for i in range(context['candidateCount'])]})
        if schema is CreativeSlate:
            if context.get('strategyVersion') in {'2026-10-13.11', '2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'}:
                assert len(set(context['developmentQuestions'])) == 3
            else:
                assert 'developmentQuestions' not in context
            return schema.model_validate({'options': [{'name': f'候选{i}', 'openingEvent': '可见事件', 'development': '实际变化', 'endingEvent': '关系回收', 'productParticipation': '有依据的行为', 'weakness': '节奏需清楚'} for i in range(context['candidateCount'])]})
        if stage.endswith('_CONCEPT'):
            if schema not in (BrandSelection, LeanBrandSelection):
                assert strategy.PLAN in instruction
            # Build through the public schema so each type must supply its own fields.
            defs = (BrandSelection if schema is LeanBrandSelection else schema).model_json_schema()['$defs']
            plan_name = {'ECOMMERCE': 'EcommercePlan', 'LOCAL_STORE': 'LocalStorePlan', 'BRAND_AD': 'BrandPlan', 'DRAMA': 'DramaPlan'}[self.route]
            plan = {key: '具体依据与创作安排' for key in defs[plan_name]['properties']}
            plan['videoType'] = self.route
            proposal = {'readiness': {'status': 'NEEDS_INFORMATION' if self.blocked else 'READY', 'reason': '需要真实场所信息' if self.blocked else '产品资料充分', 'missing': ['门店服务依据'] if self.blocked else []},
                'concepts': [] if self.blocked else [{'scriptId': sid, 'name': '晨光', 'synopsis': '光线展开', 'productFocus': '轮廓', 'structure': '显现、展开', 'difference': '光线关系', 'coreIdea': '晨光', 'openingHook': '轮廓', 'productRole': '显现', 'memoryPoint': '橙色', 'plan': plan} for sid in context['scriptIds']]}
            if schema in (BrandSelection, LeanBrandSelection):
                proposal.pop('readiness')
                proposal.update({'status': 'READY', 'reason': '独立择优', 'missing': [],
                    'evaluations': [{'ideaId': i['id'], 'attraction': 4, 'productConnection': 4, 'clarity': 4, 'distinctiveness': 4, 'verdict': 'ADVANCE', 'reason': '可执行的观看机制'} for i in context['development']['ideas']],
                    'commitments': [{'scriptId': sid, 'ideaId': context['development']['ideas'][i]['id'], 'approach': 'PRODUCT_DESIGN', 'mustPreserve': ['建立轮廓', '橙色显现'], 'essentialFactIds': ['F01'], 'reason': '保留关键表达'} for i,sid in enumerate(context['scriptIds'])]})
            if schema is LeanBrandSelection:
                proposal.pop('concepts')
            return schema.model_validate(proposal)
        if stage.endswith('_STORY'):
            assert strategy.WRITE in instruction
            body = draft()
            if not context.get('structureRequirements'):
                body['structureMapping'] = []
            return schema.model_validate(body)
        if stage == 'REPAIR':
            assert getattr(strategy, 'REPAIR', strategy.WRITE) in instruction
            body = draft()
            if not context.get('structureRequirements'):
                body['structureMapping'] = []
            return schema.model_validate({'reason': '展开变化', 'replacements': [{'beatId': 'P01', 'content': body['beats'][0]['content'], 'durationSeconds': 32, 'reason': '保留实际变化'}], 'metadata': [], 'concept': context['concept'], 'structureMapping': body['structureMapping']})
        if context.get('auditRole') != 'FACTS':
            assert strategy.REVIEW in instruction
        assert 'content' not in context['story']
        if context.get('strategyVersion') == VERSION:
            assert 'concept' not in context
        error = self.repair and stage.endswith('_REVIEW') or self.recheck_error and stage == 'RECHECK'
        result = {'summary': '独立核对全文', 'findings': [{'severity': 'ERROR', 'category': 'STORY', 'shotIds': [], 'beatIds': ['P01'], 'message': '推进不足', 'evidence': '轮廓', 'suggestion': '展开变化'}] if error else []}
        if schema in {TypedReviewV4, EvidenceReview, ObservedReview, EditorialReview, DramaEditorialReview, DramaMeritReview}:
            beat = context['story']['beats'][0]
            actual_quote = beat['excerpts'][0]['text'] if schema in {EvidenceReview, ObservedReview, EditorialReview, DramaEditorialReview, DramaMeritReview} else beat['content'].split('\n\n')[-1]
            result.update({'routeId': self.route, 'qualityChecks': [
                {'criterion': criterion,
                 'verdict': 'FAIL' if self.quality_fail and stage.endswith('_REVIEW') and i == 0 else 'PASS',
                 'beatIds': ['P01'], 'evidence': actual_quote,
                 'reason': '正文有可见动作' if i else '计划未在正文形成清楚变化',
                 'suggestion': '增加正文画面变化' if i == 0 else ''}
                for i, criterion in enumerate(QUALITY_CRITERIA[self.route])]})
            if schema in {EvidenceReview, ObservedReview, EditorialReview, DramaEditorialReview, DramaMeritReview}:
                for check in result['qualityChecks']:
                    check.pop('evidence')
                    check.pop('beatIds')
                    check['evidenceId'] = beat['excerpts'][0]['id']
                    if schema in {ObservedReview, EditorialReview, DramaEditorialReview, DramaMeritReview}:
                        check['observed'] = check.pop('reason')
                        check['defectScope'] = 'STRUCTURAL' if check['verdict'] == 'FAIL' else 'NONE'
                        check['limitation'] = '正文未体现' if check['verdict'] == 'FAIL' else ''
                        check['assessment'] = 'NOT_DEMONSTRATED' if check.pop('verdict') == 'FAIL' else 'DEMONSTRATED'
        if issubclass(schema, DramaEditorialReview):
            ref = context['story']['beats'][0]['excerpts'][0]['id']
            result['mechanism'] = {'mainLine':'角色采取行动后得到具体回应', 'dialogueMode':'DRAMATIC_EXCHANGE',
                'dialogueEvidenceIds':[ref], 'dialogueReason':'对白推动实际交锋', 'dialogueRevision':'',
                'endingMode':'DEVELOPED_PAYOFF','endingSetupEvidenceId':ref,'endingEvidenceId':ref,
                'endingReason':'前文的动作在结尾得到回应','endingRevision':''}
        if schema is DramaMeritReview:
            result['viewingValue'] = {'viewingEvent':'角色的试探引出具体行为回应','classification':'DRAMA_DRIVEN',
                'evidenceId':context['story']['beats'][0]['excerpts'][0]['id'],'reason':'动作中实际展开了信息与关系变化','revision':''}
        return schema.model_validate(result)


@pytest.mark.parametrize('route', STRATEGIES)
@pytest.mark.parametrize('count', [1, 3, 5])
async def test_selected_route_only_and_per_script_publication(route: str, count: int) -> None:
    api, provider = Api(), Provider(route)
    p = Pipeline(api, provider, value(route, count), [], [])  # type: ignore[arg-type]
    await p.run()
    assert len(provider.calls) == (2 + 3 * count if route in {'BRAND_AD', 'DRAMA'} else 1 + 2 * count)
    assert all(s.startswith(route) for s in provider.calls)
    assert len([v for path, v in api.calls if path == 'scripts']) == count
    assert all(s['status'] == 'SKIPPED' for (node, _), s in p.checkpoints.items() if node in {'REPAIR', 'RECHECK'})


@pytest.mark.parametrize('version', ['2026-10-13.1', '2026-10-13.2', '2026-10-13.3'])
@pytest.mark.parametrize('route', ['BRAND_AD', 'DRAMA'])
async def test_frozen_legacy_strategies_do_not_require_new_quality_fields(version: str, route: str) -> None:
    data = value(route)
    data['strategyVersions'] = dict.fromkeys(['concept', 'story', 'review', 'repair'], version)
    api, provider = Api(), Provider(route)
    pipeline = Pipeline(api, provider, data, [], [])  # type: ignore[arg-type]
    await pipeline.run()
    assert any(path == 'scripts' for path, _ in api.calls)
    assert 'qualityChecks' not in pipeline.checkpoints[f'{route}_REVIEW', 's0']['output']


async def test_store_missing_evidence_stops_before_writing_and_persists_reason() -> None:
    api, provider = Api(), Provider('LOCAL_STORE', blocked=True)
    p = Pipeline(api, provider, value('LOCAL_STORE'), [], [])  # type: ignore[arg-type]
    await p.run()
    assert provider.calls == ['LOCAL_STORE_CONCEPT']
    assert p.checkpoints['LOCAL_STORE_CONCEPT', '']['output']['readiness']['missing']
    assert not any(path == 'scripts' for path, _ in api.calls)


@pytest.mark.parametrize('version', ['2026-10-13.4', '2026-10-13.5', '2026-10-13.6', '2026-10-13.7', '2026-10-13.8', '2026-10-13.9', '2026-10-13.10', '2026-10-13.11', '2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4'])
async def test_v4_quality_checkpoints_still_resume(version: str) -> None:
    data = value()
    data['strategyVersions'] = dict.fromkeys(['concept', 'story', 'review', 'repair'], version)
    api, provider = Api(), Provider('BRAND_AD')
    pipeline = Pipeline(api, provider, data, [], [])  # type: ignore[arg-type]
    await pipeline.run()
    assert 'qualityChecks' in pipeline.checkpoints['BRAND_AD_REVIEW', 's0']['output']
    provider.calls.clear()
    checkpoints = [{'nodeId': node, 'scriptId': sid, **step} for (node, sid), step in pipeline.checkpoints.items()]
    await Pipeline(Api(), provider, data, checkpoints, []).run()  # type: ignore[arg-type]
    assert provider.calls == []


async def test_route_quality_failure_drives_existing_repair_and_independent_recheck() -> None:
    api, provider = Api(), Provider('BRAND_AD', quality_fail=True)
    p = Pipeline(api, provider, value('BRAND_AD'), [], [])  # type: ignore[arg-type]
    await p.run()
    assert provider.calls == ['BRAND_AD_PROPOSITION', 'BRAND_AD_CONCEPT', 'BRAND_AD_STORY', 'BRAND_AD_REVIEW', 'BRAND_AD_REVIEW', 'REPAIR', 'RECHECK', 'RECHECK']
    review = p.checkpoints['BRAND_AD_REVIEW', 's0']['output']
    assert review['qualityChecks'][0]['verdict'] == 'FAIL'
    assert any(f['severity'] == 'ERROR' and f['evidence'] == review['qualityChecks'][0]['evidence'] for f in review['findings'])
    assert any(path == 'scripts' for path, _ in api.calls)


async def test_quality_evidence_must_quote_body() -> None:
    class FabricatedReview(Provider):
        async def generate(self, stage: str, model: str, schema: Any, context: Any, instruction: str) -> Any:
            result = await super().generate(stage, model, schema, context, instruction)
            if stage == 'BRAND_AD_REVIEW' and schema in {ObservedReview, EditorialReview, DramaEditorialReview, DramaMeritReview}:
                result.qualityChecks[0].evidenceId = 'P99:E99'
            return result
    api, provider = Api(), FabricatedReview('BRAND_AD')
    await Pipeline(api, provider, value('BRAND_AD'), [], []).run()  # type: ignore[arg-type]
    assert not any(path == 'scripts' for path, _ in api.calls)
    assert provider.calls.count('BRAND_AD_REVIEW') == 3


async def test_invalid_quote_corrects_once_without_regenerating_body() -> None:
    class CorrectedReview(Provider):
        async def generate(self, stage: str, model: str, schema: Any, context: Any, instruction: str) -> Any:
            result = await super().generate(stage, model, schema, context, instruction)
            if stage == 'BRAND_AD_REVIEW' and schema in {ObservedReview, EditorialReview, DramaEditorialReview, DramaMeritReview} and 'previousReview' not in context:
                result.qualityChecks[0].evidenceId = 'P99:E99'
            return result
    api, provider = Api(), CorrectedReview('BRAND_AD')
    await Pipeline(api, provider, value('BRAND_AD'), [], []).run()  # type: ignore[arg-type]
    assert any(path == 'scripts' for path, _ in api.calls)
    assert provider.calls == ['BRAND_AD_PROPOSITION', 'BRAND_AD_CONCEPT', 'BRAND_AD_STORY', 'BRAND_AD_REVIEW', 'BRAND_AD_REVIEW', 'BRAND_AD_REVIEW']


@pytest.mark.parametrize('failed', [False, True])
async def test_repair_recheck_persist_separately_and_resume_without_repaying(failed: bool) -> None:
    api, provider = Api(), Provider('DRAMA', repair=True, recheck_error=failed)
    p = Pipeline(api, provider, value('DRAMA'), [], [])  # type: ignore[arg-type]
    await p.run()
    assert provider.calls == ['DRAMA_CONCEPT', 'DRAMA_CONCEPT', 'DRAMA_STORY', 'DRAMA_REVIEW', 'DRAMA_REVIEW', 'REPAIR', 'RECHECK', 'RECHECK']
    assert ('RECHECK', 's0') in p.checkpoints
    checkpoints = [{'nodeId': node, 'scriptId': sid, **step} for (node, sid), step in p.checkpoints.items()]
    provider.calls.clear()
    resumed_api = Api()
    await Pipeline(resumed_api, provider, value('DRAMA'), checkpoints, []).run()  # type: ignore[arg-type]
    assert provider.calls == []
    assert any(path == 'scripts' for path, _ in resumed_api.calls) is not failed


def test_structure_mapping_allows_two_requirements_in_one_natural_chapter_but_rejects_fabricated_quote() -> None:
    story = TypedDraft.model_validate(draft()).story()
    requirements = [{'id': 'R01', 'title': '吸引注意'}, {'id': 'R02', 'title': '价值兑现'}]
    assert mapping_issues(story, requirements) == []
    story.structureMapping[0].evidence = '不存在的引文'
    assert mapping_issues(story, requirements) == [{'code': 'STRUCTURE_MAPPING_EVIDENCE'}]


def test_shared_schemas_match_worker_models() -> None:
    from customized_storyboard.typed_longform import Outline, Passage
    root = Path(__file__).resolve().parents[3] / 'packages/contracts/schemas'
    for name, model in [('concepts', TypedConcepts), ('draft', TypedDraft), ('review', TypedReview), ('review-v4', TypedReviewV4), ('review-evidence', EvidenceReview), ('review-observed', ObservedReview), ('review-editorial', EditorialReview), ('creative-options', CreativeSlate), ('revision', TypedRevision), ('patch', TypedPatch), ('outline', Outline), ('passage', Passage)]:
        assert json.loads((root / f'customized-typed-script-{name}.schema.json').read_text('utf-8')) == model.model_json_schema()


def test_evidence_index_keeps_full_body_and_resolves_exact_text() -> None:
    story = TypedDraft.model_validate(draft()).story()
    context, sources = evidence_context(story)
    assert '\n\n'.join([context['beats'][0]['heading']] + [e['text'] for e in context['beats'][0]['excerpts']]) == story.beats[0].content
    review = EvidenceReview.model_validate({'summary': '检查', 'findings': [], 'routeId': 'BRAND_AD',
        'qualityChecks': [{'criterion': c, 'evidenceId': 'P01:E01', 'verdict': 'PASS', 'reason': '实际依据', 'suggestion': ''} for c in QUALITY_CRITERIA['BRAND_AD']]})
    resolved = resolve_evidence(review, sources)
    assert all(c.evidence == context['beats'][0]['excerpts'][0]['text'] and c.beatIds == ['P01'] for c in resolved.qualityChecks)


@pytest.mark.parametrize('assessment,expected', [('DEMONSTRATED', 'PASS'), ('CONTRADICTED', 'FAIL'), ('NOT_DEMONSTRATED', 'FAIL')])
@pytest.mark.parametrize('product', ['燕麦片', '保湿霜', '预约软件', '双肩包'])
def test_observation_verdict_uses_ai_decision_not_product_keywords(assessment: str, expected: str, product: str) -> None:
    from customized_storyboard.typed_creation import materialize_quality_findings
    quote = f'她把{product}放在桌边，等对方作出回应。'
    result = ObservedReview.model_validate({'routeId': 'BRAND_AD', 'summary': '真实观察', 'findings': [],
        'qualityChecks': [{'criterion': c, 'evidenceId': 'P01:E01', 'observed': '具体画面关系',
            'defectScope': 'NONE', 'limitation': '缺乏后续发展', 'suggestion': '补充实际发展', 'assessment': assessment}
            for c in QUALITY_CRITERIA['BRAND_AD']]})
    resolved = resolve_observations(result, {'P01:E01': ('P01', quote)})
    materialize_quality_findings(resolved)
    assert all(c.verdict == expected and c.evidence == quote for c in resolved.qualityChecks)
    assert bool(resolved.findings) == (expected == 'FAIL')
    assert all(f.severity == 'ERROR' for f in resolved.findings)


def test_observation_missing_defect_detail_or_unknown_evidence_cannot_pass() -> None:
    data = {'routeId': 'DRAMA', 'summary': '核查', 'findings': [], 'qualityChecks': [
        {'criterion': c, 'evidenceId': 'P01:E01', 'observed': '实际对白', 'defectScope': 'NONE', 'limitation': '',
         'suggestion': '', 'assessment': 'NOT_DEMONSTRATED'} for c in QUALITY_CRITERIA['DRAMA']]}
    with pytest.raises(ValueError, match='concrete limitation'):
        resolve_observations(ObservedReview.model_validate(data), {})
    for check in data['qualityChecks']:
        check['limitation'], check['suggestion'] = '以台词解释寓意', '改为可见行动'
    with pytest.raises(ValueError, match='unknown evidence'):
        resolve_observations(ObservedReview.model_validate(data), {})


def test_v6_frozen_writing_strategy_is_not_replaced_by_v7() -> None:
    from customized_storyboard.routes import brand_ad, drama
    assert strategy_for('BRAND_AD', '2026-10-13.6') is brand_ad
    assert strategy_for('DRAMA', '2026-10-13.6') is drama
    assert strategy_for('DRAMA', VERSION) is not drama


def test_structural_defect_cannot_be_excused_by_positive_overall_assessment() -> None:
    item = {'criterion': 'NATURAL_DIALOGUE', 'evidenceId': 'P01:E01', 'observed': '角色在主题问答中解释关系',
        'limitation': '跨段落反复讲道理驱动转折', 'suggestion': '以实际选择和反应承担转折',
        'defectScope': 'STRUCTURAL', 'assessment': 'DEMONSTRATED'}
    checks = [{**item, 'criterion': c} for c in QUALITY_CRITERIA['DRAMA']]
    review = ObservedReview.model_validate({'routeId': 'DRAMA', 'qualityChecks': checks, 'summary': '审校', 'findings': []})
    output = resolve_observations(review, {'P01:E01': ('P01', '人物连续解释主题，对方反复认可其道理。')})
    assert all(check.verdict == 'FAIL' for check in output.qualityChecks)


async def test_editorial_failure_resumes_only_missing_audit_not_facts_or_story() -> None:
    from ai_runtime.responses import ProviderError
    class InterruptedEditor(Provider):
        failed = False
        roles: list[str] = []

        async def generate(self, stage: str, model: str, schema: Any, context: Any, instruction: str) -> Any:
            if context.get('auditRole'):
                self.roles.append(context['auditRole'])
            if context.get('auditRole') == 'EDITORIAL' and not self.failed:
                self.failed = True
                raise ProviderError('temporary outage', retryable=True)
            return await super().generate(stage, model, schema, context, instruction)
    provider = InterruptedEditor('BRAND_AD')
    provider.roles = []
    first = Pipeline(Api(), provider, value(), [], [])  # type: ignore[arg-type]
    await first.run()
    saved = first.checkpoints['BRAND_AD_REVIEW', 's0']['output']
    assert 'factReview' in saved and 'editorialReview' not in saved
    checkpoints = [{'nodeId': node, 'scriptId': sid, **step} for (node, sid), step in first.checkpoints.items()]
    api = Api()
    await Pipeline(api, provider, value(), checkpoints, []).run()  # type: ignore[arg-type]
    assert provider.roles.count('FACTS') == 1 and provider.roles.count('EDITORIAL') == 2
    assert provider.calls.count('BRAND_AD_STORY') == 1
    assert any(path == 'scripts' for path, _ in api.calls)


async def test_sparse_patch_preserves_untouched_body_and_rejects_invalid_paths() -> None:
    provider = Provider('BRAND_AD')
    concepts = await provider.generate('BRAND_AD_CONCEPT', '', TypedConcepts, {'settings': {}, 'scriptIds': ['s0']}, STRATEGIES['BRAND_AD'].PLAN)
    story = TypedDraft.model_validate(draft()).story()
    second = story.beats[0].model_copy(update={'id': 'P02', 'content': 'P02｜收束\n\n晨光在桌上停住。'})
    story.beats.append(second)
    story.content += '\n\n' + second.content
    patch = TypedPatch.model_validate({'reason': '局部展开', 'replacements': [{'beatId': 'P01', 'content': story.beats[0].content + '光线继续移动。', 'durationSeconds': 34, 'reason': '增加变化'}], 'metadata': [], 'concept': concepts.concepts[0].model_dump(), 'structureMapping': [m.model_dump() for m in story.structureMapping]})
    requirements = [{'id': 'R01', 'title': '吸引注意'}, {'id': 'R02', 'title': '价值兑现'}]
    revised, changes = apply_patch(story, patch, requirements)
    assert revised.beats[1] == second
    assert len(changes) == 1
    patch.replacements[0].beatId = 'P99'
    with pytest.raises(ValueError, match='patch path'):
        apply_patch(story, patch, requirements)


async def test_output_overflow_uses_natural_parts_and_recovers_only_missing_part() -> None:
    from ai_runtime.responses import ProviderError, ProviderErrorType

    class OverflowProvider(Provider):
        paused = True
        body_calls: list[str] = []

        async def generate(self, stage: str, model: str, schema: Any, context: Any, instruction: str) -> Any:
            if schema.__name__ == 'TypedDraft':
                self.body_calls.append('full')
                raise ProviderError('output limit', retryable=False, error_type=ProviderErrorType.OUTPUT_TRUNCATED)
            if schema.__name__ == 'Outline':
                self.body_calls.append('outline')
                return schema.model_validate({'title': '晨光', 'opening': '', 'development': '', 'ending': '', 'dialoguePlan': '', 'parts': [{'id': f'P{i:02d}', 'title': '晨光变化', 'development': '光线移动', 'continuity': '相邻空间'} for i in (1, 2)]})
            if schema.__name__ == 'Passage':
                bid = context['currentPart']['id']
                self.body_calls.append(bid)
                if bid == 'P02' and self.paused:
                    self.paused = False
                    raise ProviderError('temporary outage', retryable=True)
                assert len(context['previousParts']) == (0 if bid == 'P01' else 1)
                return schema.model_validate({'beat': {'id': bid, 'content': bid + '｜晨光变化\n\n光线经过橙色端口，在桌面延展。', 'durationSeconds': 20}})
            return await super().generate(stage, model, schema, context, instruction)

    value_without_structure = value()
    value_without_structure['settings'].update({'structureMode': 'AI', 'structureSections': []})
    provider, api = OverflowProvider('BRAND_AD'), Api()
    provider.body_calls = []
    p = Pipeline(api, provider, value_without_structure, [], [])  # type: ignore[arg-type]
    await p.run()
    assert not any(path == 'scripts' for path, _ in api.calls)
    assert provider.body_calls == ['full', 'outline', 'P01', 'P02']
    checkpoints = [{'nodeId': node, 'scriptId': sid, **step} for (node, sid), step in p.checkpoints.items()]
    recovered = Api()
    await Pipeline(recovered, provider, value_without_structure, checkpoints, []).run()  # type: ignore[arg-type]
    assert provider.body_calls == ['full', 'outline', 'P01', 'P02', 'P02']
    assert any(path == 'scripts' for path, _ in recovered.calls)


async def test_concept_retry_reuses_candidate_slate_and_preserves_source() -> None:
    from ai_runtime.responses import ProviderError
    class InterruptedSelection(Provider):
        interrupted = False
        slate_calls = 0
        async def generate(self, stage: str, model: str, schema: Any, context: Any, instruction: str) -> Any:
            if schema is BrandDevelopment:
                self.slate_calls += 1
            elif stage.endswith('_CONCEPT') and not self.interrupted:
                self.interrupted = True
                raise ProviderError('temporary outage', retryable=True)
            return await super().generate(stage, model, schema, context, instruction)
    provider = InterruptedSelection('BRAND_AD')
    first = Pipeline(Api(), provider, value(), [], [])  # type: ignore[arg-type]
    with pytest.raises(ProviderError):
        await first.run()
    checkpoints = [{'nodeId': node, 'scriptId': sid, **step} for (node, sid), step in first.checkpoints.items()]
    api = Api()
    await Pipeline(api, provider, value(), checkpoints, []).run()  # type: ignore[arg-type]
    assert provider.slate_calls == 1
    assert any(path == 'scripts' for path, _ in api.calls)


def test_editorial_schema_disallows_shot_references_before_provider_result_acceptance() -> None:
    from customized_storyboard.review_calibration import EditorialFinding
    with pytest.raises(ValueError):
        EditorialFinding.model_validate({'severity': 'WARNING', 'category': 'STORY',
            'shotIds': ['P01:E01'], 'beatIds': ['P01'], 'message': '问题', 'evidence': '正文', 'suggestion': '修改'})
