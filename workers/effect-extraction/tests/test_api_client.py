import json

import httpx
import pytest

from effect_extraction.api_client import HttpInternalApi
from effect_extraction.models import BranchName, BranchOutput, BranchStatus, RuntimeContext


def claim_data() -> dict[str, object]:
    return {
        "terminal": False,
        "runId": "run-1",
        "sourceFingerprint": "server-fingerprint",
        "attemptToken": "attempt-1",
        "input": {
            "schemaVersion": 1,
            "projectId": "project-1",
            "draftId": "draft-1",
            "mode": "SINGLE",
            "sourceRevision": 2,
            "product": {
                "id": "product-1", "name": "商品", "category": "食品", "sku": "sku-1",
                "commerceUrl": None,
                "effectiveConfig": {
                    "aspectRatio": "9:16", "durationSeconds": 15, "resolution": "1080P",
                    "frameRate": 30, "subtitleStrategy": "跟随口播",
                    "voiceoverStrategy": "AI 女声", "bgmStrategy": "自动匹配",
                    "styleTone": "自然", "deliveryChannel": "抖音", "disabledElements": [],
                },
            },
            "materials": [],
        },
    }


@pytest.mark.asyncio
async def test_internal_api_claim_and_branch_match_backend_contract() -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/claim"):
            return httpx.Response(200, json={"success": True, "data": claim_data()})
        if request.url.path.endswith("/artifacts"):
            return httpx.Response(
                201,
                json={
                    "success": True,
                    "data": {
                        "artifactId": "artifact-1",
                        "storageKey": "artifact/product.md",
                        "sizeBytes": 12,
                        "replayed": False,
                    },
                },
            )
        return httpx.Response(200, json={"success": True, "data": {"accepted": True}})

    api = HttpInternalApi("http://api.local/api/", "worker-secret",
                          transport=httpx.MockTransport(handler))
    try:
        claim = await api.claim("run-1", "project-1")
        assert claim.input is not None
        context = RuntimeContext(
            "run-1", "project-1", "draft-1", "product-1", "request-1", "attempt-1",
            claim.source_fingerprint or "",
        )
        await api.put_branch(
            context,
            BranchOutput(branch=BranchName.FORM, status=BranchStatus.SUCCEEDED,
                         source_fingerprint=context.source_fingerprint),
        )
        storage_key = await api.upload_artifact(
            context,
            artifact_kind="DOCLING_MARKDOWN",
            source_id="source-1",
            content=b"# Product\n",
            content_type="text/markdown",
            idempotency_key="artifact-key-1",
        )
    finally:
        await api.aclose()
    assert storage_key == "artifact/product.md"
    assert requests[0].url.path == "/api/internal/workers/effect-extraction/runs/run-1/claim"
    assert json.loads(requests[0].content) == {"projectId": "project-1"}
    assert requests[1].headers["x-worker-token"] == "worker-secret"
    assert requests[1].headers["x-attempt-token"] == "attempt-1"
    body = json.loads(requests[1].content)
    assert body["projectId"] == "project-1"
    assert body["branch"] == "FORM"
    assert body["status"] == "SUCCEEDED"
    assert requests[2].url.path.endswith("/artifacts")
    assert requests[2].headers["x-attempt-token"] == "attempt-1"
