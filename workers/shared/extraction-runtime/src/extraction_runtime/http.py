"""Compatibility entrypoint for existing internal API clients."""

import sys
from ai_runtime import http as _implementation
from ai_runtime.http import InternalApiError, request, unwrap

__all__ = ["InternalApiError", "request", "unwrap"]
sys.modules[__name__] = _implementation
