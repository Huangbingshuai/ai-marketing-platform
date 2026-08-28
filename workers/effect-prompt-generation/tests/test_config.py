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
    if overrides.get("PROMPT_AI_PROVIDER") == "mock":
        overrides.setdefault(
            "EFFECT_PROMPT_QUEUE", "effect.prompt-generation.requested.test"
        )
    return WorkerSettings.model_validate({**_base(), **overrides})


def test_ark_is_default_and_fails_fast_without_key() -> None:
    with pytest.raises(ValidationError, match="ARK_API_KEY"):
        _settings()


def test_mock_requires_explicit_provider_and_prompt_model_falls_back() -> None:
    settings = _settings(PROMPT_AI_PROVIDER="mock")

    assert settings.prompt_ai_provider == "mock"
    assert settings.resolved_prompt_strategy_model == "doubao-seed-2-0-lite-260428"
    assert settings.resolved_prompt_blueprint_model == "doubao-seed-2-0-lite-260428"
    assert settings.resolved_prompt_candidate_model == "doubao-seed-2-1-turbo-260628"
    assert settings.ark_prompt_strategy_max_output_tokens == 8192
    assert settings.ark_prompt_candidate_max_output_tokens == 4096
    assert settings.ark_prompt_evaluation_max_output_tokens == 4096
    assert settings.ark_prompt_reasoning_effort == "minimal"
    assert settings.prompt_max_ai_calls_per_run == 256
    assert settings.prompt_max_concurrency == 6
    assert settings.prompt_shard_size == 8
    assert settings.ark_prompt_strategy_timeout_seconds == 180
    assert settings.resolved_prompt_candidate_timeout_seconds == 120
    assert settings.ark_prompt_provider_max_attempts == 1
    assert settings.resolved_prompt_evaluation_model == settings.resolved_prompt_candidate_model
    assert settings.prompt_similarity_mode == "trigram"
    assert settings.prompt_embedding_batch_size == 64
    assert settings.prompt_embedding_max_concurrency == 8
    assert settings.ark_prompt_embedding_timeout_seconds == 30
    assert settings.ark_prompt_embedding_max_attempts == 3


def test_mock_rejects_the_normal_prompt_queue() -> None:
    with pytest.raises(ValidationError, match="isolated test queue"):
        WorkerSettings.model_validate(
            {
                **_base(),
                "PROMPT_AI_PROVIDER": "mock",
                "EFFECT_PROMPT_QUEUE": "effect.prompt-generation.requested",
            }
        )


def test_legacy_prompt_model_and_node_specific_overrides_keep_precedence() -> None:
    legacy = _settings(PROMPT_AI_PROVIDER="mock", ARK_PROMPT_MODEL="legacy-model")
    specific = _settings(
        PROMPT_AI_PROVIDER="mock",
        ARK_PROMPT_MODEL="legacy-model",
        ARK_PROMPT_STRATEGY_MODEL="strategy-model",
        ARK_PROMPT_BLUEPRINT_MODEL="blueprint-model",
        ARK_PROMPT_CANDIDATE_MODEL="candidate-model",
    )

    assert legacy.resolved_prompt_strategy_model == "legacy-model"
    assert legacy.resolved_prompt_candidate_model == "legacy-model"
    assert specific.resolved_prompt_strategy_model == "strategy-model"
    assert specific.resolved_prompt_blueprint_model == "blueprint-model"
    assert specific.resolved_prompt_candidate_model == "candidate-model"


def test_candidate_timeout_prefers_node_override_and_keeps_legacy_fallback() -> None:
    legacy = _settings(PROMPT_AI_PROVIDER="mock", ARK_TIMEOUT_SECONDS=180)
    specific = _settings(
        PROMPT_AI_PROVIDER="mock",
        ARK_TIMEOUT_SECONDS=180,
        ARK_PROMPT_CANDIDATE_TIMEOUT_SECONDS=90,
        ARK_PROMPT_STRATEGY_TIMEOUT_SECONDS=240,
    )

    assert legacy.resolved_prompt_candidate_timeout_seconds == 180
    assert specific.resolved_prompt_candidate_timeout_seconds == 90
    assert specific.ark_prompt_strategy_timeout_seconds == 240


def test_ark_vector_and_shadow_modes_require_explicit_embedding_model() -> None:
    with pytest.raises(ValidationError, match="ARK_PROMPT_EMBEDDING_MODEL"):
        _settings(
            PROMPT_AI_PROVIDER="ark",
            ARK_API_KEY="real-test-key",
            PROMPT_SIMILARITY_MODE="shadow",
        )

    settings = _settings(
        PROMPT_AI_PROVIDER="ark",
        ARK_API_KEY="real-test-key",
        PROMPT_SIMILARITY_MODE="vector",
        ARK_PROMPT_EMBEDDING_MODEL="embedding-endpoint",
        ARK_PROMPT_EMBEDDING_API_MODE="multimodal",
    )
    assert settings.ark_prompt_embedding_model == "embedding-endpoint"
    assert settings.ark_prompt_embedding_api_mode == "multimodal"


def test_mock_vector_mode_uses_explicit_mock_without_ark_model() -> None:
    settings = _settings(
        PROMPT_AI_PROVIDER="mock",
        PROMPT_SIMILARITY_MODE="vector",
    )
    assert settings.prompt_similarity_mode == "vector"
