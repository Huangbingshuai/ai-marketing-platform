"""Compatibility entrypoint; both extraction workers use the lightweight runtime."""

import sys
from ai_runtime import responses as _implementation
from ai_runtime.responses import (
    AiCallMetadata,
    AiCallResult,
    ProviderError,
    ProviderErrorType,
    StructuredResponsesMixin,
)
from ai_runtime.responses import (
    _PROVIDER_ERROR_MESSAGES as _PROVIDER_ERROR_MESSAGES,
    _RetryStructuredResponse as _RetryStructuredResponse,
    _incomplete_reason as _incomplete_reason,
    _is_output_truncated_reason as _is_output_truncated_reason,
    _output_text as _output_text,
    _response_status as _response_status,
    _token as _token,
    _usage as _usage,
)

__all__ = [
    "AiCallMetadata",
    "AiCallResult",
    "ProviderError",
    "ProviderErrorType",
    "StructuredResponsesMixin",
]
sys.modules[__name__] = _implementation
