from collections.abc import Mapping
from typing import Any

import httpx

from .models import (
    Claim,
    Classification,
    ClassificationCheckpoint,
    Runtime,
    Selection,
    TrimCheckpoint,
    TrimOutput,
)


class ApiError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


def _unwrap(value: Any) -> Any:
    if isinstance(value, Mapping) and "success" in value:
        if value.get("success") is not True:
            raise ApiError("internal API rejected request", retryable=False)
        return value.get("data")
    return value


class InternalApi:
    ROOT = "internal/workers/effect-template-mix"

    def __init__(self, base_url: str, token: str, timeout: float) -> None:
        self.client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=timeout,
            headers={"x-worker-token": token, "accept": "application/json"},
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self.client.request(method, path, **kwargs)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise ApiError("internal API unavailable", retryable=True) from exc
        if response.status_code >= 400:
            raise ApiError("internal API rejected request", retryable=response.status_code >= 500)
        return _unwrap(response.json()) if response.content else None

    async def claim(self, project_id: str, run_id: str) -> Claim:
        value = await self.request("POST", f"{self.ROOT}/runs/{run_id}/claim", json={"projectId": project_id})
        return Claim.model_validate(value)

    def headers(self, runtime: Runtime) -> dict[str, str]:
        return {"x-attempt-token": runtime.attempt_token}

    async def progress(self, runtime: Runtime, stage: str, progress: int) -> None:
        await self.request(
            "PUT",
            f"{self.ROOT}/runs/{runtime.run_id}/progress",
            headers=self.headers(runtime),
            json={"projectId": runtime.project_id, "stage": stage, "progress": progress},
        )

    async def classify(self, runtime: Runtime, rows: list[Classification]) -> list[Selection]:
        value = await self.request(
            "POST",
            f"{self.ROOT}/runs/{runtime.run_id}/classifications",
            headers=self.headers(runtime),
            json={"projectId": runtime.project_id, "classifications": [row.model_dump() for row in rows]},
        )
        return [Selection.model_validate(item) for item in value["selections"]]

    async def checkpoint_classifications(
        self,
        runtime: Runtime,
        rows: list[Classification],
    ) -> ClassificationCheckpoint:
        value = await self.request(
            "PUT",
            f"{self.ROOT}/runs/{runtime.run_id}/classifications/checkpoint",
            headers=self.headers(runtime),
            json={
                "projectId": runtime.project_id,
                "classifications": [row.model_dump() for row in rows],
            },
        )
        return ClassificationCheckpoint.model_validate(value)

    async def video(self, runtime: Runtime, material_id: str, max_bytes: int) -> bytes:
        path = f"{self.ROOT}/runs/{runtime.run_id}/materials/{material_id}/content"
        async with self.client.stream(
            "GET", path, headers=self.headers(runtime), params={"projectId": runtime.project_id}
        ) as response:
            if response.status_code >= 400:
                raise ApiError("selected video unavailable", retryable=response.status_code >= 500)
            if int(response.headers.get("content-length", "0") or 0) > max_bytes:
                raise ApiError("selected video too large", retryable=False)
            parts: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise ApiError("selected video too large", retryable=False)
                parts.append(chunk)
            return b"".join(parts)

    async def checkpoint_trims(
        self,
        runtime: Runtime,
        trims: list[TrimOutput],
    ) -> TrimCheckpoint:
        value = await self.request(
            "PUT",
            f"{self.ROOT}/runs/{runtime.run_id}/trims/checkpoint",
            headers=self.headers(runtime),
            json={
                "projectId": runtime.project_id,
                "trims": [item.model_dump() for item in trims],
            },
        )
        return TrimCheckpoint.model_validate(value)

    async def complete(self, runtime: Runtime, trims: list[TrimOutput]) -> None:
        await self.request(
            "POST", f"{self.ROOT}/runs/{runtime.run_id}/complete", headers=self.headers(runtime),
            json={"projectId": runtime.project_id, "trims": [item.model_dump() for item in trims]},
        )

    async def fail(self, runtime: Runtime, code: str, message: str, retryable: bool) -> None:
        await self.request(
            "POST", f"{self.ROOT}/runs/{runtime.run_id}/fail", headers=self.headers(runtime),
            json={"projectId": runtime.project_id, "errorCode": code, "errorMessage": message, "retryable": retryable},
        )
