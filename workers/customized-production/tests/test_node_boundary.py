from typing import Any
import pytest
from ai_runtime.http import InternalApiError
from customized_production_runtime.consumer import WORKERS, execute, validate_claim


def test_video_worker_accepts_only_its_three_internal_operations() -> None:
    worker = WORKERS['VIDEO']
    assert worker.operations == ('SHOTS', 'PROMPT', 'RENDER')
    assert worker.queue == 'customized.production.requested'
    with pytest.raises(ValueError):
        validate_claim(worker, {'input': {'operation': 'ASSETS'}})


@pytest.mark.asyncio
async def test_legacy_asset_message_routes_before_model_execution() -> None:
    class Api:
        token = ''
        calls: list[str] = []

        async def call(self, method: str, path: str, value: Any = None) -> Any:
            self.calls.append(path)
            if path == 'claim':
                raise InternalApiError('wrong node', retryable=False, status_code=409)
            return {'forwarded': True}

    api = Api()
    await execute(api, object(), WORKERS['VIDEO'])  # type: ignore[arg-type]
    assert api.calls == ['claim', 'route']


@pytest.mark.asyncio
async def test_terminal_duplicate_message_never_reexecutes() -> None:
    class Api:
        token = ''
        calls: list[str] = []

        async def call(self, method: str, path: str, value: Any = None) -> Any:
            self.calls.append(path)
            return {'terminal': True}

    api = Api()
    await execute(api, object(), WORKERS['VIDEO'])  # type: ignore[arg-type]
    assert api.calls == ['claim']
