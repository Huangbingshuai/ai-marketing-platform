from typing import Any
import pytest
from customized_production_runtime.consumer import WORKERS, validate_claim, execute
from customized_production_runtime.models import QueueMessage
from customized_production_runtime import consumer
from ai_runtime.http import InternalApiError
from ai_runtime.responses import ProviderError


def test_asset_worker_is_a_single_node_with_an_independent_queue_and_credential() -> None:
    worker = WORKERS['ASSETS']
    assert worker.operations == ('ASSETS', 'IMAGE')
    assert worker.queue == 'customized.assets.requested'
    assert worker.token_env != WORKERS['VIDEO'].token_env
    for operation in ('SHOTS', 'PROMPT'):
        with pytest.raises(ValueError):
            validate_claim(worker, {'input': {'operation': operation}})
    with pytest.raises(ValueError):
        QueueMessage.model_validate({'schemaVersion': 1, 'projectId': 'p', 'runId': 't', 'requestId': 'r', 'document': 'forbidden'})


class Api:
    def __init__(self, claim: dict[str, Any]) -> None:
        self.token = ''
        self.claim = claim
        self.calls: list[tuple[str, Any]] = []

    async def call(self, method: str, path: str, value: Any = None) -> Any:
        self.calls.append((path, value))
        return self.claim if path == 'claim' else {}


@pytest.mark.asyncio
async def test_asset_execution_keeps_the_existing_checkpoint_pipeline(monkeypatch: Any) -> None:
    claim = {'input': {'operation': 'ASSETS'}, 'attemptToken': 'lease', 'output': {'saved': True}}
    api = Api(claim)
    calls = []

    async def run(a: Any, provider: Any, data: Any) -> None:
        calls.append(data)

    monkeypatch.setattr(consumer, 'run', run)
    await execute(api, object(), WORKERS['ASSETS'])  # type: ignore[arg-type]
    assert calls == [claim] and api.token == 'lease'


@pytest.mark.asyncio
async def test_wrong_node_never_calls_a_model_or_failure_callback() -> None:
    api = Api({'input': {'operation': 'SHOTS'}, 'attemptToken': 'wrong'})
    with pytest.raises(ValueError):
        await execute(api, object(), WORKERS['ASSETS'])  # type: ignore[arg-type]
    assert api.calls == [('claim', None)] and api.token == ''


@pytest.mark.asyncio
async def test_model_failure_retains_bounded_server_retry(monkeypatch: Any) -> None:
    api = Api({'input': {'operation': 'ASSETS'}, 'attemptToken': 'lease'})

    async def fail(*args: Any) -> None:
        raise ProviderError('controlled unavailable', retryable=True)

    monkeypatch.setattr(consumer, 'run', fail)
    await execute(api, object(), WORKERS['ASSETS'])  # type: ignore[arg-type]
    assert api.calls[-1] == ('fail', {'retryable': True})


@pytest.mark.asyncio
async def test_expired_lease_does_not_fail_a_new_attempt(monkeypatch: Any) -> None:
    api = Api({'input': {'operation': 'ASSETS'}, 'attemptToken': 'lease'})

    async def fail(*args: Any) -> None:
        raise InternalApiError('expired', retryable=False, status_code=409)

    monkeypatch.setattr(consumer, 'run', fail)
    await execute(api, object(), WORKERS['ASSETS'])  # type: ignore[arg-type]
    assert api.calls == [('claim', None)]
