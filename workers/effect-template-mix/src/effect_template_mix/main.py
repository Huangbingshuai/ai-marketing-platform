import asyncio
import logging

from .api import InternalApi
from .config import get_settings
from .consumer import Consumer
from .provider import ArkProvider


async def serve() -> None:
    settings = get_settings()
    api = InternalApi(str(settings.internal_api_base_url), settings.worker_token.get_secret_value(), settings.api_timeout_seconds)
    provider = ArkProvider(
        settings.ark_base_url,
        settings.ark_api_key.get_secret_value(),
        settings.model,
        settings.ark_timeout_seconds,
        settings.ark_max_output_tokens,
        settings.ark_reasoning_effort,
    )
    consumer = Consumer(
        settings.rabbitmq_url.get_secret_value(),
        settings.queue_name,
        api,
        provider,
        settings.max_video_bytes,
        settings.classification_batch_size,
        settings.classification_input_token_budget,
        settings.ark_max_output_tokens,
        settings.ai_max_concurrency,
    )
    try:
        await consumer.run()
    finally:
        await consumer.close()
        await api.close()
        await provider.close()


def main() -> None:
    settings = get_settings()
    logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(serve())


if __name__ == "__main__":
    main()
