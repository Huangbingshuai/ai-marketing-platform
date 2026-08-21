from __future__ import annotations

from typing import Any

import pytest

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
from effect_extraction.providers import MockAiProvider


class ApiStub:
    def __init__(self) -> None:
        self.saved: list[BranchOutput] = []
        self.snapshot = ExtractionSnapshot(
            schema_version=1,
            project_id="project",
            draft_id="draft",
            mode="SINGLE",
            source_revision=1,
            product=SnapshotProduct(
                id="product", name="商品", category="食品", sku="sku", commerce_url=None,
                effective_config=VideoConfig(
                    aspect_ratio="9:16", duration_seconds=15, resolution="1080P",
                    frame_rate=30, subtitle_strategy="跟随口播", voiceover_strategy="AI 女声",
                    bgm_strategy="自动匹配", style_tone="自然", delivery_channel="抖音",
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

    async def download_material(self, context: RuntimeContext, material_id: str) -> bytes:
        return material_id.encode()

    async def upload_artifact(self, context: RuntimeContext, **kwargs: Any) -> str:
        return "artifacts/markdown"

    async def put_branch(self, context: RuntimeContext, output: BranchOutput) -> None:
        self.saved.append(output)

    async def progress(self, context: RuntimeContext, payload: object) -> None:
        return None


class ParserStub:
    async def parse(self, content: bytes, *, file_name: str) -> str:
        if file_name == "bad.pdf":
            raise ValueError("corrupt PDF")
        return "# 商品\n500ml\n便携"


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
    context = RuntimeContext("run", "project", "draft", "product", "request", "attempt", "server-fingerprint")
    pipeline.register_snapshot(context, api.snapshot)
    output = await pipeline.document_branch(context)
    assert output.branch == BranchName.DOCUMENT
    assert output.status == BranchStatus.PARTIAL
    assert [item.status for item in output.items] == [
        BranchStatus.SUCCEEDED,
        BranchStatus.FAILED,
    ]
    assert api.saved[-1] == output
