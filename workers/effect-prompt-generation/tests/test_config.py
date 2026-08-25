from __future__ import annotations

import pytest
from pydantic import ValidationError

from effect_prompt_generation.config import WorkerSettings


def _base() -> dict[str, str]:
    return {
        "INTERNAL_API_BASE_URL": "http://api.local/api",
        "EFFECT_PROMPT_WORKER_TOKEN": "worker-token",
        "RABBITMQ_URL": "amqp://guest:guest@rabbitmq:5672/",
    }


def test_ark_is_default_and_fails_fast_without_key() -> None:
    with pytest.raises(ValidationError, match="ARK_API_KEY"):
        WorkerSettings(**_base())  # type: ignore[arg-type]


def test_mock_requires_explicit_provider_and_prompt_model_falls_back() -> None:
    settings = WorkerSettings(**_base(), PROMPT_AI_PROVIDER="mock")  # type: ignore[arg-type]

    assert settings.prompt_ai_provider == "mock"
    assert settings.resolved_prompt_model == "doubao-seed-2-1-turbo-260628"
    assert settings.prompt_max_concurrency == 3
    assert settings.prompt_shard_size == 8
