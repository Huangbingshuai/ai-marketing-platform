from __future__ import annotations

import asyncio
import logging

from .api_client import HttpInternalApi
from .config import WorkerSettings, get_settings
from .consumer import ExtractionConsumer
from .docling_parser import LocalDoclingParser
from .graph import build_graph
from .image_processing import ImageProcessor
from .pipeline import ExtractionPipeline
from .providers import AiProvider, ArkResponsesProvider, MockAiProvider


def _provider(settings: WorkerSettings) -> AiProvider:
    if settings.extraction_ai_provider == "mock":
        return MockAiProvider()
    assert settings.ark_api_key is not None
    assert settings.ark_model is not None
    return ArkResponsesProvider(
        base_url=str(settings.ark_base_url),
        api_key=settings.ark_api_key.get_secret_value(),
        model=settings.ark_model,
        timeout=settings.ark_timeout_seconds,
    )


async def serve(settings: WorkerSettings) -> None:
    api = HttpInternalApi(
        str(settings.internal_api_base_url),
        settings.effect_extraction_worker_token.get_secret_value(),
        timeout=settings.api_timeout_seconds,
    )
    provider = _provider(settings)
    pipeline = ExtractionPipeline(
        api=api,
        provider=provider,
        document_parser=LocalDoclingParser(
            artifacts_path=settings.docling_artifacts_path,
            max_file_size=settings.docling_max_file_size,
            max_num_pages=settings.docling_max_num_pages,
        ),
        image_processor=ImageProcessor(
            max_input_bytes=settings.image_max_input_bytes,
            max_dimension=settings.image_max_dimension,
            max_output_bytes=settings.image_max_output_bytes,
        ),
        max_document_text_chars=settings.max_document_text_chars,
    )
    consumer = ExtractionConsumer(
        rabbitmq_url=settings.rabbitmq_url.get_secret_value(),
        queue_name=settings.effect_extraction_queue,
        api=api,
        pipeline=pipeline,
        graph=build_graph(pipeline),
    )
    try:
        await consumer.run()
    finally:
        await consumer.close()
        await api.aclose()
        close = getattr(provider, "aclose", None)
        if close is not None:
            await close()


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(serve(settings))


if __name__ == "__main__":
    main()
