from __future__ import annotations
from typing import Any
import asyncio
import httpx
from extraction_runtime.http import request, unwrap, InternalApiError


class Api:
    def __init__(
        self, base_url: str, token: str, project_id: str, task_id: str
    ) -> None:
        self.project_id = project_id
        self.task_id = task_id
        self.token: str | None = None
        self.client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=httpx.Timeout(60, connect=5),
            headers={"x-worker-token": token},
        )

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        # Internal writes are idempotent and attempt-scoped. A brief API outage
        # must not rerun expensive successful model calls or restart the consumer.
        for attempt in range(4):
            try:
                return await request(self.client, method, path, **kwargs)
            except InternalApiError as error:
                if not error.retryable or attempt == 3:
                    raise
                await asyncio.sleep(2**attempt)
        raise AssertionError("unreachable")

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> Any:
        kwargs: dict[str, Any] = {"headers": {"x-attempt-token": self.token or ""}}
        if method == "GET":
            kwargs["params"] = {"projectId": self.project_id}
        else:
            kwargs["json"] = {"projectId": self.project_id, **(body or {})}
        response = await self._request(
            method,
            f"internal/workers/customized-extraction/tasks/{self.task_id}/{path}",
            **kwargs,
        )
        return unwrap(response.json())

    async def content(self, source_id: str, parsed: bool = False) -> bytes:
        response = await self._request(
            "GET",
            f"internal/workers/customized-extraction/tasks/{self.task_id}/{'parsed' if parsed else 'sources'}/{source_id}",
            params={"projectId": self.project_id},
            headers={"x-attempt-token": self.token or ""},
        )
        return response.content

    async def upload(self, source_id: str, text: str) -> None:
        response = await self._request(
            "POST",
            f"internal/workers/customized-extraction/tasks/{self.task_id}/artifacts",
            data={"projectId": self.project_id, "sourceId": source_id},
            files={"file": ("parsed.txt", text.encode(), "text/plain")},
            headers={"x-attempt-token": self.token or ""},
        )
        unwrap(response.json())

    async def close(self) -> None:
        await self.client.aclose()
