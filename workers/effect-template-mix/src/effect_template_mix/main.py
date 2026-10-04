import asyncio
import logging
from contextlib import suppress

from .api import InternalApi
from .config import get_settings
from .consumer import Consumer
from .provider import ArkProvider
from .packaging import PackagingHandler
from .packaging_provider import PackagingProvider
from .final_output import FinalOutputHandler
from .final_output_cache import SourceCache
from .caption_voice import CaptionVoiceHandler
from .voice_preview import VoicePreviewHandler


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
    packaging_provider = PackagingProvider(settings.tts_api_key.get_secret_value(), settings.tts_speaker,
        settings.tts_resource_id, settings.music_access_key.get_secret_value(), settings.music_secret_key.get_secret_value(), settings.music_action)
    packaging = PackagingHandler(api, provider, packaging_provider, settings.max_video_bytes,
        settings.packaging_item_concurrency, settings.packaging_model_concurrency, settings.packaging_tts_concurrency)
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
        packaging,
        FinalOutputHandler(api, settings.max_video_bytes, settings.final_output_max_concurrency, packaging),
        VoicePreviewHandler(api, packaging_provider, packaging.requests),
        CaptionVoiceHandler(api, packaging_provider, packaging.requests),
    )
    async def sweep_output_cache() -> None:
        while True:
            try:
                # Running once per minute with a 23h59m threshold bounds retention to 24h.
                await asyncio.to_thread(SourceCache.sweep, max_age_seconds=86_340)
            except OSError:
                logging.getLogger(__name__).warning('final output cache sweep failed')
            await asyncio.sleep(60)
    cache_sweeper = asyncio.create_task(sweep_output_cache())
    try:
        await consumer.run()
    finally:
        cache_sweeper.cancel()
        with suppress(asyncio.CancelledError):
            await cache_sweeper
        await consumer.close()
        await api.close()
        await provider.close()
        await packaging_provider.close()


def main() -> None:
    settings = get_settings()
    logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(serve())


if __name__ == "__main__":
    main()
