from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from types import SimpleNamespace
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
from effect_extraction.pipeline import ExtractionPipeline, _restore_authoritative_sources
from effect_extraction.providers import (
    AiCallResult,
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)


class ApiStub:
    def __init__(self) -> None:
        self.saved: list[BranchOutput] = []
        self.branches: list[BranchOutput] = []
        self.image_cache: dict[str, ExtractionCandidate] = {}
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

    async def get_image_cache(
        self, context: RuntimeContext, cache_key: str
    ) -> ExtractionCandidate | None:
        return self.image_cache.get(cache_key)

    async def put_image_cache(
        self,
        context: RuntimeContext,
        cache_key: str,
        candidate: ExtractionCandidate,
        metadata: Mapping[str, Any],
    ) -> None:
        self.image_cache[cache_key] = candidate

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
            metadata={
                "processedWidth": 100,
                "processedHeight": 100,
                "processedSha256": "a" * 64,
                "preprocessVersion": "test",
            },
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


class UncacheableImageProvider(CountingImageProvider):
    async def analyze_image(
        self,
        data_uri: str,
        *,
        source_name: str,
        image_metadata: Mapping[str, Any],
    ) -> AiCallResult[ExtractionCandidate]:
        result = await super().analyze_image(
            data_uri, source_name=source_name, image_metadata=image_metadata
        )
        return AiCallResult(
            value=result.value,
            metadata=result.metadata,
            cacheable=False,
        )


class DisconnectingAfterFirstImageProvider(CountingImageProvider):
    async def analyze_image(
        self,
        data_uri: str,
        *,
        source_name: str,
        image_metadata: Mapping[str, Any],
    ) -> AiCallResult[ExtractionCandidate]:
        if self.calls == 0:
            return await super().analyze_image(
                data_uri,
                source_name=source_name,
                image_metadata=image_metadata,
            )
        self.calls += 1
        raise ProviderError(
            "AI network request failed",
            retryable=True,
            error_type=ProviderErrorType.NETWORK,
            attempts=2,
            elapsed_ms=1_234,
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


class CountingDocumentProvider(MockAiProvider):
    def __init__(self) -> None:
        self.calls = 0

    async def extract_document(
        self, markdown: str, *, source_name: str
    ) -> AiCallResult[ExtractionCandidate]:
        self.calls += 1
        return await super().extract_document(markdown, source_name=source_name)


class StructuredDocumentParser:
    async def parse(self, content: bytes, *, file_name: str) -> str:
        return """
## 产品基础层
### 产品品类
腊味肉制品
### 产品名称
广式腊肠
### 核心规格
500g 真空袋装
## 卖点层
### 核心卖点
- 三七肥瘦黄金配比
- 真空锁鲜
## 用户层
### 核心痛点
- 担心腊肠口感不稳定
## 场景层
### 典型使用场景
- 家庭日常佐餐
"""


class TimeoutSemanticProvider(MockAiProvider):
    async def refine_semantics(
        self,
        *,
        facts: Sequence[Mapping[str, str]],
    ) -> Any:
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
async def test_document_branch_skips_ai_for_structured_information_table() -> None:
    api = ApiStub()
    api.snapshot.materials = [api.snapshot.materials[0]]
    provider = CountingDocumentProvider()
    pipeline = ExtractionPipeline(
        api=api,  # type: ignore[arg-type]
        provider=provider,
        document_parser=StructuredDocumentParser(),
        image_processor=object(),  # type: ignore[arg-type]
        max_document_text_chars=1000,
    )
    context = RuntimeContext(
        "run", "project", "draft", "product", "request", "attempt", "server-fingerprint"
    )
    pipeline.register_snapshot(context, api.snapshot)

    output = await pipeline.document_branch(context)

    assert provider.calls == 0
    assert output.status == BranchStatus.SUCCEEDED
    assert output.items[0].candidate is not None
    assert output.items[0].candidate.product_name == "广式腊肠"
    assert output.items[0].metadata["extractionMode"] == "STRUCTURED_TABLE"
    assert output.items[0].metadata["modelInputChars"] == 0
    assert "aiCall" not in output.items[0].metadata


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
async def test_image_branch_limits_model_concurrency_to_two_by_default() -> None:
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
    assert provider.max_active == 2
    assert all(
        item.metadata.get("aiCall", {}).get("stage") == "IMAGE"
        or item.metadata.get("cache") == {"hit": True}
        for item in output.items
    )


@pytest.mark.asyncio
async def test_image_branch_reuses_content_fingerprint_cache_without_a_second_model_call() -> (
    None
):
    api = ApiStub()
    api.snapshot.materials = [
        SnapshotMaterial(
            id="image-1",
            type="PRODUCT_IMAGE",
            original_file_name="image-1.png",
            mime_type="image/png",
            size_bytes=10,
        )
    ]
    provider = CountingImageProvider()
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

    first = await pipeline.image_branch(context)
    second = await pipeline.image_branch(context)

    assert provider.calls == 1
    assert first.items[0].metadata["cache"] == {"hit": False}
    assert second.items[0].metadata["cache"] == {"hit": True}
    assert second.items[0].candidate == first.items[0].candidate


@pytest.mark.asyncio
async def test_image_branch_bypasses_cache_for_explicit_re_extraction() -> None:
    api = ApiStub()
    api.snapshot.bypass_image_cache = True
    api.snapshot.materials = [
        SnapshotMaterial(
            id="image-1",
            type="PRODUCT_IMAGE",
            original_file_name="image-1.png",
            mime_type="image/png",
            size_bytes=10,
        )
    ]
    provider = CountingImageProvider()
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

    first = await pipeline.image_branch(context)
    second = await pipeline.image_branch(context)

    assert provider.calls == 2
    assert first.items[0].metadata["cache"] == {"hit": False, "bypassed": True}
    assert second.items[0].metadata["cache"] == {"hit": False, "bypassed": True}


@pytest.mark.asyncio
async def test_image_branch_uses_previous_result_when_refresh_disconnects() -> None:
    api = ApiStub()
    api.snapshot.materials = [
        SnapshotMaterial(
            id="image-1",
            type="PRODUCT_IMAGE",
            original_file_name="image-1.png",
            mime_type="image/png",
            size_bytes=10,
        )
    ]
    provider = DisconnectingAfterFirstImageProvider()
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

    first = await pipeline.image_branch(context)
    api.snapshot.bypass_image_cache = True
    refreshed = await pipeline.image_branch(context)

    assert provider.calls == 2
    assert first.status == BranchStatus.SUCCEEDED
    assert refreshed.status == BranchStatus.PARTIAL
    assert refreshed.items[0].status == BranchStatus.PARTIAL
    assert refreshed.items[0].candidate == first.items[0].candidate
    assert refreshed.items[0].warning == "图片 AI 识别连接失败，已使用上次识别结果"
    assert refreshed.items[0].metadata["cache"] == {
        "hit": True,
        "fallback": True,
        "bypassed": True,
    }
    assert refreshed.items[0].metadata["error"] == {
        "type": "AI_NETWORK",
        "attempts": 2,
        "elapsedMs": 1_234,
    }
    assert refreshed.metadata == {
        "failures": [{"type": "AI_NETWORK", "attempts": 2, "elapsedMs": 1_234}]
    }
    assert "Server disconnected" not in " ".join(refreshed.warnings)


@pytest.mark.asyncio
async def test_image_branch_does_not_cache_a_degraded_adaptive_result() -> None:
    api = ApiStub()
    api.snapshot.materials = [
        SnapshotMaterial(
            id="image-1",
            type="PRODUCT_IMAGE",
            original_file_name="包装背面.png",
            mime_type="image/png",
            size_bytes=10,
        )
    ]
    provider = UncacheableImageProvider()
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

    first = await pipeline.image_branch(context)
    second = await pipeline.image_branch(context)

    assert provider.calls == 2
    assert api.image_cache == {}
    assert first.items[0].metadata["cache"] == {"hit": False}
    assert second.items[0].metadata["cache"] == {"hit": False}


@pytest.mark.asyncio
async def test_normalization_branch_uses_deterministic_contract_mapping() -> None:
    api = ApiStub()
    fused = ExtractionCandidate.empty()
    fused.product_name = "商品"
    form = ExtractionCandidate.empty()
    form.product_name = "商品"
    form.product_category = "食品"
    form.duration_seconds = 20
    form.aspect_ratio = "1:1"
    form.resolution = "720p"
    form.delivery_channels = "视频号"
    form.visual_style_baseline = "烟火食欲感"
    api.branches = [
        BranchOutput(
            branch=BranchName.FORM,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=form,
        ),
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
    assert normalization.metadata["normalization"] == {
        "mode": "DETERMINISTIC",
        "modelCalled": False,
    }
    assert "aiCall" not in normalization.metadata
    assert normalization.candidate is not None
    assert normalization.candidate.product_name == "商品"
    assert normalization.candidate.resolution == "720p"


@pytest.mark.asyncio
async def test_normalization_uses_validated_semantic_candidate_without_reintroducing_duplicates() -> None:
    api = ApiStub()
    fused = ExtractionCandidate.empty()
    fused.purchase_scenarios = ["家庭日常采购", "家庭日常食材采购", "春节送礼"]
    semantic = fused.model_copy(
        update={"purchase_scenarios": ["家庭日常采购", "春节送礼"]}
    )
    form = ExtractionCandidate.empty()
    form.product_name = "商品"
    form.product_category = "食品"
    form.duration_seconds = 20
    form.aspect_ratio = "1:1"
    form.resolution = "720p"
    form.delivery_channels = "视频号"
    form.visual_style_baseline = "烟火食欲感"
    api.branches = [
        BranchOutput(
            branch=BranchName.FORM,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=form,
        ),
        BranchOutput(
            branch=BranchName.DOCUMENT,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=fused,
        ),
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
    assert normalization.candidate.purchase_scenarios == [
        "家庭日常采购",
        "春节送礼",
    ]


@pytest.mark.asyncio
async def test_normalization_keeps_user_price_and_secondary_points_before_image_suggestions() -> (
    None
):
    api = ApiStub()
    form = ExtractionCandidate.empty()
    form.product_name = "广东腊肠"
    form.product_category = "腊味肉制品"
    form.duration_seconds = 60
    form.aspect_ratio = "9:16"
    form.resolution = "720p"
    form.delivery_channels = "抖音"
    form.visual_style_baseline = "烟火食欲感"
    document = ExtractionCandidate.empty()
    document.price_range = "20 元/袋"
    document.core_selling_points = [
        "三七肥瘦黄金配比",
        "广府糖酒腌制工艺",
        "咸甜酒香回甘",
    ]
    document.secondary_selling_points = [
        "纯猪肉无淀粉",
        "真空锁鲜",
        "适配多种烹饪方式",
        "切片均匀、形态规整",
    ]
    image = ExtractionCandidate.empty()
    image.visual_features = "红白相间，切面肥瘦纹理清晰，表面油润"
    image.core_selling_points = [
        "肥瘦颗粒分明",
        "外观油润有光泽",
        "切片纹理清晰",
        "肠体形态规整",
    ]
    image.secondary_selling_points = [
        "整根切片同展便于判断形态",
        "福字中国结烘托节庆氛围",
    ]
    image.target_audience = "重视家庭餐桌效率的烹饪者"
    image.core_pain_points = ["日常菜肴搭配缺少省时的风味食材"]
    image.decision_drivers = ["切片与整根同展便于判断用法"]
    image.marketing_goal = "展示家庭蒸食与节庆礼赠的双场景价值"
    image.purchase_scenarios = ["节庆家庭礼赠"]
    fused = document.model_copy(deep=True)
    fused.product_name = form.product_name
    fused.product_category = form.product_category
    fused.duration_seconds = form.duration_seconds
    fused.aspect_ratio = form.aspect_ratio
    fused.resolution = form.resolution
    fused.delivery_channels = form.delivery_channels
    fused.visual_style_baseline = form.visual_style_baseline
    api.branches = [
        BranchOutput(
            branch=BranchName.FORM,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=form,
        ),
        BranchOutput(
            branch=BranchName.DOCUMENT,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=document,
        ),
        BranchOutput(
            branch=BranchName.IMAGE,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=image,
        ),
        BranchOutput(
            branch=BranchName.FUSION,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint="server-fingerprint",
            candidate=fused,
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

    await pipeline.normalize_and_finalize(context)

    normalization = next(
        item
        for item in api.saved
        if item.branch == BranchName.NORMALIZATION
        and item.status == BranchStatus.SUCCEEDED
    )
    assert normalization.candidate is not None
    assert normalization.candidate.price_range == "20 元/袋"
    assert normalization.candidate.visual_features == image.visual_features
    assert normalization.candidate.core_selling_points == document.core_selling_points
    assert (
        normalization.candidate.secondary_selling_points[:4]
        == document.secondary_selling_points
    )
    assert normalization.candidate.secondary_selling_points == [
        *document.secondary_selling_points,
        "肥瘦颗粒分明",
        "外观油润有光泽",
        "切片纹理清晰",
        "肠体形态规整",
    ]
    assert normalization.candidate.target_audience == image.target_audience
    assert normalization.candidate.core_pain_points == image.core_pain_points
    assert normalization.candidate.decision_drivers == image.decision_drivers
    assert normalization.candidate.marketing_goal == image.marketing_goal
    assert normalization.candidate.purchase_scenarios == image.purchase_scenarios


def test_visual_features_use_image_only_when_user_material_does_not_provide_them() -> None:
    form = ExtractionCandidate.empty()
    form.duration_seconds = 15
    form.aspect_ratio = "9:16"
    form.resolution = "1080p"
    form.delivery_channels = "抖音"
    document = ExtractionCandidate.empty()
    image = ExtractionCandidate.empty()
    image.visual_features = "AI 识图外观"

    missing_result = SimpleNamespace()
    _restore_authoritative_sources(
        missing_result,
        form=form,
        document=document,
        commerce=None,
        image=image,
    )
    assert missing_result.visual_features == "AI 识图外观"

    document.visual_features = "用户资料外观"
    user_result = SimpleNamespace()
    _restore_authoritative_sources(
        user_result,
        form=form,
        document=document,
        commerce=None,
        image=image,
    )
    assert user_result.visual_features == "用户资料外观"


def test_image_selling_suggestions_are_deduplicated_across_images_without_merging_user_facts() -> (
    None
):
    form = ExtractionCandidate.empty()
    form.duration_seconds = 15
    form.aspect_ratio = "9:16"
    form.resolution = "1080p"
    form.delivery_channels = "抖音"
    document = ExtractionCandidate.empty()
    document.core_selling_points = [
        "三七肥瘦黄金配比",
        "广府糖酒腌制工艺",
        "咸甜酒香回甘",
    ]
    document.secondary_selling_points = ["切片均匀、形态规整"]
    image = ExtractionCandidate.empty()
    image.core_selling_points = [
        "肥瘦相间纹理清晰",
        "肠体饱满形态规整",
        "肥瘦相间纹理清晰油润",
        "整根与切片同展直观展示形态",
        "肥瘦纹理清晰透亮",
        "切片油润有光泽",
    ]

    result = SimpleNamespace()
    _restore_authoritative_sources(
        result,
        form=form,
        document=document,
        commerce=None,
        image=image,
    )

    assert result.secondary_selling_points == [
        "切片均匀、形态规整",
        "肥瘦相间纹理清晰油润",
        "肠体饱满形态规整",
        "整根与切片同展直观展示形态",
        "切片油润有光泽",
    ]


def test_authoritative_source_restoration_caps_secondary_selling_points_at_ten() -> None:
    form = ExtractionCandidate.empty()
    form.duration_seconds = 15
    form.aspect_ratio = "9:16"
    form.resolution = "1080p"
    form.delivery_channels = "抖音"
    document = ExtractionCandidate.empty()
    document.secondary_selling_points = [f"次要卖点{index}" for index in range(1, 13)]

    result = SimpleNamespace()
    _restore_authoritative_sources(
        result,
        form=form,
        document=document,
        commerce=None,
        image=None,
    )

    assert result.secondary_selling_points == [
        f"次要卖点{index}" for index in range(1, 11)
    ]


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
