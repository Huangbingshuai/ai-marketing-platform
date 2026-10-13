from __future__ import annotations
import asyncio
import logging
import os
import aio_pika
from ai_runtime.http import InternalApiError
from ai_runtime.responses import ProviderError
from .api import Api
from .provider import Provider, task_context
from .models import QueueMessage
from .production import run

def required(name: str) -> str:
    value=os.getenv(name,'').strip()
    if not value: raise ValueError(f'{name} is required')
    return value

async def consume() -> None:
    api_url=required('INTERNAL_API_BASE_URL')
    worker_token=required('CUSTOMIZED_PRODUCTION_WORKER_TOKEN')
    provider=Provider(os.getenv('ARK_BASE_URL','https://ark.cn-beijing.volces.com/api/v3'),required('ARK_API_KEY'),2)
    connection=await aio_pika.connect_robust(required('RABBITMQ_URL'))
    try:
        channel=await connection.channel(publisher_confirms=True)
        await channel.set_qos(prefetch_count=1)
        queue=await channel.declare_queue('customized.production.requested',durable=True)
        logging.info('Customized production worker ready')
        async with queue.iterator() as messages:
            async for message in messages:
                async with message.process(requeue=True):
                    try: event=QueueMessage.model_validate_json(message.body)
                    except ValueError:
                        logging.error('Invalid production message');continue
                    api=Api(api_url,worker_token,event.projectId,event.runId,'customized-production')
                    task_context.set(event.runId)
                    pending:list[asyncio.Task[None]]=[]
                    try:
                        claim=await api.call('POST','claim')
                        if claim.get('terminal') or claim.get('busy'): continue
                        api.token=claim['attemptToken']
                        async def heartbeat() -> None:
                            while True:
                                await asyncio.sleep(20)
                                await api.call('PUT','heartbeat')
                        pending=[asyncio.create_task(heartbeat()),asyncio.create_task(run(api,provider,claim))]
                        done,_=await asyncio.wait(pending,return_when=asyncio.FIRST_COMPLETED)
                        for task in done: await task
                    except InternalApiError as e:
                        if e.status_code not in {404,409}: raise
                    except Exception as e:
                        logging.error('Production incomplete type=%s',type(e).__name__)
                        if api.token: await api.call('POST','fail',{'retryable':isinstance(e,ProviderError) and e.retryable})
                    finally:
                        for task in pending:
                            if not task.done():task.cancel()
                        await asyncio.gather(*pending,return_exceptions=True)
                        await api.close()
    finally:
        await provider.close();await connection.close()

if __name__=='__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(consume())
