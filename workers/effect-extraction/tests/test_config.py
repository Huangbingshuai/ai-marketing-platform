from __future__ import annotations

import pytest
from pydantic import ValidationError

from effect_extraction.config import (
    DEFAULT_ARK_MODEL,
    DEFAULT_ARK_SEMANTIC_MODEL,
    WorkerSettings,
)
from effect_extraction.main import _provider
from effect_extraction.providers import ArkResponsesProvider, MockAiProvider


def _base_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_API_BASE_URL", "http://api.test/api")
    monkeypatch.setenv("EFFECT_EXTRACTION_WORKER_TOKEN", "worker-token")
    monkeypatch.setenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq.test/")
    for name in (
        "EXTRACTION_AI_PROVIDER",
        "ARK_API_KEY",
        "ARK_MODEL",
        "ARK_DOCUMENT_MODEL",
        "ARK_DOCUMENT_TIMEOUT_SECONDS",
        "ARK_DOCUMENT_MAX_ATTEMPTS",
        "ARK_DOCUMENT_MAX_OUTPUT_TOKENS",
        "ARK_DOCUMENT_REASONING_EFFORT",
        "ARK_COMMERCE_MODEL",
        "ARK_IMAGE_MODEL",
        "ARK_SEMANTIC_MODEL",
        "ARK_SEMANTIC_TIMEOUT_SECONDS",
        "ARK_SEMANTIC_MAX_ATTEMPTS",
        "ARK_SEMANTIC_MAX_OUTPUT_TOKENS",
        "ARK_SEMANTIC_REASONING_EFFORT",
        "ARK_SEMANTIC_USER_REVIEW_REASONING_EFFORT",
        "ARK_NORMALIZATION_MODEL",
        "ARK_IMAGE_TIMEOUT_SECONDS",
        "ARK_IMAGE_MAX_ATTEMPTS",
        "ARK_IMAGE_MAX_OUTPUT_TOKENS",
        "ARK_IMAGE_RETRY_MAX_OUTPUT_TOKENS",
        "ARK_IMAGE_DETAIL",
        "ARK_IMAGE_REASONING_EFFORT",
        "ARK_IMAGE_ADAPTIVE_HIGH_DETAIL",
        "IMAGE_MAX_DIMENSION",
        "IMAGE_MAX_CONCURRENCY",
        "COMMERCE_STATIC_CONNECT_TIMEOUT_SECONDS",
        "COMMERCE_STATIC_READ_TIMEOUT_SECONDS",
        "COMMERCE_RENDERER_MAX_CONCURRENCY",
        "COMMERCE_RENDERER_TIMEOUT_SECONDS",
        "COMMERCE_RENDERER_MAX_DOM_BYTES",
        "COMMERCE_RENDERER_SETTLE_MILLISECONDS",
        "MAX_COMMERCE_TEXT_CHARS",
    ):
        monkeypatch.delenv(name, raising=False)


def test_default_provider_fails_fast_without_ark_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)

    with pytest.raises(ValidationError, match="ARK_API_KEY is required"):
        WorkerSettings()  # type: ignore[call-arg]


def test_default_provider_rejects_the_documented_key_placeholder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("ARK_API_KEY", "replace-with-your-ark-api-key")

    with pytest.raises(ValidationError, match="ARK_API_KEY is required"):
        WorkerSettings()  # type: ignore[call-arg]


def test_default_provider_uses_seed_2_1_turbo_model_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("ARK_API_KEY", "test-key")

    settings = WorkerSettings()  # type: ignore[call-arg]

    assert settings.ark_model == DEFAULT_ARK_MODEL
    assert settings.resolved_document_model == DEFAULT_ARK_MODEL
    assert settings.resolved_commerce_model == DEFAULT_ARK_MODEL
    assert settings.resolved_image_model == DEFAULT_ARK_MODEL
    assert settings.resolved_semantic_model == DEFAULT_ARK_SEMANTIC_MODEL
    assert settings.resolved_normalization_model == DEFAULT_ARK_MODEL
    assert settings.ark_document_timeout_seconds == 45
    assert settings.ark_document_max_attempts == 1
    assert settings.ark_document_max_output_tokens == 3072
    assert settings.ark_document_reasoning_effort == "minimal"
    assert settings.ark_image_timeout_seconds == 90
    assert settings.ark_image_max_attempts == 2
    assert settings.ark_image_max_output_tokens == 4096
    assert settings.ark_image_retry_max_output_tokens == 6144
    assert settings.ark_image_detail == "low"
    assert settings.ark_image_reasoning_effort == "minimal"
    assert settings.ark_image_adaptive_high_detail is True
    assert settings.ark_semantic_timeout_seconds == 30
    assert settings.ark_semantic_max_attempts == 1
    assert settings.ark_semantic_max_output_tokens == 3072
    assert settings.ark_semantic_reasoning_effort == "minimal"
    assert settings.ark_semantic_user_review_reasoning_effort == "minimal"
    assert settings.image_max_dimension == 1280
    assert settings.image_max_concurrency == 2
    assert settings.commerce_renderer_max_concurrency == 2
    assert settings.commerce_renderer_timeout_seconds == 25
    assert settings.commerce_renderer_max_dom_bytes == 2 * 1024 * 1024
    assert settings.commerce_renderer_settle_milliseconds == 750


def test_image_retry_budget_cannot_be_smaller_than_first_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("EXTRACTION_AI_PROVIDER", "mock")
    monkeypatch.setenv("ARK_IMAGE_MAX_OUTPUT_TOKENS", "4096")
    monkeypatch.setenv("ARK_IMAGE_RETRY_MAX_OUTPUT_TOKENS", "2048")

    with pytest.raises(ValidationError, match="ARK_IMAGE_RETRY_MAX_OUTPUT_TOKENS"):
        WorkerSettings()  # type: ignore[call-arg]


def test_stage_models_support_specific_values_and_blank_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("ARK_API_KEY", "test-key")
    monkeypatch.setenv("ARK_MODEL", "base-model")
    monkeypatch.setenv("ARK_DOCUMENT_MODEL", " document-model ")
    monkeypatch.setenv("ARK_COMMERCE_MODEL", " commerce-model ")
    monkeypatch.setenv("ARK_IMAGE_MODEL", "   ")
    monkeypatch.setenv("ARK_SEMANTIC_MODEL", "semantic-model")
    monkeypatch.setenv("ARK_NORMALIZATION_MODEL", "normalization-model")

    settings = WorkerSettings()  # type: ignore[call-arg]

    assert settings.resolved_document_model == "document-model"
    assert settings.resolved_commerce_model == "commerce-model"
    assert settings.resolved_image_model == "base-model"
    assert settings.resolved_semantic_model == "semantic-model"
    assert settings.resolved_normalization_model == "normalization-model"


def test_blank_semantic_model_uses_the_pro_semantic_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("ARK_API_KEY", "test-key")
    monkeypatch.setenv("ARK_MODEL", "base-model")
    monkeypatch.setenv("ARK_SEMANTIC_MODEL", "   ")

    settings = WorkerSettings()  # type: ignore[call-arg]

    assert settings.resolved_semantic_model == DEFAULT_ARK_SEMANTIC_MODEL


@pytest.mark.parametrize(
    ("commerce_model", "document_model", "expected"),
    [
        ("commerce-model", "document-model", "commerce-model"),
        ("   ", "document-model", "document-model"),
        ("", "   ", "base-model"),
    ],
)
def test_commerce_model_routes_from_specific_to_document_to_base(
    monkeypatch: pytest.MonkeyPatch,
    commerce_model: str,
    document_model: str,
    expected: str,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("ARK_API_KEY", "test-key")
    monkeypatch.setenv("ARK_MODEL", "base-model")
    monkeypatch.setenv("ARK_COMMERCE_MODEL", commerce_model)
    monkeypatch.setenv("ARK_DOCUMENT_MODEL", document_model)

    settings = WorkerSettings()  # type: ignore[call-arg]

    assert settings.resolved_commerce_model == expected


def test_process_local_renderer_limits_are_configurable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("EXTRACTION_AI_PROVIDER", "mock")
    monkeypatch.setenv("COMMERCE_RENDERER_MAX_CONCURRENCY", "4")
    monkeypatch.setenv("COMMERCE_RENDERER_TIMEOUT_SECONDS", "30")
    monkeypatch.setenv("COMMERCE_RENDERER_MAX_DOM_BYTES", "4194304")
    monkeypatch.setenv("COMMERCE_RENDERER_SETTLE_MILLISECONDS", "500")

    settings = WorkerSettings()  # type: ignore[call-arg]

    assert settings.commerce_renderer_max_concurrency == 4
    assert settings.commerce_renderer_timeout_seconds == 30
    assert settings.commerce_renderer_max_dom_bytes == 4 * 1024 * 1024
    assert settings.commerce_renderer_settle_milliseconds == 500


def test_explicit_mock_is_the_only_credential_free_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("EXTRACTION_AI_PROVIDER", "mock")

    settings = WorkerSettings()  # type: ignore[call-arg]

    assert settings.extraction_ai_provider == "mock"
    assert isinstance(_provider(settings), MockAiProvider)


def test_ark_model_accepts_a_model_id(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("ARK_API_KEY", "test-key")
    monkeypatch.setenv("ARK_MODEL", "doubao-seed-2-1-turbo")

    settings = WorkerSettings()  # type: ignore[call-arg]

    assert settings.ark_model == "doubao-seed-2-1-turbo"


def test_ark_provider_rejects_blank_base_model(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("ARK_API_KEY", "test-key")
    monkeypatch.setenv("ARK_MODEL", "   ")

    with pytest.raises(ValidationError, match="ARK_MODEL cannot be empty"):
        WorkerSettings()  # type: ignore[call-arg]


@pytest.mark.asyncio
async def test_default_provider_builds_ark_client_when_credentials_exist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("ARK_API_KEY", "test-key")
    monkeypatch.setenv("ARK_MODEL", "ep-test-endpoint")
    settings = WorkerSettings()  # type: ignore[call-arg]

    provider = _provider(settings)
    try:
        assert settings.extraction_ai_provider == "ark"
        assert isinstance(provider, ArkResponsesProvider)
    finally:
        assert isinstance(provider, ArkResponsesProvider)
        await provider.aclose()
