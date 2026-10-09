from __future__ import annotations
import asyncio, json, logging, random, time
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Generic, TypeVar
import httpx
from pydantic import BaseModel, ValidationError

TModel = TypeVar("TModel", bound=BaseModel)
TResult = TypeVar("TResult", bound=BaseModel)
LOGGER = logging.getLogger(__name__)


class ProviderErrorType(StrEnum):
    TIMEOUT = "AI_TIMEOUT"
    NETWORK = "AI_NETWORK"
    RATE_LIMIT = "AI_RATE_LIMIT"
    SERVICE = "AI_SERVICE"
    RESPONSE_INVALID = "AI_RESPONSE_INVALID"
    REQUEST_REJECTED = "AI_REQUEST_REJECTED"
    OUTPUT_TRUNCATED = "AI_OUTPUT_TRUNCATED"
    UNKNOWN = "AI_UNKNOWN"


class ProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool,
        error_type: ProviderErrorType = ProviderErrorType.UNKNOWN,
        attempts: int = 1,
        elapsed_ms: int = 0,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.error_type = error_type
        self.attempts = max(1, attempts)
        self.elapsed_ms = max(0, elapsed_ms)


@dataclass(frozen=True, slots=True)
class AiCallMetadata:
    stage: str
    model: str
    prompt_version: str
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    latency_ms: int
    attempts: int
    reasoning_tokens: int | None = None

    def as_dict(self) -> dict[str, str | int | None]:
        return {
            "stage": self.stage,
            "model": self.model,
            "promptVersion": self.prompt_version,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "totalTokens": self.total_tokens,
            "latencyMs": self.latency_ms,
            "attempts": self.attempts,
            "reasoningTokens": self.reasoning_tokens,
        }


@dataclass(frozen=True, slots=True)
class AiCallResult(Generic[TResult]):
    value: TResult
    metadata: AiCallMetadata
    cacheable: bool = True


class _RetryStructuredResponse(Exception):
    pass


def _token(value: Any) -> int | None:
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0
        else None
    )


def _usage(payload: Any) -> dict[str, int | None]:
    usage = payload.get("usage") if isinstance(payload, Mapping) else None
    if not isinstance(usage, Mapping):
        usage = {}
    output_details = usage.get(
        "output_tokens_details", usage.get("outputTokensDetails")
    )
    if not isinstance(output_details, Mapping):
        output_details = {}
    return {
        "inputTokens": _token(usage.get("input_tokens", usage.get("inputTokens"))),
        "outputTokens": _token(usage.get("output_tokens", usage.get("outputTokens"))),
        "totalTokens": _token(usage.get("total_tokens", usage.get("totalTokens"))),
        "reasoningTokens": _token(
            output_details.get(
                "reasoning_tokens", output_details.get("reasoningTokens")
            )
        ),
    }


def _response_status(payload: Any) -> str | None:
    if not isinstance(payload, Mapping):
        return None
    status = payload.get("status")
    return status.strip().lower() if isinstance(status, str) else None


def _incomplete_reason(payload: Any) -> str | None:
    if not isinstance(payload, Mapping):
        return None
    details = payload.get("incomplete_details", payload.get("incompleteDetails"))
    if not isinstance(details, Mapping):
        return None
    reason = details.get("reason")
    return reason.strip().lower() if isinstance(reason, str) else None


def _is_output_truncated_reason(reason: str | None) -> bool:
    return bool(reason and reason.startswith("max_output_tokens"))


def _output_text(payload: Any) -> str:
    if isinstance(payload, Mapping):
        direct = payload.get("output_text")
        if isinstance(direct, str) and direct.strip():
            return direct
        output = payload.get("output")
        if isinstance(output, list):
            for item in output:
                if not isinstance(item, Mapping) or item.get("type") != "message":
                    continue
                content = item.get("content")
                if not isinstance(content, list):
                    continue
                for part in content:
                    if isinstance(part, Mapping) and part.get("type") == "output_text":
                        text = part.get("text")
                        if isinstance(text, str) and text.strip():
                            return text
    raise ValueError("Ark response does not contain output_text")


_PROVIDER_ERROR_MESSAGES: dict[ProviderErrorType, str] = {
    ProviderErrorType.TIMEOUT: "AI request timed out",
    ProviderErrorType.NETWORK: "AI network request failed",
    ProviderErrorType.RATE_LIMIT: "AI service rate limit exceeded",
    ProviderErrorType.SERVICE: "AI service request failed",
    ProviderErrorType.RESPONSE_INVALID: "AI structured response is invalid",
    ProviderErrorType.REQUEST_REJECTED: "AI request was rejected",
    ProviderErrorType.OUTPUT_TRUNCATED: "AI structured response exceeded the output limit",
    ProviderErrorType.UNKNOWN: "AI structured-output request failed",
}


class StructuredResponsesMixin:
    _client: httpx.AsyncClient
    _max_attempts: int

    async def _structured(
        self,
        input_items: list[dict[str, Any]],
        model_type: type[TModel],
        *,
        schema_name: str,
        stage: str,
        model: str,
        prompt_version: str,
        request_timeout: float | None = None,
        max_attempts: int | None = None,
        max_output_tokens: int | None = None,
        retry_max_output_tokens: int | None = None,
        reasoning_effort: str | None = None,
    ) -> AiCallResult[TModel]:
        schema = model_type.model_json_schema(by_alias=True)
        payload = {
            "model": model,
            "input": input_items,
            "store": False,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": schema_name,
                    "schema": schema,
                    "strict": True,
                }
            },
        }
        if reasoning_effort is not None:
            payload["reasoning"] = {"effort": reasoning_effort}
        last_error: Exception | None = None
        last_error_type = ProviderErrorType.UNKNOWN
        retryable = False
        attempts = 0
        started_at = time.perf_counter()
        attempt_limit = max(1, max_attempts or self._max_attempts)
        for attempt in range(1, attempt_limit + 1):
            attempts = attempt
            request_payload = dict(payload)
            if max_output_tokens is not None:
                request_payload["max_output_tokens"] = (
                    retry_max_output_tokens
                    if attempt > 1 and retry_max_output_tokens is not None
                    else max_output_tokens
                )
            try:
                response = await self._client.post(
                    "responses", json=request_payload, timeout=request_timeout
                )
            except httpx.TimeoutException as exc:
                last_error = exc
                last_error_type = ProviderErrorType.TIMEOUT
                retryable = True
            except httpx.RemoteProtocolError as exc:
                # The upstream can close an HTTP connection after accepting the
                # request but before returning a response. HTTPX classifies this
                # separately from NetworkError, but it is still a transient
                # transport failure that is safe to retry within the existing
                # bounded attempt budget.
                last_error = exc
                last_error_type = ProviderErrorType.NETWORK
                retryable = True
            except httpx.NetworkError as exc:
                last_error = exc
                last_error_type = ProviderErrorType.NETWORK
                retryable = True
            else:
                if not response.is_error:
                    try:
                        response_payload = response.json()
                        if _response_status(response_payload) == "incomplete":
                            reason = _incomplete_reason(response_payload)
                            last_error = RuntimeError("Ark response is incomplete")
                            last_error_type = (
                                ProviderErrorType.OUTPUT_TRUNCATED
                                if _is_output_truncated_reason(reason)
                                else ProviderErrorType.RESPONSE_INVALID
                            )
                            usage = _usage(response_payload)
                            LOGGER.warning(
                                "Ark call incomplete stage=%s model=%s prompt_version=%s "
                                "reason=%s input_tokens=%s output_tokens=%s "
                                "reasoning_tokens=%s total_tokens=%s attempt=%s",
                                stage,
                                model,
                                prompt_version,
                                reason or "unknown",
                                usage["inputTokens"],
                                usage["outputTokens"],
                                usage["reasoningTokens"],
                                usage["totalTokens"],
                                attempt,
                            )
                            retryable = attempt < attempt_limit
                            raise _RetryStructuredResponse
                        value = model_type.model_validate_json(
                            _output_text(response_payload)
                        )
                        usage = _usage(response_payload)
                        metadata = AiCallMetadata(
                            stage=stage,
                            model=model,
                            prompt_version=prompt_version,
                            input_tokens=usage["inputTokens"],
                            output_tokens=usage["outputTokens"],
                            total_tokens=usage["totalTokens"],
                            latency_ms=max(
                                0, round((time.perf_counter() - started_at) * 1000)
                            ),
                            attempts=attempt,
                            reasoning_tokens=usage["reasoningTokens"],
                        )
                        LOGGER.info(
                            "Ark call succeeded stage=%s model=%s prompt_version=%s "
                            "input_tokens=%s output_tokens=%s reasoning_tokens=%s total_tokens=%s "
                            "latency_ms=%s attempts=%s",
                            metadata.stage,
                            metadata.model,
                            metadata.prompt_version,
                            metadata.input_tokens,
                            metadata.output_tokens,
                            metadata.reasoning_tokens,
                            metadata.total_tokens,
                            metadata.latency_ms,
                            metadata.attempts,
                        )
                        return AiCallResult(
                            value=value,
                            metadata=metadata,
                        )
                    except _RetryStructuredResponse:
                        pass
                    except (ValueError, ValidationError, KeyError, TypeError) as exc:
                        last_error = exc
                        last_error_type = ProviderErrorType.RESPONSE_INVALID
                        retryable = attempt == 1
                else:
                    last_error = RuntimeError("Ark returned a non-success response")
                    if response.status_code == 429:
                        last_error_type = ProviderErrorType.RATE_LIMIT
                        retryable = True
                    elif response.status_code >= 500:
                        last_error_type = ProviderErrorType.SERVICE
                        retryable = True
                    else:
                        last_error_type = ProviderErrorType.REQUEST_REJECTED
                        retryable = False
            if not retryable or attempt >= attempt_limit:
                break
            delay = min(4.0, 0.4 * (2 ** (attempt - 1))) + random.uniform(0.0, 0.15)
            await asyncio.sleep(delay)
        elapsed_ms = max(0, round((time.perf_counter() - started_at) * 1000))
        raise ProviderError(
            _PROVIDER_ERROR_MESSAGES[last_error_type],
            retryable=retryable,
            error_type=last_error_type,
            attempts=attempts,
            elapsed_ms=elapsed_ms,
        ) from last_error
