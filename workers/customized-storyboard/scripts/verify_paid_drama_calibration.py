"""Paid, body-only drama calibration. Offline expectations never enter model input."""
import argparse
import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
from pathlib import Path
import time

from customized_storyboard.provider import Provider
from customized_storyboard.routes import DRAMA_VERSIONS, strategy_for
from ai_runtime.responses import ProviderError
from customized_storyboard.review_calibration import EditorialReview, resolve_observations
from customized_storyboard.drama_audit import DramaEditorialReview, DramaMeritReview, resolve_drama_audit, resolve_drama_merit
from customized_storyboard.review_evidence import evidence_context, EVIDENCE_INSTRUCTION
from customized_storyboard.typed_creation import TypedStory, check_review, materialize_quality_findings


async def main():
    if os.getenv('CUSTOMIZED_STORYBOARD_PAID_TEST') != '1':
        raise RuntimeError('Explicit paid authorization required')
    parser = argparse.ArgumentParser()
    parser.add_argument('cases')
    parser.add_argument('output')
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    if args.version not in DRAMA_VERSIONS:
        raise ValueError('Unsupported frozen drama strategy')
    cases = json.loads(Path(args.cases).read_text('utf-8-sig'))
    destination = Path(args.output)
    fingerprint = hashlib.sha256(json.dumps([cases,args.version],ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    state = json.loads(destination.read_text('utf-8')) if destination.exists() else {'fingerprint':fingerprint,'version':args.version,'results':[],'calls':[]}
    if state['fingerprint'] != fingerprint:
        raise RuntimeError('Calibration input changed; use a new output')

    def persist():
        destination.parent.mkdir(parents=True,exist_ok=True)
        destination.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

    class MeasuredProvider(Provider):
        async def _structured(self,*values,**kwargs):
            response = await super()._structured(*values,**kwargs)
            state['calls'].append(response.metadata.as_dict())
            persist()
            return response

    provider = MeasuredProvider(os.getenv('ARK_BASE_URL','https://ark.cn-beijing.volces.com/api/v3'),os.environ['ARK_API_KEY'])
    async def diagnostic(response):
        if response.status_code != 401:
            return
        await response.aread()
        try:
            error = response.json().get('error', {})
            message = error.get('message', '')
            match = re.search(r'clientIP:\s*([0-9a-fA-F:.]+)', message)
            address = str(ipaddress.ip_address(match.group(1))) if match else None
            # Whitelist diagnostic only: never persist arbitrary supplier bodies or credentials.
            if error.get('code') == 'AuthenticationError' and 'IP whitelist' in message:
                state['whitelistRejection'] = {'sourceAddress':address}
                persist()
                print(json.dumps({'ipWhitelistRejected':True,'sourceAddress':address}),flush=True)
        except (ValueError, AttributeError, TypeError):
            pass
    provider._client.event_hooks['response'].append(diagnostic)
    try:
        for case in cases:
            if any(r['case']==case['id'] for r in state['results']):
                continue
            started = time.monotonic()
            story = TypedStory.model_validate(case['story'])
            body,sources = evidence_context(story)
            # Match production editorial scope. No case ID, expectation, author plan or facts coverage rubric.
            context = {'storyFormat':'VIDEO_SCRIPT_V3','strategyVersion':args.version,'auditRole':'EDITORIAL',
                'settings':{'videoType':'DRAMA'},'structureRequirements':[],'otherConcepts':[],
                'brief':{k:case['brief'].get(k,'') for k in ('brandName','brandTone','productName','targetAudience')},
                'story':{'beats':body['beats']}}
            strategy = strategy_for('DRAMA',args.version)
            review_schema = DramaMeritReview if getattr(strategy, 'MERIT_AUDIT', False) else DramaEditorialReview if getattr(strategy, 'MECHANISM_AUDIT', False) else EditorialReview
            instruction = strategy.REVIEW+'\n'+EVIDENCE_INSTRUCTION+'\n'+strategy.OBSERVATION
            pending = state.setdefault('pending',{})
            if pending.get('case') != case['id']:
                pending.clear()
                pending['case'] = case['id']
            for attempt in range(2):
                key = 'review' if not attempt else 'correctedReview'
                if key in pending:
                    decision = review_schema.model_validate(pending[key])
                else:
                    decision = await provider.generate('DRAMA_REVIEW',case['model'],review_schema,context,instruction)
                    pending[key] = decision.model_dump()
                    persist()
                try:
                    result = resolve_drama_merit(decision,sources) if isinstance(decision, DramaMeritReview) else resolve_drama_audit(decision,sources) if isinstance(decision, DramaEditorialReview) else resolve_observations(decision,sources)
                    if result.routeId != 'DRAMA':
                        raise ValueError('Calibration review route mismatch')
                    materialize_quality_findings(result)
                    check_review(result,story)
                    break
                except ValueError:
                    if attempt:
                        raise
                    context = {**context,'previousReview':decision.model_dump(),'correction':'只修正当前正文引用或结构，保留实质判断，不把失败改为通过。'}
            actual = {q.criterion:q.verdict for q in result.qualityChecks}
            state['results'].append({'case':case['id'],'seconds':round(time.monotonic()-started,2),
                'review':result.model_dump(),'actual':actual,'expected':case.get('expected',{}),
                **({'mechanism':decision.mechanism.model_dump()} if isinstance(decision, DramaEditorialReview) else {}),
                **({'viewingValue':decision.viewingValue.model_dump()} if isinstance(decision, DramaMeritReview) else {}),
                'matches':all(actual.get(k)==v for k,v in case.get('expected',{}).items())})
            pending.clear()
            persist()
            print(json.dumps({'case':case['id'],'seconds':state['results'][-1]['seconds'],'verdicts':actual,
                'errorCount':len([f for f in result.findings if f.severity=='ERROR'])}),flush=True)
    except ProviderError as error:
        state['lastFailure'] = {'type':error.error_type,'attempts':error.attempts}
        persist()
        raise
    finally:
        await provider.close()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
