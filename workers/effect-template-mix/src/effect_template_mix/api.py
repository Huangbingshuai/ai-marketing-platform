import asyncio
from collections.abc import Mapping
from typing import Any
from time import monotonic

import httpx

from .models import (
    Claim,
    Classification,
    ClassificationCheckpoint,
    IncrementalPlan,
    Runtime,
    SampledMaterial,
    SamplingCheckpoint,
    Selection,
    TrimCheckpoint,
    TrimOutput,
)


class ApiError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool, status_code: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code


def _unwrap(value: Any) -> Any:
    if isinstance(value, Mapping) and "success" in value:
        if value.get("success") is not True:
            raise ApiError("internal API rejected request", retryable=False)
        return value.get("data")
    return value


class InternalApi:
    ROOT = "internal/workers/effect-template-mix"

    def __init__(self, base_url: str, token: str, timeout: float, max_attempts: int = 4, *,
                 recovery_max_attempts: int | None = None, recovery_timeout_seconds: float = 600,
                 recovery_max_delay_seconds: float = 30) -> None:
        self.max_attempts = max(1, max_attempts)
        self.recovery_max_attempts = max(1, recovery_max_attempts if recovery_max_attempts is not None else self.max_attempts)
        self.recovery_timeout_seconds = max(0.001, recovery_timeout_seconds)
        self.recovery_max_delay_seconds = max(0.001, recovery_max_delay_seconds)
        self.client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=timeout,
            headers={"x-worker-token": token, "accept": "application/json"},
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def _wait_for_recovery(self, attempt: int, deadline: float) -> bool:
        remaining = deadline - monotonic()
        if remaining <= 0:
            return False
        await asyncio.sleep(min(self.recovery_max_delay_seconds, 2 ** min(attempt + 1, 10), remaining))
        return monotonic() < deadline

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        deadline = monotonic() + self.recovery_timeout_seconds
        for attempt in range(self.recovery_max_attempts):
            try:
                async with asyncio.timeout(max(0.001, deadline - monotonic())):
                    response = await self.client.request(method, path, **kwargs)
            except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError, TimeoutError) as exc:
                # A failed connection sent no mutation. Ambiguous POST timeouts must
                # not replay a claim and acquire a second attempt token.
                safe_replay = isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)) or method.upper() in ("GET", "PUT")
                if safe_replay and attempt + 1 < self.recovery_max_attempts and await self._wait_for_recovery(attempt, deadline):
                    continue
                raise ApiError("internal API unavailable", retryable=True) from exc
            if response.status_code >= 500 and method.upper() in ("GET", "PUT") and attempt + 1 < self.recovery_max_attempts and await self._wait_for_recovery(attempt, deadline):
                continue
            break
        if response.status_code >= 400:
            message = "internal API rejected request"
            try:
                data = response.json()
                if isinstance(data, Mapping):
                    value = data.get("message")
                    if isinstance(value, str) and value.strip():
                        message = value.strip()
            except Exception:
                pass
            raise ApiError(message, retryable=response.status_code >= 500, status_code=response.status_code)
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

    async def incremental_roles(self, runtime: Runtime, rows: list[Classification]) -> dict[str, str]:
        value = await self.request(
            "POST", f"{self.ROOT}/runs/{runtime.run_id}/classifications",
            headers=self.headers(runtime),
            json={"projectId": runtime.project_id, "classifications": [row.model_dump() for row in rows]},
        )
        return dict(value["roleAssignments"])

    async def classify(self, runtime: Runtime, rows: list[Classification],
                       plan: IncrementalPlan | None = None) -> list[Selection]:
        body: dict[str, Any] = {"projectId": runtime.project_id, "classifications": [row.model_dump() for row in rows]}
        if plan is not None:
            body["incrementalPlan"] = plan.model_dump()
        value = await self.request(
            "POST",
            f"{self.ROOT}/runs/{runtime.run_id}/classifications",
            headers=self.headers(runtime),
            json=body,
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
        deadline = monotonic() + self.recovery_timeout_seconds
        for attempt in range(self.recovery_max_attempts):
            try:
                async with asyncio.timeout(max(0.001, deadline - monotonic())):
                    return await self._video_once(runtime, path, max_bytes)
            except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError, TimeoutError) as exc:
                failure = ApiError("素材下载暂时中断，请稍后重试", retryable=True)
                failure.__cause__ = exc
            except ApiError as exc:
                if not exc.retryable:
                    raise
                failure = exc
            if attempt + 1 >= self.recovery_max_attempts or not await self._wait_for_recovery(attempt, deadline):
                raise failure
        raise AssertionError("unreachable download attempt")

    async def _video_once(self, runtime: Runtime, path: str, max_bytes: int) -> bytes:
        async with self.client.stream(
            "GET", path, headers=self.headers(runtime), params={"projectId": runtime.project_id}
        ) as response:
            if response.status_code >= 400:
                raise ApiError("selected video unavailable", retryable=response.status_code >= 500,
                               status_code=response.status_code)
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

    async def checkpoint_sampling(self, runtime: Runtime, samples: list[SampledMaterial]) -> SamplingCheckpoint:
        value = await self.request(
            "PUT",
            f"{self.ROOT}/runs/{runtime.run_id}/sampling/checkpoint",
            headers=self.headers(runtime),
            json={"projectId": runtime.project_id, "samples": [item.model_dump() for item in samples]},
        )
        return SamplingCheckpoint.model_validate(value)

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
