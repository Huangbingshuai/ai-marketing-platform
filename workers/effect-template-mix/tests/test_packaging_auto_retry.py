from typing import Any
from unittest.mock import AsyncMock
import httpx
import pytest
from effect_template_mix.packaging import recover_packaging_item
from effect_template_mix.packaging_provider import PackagingError, PackagingTransientError
from effect_template_mix.provider import ProviderError, ProviderOutputError
from effect_template_mix.api import ApiError


async def test_recovery_preserves_successful_steps_and_music_task() -> None:
    item: dict[str, Any] = {'id': 'item', 'stage': 'MUSIC', 'checkpoint': {'voices': {'slot': 'saved'}, 'musicTaskId': 'paid'}}
    process = AsyncMock(side_effect=[PackagingTransientError('temporary'), None])
    persist = AsyncMock()
    await recover_packaging_item(item, process, persist, 0)
    assert process.call_count == 2
    persist.assert_awaited_once_with(1)
    assert item['checkpoint'] == {'voices': {'slot': 'saved'}, 'musicTaskId': 'paid', 'automaticRetries': 1}


@pytest.mark.parametrize('initial, calls', [(0, 3), (1, 2), (2, 1)])
async def test_budget_survives_restart(initial: int, calls: int) -> None:
    item: dict[str, Any] = {'id': 'item', 'stage': 'VOICE', 'checkpoint': {'automaticRetries': initial}}
    process = AsyncMock(side_effect=ProviderError('temporary', retryable=True))
    with pytest.raises(ProviderError):
        await recover_packaging_item(item, process, AsyncMock(), 0)
    assert process.call_count == calls
    assert item['checkpoint']['automaticRetries'] == 2


@pytest.mark.parametrize('error', [PackagingError('permanent'), ProviderError('invalid', retryable=False), ApiError('lease', retryable=True)])
async def test_permanent_or_lease_failure_not_retried(error: Exception) -> None:
    process, persist = AsyncMock(side_effect=error), AsyncMock()
    with pytest.raises(type(error)):
        await recover_packaging_item({'id': 'item', 'stage': 'VOICE', 'checkpoint': {}}, process, persist, 0)
    assert process.call_count == 1
    persist.assert_not_called()


async def test_unknown_music_submit_never_repeated() -> None:
    process = AsyncMock(side_effect=httpx.ReadTimeout('timeout'))
    persist = AsyncMock()
    with pytest.raises(httpx.ReadTimeout):
        await recover_packaging_item({'id': 'item', 'stage': 'MUSIC', 'checkpoint': {'musicSubmissionPending': True}}, process, persist, 0)
    assert process.call_count == 1
    persist.assert_not_called()


async def test_lost_lease_during_retry_checkpoint_does_not_spend() -> None:
    process = AsyncMock(side_effect=PackagingTransientError('temporary'))
    persist = AsyncMock(side_effect=ApiError('cancelled', retryable=False))
    with pytest.raises(ApiError):
        await recover_packaging_item({'id': 'item', 'stage': 'VOICE', 'checkpoint': {}}, process, persist, 0)
    assert process.call_count == 1


async def test_invalid_model_structure_gets_bounded_retry_like_prompt_node() -> None:
    item: dict[str, Any] = {'id': 'item', 'stage': 'VISION', 'checkpoint': {}}
    process = AsyncMock(side_effect=[ProviderOutputError('invalid JSON', retryable=False), None])
    await recover_packaging_item(item, process, AsyncMock(), 0)
    assert item['checkpoint']['automaticRetries'] == 1
    assert process.call_count == 2
