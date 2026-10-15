import asyncio
from typing import Any
from unittest.mock import AsyncMock
from contextlib import asynccontextmanager

import httpx
import pytest

from effect_template_mix.api import ApiError
from effect_template_mix.config import Settings
from effect_template_mix.packaging import recover_packaging_item
from effect_template_mix.packaging_provider import PackagingError, TimedVoicePcm
from effect_template_mix.packaging_voice_recovery import (
    VoiceConnectionExhausted, VoiceResponseUncertain, recover_voice_connection,
)

async def test_durable_attempt_budget_survives_worker_restart(monkeypatch: Any) -> None:
    from datetime import datetime, timezone
    monkeypatch.setattr('effect_template_mix.packaging_voice_recovery.sleep', AsyncMock())
    state = {'startedAt': datetime.now(timezone.utc).isoformat(), 'attempts': 7}
    request = AsyncMock(side_effect=httpx.ConnectError('offline'))
    with pytest.raises(VoiceConnectionExhausted):
        await recover_voice_connection(request, AsyncMock(), item_id='i', slot_id='s', state=state, persist=AsyncMock())
    assert request.await_count == 1
    assert state['attempts'] == 8


async def test_paid_success_remains_fenced_until_audio_is_uploaded() -> None:
    state: dict[str, Any] = {}
    request = AsyncMock(return_value=b'pcm')
    await recover_voice_connection(request, AsyncMock(), item_id='i', slot_id='s', state=state, persist=AsyncMock())
    assert state['pending'] is True
    with pytest.raises(VoiceResponseUncertain):
        await recover_voice_connection(request, AsyncMock(), item_id='i', slot_id='s', state=state, persist=AsyncMock())
    assert request.await_count == 1


async def test_concurrent_voice_records_are_valid_before_any_checkpoint_is_written() -> None:
    states: dict[str, Any] = {}
    ready = asyncio.Event()
    async def guard() -> None:
        if len(states) == 6:
            ready.set()
        await ready.wait()
    async def persist() -> None:
        assert len(states) == 6
        assert all(isinstance(row.get('startedAt'), str) and isinstance(row.get('attempts'), int)
                   for row in states.values())
    async def clause(index: int) -> None:
        row = states.setdefault(str(index), {})
        await recover_voice_connection(AsyncMock(return_value=b'pcm'), guard,
            item_id='i', slot_id=str(index), state=row, persist=persist)
    await asyncio.gather(*(clause(index) for index in range(6)))


async def test_cancelled_queue_or_lease_guard_never_marks_an_unsubmitted_voice_paid() -> None:
    state: dict[str, Any] = {}
    request = AsyncMock()
    @asynccontextmanager
    async def scope():  # type: ignore[no-untyped-def]
        raise ApiError('lease expired before sending', retryable=False)
        yield
    with pytest.raises(ApiError):
        await recover_voice_connection(request, AsyncMock(), item_id='i', slot_id='s',
            state=state, persist=AsyncMock(), request_scope=scope)
    assert not state.get('pending')
    assert state['attempts'] == 0
    request.assert_not_called()


async def test_stage_retry_budget_is_persisted_and_does_not_regenerate_successful_steps() -> None:
    from effect_template_mix.packaging_provider import PackagingTransientError
    item: dict[str, Any] = {'id': 'i', 'stage': 'MUSIC', 'snapshot': {'operation': 'SINGLE_PACKAGE'},
      'checkpoint': {'voices': {'saved': {'fileObjectId': 'audio'}}, 'recovery': {'attempts': {'MUSIC': 1}}}}
    process, persist = AsyncMock(side_effect=PackagingTransientError('busy')), AsyncMock()
    with pytest.raises(PackagingTransientError):
        await recover_packaging_item(item, process, persist, 0)
    assert process.await_count == 2
    assert item['checkpoint']['recovery']['attempts']['MUSIC'] == 2
    assert item['checkpoint']['voices']['saved']['fileObjectId'] == 'audio'
    persist.assert_awaited_once_with(2)


@pytest.mark.parametrize('error_type', [httpx.ConnectError, httpx.ConnectTimeout])
async def test_connection_recovery_has_its_own_budget_and_keeps_pcm_identity(error_type: Any, monkeypatch: Any) -> None:
    pause = AsyncMock()
    monkeypatch.setattr('effect_template_mix.packaging_voice_recovery.sleep', pause)
    pcm = TimedVoicePcm(b'\0\0' * 24, 0, 24)
    request = AsyncMock(side_effect=[error_type('private'), error_type('private'), pcm])
    guard = AsyncMock()
    assert await recover_voice_connection(request, guard, item_id='i', slot_id='s') is pcm
    assert request.await_count == guard.await_count == 3
    assert [call.args[0] for call in pause.await_args_list] == [5, 10]


async def test_exhausted_connection_is_not_multiplied_by_item_retries(monkeypatch: Any) -> None:
    monkeypatch.setattr('effect_template_mix.packaging_voice_recovery.sleep', AsyncMock())
    request, persist = AsyncMock(side_effect=httpx.ConnectError('secret URL')), AsyncMock()
    async def process() -> None:
        await recover_voice_connection(request, AsyncMock(), item_id='i', slot_id='s', max_attempts=4)
    item: dict[str, Any] = {'id': 'i', 'stage': 'VOICE', 'checkpoint': {'music': {'saved': True}, 'voices': {'good': {} }}}
    with pytest.raises(VoiceConnectionExhausted, match='配音服务连接持续失败') as error:
        await recover_packaging_item(item, process, persist, 0)
    assert 'secret' not in str(error.value)
    assert request.await_count == 4
    persist.assert_not_called()
    assert set(item['checkpoint']) == {'music', 'voices'}


@pytest.mark.parametrize('error', [httpx.ReadTimeout('private'), httpx.WriteError('private'), httpx.RemoteProtocolError('private')])
async def test_ambiguous_paid_response_is_never_automatically_resubmitted(error: Exception) -> None:
    request = AsyncMock(side_effect=error)
    async def process() -> None:
        await recover_voice_connection(request, AsyncMock(), item_id='i', slot_id='s')
    with pytest.raises(VoiceResponseUncertain, match='未自动重复提交'):
        await recover_packaging_item({'id': 'i', 'stage': 'VOICE', 'checkpoint': {}}, process, AsyncMock(), 0)
    assert request.await_count == 1


@pytest.mark.parametrize('error', [ApiError('lease', retryable=False), PackagingError('permission'), asyncio.CancelledError()])
async def test_guard_permission_and_cancellation_stop_without_retry(error: BaseException) -> None:
    request, guard = AsyncMock(), AsyncMock(side_effect=error)
    with pytest.raises(type(error)):
        await recover_voice_connection(request, guard, item_id='i', slot_id='s')
    request.assert_not_called()


async def test_guard_rechecked_after_backoff(monkeypatch: Any) -> None:
    monkeypatch.setattr('effect_template_mix.packaging_voice_recovery.sleep', AsyncMock())
    request = AsyncMock(side_effect=httpx.ConnectError('connect'))
    guard = AsyncMock(side_effect=[None, ApiError('cancelled', retryable=False)])
    with pytest.raises(ApiError):
        await recover_voice_connection(request, guard, item_id='i', slot_id='s')
    assert request.await_count == 1


async def test_deadline_and_capped_backoff_are_bounded(monkeypatch: Any) -> None:
    now = [0.0]
    delays: list[float] = []
    async def pause(seconds: float) -> None:
        delays.append(seconds)
        now[0] += seconds
    monkeypatch.setattr('effect_template_mix.packaging_voice_recovery.monotonic', lambda: now[0])
    monkeypatch.setattr('effect_template_mix.packaging_voice_recovery.sleep', pause)
    request = AsyncMock(side_effect=httpx.ConnectTimeout('connect'))
    with pytest.raises(VoiceConnectionExhausted, match='恢复超时'):
        await recover_voice_connection(request, AsyncMock(), item_id='i', slot_id='s',
            max_attempts=20, timeout_seconds=52, max_delay_seconds=20)
    assert delays == [5, 10, 20, 17]
    assert request.await_count == 4


def test_voice_recovery_config_defaults_and_validation() -> None:
    values = dict(INTERNAL_API_BASE_URL='http://api/', EFFECT_TEMPLATE_MIX_WORKER_TOKEN='test',
                  RABBITMQ_URL='amqp://test/', ARK_API_KEY='test', ARK_MODEL='test')
    settings = Settings(**values)
    assert settings.packaging_tts_connection_max_attempts == 8
    assert settings.packaging_tts_connection_timeout_seconds == 600
    assert settings.packaging_tts_connection_max_delay_seconds == 30
    with pytest.raises(ValueError):
        Settings(**values, TEMPLATE_MIX_PACKAGING_TTS_CONNECTION_MAX_ATTEMPTS=0)
