from __future__ import annotations

import pytest
from pydantic import ValidationError

from seedance_worker.config import WorkerSettings


def settings(**overrides: str) -> WorkerSettings:
    values = {
        "INTERNAL_API_BASE_URL": "http://api:3000/api",
        "EFFECT_SEGMENT_RENDER_WORKER_TOKEN": "worker-secret",
        "RABBITMQ_URL": "amqp://guest:guest@rabbitmq:5672",
        "SEGMENT_RENDER_PROVIDER": "ark",
        "SEEDANCE_API_KEY": "real-key",
        **overrides,
    }
    return WorkerSettings(**values)  # type: ignore[arg-type]


def test_real_provider_requires_a_non_placeholder_api_key() -> None:
    with pytest.raises(ValidationError):
        settings(SEEDANCE_API_KEY="your-api-key")


def test_mock_provider_is_restricted_to_an_isolated_queue() -> None:
    with pytest.raises(ValidationError):
        settings(
            SEGMENT_RENDER_PROVIDER="mock",
            EFFECT_SEGMENT_RENDER_QUEUE="effect.segment-render.requested",
        )

    result = settings(
        SEGMENT_RENDER_PROVIDER="mock",
        EFFECT_SEGMENT_RENDER_QUEUE="test.effect.segment-render",
    )
    assert result.provider == "mock"
