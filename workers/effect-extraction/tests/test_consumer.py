from effect_extraction.api_client import InternalApiError
from effect_extraction.consumer import _retryable
from effect_extraction.fusion import FusionError
from effect_extraction.providers import ProviderError


def test_only_explicit_transient_errors_are_requeued() -> None:
    assert _retryable(InternalApiError("temporary", retryable=True)) is True
    assert _retryable(ProviderError("temporary", retryable=True)) is True
    assert _retryable(InternalApiError("unauthorized", retryable=False)) is False
    assert _retryable(FusionError("invalid branch state")) is False
    assert _retryable(RuntimeError("unexpected")) is False
