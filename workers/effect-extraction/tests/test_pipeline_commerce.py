from __future__ import annotations

from typing import Any

import pytest

from effect_extraction.commerce import CommercePage, CommerceFetchError, CommerceErrorType
from effect_extraction.models import (
    BranchOutput,
    BranchStatus,
    ExtractionCandidate,
    ExtractionSnapshot,
    RuntimeContext,
    SnapshotProduct,
    VideoConfig,
)
from effect_extraction.pipeline import ExtractionPipeline
from effect_extraction.providers import MockAiProvider, ProviderError, ProviderErrorType


def context() -> RuntimeContext:
    return RuntimeContext(
        "run", "project", "draft", "product", "request", "attempt", "fingerprint"
    )


def snapshot(url: str | None) -> ExtractionSnapshot:
    config = VideoConfig(
        aspect_ratio="9:16",
        duration_seconds=20,
        resolution="1080P",
        frame_rate=30,
        subtitle_strategy="无字幕",
        voiceover_strategy="无口播",
        bgm_strategy="自动",
        style_tone="自然",
        delivery_channel="抖音",
        disabled_elements=[],
    )
    return ExtractionSnapshot(
        project_id="project",
        draft_id="draft",
        mode="SINGLE",
        source_revision=1,
        product=SnapshotProduct(
            id="product",
            name="表单商品",
            category="食品",
            sku="sku",
            commerce_url=url,
            effective_config=config,
        ),
    )


class Api:
    def __init__(self) -> None:
        self.saved: list[BranchOutput] = []
        self.uploads: list[dict[str, Any]] = []

    async def put_branch(self, context: RuntimeContext, output: BranchOutput) -> None:
        self.saved.append(output)

    async def progress(self, context: RuntimeContext, payload: object) -> None:
        return None

    async def upload_artifact(self, context: RuntimeContext, **kwargs: Any) -> str:
        self.uploads.append(kwargs)
        return "commerce/page.md"


class Fetcher:
    async def fetch(self, url: str) -> CommercePage:
        deterministic = ExtractionCandidate.empty()
        deterministic.product_name = "结构化商品名"
        deterministic.price_range = "CNY 59"
        return CommercePage(
            markdown="# 商品\n六分瘦四分肥",
            source_host="shop.example",
            page_title="商品详情",
            deterministic_candidate=deterministic,
            model_metadata={"name": "结构化商品名", "price": "59"},
            used_renderer=False,
        )


class FailingFetcher:
    async def fetch(self, url: str) -> CommercePage:
        raise CommerceFetchError(CommerceErrorType.ACCESS_RESTRICTED)


class FailingProvider(MockAiProvider):
    async def extract_commerce(self, *args: Any, **kwargs: Any) -> Any:
        raise ProviderError(
            "AI request timed out",
            retryable=True,
            error_type=ProviderErrorType.TIMEOUT,
            attempts=3,
            elapsed_ms=12_345,
        )


def pipeline(api: Api, provider: MockAiProvider, fetcher: object) -> ExtractionPipeline:
    return ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        document_parser=object(),  # type: ignore[arg-type]
        image_processor=object(),  # type: ignore[arg-type]
        max_document_text_chars=1_000,
        commerce_fetcher=fetcher,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_commerce_without_url_is_skipped_without_warning() -> None:
    api = Api()
    worker = pipeline(api, MockAiProvider(), Fetcher())
    worker.register_snapshot(context(), snapshot(None))
    output = await worker.commerce_branch(context())
    assert output.status == BranchStatus.SKIPPED
    assert output.warnings == []
    assert api.uploads == []


@pytest.mark.asyncio
async def test_commerce_success_uploads_markdown_idempotently_and_merges_facts() -> None:
    api = Api()
    worker = pipeline(api, MockAiProvider(), Fetcher())
    worker.register_snapshot(context(), snapshot("https://shop.example/product"))
    output = await worker.commerce_branch(context())
    assert output.status == BranchStatus.SUCCEEDED
    assert output.candidate is not None
    assert output.candidate.product_name == "结构化商品名"
    assert output.candidate.price_range == "CNY 59"
    assert output.metadata == {"sourceHost": "shop.example"}
    assert api.uploads[0]["artifact_kind"] == "COMMERCE_MARKDOWN"
    assert api.uploads[0]["idempotency_key"] == "run:commerce:product:fingerprint"
    assert "https://" not in str(output.model_dump())
    assert "六分瘦四分肥" not in str(output.model_dump())


@pytest.mark.asyncio
async def test_commerce_ai_failure_keeps_structured_facts_as_partial() -> None:
    api = Api()
    worker = pipeline(api, FailingProvider(), Fetcher())
    worker.register_snapshot(context(), snapshot("https://shop.example/product"))
    output = await worker.commerce_branch(context())
    assert output.status == BranchStatus.PARTIAL
    assert output.candidate is not None
    assert output.candidate.product_name == "结构化商品名"
    assert output.warnings == ["商品页面 AI 抽取超时"]
    assert output.metadata == {
        "sourceHost": "shop.example",
        "failures": [{"type": "AI_TIMEOUT", "attempts": 3, "elapsedMs": 12_345}],
    }


@pytest.mark.asyncio
async def test_commerce_access_restriction_is_failed_but_safe() -> None:
    api = Api()
    worker = pipeline(api, MockAiProvider(), FailingFetcher())
    worker.register_snapshot(context(), snapshot("https://shop.example/product?token=secret"))
    output = await worker.commerce_branch(context())
    assert output.status == BranchStatus.FAILED
    assert output.warnings == ["商品页面需要登录或验证，暂时无法读取"]
    assert "secret" not in str(output.model_dump())
    assert output.metadata == {
        "failures": [
            {"type": "COMMERCE_ACCESS_RESTRICTED", "attempts": 1, "elapsedMs": 0}
        ]
    }
