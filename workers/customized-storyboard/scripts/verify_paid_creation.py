"""Real model pipeline against local checkpoints; never writes to project APIs."""
import argparse
import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import time

from customized_storyboard.pipeline import Pipeline
from customized_storyboard.provider import Provider


async def main():
    if os.getenv('CUSTOMIZED_STORYBOARD_PAID_TEST') != '1':
        raise RuntimeError('Explicit paid authorization required')
    parser = argparse.ArgumentParser()
    parser.add_argument('input')
    parser.add_argument('output')
    parser.add_argument('--concurrency', type=int, choices=[1,2], default=1)
    args = parser.parse_args()
    data = json.loads(Path(args.input).read_text('utf-8-sig'))
    if data.get('graphVersion') != 'TYPED_CREATION_V1' or data.get('outputMode') != 'STORY_ONLY':
        raise ValueError('Expected frozen story-only pipeline input')
    destination = Path(args.output)
    fingerprint = hashlib.sha256(json.dumps(data,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    state = json.loads(destination.read_text('utf-8')) if destination.exists() else {
        'fingerprint':fingerprint,'checkpoints':[],'scripts':[],'calls':[],'runs':[],
    }
    if state['fingerprint'] != fingerprint:
        raise ValueError('Input changed; use a different output')

    def persist():
        destination.parent.mkdir(parents=True,exist_ok=True)
        destination.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

    class MeasuredProvider(Provider):
        async def _structured(self,*values,**kwargs):
            result = await super()._structured(*values,**kwargs)
            state['calls'].append(result.metadata.as_dict())
            persist()
            return result

    class LocalApi:
        async def call(self,method,path,payload=None):
            if path == 'steps':
                state['checkpoints'] = [c for c in state['checkpoints'] if (c['nodeId'],c['scriptId']) != (payload['nodeId'],payload['scriptId'])]
                state['checkpoints'].append(payload)
            elif path == 'scripts':
                script = payload['script']
                if script['id'] not in data['scriptIds']:
                    raise ValueError('Script outside frozen input')
                state['scripts'] = [s for s in state['scripts'] if s['id'] != script['id']] + [script]
            elif path == 'finish':
                state['finish'] = payload
            else:
                raise ValueError('Local verification cannot call remote API')
            persist()
            return {}

    provider = MeasuredProvider(os.getenv('ARK_BASE_URL','https://ark.cn-beijing.volces.com/api/v3'),os.environ['ARK_API_KEY'],concurrency=args.concurrency)
    started = time.monotonic()
    try:
        pipeline = Pipeline(LocalApi(),provider,data,state['checkpoints'],[s['id'] for s in state['scripts']])
        await pipeline.run()
        state['complete'] = len(state['scripts']) == len(data['scriptIds'])
        state.pop('failure',None)
    except Exception as error:
        state['failure'] = type(error).__name__
        raise
    finally:
        state['runs'].append({'seconds':round(time.monotonic()-started,2)})
        persist()
        await provider.close()
    print(json.dumps({'complete':state['complete'],'scripts':len(state['scripts']),'calls':len(state['calls']),'seconds':state['runs'][-1]['seconds']}))
    if not state['complete']:
        raise RuntimeError('Model pipeline incomplete; inspect persisted checkpoints')


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
