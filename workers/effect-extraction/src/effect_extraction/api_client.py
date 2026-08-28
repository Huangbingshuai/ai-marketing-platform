from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

import httpx

from .models import (
    ArtifactResponse,
    BranchItem,
    BranchName,
    BranchOutput,
    BranchStatus,
    ClaimResponse,
    ExtractionCandidate,
    FailurePayload,
    FinalizePayload,
    FinalizeResponse,
    ProgressPayload,
    RuntimeContext,
)


class InternalApiError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool, status_code: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code


class InternalApi(Protocol):
    async def claim(self, run_id: str, project_id: str) -> ClaimResponse: ...
    async def download_material(self, context: RuntimeContext, material_id: str) -> bytes: ...
    async def upload_artifact(
        self, context: RuntimeContext, *, artifact_kind: str, source_id: str,
        content: bytes, content_type: str, idempotency_key: str,
    ) -> str: ...
    async def put_branch(self, context: RuntimeContext, output: BranchOutput) -> None: ...
    async def get_branches(self, context: RuntimeContext) -> list[BranchOutput]: ...
    async def get_image_cache(
        self, context: RuntimeContext, cache_key: str
    ) -> ExtractionCandidate | None: ...
    async def put_image_cache(
        self,
        context: RuntimeContext,
        cache_key: str,
        candidate: ExtractionCandidate,
        metadata: Mapping[str, Any],
    ) -> None: ...
    async def complete(self, context: RuntimeContext, payload: FinalizePayload) -> str: ...
    async def fail(self, context: RuntimeContext, payload: FailurePayload) -> None: ...
    async def progress(self, context: RuntimeContext, payload: ProgressPayload) -> None: ...


def _unwrap(payload: Any) -> Any:
    if isinstance(payload, Mapping) and "success" in payload:
        if payload.get("success") is not True:
            raise InternalApiError(str(payload.get("message") or "success=false"), retryable=False)
        return payload.get("data")
    return payload


class HttpInternalApi:
    _ROOT = "internal/workers/effect-extraction"

    def __init__(self, base_url: str, token: str, *, timeout: float = 60.0,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/", timeout=timeout, transport=transport,
            headers={"x-worker-token": token, "accept": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._client.request(method, path, **kwargs)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise InternalApiError("internal API is unavailable", retryable=True) from exc
        if response.is_error:
            retryable = response.status_code == 429 or response.status_code >= 500
            raise InternalApiError(f"internal API returned HTTP {response.status_code}",
                                   retryable=retryable, status_code=response.status_code)
        return response

    async def _json(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self._request(method, path, **kwargs)
        try:
            return _unwrap(response.json())
        except ValueError as exc:
            raise InternalApiError("internal API returned invalid JSON", retryable=False) from exc

    @staticmethod
    def _lease(context: RuntimeContext) -> dict[str, str]:
        return {"x-attempt-token": context.attempt_token}

    async def claim(self, run_id: str, project_id: str) -> ClaimResponse:
        payload = await self._json("POST", f"{self._ROOT}/runs/{run_id}/claim",
                                   json={"projectId": project_id})
        return ClaimResponse.model_validate(payload)

    async def download_material(self, context: RuntimeContext, material_id: str) -> bytes:
        response = await self._request(
            "GET", f"{self._ROOT}/runs/{context.run_id}/sources/{material_id}/content",
            params={"projectId": context.project_id}, headers=self._lease(context),
        )
        return response.content

    async def upload_artifact(
        self, context: RuntimeContext, *, artifact_kind: str, source_id: str,
        content: bytes, content_type: str, idempotency_key: str,
    ) -> str:
        payload = await self._json(
            "POST", f"{self._ROOT}/runs/{context.run_id}/artifacts",
            data={"projectId": context.project_id, "artifactKind": artifact_kind,
                  "sourceId": source_id, "idempotencyKey": idempotency_key},
            files={"file": (f"{source_id}.md", content, content_type)},
            headers=self._lease(context),
        )
        return ArtifactResponse.model_validate(payload).storage_key

    async def put_branch(self, context: RuntimeContext, output: BranchOutput) -> None:
        structured_output = {
            "candidate": output.candidate.model_dump(mode="json", by_alias=True) if output.candidate else None,
            "items": [item.model_dump(mode="json", by_alias=True) for item in output.items],
            "metadata": output.metadata,
        }
        text_key = next((item.artifact_storage_key for item in output.items
                         if item.artifact_storage_key), None)
        error = output.warnings[0] if output.status == BranchStatus.FAILED and output.warnings else None
        await self._json(
            "PUT", f"{self._ROOT}/runs/{context.run_id}/branches",
            headers=self._lease(context),
            json={"projectId": context.project_id, "branch": output.branch.value,
                  "status": output.status.value, "structuredOutput": structured_output,
                  "textStorageKey": text_key, "warnings": _warnings(output.warnings, output.branch),
                  "errorCode": _branch_error_code(output) if error else None,
                  "errorMessage": error},
        )

    async def get_branches(self, context: RuntimeContext) -> list[BranchOutput]:
        payload = await self._json(
            "GET", f"{self._ROOT}/runs/{context.run_id}/branches",
            params={"projectId": context.project_id}, headers=self._lease(context),
        )
        records = payload.get("branches", []) if isinstance(payload, Mapping) else payload
        if not isinstance(records, list):
            raise InternalApiError("branches response is not a list", retryable=False)
        return [_branch_output(record, context.source_fingerprint) for record in records]

    async def get_image_cache(
        self, context: RuntimeContext, cache_key: str
    ) -> ExtractionCandidate | None:
        payload = await self._json(
            "GET",
            f"{self._ROOT}/runs/{context.run_id}/image-cache",
            params={"projectId": context.project_id, "cacheKey": cache_key},
            headers=self._lease(context),
        )
        if not isinstance(payload, Mapping) or payload.get("hit") is not True:
            return None
        candidate = payload.get("candidate")
        if not isinstance(candidate, Mapping):
            raise InternalApiError("image cache candidate is invalid", retryable=False)
        return ExtractionCandidate.model_validate(candidate)

    async def put_image_cache(
        self,
        context: RuntimeContext,
        cache_key: str,
        candidate: ExtractionCandidate,
        metadata: Mapping[str, Any],
    ) -> None:
        await self._json(
            "PUT",
            f"{self._ROOT}/runs/{context.run_id}/image-cache",
            headers=self._lease(context),
            json={
                "projectId": context.project_id,
                "cacheKey": cache_key,
                "candidate": candidate.model_dump(mode="json", by_alias=True),
                "metadata": dict(metadata),
            },
        )

    async def complete(self, context: RuntimeContext, payload: FinalizePayload) -> str:
        data = await self._json(
            "POST", f"{self._ROOT}/runs/{context.run_id}/complete",
            headers=self._lease(context),
            json={"projectId": context.project_id,
                  "result": payload.result.model_dump(mode="json", by_alias=True),
                  "provenance": payload.provenance, "conflictReport": payload.conflict_report,
                  "warnings": _warnings(payload.warnings, None)},
        )
        return FinalizeResponse.model_validate(data).extract_result_id

    async def fail(self, context: RuntimeContext, payload: FailurePayload) -> None:
        await self._json(
            "POST", f"{self._ROOT}/runs/{context.run_id}/fail", headers=self._lease(context),
            json={"projectId": context.project_id, "errorCode": payload.error_code,
                  "errorMessage": payload.error_message, "retryable": payload.retryable,
                  "warnings": _warnings(payload.warnings, None)},
        )

    async def progress(self, context: RuntimeContext, payload: ProgressPayload) -> None:
        await self._json(
            "PUT", f"{self._ROOT}/runs/{context.run_id}/progress", headers=self._lease(context),
            json={"projectId": context.project_id, "progress": payload.progress,
                  "currentNode": payload.current_node},
        )


def _warnings(messages: list[str], branch: BranchName | None) -> list[dict[str, str | None]]:
    return [{"code": "SOURCE_WARNING", "message": message[:1000],
             "branch": branch.value if branch else None, "sourceId": None}
            for message in messages]


def _branch_error_code(output: BranchOutput) -> str:
    failures = output.metadata.get("failures")
    if isinstance(failures, list) and failures:
        first = failures[0]
        if isinstance(first, Mapping):
            error_type = first.get("type")
            if error_type in {
                "AI_TIMEOUT",
                "AI_NETWORK",
                "AI_RATE_LIMIT",
                "AI_SERVICE",
                "AI_RESPONSE_INVALID",
                "AI_REQUEST_REJECTED",
                "AI_OUTPUT_TRUNCATED",
                "AI_UNKNOWN",
            }:
                return f"{output.branch.value}_{error_type}"
    return f"{output.branch.value}_FAILED"


def _branch_output(record: Any, source_fingerprint: str) -> BranchOutput:
    if not isinstance(record, Mapping):
        raise InternalApiError("invalid branch record", retryable=False)
    structured = record.get("structuredOutput") or {}
    if not isinstance(structured, Mapping):
        structured = {}
    candidate_raw = structured.get("candidate")
    items_raw = structured.get("items") or []
    warnings_raw = record.get("warnings") or []
    return BranchOutput(
        branch=BranchName(str(record.get("branch"))), status=BranchStatus(str(record.get("status"))),
        source_fingerprint=source_fingerprint,
        candidate=ExtractionCandidate.model_validate(candidate_raw) if candidate_raw is not None else None,
        items=[BranchItem.model_validate(item) for item in items_raw],
        warnings=[str(item.get("message")) for item in warnings_raw
                  if isinstance(item, Mapping) and item.get("message")],
        metadata=dict(structured.get("metadata") or {}),
    )
