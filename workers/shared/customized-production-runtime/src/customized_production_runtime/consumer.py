from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Any

import aio_pika
from ai_runtime.http import InternalApiError
from ai_runtime.responses import ProviderError

from .api import Api
from .models import QueueMessage
from .pipeline import run
from .image_generation import run_image
from .video_render import run_video
from .provider import Provider, task_context


@dataclass(frozen=True)
class NodeWorker:
    namespace: str
    queue: str
    token_env: str
    operations: tuple[str, ...]


WORKERS = {
    'ASSETS': NodeWorker('customized-assets', 'customized.assets.requested', 'CUSTOMIZED_ASSETS_WORKER_TOKEN', ('ASSETS', 'IMAGE')),
    'VIDEO': NodeWorker('customized-production', 'customized.production.requested', 'CUSTOMIZED_PRODUCTION_WORKER_TOKEN', ('SHOTS', 'PROMPT', 'RENDER')),
}


def required(name: str) -> str:
    value = os.getenv(name, '').strip()
    if not value:
        raise ValueError(f'{name} is required')
    return value


def validate_claim(worker: NodeWorker, claim: dict[str, Any]) -> None:
    if claim['input']['operation'] not in worker.operations:
        raise ValueError('task does not belong to this node worker')


async def keep_lease(api: Api) -> None:
    # Server leases last 90 seconds. Stop before that boundary; a brief API
    # restart must not immediately cancel an in-flight paid response.
    last_success = time.monotonic()
    delay = 20.0
    while True:
        await asyncio.sleep(delay)
        remaining = 75 - (time.monotonic() - last_success)
        if remaining <= 0:
            raise InternalApiError('lease renewal unavailable', retryable=True)
        try:
            await asyncio.wait_for(api.call('PUT', 'heartbeat'), timeout=remaining)
            last_success = time.monotonic()
            delay = 20.0
        except asyncio.TimeoutError as error:
            raise InternalApiError('lease renewal unavailable', retryable=True) from error
        except InternalApiError as error:
            if not error.retryable:
                raise
            logging.warning('Lease renewal query interrupted; retrying within lease budget')
            delay = 2.0


async def execute(api: Api, provider: Provider, worker: NodeWorker) -> None:
    pending: list[asyncio.Task[None]] = []
    try:
        try:
            claim = await api.call('POST', 'claim')
        except InternalApiError as error:
            if error.status_code == 409 and worker.namespace == 'customized-production':
                # Old queue messages contain identifiers only. The API re-enqueues
                # a queued ASSETS task transactionally through its existing Outbox.
                await api.call('POST', 'route')
                return
            raise
        if claim.get('terminal') or claim.get('busy'):
            return
        validate_claim(worker, claim)
        api.token = claim['attemptToken']

        pipeline = run_image if claim['input']['operation'] == 'IMAGE' else run_video if claim['input']['operation'] == 'RENDER' else run
        pending = [asyncio.create_task(keep_lease(api)), asyncio.create_task(pipeline(api, provider, claim))]
        done, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            await task
    except InternalApiError as error:
        if error.status_code not in {404, 409}:
            raise
    except Exception as error:
        logging.error('Node task incomplete type=%s', type(error).__name__)
        if api.token:
            await api.call('POST', 'fail', {'retryable': isinstance(error, ProviderError) and error.retryable})
        else:
            raise
    finally:
        for task in pending:
            if not task.done():
                task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


async def consume(role: str) -> None:
    worker = WORKERS[role]
    url, token = required('INTERNAL_API_BASE_URL'), required(worker.token_env)
    prefix = 'CUSTOMIZED_ASSETS' if role == 'ASSETS' else 'CUSTOMIZED_PRODUCTION'
    provider = Provider(
        os.getenv('ARK_BASE_URL', 'https://ark.cn-beijing.volces.com/api/v3'),
        required('ARK_API_KEY'),
        max(1, min(2 if role=='VIDEO' else 4, int(os.getenv(f'{prefix}_CONCURRENCY', '2')))),
        max(10, float(os.getenv(f'{prefix}_TIMEOUT_SECONDS', '300'))),
        max(1, min(3, int(os.getenv(f'{prefix}_MAX_ATTEMPTS', '2')))),
    )
    connection = await aio_pika.connect_robust(required('RABBITMQ_URL'))
    try:
        channel = await connection.channel(publisher_confirms=True)
        await channel.set_qos(prefetch_count=1)
        queue = await channel.declare_queue(worker.queue, durable=True)
        logging.info('Node worker ready node=%s queue=%s', role, worker.queue)
        async with queue.iterator() as messages:
            async for message in messages:
                async with message.process(requeue=True, ignore_processed=True):
                    try:
                        event = QueueMessage.model_validate_json(message.body)
                    except ValueError:
                        logging.error('Invalid node task message')
                        continue
                    api = Api(url, token, event.projectId, event.runId, worker.namespace)
                    task_context.set(event.runId)
                    try:
                        await execute(api, provider, worker)
                    except InternalApiError as error:
                        if not error.retryable:
                            raise
                        logging.warning('Internal API temporarily unavailable; task message requeued')
                        await message.nack(requeue=True)
                        await asyncio.sleep(2)
                    finally:
                        await api.close()
    finally:
        await provider.close()
        await connection.close()


def main(role: str) -> None:
    logging.basicConfig(level=logging.INFO)
    logging.getLogger('httpx').setLevel(logging.WARNING)
    asyncio.run(consume(role))
