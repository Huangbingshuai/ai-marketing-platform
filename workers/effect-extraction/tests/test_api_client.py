import json

import httpx
import pytest

from effect_extraction.api_client import HttpInternalApi
from effect_extraction.models import (
    BranchName,
    BranchOutput,
    BranchStatus,
    ExtractionCandidate,
    RuntimeContext,
)


def claim_data() -> dict[str, object]:
    return {
        "terminal": False,
        "runId": "run-1",
        "sourceFingerprint": "server-fingerprint",
        "attemptToken": "attempt-1",
        "input": {
            "schemaVersion": 2,
            "projectId": "project-1",
            "draftId": "draft-1",
            "mode": "SINGLE",
            "sourceRevision": 2,
            "globalVideoConfig": {
                "aspectRatio": "1:1", "durationSeconds": 20, "resolution": "720P",
                "frameRate": 25, "subtitleStrategy": "无字幕",
                "voiceoverStrategy": "无口播", "bgmStrategy": "轻快",
                "styleTone": "烟火食欲感", "deliveryChannel": "视频号",
                "disabledElements": ["医疗功效"],
            },
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
            "dependencySnapshot": {
                "sourcePackageRevision": 2,
                "effectiveVideoConfigRevision": 3,
                "executionInputHash": "input-hash",
            },
            "dependencies": [
                {
                    "sourceType": "EXECUTION_INPUT",
                    "sourceKey": "effect-extraction:product-1",
                    "sourceRevision": 2,
                    "sourceHash": "input-hash",
                }
            ],
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
        assert claim.input.dependency_snapshot is not None
        assert claim.input.dependency_snapshot.execution_input_hash == "input-hash"
        assert claim.input.dependencies[0].source_type == "EXECUTION_INPUT"
        assert claim.input.global_video_config is not None
        assert claim.input.global_video_config.delivery_channel == "视频号"
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


@pytest.mark.asyncio
async def test_internal_api_persists_specific_document_timeout_code() -> None:
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"success": True, "data": {"accepted": True}})

    context = RuntimeContext(
        "run-1", "project-1", "draft-1", "product-1", "request-1", "attempt-1",
        "server-fingerprint",
    )
    api = HttpInternalApi(
        "http://api.local/api/", "worker-secret", transport=httpx.MockTransport(handler)
    )
    try:
        await api.put_branch(
            context,
            BranchOutput(
                branch=BranchName.DOCUMENT,
                status=BranchStatus.FAILED,
                source_fingerprint=context.source_fingerprint,
                warnings=["文档 AI 抽取超时"],
                metadata={
                    "failures": [
                        {"type": "AI_TIMEOUT", "attempts": 3, "elapsedMs": 361_250}
                    ]
                },
            ),
        )
    finally:
        await api.aclose()

    assert captured["errorCode"] == "DOCUMENT_AI_TIMEOUT"
    assert captured["errorMessage"] == "文档 AI 抽取超时"
    assert captured["warnings"] == [
        {
            "code": "SOURCE_WARNING",
            "message": "文档 AI 抽取超时",
            "branch": "DOCUMENT",
            "sourceId": None,
        }
    ]


@pytest.mark.asyncio
async def test_internal_api_reads_and_writes_project_scoped_image_cache() -> None:
    requests: list[httpx.Request] = []
    candidate = ExtractionCandidate.empty()
    candidate.visual_features = "红色包装"

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "hit": True,
                        "candidate": candidate.model_dump(mode="json", by_alias=True),
                        "metadata": {},
                    },
                },
            )
        return httpx.Response(200, json={"success": True, "data": {"accepted": True}})

    context = RuntimeContext(
        "run-1",
        "project-1",
        "draft-1",
        "product-1",
        "request-1",
        "attempt-1",
        "server-fingerprint",
    )
    api = HttpInternalApi(
        "http://api.local/api/", "worker-secret", transport=httpx.MockTransport(handler)
    )
    try:
        cached = await api.get_image_cache(context, "a" * 64)
        await api.put_image_cache(
            context,
            "a" * 64,
            candidate,
            {"promptVersion": "4.0.0"},
        )
    finally:
        await api.aclose()

    assert cached is not None and cached.visual_features == "红色包装"
    assert dict(requests[0].url.params) == {
        "projectId": "project-1",
        "cacheKey": "a" * 64,
    }
    assert requests[0].headers["x-attempt-token"] == "attempt-1"
    body = json.loads(requests[1].content)
    assert body["projectId"] == "project-1"
    assert body["cacheKey"] == "a" * 64
    assert body["candidate"]["visualFeatures"] == "红色包装"
    assert body["metadata"] == {"promptVersion": "4.0.0"}
