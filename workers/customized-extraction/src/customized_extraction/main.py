from __future__ import annotations
import asyncio
import logging
import os
import aio_pika
from extraction_runtime.docling_parser import LocalDoclingParser
from extraction_runtime.http import InternalApiError
from .api import Api
from .models import QueueMessage
from .pipeline import Pipeline, PartialFailure
from .provider import Provider


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


async def consume() -> None:
    worker_token = required("CUSTOMIZED_EXTRACTION_WORKER_TOKEN")
    provider = Provider(
        os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        required("ARK_API_KEY"),
        os.getenv("ARK_DOCUMENT_MODEL", "doubao-seed-2-1-pro-260628"),
        timeout=float(os.getenv("ARK_DOCUMENT_TIMEOUT_SECONDS", "180")),
        max_attempts=int(os.getenv("ARK_DOCUMENT_MAX_ATTEMPTS", "2")),
        max_output_tokens=int(os.getenv("ARK_DOCUMENT_MAX_OUTPUT_TOKENS", "8192")),
    )
    parser = LocalDoclingParser(
        artifacts_path=os.getenv("DOCLING_ARTIFACTS_PATH"),
        max_file_size=100 * 1024 * 1024,
        max_num_pages=int(os.getenv("DOCLING_MAX_PAGES", "200")),
    )
    connection = await aio_pika.connect_robust(required("RABBITMQ_URL"))
    try:
        channel = await connection.channel(publisher_confirms=True)
        await channel.set_qos(prefetch_count=1)
        queue = await channel.declare_queue(
            os.getenv("CUSTOMIZED_EXTRACTION_QUEUE", "customized.extraction.requested"),
            durable=True,
        )
        async with queue.iterator() as messages:
            async for message in messages:
                async with message.process(requeue=True):
                    try:
                        event = QueueMessage.model_validate_json(message.body)
                    except ValueError:
                        logging.error("Invalid customized extraction event")
                        continue
                    api = Api(
                        required("INTERNAL_API_BASE_URL"),
                        worker_token,
                        event.projectId,
                        event.runId,
                    )
                    heartbeat: asyncio.Task[None] | None = None
                    execution: asyncio.Task[None] | None = None
                    try:
                        claim = await api.call("POST", "claim")
                        if claim.get("terminal") or claim.get("busy"):
                            continue
                        api.token = claim["attemptToken"]
                        pipeline = Pipeline(
                            api,
                            parser,
                            provider,
                            claim["input"],
                            claim["checkpoints"],
                            concurrency=max(
                                1,
                                min(4, int(os.getenv("DOCUMENT_MAX_CONCURRENCY", "2"))),
                            ),
                            chunk_chars=int(
                                os.getenv("DOCUMENT_CHUNK_TEXT_CHARS", "12000")
                            ),
                        )
                        heartbeat = asyncio.create_task(pipeline.heartbeat())
                        execution = asyncio.create_task(pipeline.run())
                        done, _ = await asyncio.wait(
                            [heartbeat, execution], return_when=asyncio.FIRST_COMPLETED
                        )
                        for task in done:
                            await task
                    except InternalApiError as error:
                        if error.status_code not in {404, 409}:
                            raise
                    except Exception as error:
                        logging.error(
                            "Extraction failed project=%s task=%s type=%s",
                            event.projectId,
                            event.runId,
                            type(error).__name__,
                        )
                        if api.token:
                            await api.call(
                                "POST",
                                "fail",
                                {"partial": isinstance(error, PartialFailure)},
                            )
                    finally:
                        for pending in (heartbeat, execution):
                            if pending and not pending.done():
                                pending.cancel()
                        await asyncio.gather(
                            *(t for t in (heartbeat, execution) if t),
                            return_exceptions=True,
                        )
                        await api.close()
    finally:
        await provider.close()
        await connection.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(consume())
