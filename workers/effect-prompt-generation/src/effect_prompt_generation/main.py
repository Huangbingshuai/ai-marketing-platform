from __future__ import annotations

import asyncio
import logging

from .api_client import HttpInternalApi
from .config import WorkerSettings, get_settings
from .consumer import PromptGenerationConsumer
from .graph import build_graph
from .pipeline import PromptGenerationPipeline
from .providers import AiProvider, ArkResponsesProvider, MockAiProvider


def _provider(settings: WorkerSettings) -> AiProvider:
    if settings.prompt_ai_provider == "mock":
        return MockAiProvider()
    assert settings.ark_api_key is not None
    return ArkResponsesProvider(
        base_url=settings.ark_base_url,
        api_key=settings.ark_api_key.get_secret_value(),
        model=settings.resolved_prompt_model,
        timeout=settings.ark_timeout_seconds,
    )


async def serve(settings: WorkerSettings) -> None:
    api = HttpInternalApi(
        str(settings.internal_api_base_url),
        settings.effect_prompt_worker_token.get_secret_value(),
        timeout=settings.api_timeout_seconds,
    )
    provider = _provider(settings)
    pipeline = PromptGenerationPipeline(
        api=api,
        provider=provider,
        shard_size=settings.prompt_shard_size,
    )
    consumer = PromptGenerationConsumer(
        rabbitmq_url=settings.rabbitmq_url.get_secret_value(),
        queue_name=settings.effect_prompt_queue,
        api=api,
        pipeline=pipeline,
        graph=build_graph(pipeline),
        max_concurrency=settings.prompt_max_concurrency,
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
