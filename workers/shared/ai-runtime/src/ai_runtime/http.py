from __future__ import annotations

from typing import Any
import httpx


class InternalApiError(RuntimeError):
    def __init__(
        self, message: str, *, retryable: bool, status_code: int | None = None
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code


async def request(
    client: httpx.AsyncClient, method: str, path: str, **kwargs: Any
) -> httpx.Response:
    try:
        response = await client.request(method, path, **kwargs)
    except (
        httpx.TimeoutException,
        httpx.NetworkError,
        httpx.RemoteProtocolError,
    ) as exc:
        raise InternalApiError("internal API is unavailable", retryable=True) from exc
    if response.is_error:
        raise InternalApiError(
            "internal API request failed",
            retryable=response.status_code == 429 or response.status_code >= 500,
            status_code=response.status_code,
        )
    return response


def unwrap(payload: Any) -> Any:
    if isinstance(payload, dict) and "success" in payload:
        if payload["success"] is not True:
            raise InternalApiError("internal API rejected request", retryable=False)
        return payload.get("data")
    return payload
