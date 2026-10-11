"""Recover only unambiguously unsubmitted TTS requests, outside the shared voice pool."""
import logging
from asyncio import sleep
from time import monotonic
from datetime import datetime, timezone
from typing import Any
from collections.abc import Awaitable, Callable

import httpx

from .packaging_provider import PackagingError, PackagingTransientError

LOGGER = logging.getLogger(__name__)


class VoiceConnectionExhausted(PackagingError):
    """Request-level budget is spent; the item retry must not multiply it."""


class VoiceResponseUncertain(PackagingError):
    """A request may have been billed, so automatic resubmission is unsafe."""


async def recover_voice_connection(
    request: Callable[[], Awaitable[bytes]], guard: Callable[[], Awaitable[None]], *,
    item_id: str, slot_id: str, max_attempts: int = 8, timeout_seconds: float = 600,
    max_delay_seconds: float = 30, backoff_seconds: float = 5,
    state: dict[str, Any] | None = None, persist: Callable[[], Awaitable[None]] | None = None,
) -> bytes:
    deadline = monotonic() + timeout_seconds
    first_attempt = 0
    if state is not None:
        started = state.setdefault('startedAt', datetime.now(timezone.utc).isoformat())
        first_attempt = int(state.get('attempts', 0))
        deadline -= (datetime.now(timezone.utc) - datetime.fromisoformat(started)).total_seconds()
        if state.get('pending'):
            raise VoiceResponseUncertain('上次配音响应未确认，已保留包装前原样')
    for attempt in range(first_attempt, max_attempts):
        await guard()
        if monotonic() >= deadline:
            raise VoiceConnectionExhausted('配音连接恢复超时，已保留包装前原样')
        try:
            if state is not None:
                state.update(attempts=attempt + 1, pending=True)
                state.pop('waitingUntil', None)
                if persist:
                    await persist()
            result = await request()
            # Keep the in-flight marker until the caller has durably uploaded the audio.
            # A crash after a paid response but before upload must not submit that sentence again.
            return result
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            if state is not None:
                state['pending'] = False
                if persist:
                    await persist()
            remaining = deadline - monotonic()
            if attempt + 1 >= max_attempts or remaining <= 0:
                raise VoiceConnectionExhausted(
                    '配音服务连接持续失败，已保留包装前原样',
                ) from exc
            LOGGER.warning('packaging voice connection retry item=%s slot=%s attempt=%s error=%s',
                           item_id, slot_id, attempt + 1, type(exc).__name__)
            # request() has released the shared semaphore. Never sleep holding a TTS permit.
            delay = min(backoff_seconds * 2 ** attempt, max_delay_seconds, remaining)
            if state is not None:
                from datetime import timedelta
                state['waitingUntil'] = (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat()
                if persist:
                    await persist()
            await sleep(delay)
            if monotonic() >= deadline:
                raise VoiceConnectionExhausted(
                    '配音服务连接恢复超时，已保留包装前原样',
                ) from exc
        except PackagingTransientError:
            # A definite service rejection can use the shared stage budget, not eight
            # connection attempts multiplied by three item attempts.
            if state is not None:
                state['pending'] = False
                if persist:
                    await persist()
            raise
        except httpx.TransportError as exc:
            # Read/write/stream failures may follow a successful paid submission.
            raise VoiceResponseUncertain(
                '配音响应中断，无法确认本次合成结果；已保留包装前原样，未自动重复提交',
            ) from exc
    raise VoiceConnectionExhausted('配音连接重试次数已耗尽，已保留包装前原样')
