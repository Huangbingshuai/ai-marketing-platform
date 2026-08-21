from __future__ import annotations

import asyncio
from collections.abc import Sequence
from pathlib import PurePath

from .api_client import InternalApi, InternalApiError
from .docling_parser import DocumentParser
from .fusion import FusionError, fuse
from .image_processing import ImageProcessor
from .models import (
    BranchItem,
    BranchName,
    BranchOutput,
    BranchStatus,
    ExtractionCandidate,
    ExtractionSnapshot,
    FailurePayload,
    FinalizePayload,
    ProgressPayload,
    RuntimeContext,
    SnapshotMaterial,
)
from .providers import AiProvider

DOCUMENT_MIME_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
DOCUMENT_EXTENSIONS = {".pdf", ".docx"}


class PipelineError(RuntimeError):
    pass


class ExtractionPipeline:
    def __init__(
        self,
        *,
        api: InternalApi,
        provider: AiProvider,
        document_parser: DocumentParser,
        image_processor: ImageProcessor,
        max_document_text_chars: int,
    ) -> None:
        self.api = api
        self.provider = provider
        self.document_parser = document_parser
        self.image_processor = image_processor
        self.max_document_text_chars = max_document_text_chars
        self._snapshots: dict[str, ExtractionSnapshot] = {}
        self._progress: dict[str, ProgressPayload] = {}

    def register_snapshot(self, context: RuntimeContext, snapshot: ExtractionSnapshot) -> None:
        if snapshot.project_id != context.project_id or snapshot.product.id != context.product_id:
            raise PipelineError("claimed snapshot does not match runtime context")
        self._snapshots[context.run_id] = snapshot

    def _snapshot(self, context: RuntimeContext) -> ExtractionSnapshot:
        try:
            return self._snapshots[context.run_id]
        except KeyError as exc:
            raise PipelineError("claimed snapshot is not registered") from exc

    async def snapshot(self, project_id: str, context: RuntimeContext) -> ExtractionSnapshot:
        snapshot = self._snapshot(context)
        expected = (
            project_id,
            context.project_id,
            context.draft_id,
            context.product_id,
        )
        actual = (
            snapshot.project_id,
            snapshot.project_id,
            snapshot.draft_id,
            snapshot.product.id,
        )
        if expected != actual:
            raise PipelineError("extraction snapshot does not match the queued request")
        await self.report_progress(context, ProgressPayload(current_node="LOAD_AND_SNAPSHOT", progress=5))
        return snapshot

    async def report_progress(self, context: RuntimeContext, payload: ProgressPayload) -> None:
        self._progress[context.run_id] = payload
        await self.api.progress(context, payload)

    async def heartbeat(self, context: RuntimeContext) -> None:
        payload = self._progress.get(
            context.run_id,
            ProgressPayload(current_node="LOAD_AND_SNAPSHOT", progress=1),
        )
        await self.api.progress(context, payload)

    async def document_branch(self, context: RuntimeContext) -> BranchOutput:
        snapshot = self._snapshot(context)
        sources = [material for material in snapshot.materials if _is_document(material)]
        await self._start(context, BranchName.DOCUMENT)
        await self.report_progress(
            context,
            ProgressPayload(current_node="DOCUMENT", progress=15),
        )
        if not sources:
            return await self._save(
                context,
                BranchOutput(
                    branch=BranchName.DOCUMENT,
                    status=BranchStatus.SKIPPED,
                    source_fingerprint=context.source_fingerprint,
                    warnings=["未提供可解析的 PDF/DOCX 文档"],
                ),
            )

        items: list[BranchItem] = []
        for material in sources:
            try:
                content = await self.api.download_material(context, material.id)
                markdown = await self.document_parser.parse(
                    content, file_name=material.original_file_name
                )
                storage_key = await self.api.upload_artifact(
                    context,
                    artifact_kind="DOCLING_MARKDOWN",
                    source_id=material.id,
                    content=markdown.encode("utf-8"),
                    content_type="text/markdown; charset=utf-8",
                    idempotency_key=(
                        f"{context.run_id}:docling:{material.id}:{context.source_fingerprint}"
                    ),
                )
                truncated = len(markdown) > self.max_document_text_chars
                model_text = markdown[: self.max_document_text_chars]
                candidate = await self.provider.extract_document(
                    model_text, source_name=material.original_file_name
                )
                items.append(
                    BranchItem(
                        source_id=material.id,
                        status=BranchStatus.SUCCEEDED,
                        candidate=candidate,
                        artifact_storage_key=storage_key,
                        metadata={
                            "markdownChars": len(markdown),
                            "modelInputChars": len(model_text),
                            "modelInputTruncated": truncated,
                        },
                        warning=(
                            "文档过长，模型候选抽取使用了受限长度文本；完整 Markdown 已保留"
                            if truncated
                            else None
                        ),
                    )
                )
            except InternalApiError as exc:
                if exc.retryable:
                    raise
                items.append(_failed_item(material.id, exc))
            except Exception as exc:
                items.append(_failed_item(material.id, exc))

        return await self._save(context, _aggregate(BranchName.DOCUMENT, context, items))

    async def image_branch(self, context: RuntimeContext) -> BranchOutput:
        snapshot = self._snapshot(context)
        sources = [material for material in snapshot.materials if _is_image(material)]
        await self._start(context, BranchName.IMAGE)
        await self.report_progress(
            context,
            ProgressPayload(current_node="IMAGE", progress=15),
        )
        if not sources:
            return await self._save(
                context,
                BranchOutput(
                    branch=BranchName.IMAGE,
                    status=BranchStatus.SKIPPED,
                    source_fingerprint=context.source_fingerprint,
                    warnings=["未提供可识别的产品图片"],
                ),
            )

        items: list[BranchItem] = []
        for material in sources:
            try:
                content = await self.api.download_material(context, material.id)
                processed = await asyncio.to_thread(self.image_processor.process, content)
                candidate = await self.provider.analyze_image(
                    processed.data_uri,
                    source_name=material.original_file_name,
                    image_metadata=processed.metadata,
                )
                items.append(
                    BranchItem(
                        source_id=material.id,
                        status=BranchStatus.SUCCEEDED,
                        candidate=candidate,
                        metadata=processed.metadata,
                    )
                )
            except InternalApiError as exc:
                if exc.retryable:
                    raise
                items.append(_failed_item(material.id, exc))
            except Exception as exc:
                items.append(_failed_item(material.id, exc))

        return await self._save(context, _aggregate(BranchName.IMAGE, context, items))

    async def commerce_branch(self, context: RuntimeContext) -> BranchOutput:
        snapshot = self._snapshot(context)
        await self._start(context, BranchName.COMMERCE)
        warnings = (
            ["当前版本暂未解析电商链接，链接已保留在运行快照中"]
            if snapshot.product.commerce_url
            else ["未提供电商链接，无需解析"]
        )
        return await self._save(
            context,
            BranchOutput(
                branch=BranchName.COMMERCE,
                status=BranchStatus.SKIPPED,
                source_fingerprint=context.source_fingerprint,
                warnings=warnings,
                metadata={"hasCommerceUrl": bool(snapshot.product.commerce_url)},
            ),
        )

    async def form_branch(self, context: RuntimeContext) -> BranchOutput:
        snapshot = self._snapshot(context)
        await self._start(context, BranchName.FORM)
        config = snapshot.product.effective_config
        candidate = ExtractionCandidate.empty()
        candidate.product_name = snapshot.product.name.strip() or None
        candidate.product_category = snapshot.product.category.strip() or None
        candidate.delivery_channels = _optional(config.delivery_channel)
        candidate.brand_tone = _optional(config.style_tone)
        candidate.disabled_elements = _strings(config.disabled_elements) or None
        status = (
            BranchStatus.SUCCEEDED
            if candidate.product_name and candidate.product_category
            else BranchStatus.FAILED
        )
        warnings = [] if status == BranchStatus.SUCCEEDED else ["表单缺少产品名称或品类"]
        return await self._save(
            context,
            BranchOutput(
                branch=BranchName.FORM,
                status=status,
                source_fingerprint=context.source_fingerprint,
                candidate=candidate,
                warnings=warnings,
                metadata={
                    "durationSeconds": config.duration_seconds,
                    "aspectRatio": config.aspect_ratio,
                },
            ),
        )

    async def fuse_sources(self, context: RuntimeContext) -> BranchOutput:
        await self._start(context, BranchName.FUSION)
        branches = await self.api.get_branches(context)
        result = fuse(branches)
        output = BranchOutput(
            branch=BranchName.FUSION,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint=context.source_fingerprint,
            candidate=result.candidate,
            warnings=result.warnings,
            metadata={"provenance": result.provenance},
        )
        await self.report_progress(
            context,
            ProgressPayload(current_node="FUSION", progress=75),
        )
        return await self._save(context, output)

    async def normalize_and_finalize(self, context: RuntimeContext) -> str:
        await self._start(context, BranchName.NORMALIZATION)
        await self.report_progress(
            context,
            ProgressPayload(current_node="NORMALIZATION", progress=85),
        )
        branches = await self.api.get_branches(context)
        by_name = {branch.branch: branch for branch in branches}
        fusion = by_name.get(BranchName.FUSION)
        if fusion is None or fusion.candidate is None:
            raise FusionError("fusion output is missing")
        result = await self.provider.normalize(fusion.candidate)
        form = by_name.get(BranchName.FORM)
        if form and form.candidate:
            _restore_manual_fields(result, form.candidate)
        provenance_raw = fusion.metadata.get("provenance", {})
        provenance = {
            str(key): str(value)
            for key, value in provenance_raw.items()
        } if isinstance(provenance_raw, dict) else {}
        warnings = []
        for branch in branches:
            warnings.extend(branch.warnings)
            warnings.extend(item.warning for item in branch.items if item.warning)
        normalization = BranchOutput(
            branch=BranchName.NORMALIZATION,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint=context.source_fingerprint,
            candidate=ExtractionCandidate.model_validate(result.model_dump()),
        )
        await self._save(context, normalization)
        extract_result_id = await self.api.complete(
            context,
            FinalizePayload(
                result=result,
                provenance=provenance,
                conflict_report=fusion.warnings,
                warnings=_strings(warnings),
            ),
        )
        self._snapshots.pop(context.run_id, None)
        self._progress.pop(context.run_id, None)
        return extract_result_id

    async def mark_failed(self, context: RuntimeContext, exc: Exception) -> None:
        await self.api.fail(
            context,
            FailurePayload(
                error_code=type(exc).__name__.upper(),
                error_message=_safe_error(exc),
                retryable=isinstance(exc, InternalApiError) and exc.retryable,
            ),
        )

    async def _save(self, context: RuntimeContext, output: BranchOutput) -> BranchOutput:
        await self.api.put_branch(context, output)
        return output

    async def _start(self, context: RuntimeContext, branch: BranchName) -> None:
        await self.api.put_branch(
            context,
            BranchOutput(
                branch=branch,
                status=BranchStatus.RUNNING,
                source_fingerprint=context.source_fingerprint,
            ),
        )


def _is_document(material: SnapshotMaterial) -> bool:
    return material.mime_type.lower() in DOCUMENT_MIME_TYPES \
        or PurePath(material.original_file_name).suffix.lower() in DOCUMENT_EXTENSIONS


def _is_image(material: SnapshotMaterial) -> bool:
    return material.mime_type.lower().startswith("image/")


def _aggregate(
    branch: BranchName, context: RuntimeContext, items: list[BranchItem]
) -> BranchOutput:
    succeeded = sum(item.status == BranchStatus.SUCCEEDED for item in items)
    if succeeded == len(items):
        status = BranchStatus.SUCCEEDED
    elif succeeded > 0:
        status = BranchStatus.PARTIAL
    else:
        status = BranchStatus.FAILED
    warnings = [item.warning for item in items if item.warning]
    return BranchOutput(
        branch=branch,
        status=status,
        source_fingerprint=context.source_fingerprint,
        items=items,
        warnings=_strings(warnings),
    )


def _failed_item(source_id: str, exc: Exception) -> BranchItem:
    return BranchItem(
        source_id=source_id,
        status=BranchStatus.FAILED,
        warning=_safe_error(exc),
    )


def _safe_error(exc: Exception) -> str:
    message = " ".join(str(exc).split())
    return (message or type(exc).__name__)[:500]


def _optional(value: str | None) -> str | None:
    return value.strip() if value and value.strip() else None


def _strings(values: Sequence[str | None]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if raw is None:
            continue
        value = " ".join(raw.split()).strip()
        key = value.casefold()
        if value and key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _restore_manual_fields(result: object, form: ExtractionCandidate) -> None:
    for field in ("product_category", "product_name", "delivery_channels", "brand_tone"):
        value = getattr(form, field)
        if isinstance(value, str) and value.strip():
            setattr(result, field, value.strip())
    if form.disabled_elements:
        setattr(result, "disabled_elements", _strings(form.disabled_elements))
