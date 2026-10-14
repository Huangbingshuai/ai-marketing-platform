"""Paid paired review of a frozen body; no API writes or new script publication."""
import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import sys
import time

from customized_storyboard.pipeline import Pipeline
from customized_storyboard.provider import Provider
from customized_storyboard.routes import strategy_for
from customized_storyboard.screenplay import review_context
from customized_storyboard.typed_creation import TypedStory, REVIEW, generate_review


async def main():
    if os.getenv('CUSTOMIZED_STORYBOARD_PAID_TEST') != '1':
        raise RuntimeError('Explicit paid authorization required')
    fixture = json.loads(Path(sys.argv[1]).read_text('utf-8-sig'))
    destination = Path(sys.argv[2])
    effort = sys.argv[3]
    if effort not in {'medium', 'high', 'configured'}:
        raise ValueError('Unsupported review effort')
    fingerprint = hashlib.sha256(json.dumps([fixture, effort], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    state = json.loads(destination.read_text('utf-8')) if destination.exists() else {'fingerprint': fingerprint, 'calls': []}
    if state['fingerprint'] != fingerprint:
        raise ValueError('Replay input changed; use another output')
    if 'result' in state:
        print(json.dumps({'restored': True, 'seconds': state['seconds']}))
        return

    def persist():
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', 'utf-8')

    class ReplayProvider(Provider):
        async def _structured(self, *args, **kwargs):
            if effort != 'configured':
                kwargs['reasoning_effort'] = effort
            result = await super()._structured(*args, **kwargs)
            state['calls'].append(result.metadata.as_dict())
            state.setdefault('reviews', []).append(result.value.model_dump())
            persist()
            return result

    class LocalApi:
        async def call(self, method, path, payload):
            if path != 'steps':
                raise RuntimeError('Replay must not publish')
            state['checkpoint'] = payload
            persist()

    provider = ReplayProvider(os.getenv('ARK_BASE_URL', 'https://ark.cn-beijing.volces.com/api/v3'), os.environ['ARK_API_KEY'])
    started = time.monotonic()
    try:
        data = fixture['input']
        checkpoints = [state['checkpoint']] if state.get('checkpoint') else []
        pipeline = Pipeline(LocalApi(), provider, data, checkpoints, [])
        pipeline.context['strategyVersion'] = data['strategyVersions']['review']
        pipeline.context['structureRequirements'] = [{'id': f'R{i+1:02d}', 'title': title} for i, title in enumerate(data['settings'].get('structureSections', []))]
        story = TypedStory.model_validate(fixture['story'])
        result = await generate_review(pipeline, data['routeId'] + '_REVIEW', data['scriptIds'][0],
            {'story': review_context(story, True), **({'commerceCommitment': fixture['commerceCommitment']} if 'commerceCommitment' in fixture else {})}, strategy_for(data['routeId'], data['strategyVersions']['review']).REVIEW + REVIEW, story)
        state['result'] = result.model_dump()
        if 'failure' in state:
            state['recoveredFailure'] = state.pop('failure')
        state['seconds'] = round(time.monotonic() - started, 2)
        persist()
        print(json.dumps({'seconds': state['seconds'], 'calls': len(state['calls']), 'verdicts': [c['verdict'] for c in state['result']['qualityChecks']]}))
    except Exception as error:
        state['failure'] = type(error).__name__
        persist()
        raise RuntimeError('Review replay did not pass validation; inspect local evidence') from None
    finally:
        await provider.close()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
