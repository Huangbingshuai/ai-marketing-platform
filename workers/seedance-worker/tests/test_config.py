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
    return WorkerSettings.model_validate(values)


def test_real_provider_requires_a_non_placeholder_api_key() -> None:
    with pytest.raises(ValidationError):
        settings(SEEDANCE_API_KEY="your-api-key")


def test_real_provider_can_reuse_the_existing_ark_api_key() -> None:
    result = WorkerSettings.model_validate(
        {
            "INTERNAL_API_BASE_URL": "http://api:3000/api",
            "EFFECT_SEGMENT_RENDER_WORKER_TOKEN": "worker-secret",
            "RABBITMQ_URL": "amqp://guest:guest@rabbitmq:5672",
            "SEGMENT_RENDER_PROVIDER": "ark",
            "ARK_API_KEY": "shared-real-key",
        }
    )

    assert result.seedance_api_key is not None
    assert result.seedance_api_key.get_secret_value() == "shared-real-key"


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


def test_render_concurrency_defaults_are_split_by_workload() -> None:
    result = settings()

    assert result.max_inflight == 20
    assert result.create_qps == 3
    assert result.download_concurrency == 3
    assert result.poll_interval_seconds == 8


def test_legacy_max_concurrency_is_used_as_an_inflight_fallback() -> None:
    result = settings(SEGMENT_RENDER_MAX_CONCURRENCY="7")

    assert result.max_inflight == 7
