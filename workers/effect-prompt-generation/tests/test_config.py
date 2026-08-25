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


def _settings(**overrides: object) -> WorkerSettings:
    return WorkerSettings.model_validate({**_base(), **overrides})


def test_ark_is_default_and_fails_fast_without_key() -> None:
    with pytest.raises(ValidationError, match="ARK_API_KEY"):
        _settings()


def test_mock_requires_explicit_provider_and_prompt_model_falls_back() -> None:
    settings = _settings(PROMPT_AI_PROVIDER="mock")

    assert settings.prompt_ai_provider == "mock"
    assert settings.resolved_prompt_strategy_model == "doubao-seed-2-0-lite-260428"
    assert settings.resolved_prompt_candidate_model == "doubao-seed-2-1-turbo-260628"
    assert settings.ark_prompt_strategy_max_output_tokens == 2048
    assert settings.ark_prompt_candidate_max_output_tokens == 4096
    assert settings.ark_prompt_reasoning_effort == "minimal"
    assert settings.prompt_max_ai_calls_per_run == 129
    assert settings.prompt_max_concurrency == 3
    assert settings.prompt_shard_size == 8


def test_legacy_prompt_model_and_node_specific_overrides_keep_precedence() -> None:
    legacy = _settings(PROMPT_AI_PROVIDER="mock", ARK_PROMPT_MODEL="legacy-model")
    specific = _settings(
        PROMPT_AI_PROVIDER="mock",
        ARK_PROMPT_MODEL="legacy-model",
        ARK_PROMPT_STRATEGY_MODEL="strategy-model",
        ARK_PROMPT_CANDIDATE_MODEL="candidate-model",
    )

    assert legacy.resolved_prompt_strategy_model == "legacy-model"
    assert legacy.resolved_prompt_candidate_model == "legacy-model"
    assert specific.resolved_prompt_strategy_model == "strategy-model"
    assert specific.resolved_prompt_candidate_model == "candidate-model"
