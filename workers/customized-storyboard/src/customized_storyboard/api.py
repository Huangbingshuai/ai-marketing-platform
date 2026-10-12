from __future__ import annotations
from typing import Any
import httpx
from ai_runtime.http import request, unwrap


class Api:
    def __init__(self, url: str, secret: str, project: str, task: str) -> None:
        self.client = httpx.AsyncClient(
            base_url=f"{url.rstrip('/')}/internal/workers/customized-storyboard/tasks/{task}/",
            headers={"x-worker-token": secret},
            timeout=60,
        )
        self.project = project
        self.token = ""

    async def call(
        self, method: str, path: str, value: dict[str, Any] | None = None
    ) -> Any:
        response = await request(
            self.client,
            method,
            path,
            headers={"x-attempt-token": self.token},
            json={"projectId": self.project, **(value or {})},
        )
        return unwrap(response.json())

    async def close(self) -> None:
        await self.client.aclose()
