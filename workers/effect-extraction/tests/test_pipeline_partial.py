from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from typing import Any

import pytest

from effect_extraction.image_processing import ProcessedImage
from effect_extraction.models import (
    BranchName,
    BranchOutput,
    BranchStatus,
    ExtractionCandidate,
    ExtractionSnapshot,
    FinalizePayload,
    RuntimeContext,
    SemanticRefinementDecision,
    SnapshotMaterial,
    SnapshotProduct,
    VideoConfig,
)
from effect_extraction.pipeline import (
    ExtractionPipeline,
    FusionError,
    _normalize_candidate_deterministically,
    _prepare_semantic_candidate,
    _restore_authoritative_sources,
)
from effect_extraction.providers import (
    AiCallMetadata,
    AiCallResult,
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)


CONTEXT = RuntimeContext(
    "run", "project", "draft", "product", "request", "attempt", "fingerprint"
)


class ApiStub:
    def __init__(self) -> None:
        config = VideoConfig(
            aspect_ratio="9:16",
            duration_seconds=15,
            resolution="1080P",
            frame_rate=30,
            subtitle_strategy="无字幕",
            voiceover_strategy="无口播",
            bgm_strategy="自动匹配",
            style_tone="自然",
            delivery_channel="抖音",
            disabled_elements=["医疗功效"],
        )
        self.snapshot = ExtractionSnapshot(
            schema_version=3,
            project_id="project",
            draft_id="draft",
            mode="SINGLE",
            source_revision=1,
            product=SnapshotProduct(
                id="product",
                name="紫苏梅子酱",
                category="复合调味酱",
                sku="sku",
                effective_config=config,
            ),
            materials=[],
        )
        self.saved: list[BranchOutput] = []
        self.branches: list[BranchOutput] = []
        self.image_cache: dict[str, ExtractionCandidate] = {}
        self.completed_payload: FinalizePayload | None = None

    async def download_material(
        self, context: RuntimeContext, material_id: str
    ) -> bytes:
        del context
        return material_id.encode()

    async def upload_artifact(self, context: RuntimeContext, **kwargs: Any) -> str:
        del context, kwargs
        return "artifacts/markdown"

    async def put_branch(self, context: RuntimeContext, output: BranchOutput) -> None:
        del context
        self.saved.append(output)

    async def progress(self, context: RuntimeContext, payload: object) -> None:
        del context, payload

    async def get_branches(self, context: RuntimeContext) -> list[BranchOutput]:
        del context
        return self.branches

    async def get_image_cache(
        self, context: RuntimeContext, cache_key: str
    ) -> ExtractionCandidate | None:
        del context
        return self.image_cache.get(cache_key)

    async def put_image_cache(
        self,
        context: RuntimeContext,
        cache_key: str,
        candidate: ExtractionCandidate,
        metadata: Mapping[str, Any],
    ) -> None:
        del context, metadata
        self.image_cache[cache_key] = candidate

    async def complete(self, context: RuntimeContext, payload: FinalizePayload) -> str:
        del context
        self.completed_payload = payload
        return "extract-result"


class ParserStub:
    async def parse(self, content: bytes, *, file_name: str) -> str:
        del content
        if file_name == "bad.pdf":
            raise ValueError("corrupt PDF")
        return "# 紫苏梅子酱\n220g\n适合刷制烤物"


class StructuredDocumentParser:
    async def parse(self, content: bytes, *, file_name: str) -> str:
        del content, file_name
        return """
### 产品品类
复合调味酱
### 产品名称
紫苏梅子酱
### 核心规格
220g 玻璃瓶装
### 核心卖点
- 梅子酸味与紫苏草本香
### 使用场景
- 适合刷制烤物
"""


class LongArticleParser:
    async def parse(self, content: bytes, *, file_name: str) -> str:
        del content, file_name
        sections = [
            "# 紫苏梅酱产品文章\n\n紫苏梅酱是一种复合调味酱。",
            "## 风味与质地\n\n" + "酸甜咸鲜与紫苏草本香层层展开。" * 70,
            "## 制作与用法\n\n" + "去核梅肉与紫苏调和成浓稠酱体。" * 70,
            "## 尾部独特用法\n\n可作为烤肉刷酱，让酱汁附着在食材表面。",
        ]
        return "\n\n".join(sections)


class ImageProcessorStub:
    def process(self, content: bytes) -> ProcessedImage:
        del content
        return ProcessedImage(
            data_uri="data:image/jpeg;base64,AA==",
            metadata={
                "processedWidth": 100,
                "processedHeight": 100,
                "processedSha256": "a" * 64,
                "preprocessVersion": "test",
            },
        )


class CountingDocumentProvider(MockAiProvider):
    def __init__(self) -> None:
        self.calls = 0

    async def extract_document(
        self, markdown: str, *, source_name: str
    ) -> AiCallResult[ExtractionCandidate]:
        self.calls += 1
        return await super().extract_document(markdown, source_name=source_name)


class ArticleChunkProvider(MockAiProvider):
    def __init__(self) -> None:
        self.active = 0
        self.max_active = 0
        self.inputs: list[str] = []

    async def extract_document(
        self, markdown: str, *, source_name: str
    ) -> AiCallResult[ExtractionCandidate]:
        del source_name
        self.inputs.append(markdown)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        await asyncio.sleep(0.01)
        self.active -= 1
        selling_point = (
            "可作为烤肉刷酱"
            if "尾部独特用法" in markdown
            else f"分片卖点-{len(self.inputs)}"
        )
        return AiCallResult(
            value=ExtractionCandidate(
                product_category="复合调味酱",
                product_name="紫苏梅酱",
                core_specification=None,
                price_range=None,
                visual_features=None,
                selling_points=[selling_point],
            ),
            metadata=AiCallMetadata(
                stage="DOCUMENT",
                model="strong-document-model",
                prompt_version="test-article",
                input_tokens=100,
                output_tokens=20,
                total_tokens=120,
                latency_ms=10,
                attempts=1,
                reasoning_tokens=5,
            ),
        )


class PartiallyFailingArticleProvider(ArticleChunkProvider):
    async def extract_document(
        self, markdown: str, *, source_name: str
    ) -> AiCallResult[ExtractionCandidate]:
        if "制作与用法" in markdown:
            raise ProviderError(
                "AI request timed out",
                retryable=True,
                error_type=ProviderErrorType.TIMEOUT,
            )
        return await super().extract_document(markdown, source_name=source_name)


class ConcurrentImageProvider(MockAiProvider):
    def __init__(self) -> None:
        self.active = 0
        self.max_active = 0

    async def analyze_image(
        self,
        data_uri: str,
        *,
        source_name: str,
        image_metadata: Mapping[str, Any],
    ) -> AiCallResult[ExtractionCandidate]:
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        await asyncio.sleep(0.02)
        self.active -= 1
        return await super().analyze_image(
            data_uri, source_name=source_name, image_metadata=image_metadata
        )


class CountingImageProvider(MockAiProvider):
    def __init__(self) -> None:
        self.calls = 0

    async def analyze_image(
        self,
        data_uri: str,
        *,
        source_name: str,
        image_metadata: Mapping[str, Any],
    ) -> AiCallResult[ExtractionCandidate]:
        self.calls += 1
        return await super().analyze_image(
            data_uri, source_name=source_name, image_metadata=image_metadata
        )


class TimeoutSemanticProvider(MockAiProvider):
    async def refine_semantics(
        self,
        *,
        user_facts: Sequence[Mapping[str, str]],
        image_suggestions: Sequence[Mapping[str, str]],
        reference_facts: Sequence[Mapping[str, str]],
        remaining_capacity_by_field: Mapping[str, int],
    ) -> Any:
        del user_facts, image_suggestions, reference_facts, remaining_capacity_by_field
        raise ProviderError(
            "AI request timed out",
            retryable=True,
            error_type=ProviderErrorType.TIMEOUT,
            attempts=1,
            elapsed_ms=12_500,
        )


class MissingDecisionSemanticProvider(MockAiProvider):
    async def refine_semantics(
        self,
        *,
        user_facts: Sequence[Mapping[str, str]],
        image_suggestions: Sequence[Mapping[str, str]],
        reference_facts: Sequence[Mapping[str, str]],
        remaining_capacity_by_field: Mapping[str, int],
    ) -> AiCallResult[SemanticRefinementDecision]:
        del user_facts, image_suggestions, reference_facts, remaining_capacity_by_field
        return AiCallResult(
            value=SemanticRefinementDecision(
                suggestion_decisions=[], user_fact_notices=[]
            ),
            metadata=AiCallMetadata(
                stage="SEMANTIC_REFINEMENT",
                model="test-model",
                prompt_version="test-current",
                input_tokens=10,
                output_tokens=5,
                total_tokens=15,
                latency_ms=20,
                attempts=1,
                reasoning_tokens=0,
            ),
        )


def pipeline(api: ApiStub, provider: MockAiProvider) -> ExtractionPipeline:
    return ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        document_parser=ParserStub(),
        image_processor=ImageProcessorStub(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )


@pytest.mark.asyncio
async def test_document_branch_keeps_success_when_one_file_fails() -> None:
    api = ApiStub()
    api.snapshot.materials = [
        SnapshotMaterial(
            id=name,
            type="PRODUCT_DOCUMENT",
            original_file_name=f"{name}.pdf",
            mime_type="application/pdf",
            size_bytes=4,
        )
        for name in ("good", "bad")
    ]
    worker = pipeline(api, MockAiProvider())
    worker.register_snapshot(CONTEXT, api.snapshot)
    output = await worker.document_branch(CONTEXT)
    assert output.status == BranchStatus.PARTIAL
    assert [item.status for item in output.items] == [
        BranchStatus.SUCCEEDED,
        BranchStatus.FAILED,
    ]


@pytest.mark.asyncio
async def test_plain_text_product_document_enters_document_ai_branch() -> None:
    api = ApiStub()
    api.snapshot.materials = [
        SnapshotMaterial(
            id="article",
            type="PRODUCT_DOCUMENT",
            original_file_name="紫苏梅子酱产品文章.txt",
            mime_type="text/plain",
            size_bytes=4,
        )
    ]
    provider = CountingDocumentProvider()
    worker = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        document_parser=ParserStub(),
        image_processor=ImageProcessorStub(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )
    worker.register_snapshot(CONTEXT, api.snapshot)

    output = await worker.document_branch(CONTEXT)

    assert output.status == BranchStatus.SUCCEEDED
    assert provider.calls == 1
    assert output.items[0].source_id == "article"
    assert output.items[0].metadata["extractionMode"] == "AI_FALLBACK"


@pytest.mark.asyncio
async def test_structured_document_folds_old_labels_into_unified_selling_points() -> (
    None
):
    api = ApiStub()
    api.snapshot.materials = [
        SnapshotMaterial(
            id="doc",
            type="PRODUCT_DOCUMENT",
            original_file_name="产品资料.docx",
            mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size_bytes=4,
        )
    ]
    provider = CountingDocumentProvider()
    worker = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        document_parser=StructuredDocumentParser(),
        image_processor=ImageProcessorStub(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )
    worker.register_snapshot(CONTEXT, api.snapshot)
    output = await worker.document_branch(CONTEXT)
    assert provider.calls == 0
    assert output.items[0].candidate is not None
    assert output.items[0].candidate.selling_points == [
        "梅子酸味与紫苏草本香",
        "适合刷制烤物",
    ]


@pytest.mark.asyncio
async def test_unstructured_product_article_uses_sliding_chunks_and_keeps_tail() -> None:
    api = ApiStub()
    api.snapshot.materials = [
        SnapshotMaterial(
            id="article",
            type="PRODUCT_DOCUMENT",
            original_file_name="紫苏梅酱产品文章.docx",
            mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size_bytes=4,
        )
    ]
    provider = ArticleChunkProvider()
    worker = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        document_parser=LongArticleParser(),
        image_processor=ImageProcessorStub(),  # type: ignore[arg-type]
        max_document_text_chars=5_000,
        document_chunk_text_chars=1_000,
        document_max_concurrency=2,
    )
    worker.register_snapshot(CONTEXT, api.snapshot)

    output = await worker.document_branch(CONTEXT)

    item = output.items[0]
    assert output.status == BranchStatus.SUCCEEDED
    assert item.candidate is not None
    assert "可作为烤肉刷酱" in (item.candidate.selling_points or [])
    assert len(provider.inputs) >= 3
    assert provider.max_active == 2
    assert item.metadata["extractionMode"] == "AI_DOCUMENT_CHUNKS"
    assert item.metadata["modelChunkCount"] == len(provider.inputs)
    assert item.metadata["successfulModelChunkCount"] == len(provider.inputs)
    assert item.metadata["failedModelChunkCount"] == 0
    assert item.metadata["modelInputTruncated"] is False
    assert item.metadata["aiCall"]["model"] == "strong-document-model"
    assert item.metadata["aiCall"]["inputTokens"] == 100 * len(provider.inputs)


@pytest.mark.asyncio
async def test_unstructured_article_keeps_successful_chunks_when_one_fails() -> None:
    api = ApiStub()
    api.snapshot.materials = [
        SnapshotMaterial(
            id="article",
            type="PRODUCT_DOCUMENT",
            original_file_name="产品文章.docx",
            mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size_bytes=4,
        )
    ]
    provider = PartiallyFailingArticleProvider()
    worker = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        document_parser=LongArticleParser(),
        image_processor=ImageProcessorStub(),  # type: ignore[arg-type]
        max_document_text_chars=5_000,
        document_chunk_text_chars=1_000,
        document_max_concurrency=2,
    )
    worker.register_snapshot(CONTEXT, api.snapshot)

    output = await worker.document_branch(CONTEXT)

    item = output.items[0]
    assert output.status == BranchStatus.PARTIAL
    assert item.status == BranchStatus.PARTIAL
    assert item.candidate is not None
    assert "可作为烤肉刷酱" in (item.candidate.selling_points or [])
    assert item.metadata["failedModelChunkCount"] == 1
    assert item.warning is not None
    assert "1 个分片处理失败" in item.warning


@pytest.mark.asyncio
async def test_image_branch_uses_sliding_concurrency_and_cache() -> None:
    api = ApiStub()
    api.snapshot.materials = [
        SnapshotMaterial(
            id=f"image-{index}",
            type="PRODUCT_IMAGE",
            original_file_name=f"image-{index}.png",
            mime_type="image/png",
            size_bytes=10,
        )
        for index in range(3)
    ]
    provider = ConcurrentImageProvider()
    worker = pipeline(api, provider)
    worker.register_snapshot(CONTEXT, api.snapshot)
    first = await worker.image_branch(CONTEXT)
    second = await worker.image_branch(CONTEXT)
    assert first.status == BranchStatus.SUCCEEDED
    assert provider.max_active == 2
    assert all(item.metadata["cache"]["hit"] for item in second.items)


def test_semantic_candidate_preserves_source_authority() -> None:
    document = ExtractionCandidate.empty()
    document.product_name = "紫苏梅子酱"
    document.visual_features = "深红紫色酱体"
    document.selling_points = ["梅子酸甜", "适合刷制烤物"]
    image = ExtractionCandidate.empty()
    image.selling_points = ["可见果肉颗粒"]
    candidate, user_facts, image_suggestions, references = _prepare_semantic_candidate(
        ExtractionCandidate.empty(),
        [
            BranchOutput(
                branch=BranchName.DOCUMENT,
                status=BranchStatus.SUCCEEDED,
                source_fingerprint="fingerprint",
                candidate=document,
            ),
            BranchOutput(
                branch=BranchName.IMAGE,
                status=BranchStatus.SUCCEEDED,
                source_fingerprint="fingerprint",
                candidate=image,
            ),
        ],
        manual_overrides={},
    )
    assert candidate.selling_points == [
        "梅子酸甜",
        "适合刷制烤物",
        "可见果肉颗粒",
    ]
    assert [item["value"] for item in user_facts] == [
        "梅子酸甜",
        "适合刷制烤物",
    ]
    assert [item["value"] for item in image_suggestions] == ["可见果肉颗粒"]
    assert [item["field"] for item in [*user_facts, *image_suggestions]] == [
        "sellingPoints",
        "sellingPoints",
        "sellingPoints",
    ]
    assert {item["field"] for item in references} == {
        "productName",
        "visualFeatures",
    }


def test_semantic_candidate_preserves_all_sources_beyond_recommended_count() -> None:
    document = ExtractionCandidate.empty()
    document.selling_points = [f"文档卖点 {index}" for index in range(1, 41)]
    image = ExtractionCandidate.empty()
    image.selling_points = ["图片补充卖点"]

    candidate, user_facts, image_suggestions, _ = _prepare_semantic_candidate(
        ExtractionCandidate.empty(),
        [
            BranchOutput(
                branch=BranchName.DOCUMENT,
                status=BranchStatus.SUCCEEDED,
                source_fingerprint="fingerprint",
                candidate=document,
            ),
            BranchOutput(
                branch=BranchName.IMAGE,
                status=BranchStatus.SUCCEEDED,
                source_fingerprint="fingerprint",
                candidate=image,
            ),
        ],
        manual_overrides={},
    )

    assert candidate.selling_points == [
        *[f"文档卖点 {index}" for index in range(1, 41)],
        "图片补充卖点",
    ]
    assert len(user_facts) == 40
    assert [item["value"] for item in image_suggestions] == ["图片补充卖点"]


def test_authoritative_source_restoration_preserves_all_points() -> None:
    document = ExtractionCandidate.empty()
    document.selling_points = [f"卖点 {index}" for index in range(1, 41)]
    image = ExtractionCandidate.empty()
    image.selling_points = ["图片补充卖点"]
    result = type("Result", (), {})()
    _restore_authoritative_sources(
        result,
        document=document,
        commerce=None,
        image=image,
    )
    assert len(result.selling_points) == 41
    assert result.selling_points[-1] == "图片补充卖点"


def test_authoritative_source_restoration_keeps_commerce_selling_points() -> None:
    commerce = ExtractionCandidate.empty()
    commerce.selling_points = ["商品页面确认的独立卖点"]
    result = type("Result", (), {})()
    _restore_authoritative_sources(
        result,
        document=None,
        commerce=commerce,
        image=None,
    )
    assert result.selling_points == ["商品页面确认的独立卖点"]


def test_normalization_rejects_missing_selling_points_without_placeholder() -> None:
    with pytest.raises(FusionError, match="未提取到可用卖点"):
        _normalize_candidate_deterministically(ExtractionCandidate.empty())


@pytest.mark.asyncio
async def test_semantic_timeout_keeps_user_points_and_drops_image_suggestions() -> None:
    api = ApiStub()
    document = ExtractionCandidate.empty()
    document.selling_points = ["梅子酸甜"]
    image = ExtractionCandidate.empty()
    image.selling_points = ["可见果肉颗粒"]
    fused = document.model_copy(update={"selling_points": ["梅子酸甜", "可见果肉颗粒"]})
    api.branches = [
        BranchOutput(
            branch=BranchName.DOCUMENT,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="fingerprint",
            candidate=document,
        ),
        BranchOutput(
            branch=BranchName.IMAGE,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="fingerprint",
            candidate=image,
        ),
        BranchOutput(
            branch=BranchName.FUSION,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="fingerprint",
            candidate=fused,
        ),
    ]
    worker = pipeline(api, TimeoutSemanticProvider())
    worker.register_snapshot(CONTEXT, api.snapshot)
    output = await worker.refine_semantics(CONTEXT)
    assert output.status == BranchStatus.PARTIAL
    assert output.candidate is not None
    assert output.candidate.selling_points == ["梅子酸甜"]
    assert output.metadata["degraded"] is True


@pytest.mark.asyncio
async def test_missing_image_decision_is_corrected_without_losing_user_points() -> None:
    api = ApiStub()
    document = ExtractionCandidate.empty()
    document.selling_points = ["梅子酸甜"]
    image = ExtractionCandidate.empty()
    image.selling_points = ["可见果肉颗粒"]
    fused = document.model_copy(update={"selling_points": ["梅子酸甜", "可见果肉颗粒"]})
    api.branches = [
        BranchOutput(
            branch=BranchName.DOCUMENT,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="fingerprint",
            candidate=document,
        ),
        BranchOutput(
            branch=BranchName.IMAGE,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="fingerprint",
            candidate=image,
        ),
        BranchOutput(
            branch=BranchName.FUSION,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="fingerprint",
            candidate=fused,
        ),
    ]
    worker = pipeline(api, MissingDecisionSemanticProvider())
    worker.register_snapshot(CONTEXT, api.snapshot)
    output = await worker.refine_semantics(CONTEXT)
    assert output.status == BranchStatus.PARTIAL
    assert output.candidate is not None
    assert output.candidate.selling_points == ["梅子酸甜"]
    assert output.metadata["validation"]["correctionCounts"] == {
        "MISSING_SUGGESTION_DECISION": 1
    }
