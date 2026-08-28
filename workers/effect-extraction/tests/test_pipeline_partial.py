from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

import pytest

from effect_extraction.image_processing import ProcessedImage
from effect_extraction.models import (
    BranchName,
    BranchOutput,
    BranchStatus,
    ExtractionCandidate,
    ExtractionSnapshot,
    RuntimeContext,
    SnapshotMaterial,
    SnapshotProduct,
    VideoConfig,
)
from effect_extraction.pipeline import ExtractionPipeline
from effect_extraction.providers import (
    AiCallResult,
    EmbeddingBatchResult,
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)


class ApiStub:
    def __init__(self) -> None:
        self.saved: list[BranchOutput] = []
        self.branches: list[BranchOutput] = []
        self.snapshot = ExtractionSnapshot(
            schema_version=2,
            project_id="project",
            draft_id="draft",
            mode="SINGLE",
            source_revision=1,
            global_video_config=VideoConfig(
                aspect_ratio="1:1",
                duration_seconds=20,
                resolution="720P",
                frame_rate=25,
                subtitle_strategy="无字幕",
                voiceover_strategy="无口播",
                bgm_strategy="轻快",
                style_tone="烟火食欲感",
                delivery_channel="视频号",
                disabled_elements=["医疗功效"],
            ),
            product=SnapshotProduct(
                id="product",
                name="商品",
                category="食品",
                sku="sku",
                commerce_url=None,
                effective_config=VideoConfig(
                    aspect_ratio="9:16",
                    duration_seconds=15,
                    resolution="1080P",
                    frame_rate=30,
                    subtitle_strategy="跟随口播",
                    voiceover_strategy="AI 女声",
                    bgm_strategy="自动匹配",
                    style_tone="自然",
                    delivery_channel="抖音",
                    disabled_elements=[],
                ),
            ),
            materials=[
                SnapshotMaterial(
                    id="good",
                    type="PRODUCT_DOCUMENT",
                    original_file_name="good.pdf",
                    mime_type="application/pdf",
                    size_bytes=4,
                ),
                SnapshotMaterial(
                    id="bad",
                    type="PRODUCT_DOCUMENT",
                    original_file_name="bad.pdf",
                    mime_type="application/pdf",
                    size_bytes=3,
                ),
            ],
        )

    async def download_material(
        self, context: RuntimeContext, material_id: str
    ) -> bytes:
        return material_id.encode()

    async def upload_artifact(self, context: RuntimeContext, **kwargs: Any) -> str:
        return "artifacts/markdown"

    async def put_branch(self, context: RuntimeContext, output: BranchOutput) -> None:
        self.saved.append(output)

    async def progress(self, context: RuntimeContext, payload: object) -> None:
        return None

    async def get_branches(self, context: RuntimeContext) -> list[BranchOutput]:
        return self.branches

    async def complete(self, context: RuntimeContext, payload: object) -> str:
        return "extract-result"


class ParserStub:
    async def parse(self, content: bytes, *, file_name: str) -> str:
        if file_name == "bad.pdf":
            raise ValueError("corrupt PDF")
        return "# 商品\n500ml\n便携"


class ImageProcessorStub:
    def process(self, content: bytes) -> ProcessedImage:
        return ProcessedImage(
            data_uri="data:image/jpeg;base64,AA==",
            metadata={"processedWidth": 100, "processedHeight": 100},
        )


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
            data_uri,
            source_name=source_name,
            image_metadata=image_metadata,
        )


class TimeoutDocumentProvider(MockAiProvider):
    async def extract_document(
        self, markdown: str, *, source_name: str
    ) -> AiCallResult[ExtractionCandidate]:
        raise ProviderError(
            "AI request timed out",
            retryable=True,
            error_type=ProviderErrorType.TIMEOUT,
            attempts=3,
            elapsed_ms=361_250,
        )


class TimeoutSemanticProvider(MockAiProvider):
    async def embed_semantic_texts(self, texts: list[str]) -> EmbeddingBatchResult:
        raise ProviderError(
            "AI request timed out",
            retryable=True,
            error_type=ProviderErrorType.TIMEOUT,
            attempts=3,
            elapsed_ms=12_500,
        )


class ReexpandingNormalizationProvider(MockAiProvider):
    async def normalize(
        self,
        fused: ExtractionCandidate,
        *,
        protected_input: Mapping[str, Any] | None = None,
    ) -> AiCallResult[Any]:
        result = await super().normalize(fused, protected_input=protected_input)
        result.value.purchase_scenarios = [
            "年货送礼",
            "节日伴手礼",
            "走亲访友礼赠",
        ]
        return result


@pytest.mark.asyncio
async def test_document_branch_keeps_success_when_one_file_fails() -> None:
    api = ApiStub()
    pipeline = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        document_parser=ParserStub(),
        image_processor=object(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )
    context = RuntimeContext(
        "run", "project", "draft", "product", "request", "attempt", "server-fingerprint"
    )
    pipeline.register_snapshot(context, api.snapshot)
    output = await pipeline.document_branch(context)
    assert output.branch == BranchName.DOCUMENT
    assert output.status == BranchStatus.PARTIAL
    assert [item.status for item in output.items] == [
        BranchStatus.SUCCEEDED,
        BranchStatus.FAILED,
    ]
    assert output.items[0].metadata["aiCall"]["stage"] == "DOCUMENT"
    assert api.saved[-1] == output


@pytest.mark.asyncio
async def test_document_branch_persists_safe_ai_timeout_diagnostics_once() -> None:
    api = ApiStub()
    api.snapshot.materials = [api.snapshot.materials[0]]
    pipeline = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=TimeoutDocumentProvider(),
        document_parser=ParserStub(),
        image_processor=object(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )
    context = RuntimeContext(
        "run", "project", "draft", "product", "request", "attempt", "server-fingerprint"
    )
    pipeline.register_snapshot(context, api.snapshot)

    output = await pipeline.document_branch(context)

    assert output.status == BranchStatus.FAILED
    assert output.warnings == ["文档 AI 抽取超时"]
    assert output.items[0].warning == "文档 AI 抽取超时"
    assert output.items[0].metadata == {
        "error": {"type": "AI_TIMEOUT", "attempts": 3, "elapsedMs": 361_250}
    }
    assert output.metadata == {
        "failures": [{"type": "AI_TIMEOUT", "attempts": 3, "elapsedMs": 361_250}]
    }


@pytest.mark.asyncio
async def test_form_branch_reads_only_the_global_video_configuration() -> None:
    api = ApiStub()
    api.snapshot.product.category = ""
    pipeline = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        document_parser=ParserStub(),
        image_processor=object(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )
    context = RuntimeContext(
        "run", "project", "draft", "product", "request", "attempt", "server-fingerprint"
    )
    pipeline.register_snapshot(context, api.snapshot)

    output = await pipeline.form_branch(context)

    assert output.status == BranchStatus.SUCCEEDED
    assert output.candidate is not None
    assert output.candidate.product_name == "商品"
    assert output.candidate.product_category is None
    assert output.candidate.delivery_channels == "视频号"
    assert output.candidate.duration_seconds == 20
    assert output.candidate.aspect_ratio == "1:1"
    assert output.candidate.visual_style_baseline == "烟火食欲感"
    assert output.candidate.disabled_elements == ["医疗功效"]
    assert output.metadata == {
        "durationSeconds": 20,
        "aspectRatio": "1:1",
        "resolution": "720P",
        "styleTone": "烟火食欲感",
        "deliveryChannel": "视频号",
        "disabledElements": ["医疗功效"],
    }
    assert output.warnings == []


@pytest.mark.asyncio
async def test_image_branch_analyzes_up_to_three_images_concurrently() -> None:
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
    pipeline = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        document_parser=ParserStub(),
        image_processor=ImageProcessorStub(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )
    context = RuntimeContext(
        "run", "project", "draft", "product", "request", "attempt", "server-fingerprint"
    )
    pipeline.register_snapshot(context, api.snapshot)

    output = await pipeline.image_branch(context)

    assert output.status == BranchStatus.SUCCEEDED
    assert [item.source_id for item in output.items] == [
        "image-0",
        "image-1",
        "image-2",
    ]
    assert provider.max_active == 3
    assert all(item.metadata["aiCall"]["stage"] == "IMAGE" for item in output.items)


@pytest.mark.asyncio
async def test_normalization_branch_records_ai_call_metadata() -> None:
    api = ApiStub()
    fused = ExtractionCandidate.empty()
    fused.product_name = "商品"
    api.branches = [
        BranchOutput(
            branch=BranchName.FUSION,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=fused,
            metadata={"provenance": {"productName": "FORM"}},
        ),
        BranchOutput(
            branch=BranchName.SEMANTIC_REFINEMENT,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=fused.model_copy(update={"product_name": "语义整理后的商品"}),
        ),
    ]
    pipeline = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        document_parser=ParserStub(),
        image_processor=ImageProcessorStub(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )
    context = RuntimeContext(
        "run", "project", "draft", "product", "request", "attempt", "server-fingerprint"
    )
    pipeline.register_snapshot(context, api.snapshot)

    result_id = await pipeline.normalize_and_finalize(context)

    assert result_id == "extract-result"
    normalization = next(
        item
        for item in api.saved
        if item.branch == BranchName.NORMALIZATION
        and item.status == BranchStatus.SUCCEEDED
    )
    assert normalization.metadata["aiCall"]["stage"] == "NORMALIZATION"
    assert normalization.candidate is not None
    assert normalization.candidate.product_name == "语义整理后的商品"


@pytest.mark.asyncio
async def test_normalization_cannot_reintroduce_semantic_duplicates() -> None:
    api = ApiStub()
    fused = ExtractionCandidate.empty()
    fused.purchase_scenarios = ["年货送礼", "节庆礼赠", "走亲访友礼赠"]
    semantic = fused.model_copy(update={"purchase_scenarios": ["年节采购与礼赠"]})
    api.branches = [
        BranchOutput(
            branch=BranchName.FUSION,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=fused,
        ),
        BranchOutput(
            branch=BranchName.SEMANTIC_REFINEMENT,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=semantic,
        ),
    ]
    pipeline = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=ReexpandingNormalizationProvider(),
        document_parser=ParserStub(),
        image_processor=ImageProcessorStub(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )
    context = RuntimeContext(
        "run", "project", "draft", "product", "request", "attempt", "server-fingerprint"
    )
    pipeline.register_snapshot(context, api.snapshot)

    await pipeline.normalize_and_finalize(context)

    normalization = next(
        item
        for item in api.saved
        if item.branch == BranchName.NORMALIZATION
        and item.status == BranchStatus.SUCCEEDED
    )
    assert normalization.candidate is not None
    assert normalization.candidate.purchase_scenarios == ["年节采购与礼赠"]


@pytest.mark.asyncio
async def test_semantic_refinement_degrades_to_original_fusion_candidate_on_timeout() -> (
    None
):
    api = ApiStub()
    fused = ExtractionCandidate.empty()
    fused.core_pain_points = ["家庭用餐准备不便", "家庭日常用餐准备不方便"]
    api.branches = [
        BranchOutput(
            branch=BranchName.FUSION,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=fused,
        )
    ]
    pipeline = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=TimeoutSemanticProvider(),
        document_parser=ParserStub(),
        image_processor=ImageProcessorStub(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )
    context = RuntimeContext(
        "run", "project", "draft", "product", "request", "attempt", "server-fingerprint"
    )
    pipeline.register_snapshot(context, api.snapshot)

    output = await pipeline.refine_semantics(context)

    assert output.status == BranchStatus.PARTIAL
    assert output.candidate == fused
    assert output.warnings == ["语义整理超时，已保留原始提炼信息"]
    assert output.metadata == {
        "failures": [{"type": "AI_TIMEOUT", "attempts": 3, "elapsedMs": 12_500}]
    }
