from __future__ import annotations

import pytest
from pydantic import ValidationError

from effect_extraction.config import WorkerSettings
from effect_extraction.main import _provider
from effect_extraction.providers import ArkResponsesProvider, MockAiProvider


def _base_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_API_BASE_URL", "http://api.test/api")
    monkeypatch.setenv("EFFECT_EXTRACTION_WORKER_TOKEN", "worker-token")
    monkeypatch.setenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq.test/")
    for name in ("EXTRACTION_AI_PROVIDER", "ARK_API_KEY", "ARK_MODEL"):
        monkeypatch.delenv(name, raising=False)


def test_default_provider_fails_fast_without_ark_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)

    with pytest.raises(ValidationError, match="ARK_API_KEY is required"):
        WorkerSettings()  # type: ignore[call-arg]


def test_default_provider_fails_fast_without_ark_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("ARK_API_KEY", "test-key")

    with pytest.raises(ValidationError, match="ARK_MODEL is required"):
        WorkerSettings()  # type: ignore[call-arg]


def test_explicit_mock_is_the_only_credential_free_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("EXTRACTION_AI_PROVIDER", "mock")

    settings = WorkerSettings()  # type: ignore[call-arg]

    assert settings.extraction_ai_provider == "mock"
    assert isinstance(_provider(settings), MockAiProvider)


def test_ark_model_must_be_an_endpoint_id(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_environment(monkeypatch)
    monkeypatch.setenv("ARK_API_KEY", "test-key")
    monkeypatch.setenv("ARK_MODEL", "doubao-seed-2-1-turbo")

    with pytest.raises(ValidationError, match="Ark Endpoint ID"):
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
