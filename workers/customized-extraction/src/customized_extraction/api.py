from __future__ import annotations
from typing import Any
import httpx
from extraction_runtime.http import request, unwrap


class Api:
    def __init__(
        self, base_url: str, token: str, project_id: str, task_id: str
    ) -> None:
        self.project_id = project_id
        self.task_id = task_id
        self.token: str | None = None
        self.client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=60,
            headers={"x-worker-token": token},
        )

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> Any:
        kwargs: dict[str, Any] = {"headers": {"x-attempt-token": self.token or ""}}
        if method == "GET":
            kwargs["params"] = {"projectId": self.project_id}
        else:
            kwargs["json"] = {"projectId": self.project_id, **(body or {})}
        response = await request(
            self.client,
            method,
            f"internal/workers/customized-extraction/tasks/{self.task_id}/{path}",
            **kwargs,
        )
        return unwrap(response.json())

    async def content(self, source_id: str, parsed: bool = False) -> bytes:
        response = await request(
            self.client,
            "GET",
            f"internal/workers/customized-extraction/tasks/{self.task_id}/{'parsed' if parsed else 'sources'}/{source_id}",
            params={"projectId": self.project_id},
            headers={"x-attempt-token": self.token or ""},
        )
        return response.content

    async def upload(self, source_id: str, text: str) -> None:
        response = await request(
            self.client,
            "POST",
            f"internal/workers/customized-extraction/tasks/{self.task_id}/artifacts",
            data={"projectId": self.project_id, "sourceId": source_id},
            files={"file": ("parsed.txt", text.encode(), "text/plain")},
            headers={"x-attempt-token": self.token or ""},
        )
        unwrap(response.json())

    async def close(self) -> None:
        await self.client.aclose()
