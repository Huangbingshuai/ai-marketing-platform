from __future__ import annotations

import asyncio
import logging

from .api_client import HttpInternalApi
from .config import WorkerSettings, get_settings
from .consumer import SegmentRenderConsumer
from .providers import ArkSeedanceProvider, MockVideoProvider, VideoProvider


def _provider(settings: WorkerSettings) -> VideoProvider:
    if settings.provider == "mock":
        return MockVideoProvider()
    assert settings.seedance_api_key is not None
    return ArkSeedanceProvider(
        base_url=settings.seedance_base_url,
        api_key=settings.seedance_api_key.get_secret_value(),
        timeout_seconds=settings.seedance_timeout_seconds,
        poll_interval_seconds=settings.poll_interval_seconds,
        create_qps=settings.create_qps,
        download_concurrency=settings.download_concurrency,
        max_download_bytes=settings.max_download_bytes,
    )


async def serve(settings: WorkerSettings) -> None:
    api = HttpInternalApi(
        str(settings.internal_api_base_url),
        settings.worker_token.get_secret_value(),
        timeout=settings.api_timeout_seconds,
        reference_cache_bytes=settings.reference_cache_bytes,
    )
    provider = _provider(settings)
    consumer = SegmentRenderConsumer(
        rabbitmq_url=settings.rabbitmq_url.get_secret_value(),
        queue_name=settings.queue_name,
        api=api,
        provider=provider,
        max_inflight=settings.max_inflight,
        result_concurrency=settings.download_concurrency,
    )
    try:
        await consumer.run()
    finally:
        await consumer.close()
        await api.aclose()
        await provider.aclose()


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(serve(settings))


if __name__ == "__main__":
    main()
