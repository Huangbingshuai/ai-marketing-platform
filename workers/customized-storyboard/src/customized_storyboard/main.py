from __future__ import annotations
import asyncio
import logging
import os
import aio_pika
from ai_runtime.http import InternalApiError
from .api import Api
from .models import QueueMessage
from .pipeline import Pipeline
from .provider import Provider


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


async def consume() -> None:
    token = required("CUSTOMIZED_STORYBOARD_WORKER_TOKEN")
    url = required("INTERNAL_API_BASE_URL")
    provider = Provider(
        os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        required("ARK_API_KEY"),
        max(1, min(4, int(os.getenv("CUSTOMIZED_STORYBOARD_CONCURRENCY", "2")))),
        max(10, float(os.getenv("CUSTOMIZED_STORYBOARD_TIMEOUT_SECONDS", "300"))),
        max(1, min(3, int(os.getenv("CUSTOMIZED_STORYBOARD_MAX_ATTEMPTS", "2")))),
    )
    connection = await aio_pika.connect_robust(required("RABBITMQ_URL"))
    try:
        channel = await connection.channel(publisher_confirms=True)
        await channel.set_qos(prefetch_count=1)
        queue = await channel.declare_queue(
            os.getenv("CUSTOMIZED_STORYBOARD_QUEUE", "customized.storyboard.requested"),
            durable=True,
        )
        logging.info("Customized storyboard worker ready")
        async with queue.iterator() as messages:
            async for message in messages:
                async with message.process(requeue=True):
                    try:
                        event = QueueMessage.model_validate_json(message.body)
                    except ValueError:
                        logging.error("Invalid storyboard event")
                        continue
                    api = Api(url, token, event.projectId, event.runId)
                    tasks: list[asyncio.Task[None]] = []
                    try:
                        claim = await api.call("POST", "claim")
                        if claim.get("terminal") or claim.get("busy"):
                            continue
                        api.token = claim["attemptToken"]
                        pipeline = Pipeline(
                            api,
                            provider,
                            claim["input"],
                            claim["checkpoints"],
                            claim["completedScriptIds"],
                        )
                        tasks = [
                            asyncio.create_task(pipeline.heartbeat()),
                            asyncio.create_task(pipeline.run()),
                        ]
                        done, _ = await asyncio.wait(
                            tasks, return_when=asyncio.FIRST_COMPLETED
                        )
                        for task in done:
                            await task
                    except InternalApiError as error:
                        if error.status_code not in {404, 409}:
                            raise
                    except Exception as error:
                        logging.error(
                            "Storyboard incomplete type=%s", type(error).__name__
                        )
                        if api.token:
                            await api.call("POST", "finish")
                    finally:
                        for task in tasks:
                            if not task.done():
                                task.cancel()
                        await asyncio.gather(*tasks, return_exceptions=True)
                        await api.close()
    finally:
        await provider.close()
        await connection.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(consume())
