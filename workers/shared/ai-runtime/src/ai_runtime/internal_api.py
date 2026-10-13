from __future__ import annotations
import asyncio
import time
from typing import Any
import httpx
from ai_runtime.http import InternalApiError, request, unwrap


class Api:
    def __init__(self, url: str, secret: str, project: str, task: str, namespace: str = 'customized-storyboard') -> None:
        self.client = httpx.AsyncClient(
            base_url=f"{url.rstrip('/')}/internal/workers/{namespace}/tasks/{task}/",
            headers={"x-worker-token": secret},
            timeout=60,
        )
        self.project = project
        self.token = ""

    async def call(
        self, method: str, path: str, value: dict[str, Any] | None = None
    ) -> Any:
        # All worker endpoints are idempotent and fenced by attemptToken. Keep a
        # completed paid response in memory across short API restarts instead of
        # discarding it and paying for generation again after lease recovery.
        deadline = time.monotonic() + 40
        for attempt in range(6):
            try:
                response = await request(
                    self.client,
                    method,
                    path,
                    headers={"x-attempt-token": self.token},
                    json={"projectId": self.project, **(value or {})},
                    timeout=min(10, max(0.1, deadline - time.monotonic())),
                )
                return unwrap(response.json())
            except InternalApiError as error:
                delay = min(8, 2**attempt)
                if (
                    not error.retryable
                    or attempt == 5
                    or time.monotonic() + delay >= deadline
                ):
                    raise
                await asyncio.sleep(delay)
        raise AssertionError("unreachable retry boundary")

    async def close(self) -> None:
        await self.client.aclose()
