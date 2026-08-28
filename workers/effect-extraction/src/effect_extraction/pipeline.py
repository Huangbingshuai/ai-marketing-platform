from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Sequence
from pathlib import PurePath

from .api_client import InternalApi, InternalApiError
from .commerce import (
    CommerceErrorType,
    CommerceFetcher,
    CommerceFetchError,
    CommercePage,
    HttpxCommerceFetcher,
    has_candidate_data,
    merge_commerce_candidates,
)
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
from .providers import AiProvider, ProviderError, ProviderErrorType
from .semantic_refinement import refine_candidate_semantics

LOGGER = logging.getLogger(__name__)

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
        image_max_concurrency: int = 2,
        commerce_fetcher: CommerceFetcher | None = None,
        max_commerce_text_chars: int = 80_000,
    ) -> None:
        self.api = api
        self.provider = provider
        self.document_parser = document_parser
        self.image_processor = image_processor
        self.max_document_text_chars = max_document_text_chars
        self.image_max_concurrency = max(1, min(image_max_concurrency, 8))
        self.commerce_fetcher = commerce_fetcher or HttpxCommerceFetcher()
        self.max_commerce_text_chars = max_commerce_text_chars
        self._snapshots: dict[str, ExtractionSnapshot] = {}
        self._progress: dict[str, ProgressPayload] = {}

    def register_snapshot(
        self, context: RuntimeContext, snapshot: ExtractionSnapshot
    ) -> None:
        if (
            snapshot.project_id != context.project_id
            or snapshot.product.id != context.product_id
        ):
            raise PipelineError("claimed snapshot does not match runtime context")
        self._snapshots[context.run_id] = snapshot

    def _snapshot(self, context: RuntimeContext) -> ExtractionSnapshot:
        try:
            return self._snapshots[context.run_id]
        except KeyError as exc:
            raise PipelineError("claimed snapshot is not registered") from exc

    async def snapshot(
        self, project_id: str, context: RuntimeContext
    ) -> ExtractionSnapshot:
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
        await self.report_progress(
            context, ProgressPayload(current_node="LOAD_AND_SNAPSHOT", progress=5)
        )
        return snapshot

    async def report_progress(
        self, context: RuntimeContext, payload: ProgressPayload
    ) -> None:
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
        sources = [
            material for material in snapshot.materials if _is_document(material)
        ]
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
                ai_call = await self.provider.extract_document(
                    model_text, source_name=material.original_file_name
                )
                items.append(
                    BranchItem(
                        source_id=material.id,
                        status=BranchStatus.SUCCEEDED,
                        candidate=ai_call.value,
                        artifact_storage_key=storage_key,
                        metadata={
                            "markdownChars": len(markdown),
                            "modelInputChars": len(model_text),
                            "modelInputTruncated": truncated,
                            "aiCall": ai_call.metadata.as_dict(),
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
                items.append(_failed_item(material.id, exc, BranchName.DOCUMENT))
            except Exception as exc:
                items.append(_failed_item(material.id, exc, BranchName.DOCUMENT))

        return await self._save(
            context, _aggregate(BranchName.DOCUMENT, context, items)
        )

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

        semaphore = asyncio.Semaphore(self.image_max_concurrency)

        async def process(material: SnapshotMaterial) -> BranchItem | InternalApiError:
            async with semaphore:
                try:
                    content = await self.api.download_material(context, material.id)
                    processed = await asyncio.to_thread(
                        self.image_processor.process, content
                    )
                    cache_key = _image_cache_key(
                        processed.metadata, self.provider.image_cache_namespace
                    )
                    cached_candidate: ExtractionCandidate | None = None
                    try:
                        cached_candidate = await self.api.get_image_cache(
                            context, cache_key
                        )
                    except InternalApiError as exc:
                        LOGGER.warning(
                            "Image cache lookup failed run_id=%s source_id=%s retryable=%s",
                            context.run_id,
                            material.id,
                            exc.retryable,
                        )
                    if cached_candidate is not None:
                        return BranchItem(
                            source_id=material.id,
                            status=BranchStatus.SUCCEEDED,
                            candidate=cached_candidate,
                            metadata={
                                **processed.metadata,
                                "cache": {"hit": True},
                            },
                        )
                    ai_call = await self.provider.analyze_image(
                        processed.data_uri,
                        source_name=material.original_file_name,
                        image_metadata=processed.metadata,
                    )
                    try:
                        await self.api.put_image_cache(
                            context,
                            cache_key,
                            ai_call.value,
                            {
                                "model": ai_call.metadata.model,
                                "promptVersion": ai_call.metadata.prompt_version,
                                "preprocessVersion": processed.metadata.get(
                                    "preprocessVersion"
                                ),
                            },
                        )
                    except InternalApiError as exc:
                        LOGGER.warning(
                            "Image cache write failed run_id=%s source_id=%s retryable=%s",
                            context.run_id,
                            material.id,
                            exc.retryable,
                        )
                    return BranchItem(
                        source_id=material.id,
                        status=BranchStatus.SUCCEEDED,
                        candidate=ai_call.value,
                        metadata={
                            **processed.metadata,
                            "cache": {"hit": False},
                            "aiCall": ai_call.metadata.as_dict(),
                        },
                    )
                except InternalApiError as exc:
                    return (
                        exc
                        if exc.retryable
                        else _failed_item(material.id, exc, BranchName.IMAGE)
                    )
                except Exception as exc:
                    return _failed_item(material.id, exc, BranchName.IMAGE)

        processed_items = await asyncio.gather(
            *(process(material) for material in sources)
        )
        retryable_error = next(
            (item for item in processed_items if isinstance(item, InternalApiError)),
            None,
        )
        if retryable_error is not None:
            raise retryable_error
        items = [item for item in processed_items if isinstance(item, BranchItem)]

        return await self._save(context, _aggregate(BranchName.IMAGE, context, items))

    async def commerce_branch(self, context: RuntimeContext) -> BranchOutput:
        snapshot = self._snapshot(context)
        await self._start(context, BranchName.COMMERCE)
        await self.report_progress(
            context,
            ProgressPayload(current_node="COMMERCE", progress=15),
        )
        commerce_url = _optional(snapshot.product.commerce_url)
        if commerce_url is None:
            return await self._save(
                context,
                BranchOutput(
                    branch=BranchName.COMMERCE,
                    status=BranchStatus.SKIPPED,
                    source_fingerprint=context.source_fingerprint,
                    warnings=[],
                    metadata={"hasCommerceUrl": False},
                ),
            )

        try:
            page = await self.commerce_fetcher.fetch(commerce_url)
            page_metadata = _commerce_page_metadata(page)
            storage_key = await self.api.upload_artifact(
                context,
                artifact_kind="COMMERCE_MARKDOWN",
                source_id=snapshot.product.id,
                content=page.markdown.encode("utf-8"),
                content_type="text/markdown; charset=utf-8",
                idempotency_key=(
                    f"{context.run_id}:commerce:{snapshot.product.id}:"
                    f"{context.source_fingerprint}"
                ),
            )
            model_text = page.markdown[: self.max_commerce_text_chars]
            try:
                ai_call = await self.provider.extract_commerce(
                    model_text,
                    source_host=page.source_host,
                    structured_metadata=page.model_metadata,
                )
                candidate = merge_commerce_candidates(
                    page.deterministic_candidate, ai_call.value
                )
                if not has_candidate_data(candidate):
                    raise CommerceFetchError(CommerceErrorType.EMPTY_CONTENT)
                item = BranchItem(
                    source_id=snapshot.product.id,
                    status=BranchStatus.SUCCEEDED,
                    candidate=candidate,
                    artifact_storage_key=storage_key,
                    metadata={
                        **page_metadata,
                        "pageTitle": page.page_title,
                        "aiCall": ai_call.metadata.as_dict(),
                    },
                )
                output = BranchOutput(
                    branch=BranchName.COMMERCE,
                    status=BranchStatus.SUCCEEDED,
                    source_fingerprint=context.source_fingerprint,
                    candidate=candidate,
                    items=[item],
                    metadata=page_metadata,
                )
            except ProviderError as exc:
                if not has_candidate_data(page.deterministic_candidate):
                    output = _commerce_failed_output(
                        context,
                        snapshot.product.id,
                        exc,
                        source_host=page.source_host,
                        page_title=page.page_title,
                        artifact_storage_key=storage_key,
                    )
                else:
                    warning = _provider_error_message(
                        BranchName.COMMERCE, exc.error_type
                    )
                    error = {
                        "type": exc.error_type.value,
                        "attempts": exc.attempts,
                        "elapsedMs": exc.elapsed_ms,
                    }
                    item = BranchItem(
                        source_id=snapshot.product.id,
                        status=BranchStatus.PARTIAL,
                        candidate=page.deterministic_candidate,
                        artifact_storage_key=storage_key,
                        warning=warning,
                        metadata={
                            **page_metadata,
                            "pageTitle": page.page_title,
                            "error": error,
                        },
                    )
                    output = BranchOutput(
                        branch=BranchName.COMMERCE,
                        status=BranchStatus.PARTIAL,
                        source_fingerprint=context.source_fingerprint,
                        candidate=page.deterministic_candidate,
                        items=[item],
                        warnings=[warning],
                        metadata={**page_metadata, "failures": [error]},
                    )
            except CommerceFetchError as exc:
                output = _commerce_failed_output(
                    context,
                    snapshot.product.id,
                    exc,
                    source_host=page.source_host,
                    page_title=page.page_title,
                    artifact_storage_key=storage_key,
                )
            return await self._save(context, output)
        except InternalApiError as exc:
            if exc.retryable:
                raise
            return await self._save(
                context,
                _commerce_failed_output(context, snapshot.product.id, exc),
            )
        except (CommerceFetchError, ProviderError) as exc:
            return await self._save(
                context,
                _commerce_failed_output(context, snapshot.product.id, exc),
            )
        except Exception as exc:
            return await self._save(
                context,
                _commerce_failed_output(context, snapshot.product.id, exc),
            )

    async def form_branch(self, context: RuntimeContext) -> BranchOutput:
        snapshot = self._snapshot(context)
        await self._start(context, BranchName.FORM)
        config = snapshot.global_video_config or snapshot.product.effective_config
        candidate = ExtractionCandidate.empty()
        # Product identity remains a manual-priority fusion input, but the public FORM detail
        # intentionally presents only the five global video fields from the import node.
        candidate.product_name = snapshot.product.name.strip() or None
        candidate.product_category = snapshot.product.category.strip() or None
        candidate.duration_seconds = config.duration_seconds
        candidate.aspect_ratio = _optional(config.aspect_ratio)
        candidate.resolution = _optional(config.resolution)
        candidate.delivery_channels = _optional(config.delivery_channel)
        candidate.visual_style_baseline = _optional(config.style_tone)
        candidate.disabled_elements = _strings(config.disabled_elements) or None
        return await self._save(
            context,
            BranchOutput(
                branch=BranchName.FORM,
                status=BranchStatus.SUCCEEDED,
                source_fingerprint=context.source_fingerprint,
                candidate=candidate,
                warnings=[],
                metadata={
                    "durationSeconds": config.duration_seconds,
                    "aspectRatio": config.aspect_ratio,
                    "resolution": config.resolution,
                    "styleTone": config.style_tone,
                    "deliveryChannel": config.delivery_channel,
                    "disabledElements": config.disabled_elements,
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

    async def refine_semantics(self, context: RuntimeContext) -> BranchOutput:
        await self._start(context, BranchName.SEMANTIC_REFINEMENT)
        await self.report_progress(
            context,
            ProgressPayload(current_node="SEMANTIC_REFINEMENT", progress=82),
        )
        branches = await self.api.get_branches(context)
        fusion = next(
            (branch for branch in branches if branch.branch == BranchName.FUSION), None
        )
        if fusion is None or fusion.candidate is None:
            raise FusionError("fusion output is missing")
        try:
            result = await refine_candidate_semantics(
                fusion.candidate, provider=self.provider
            )
            output = BranchOutput(
                branch=BranchName.SEMANTIC_REFINEMENT,
                status=BranchStatus.SUCCEEDED,
                source_fingerprint=context.source_fingerprint,
                candidate=result.candidate,
                metadata=result.metadata,
            )
        except ProviderError as exc:
            warning = _provider_error_message(
                BranchName.SEMANTIC_REFINEMENT, exc.error_type
            )
            output = BranchOutput(
                branch=BranchName.SEMANTIC_REFINEMENT,
                status=BranchStatus.PARTIAL,
                source_fingerprint=context.source_fingerprint,
                candidate=fusion.candidate,
                warnings=[f"{warning}，已保留原始提炼信息"],
                metadata={
                    "failures": [
                        {
                            "type": exc.error_type.value,
                            "attempts": exc.attempts,
                            "elapsedMs": exc.elapsed_ms,
                        }
                    ]
                },
            )
        except (TypeError, ValueError) as exc:
            output = BranchOutput(
                branch=BranchName.SEMANTIC_REFINEMENT,
                status=BranchStatus.PARTIAL,
                source_fingerprint=context.source_fingerprint,
                candidate=fusion.candidate,
                warnings=["语义整理结果无效，已保留原始提炼信息"],
                metadata={
                    "failures": [
                        {
                            "type": type(exc).__name__.upper(),
                            "attempts": 1,
                            "elapsedMs": 0,
                        }
                    ]
                },
            )
        return await self._save(context, output)

    async def normalize_and_finalize(self, context: RuntimeContext) -> str:
        await self._start(context, BranchName.NORMALIZATION)
        await self.report_progress(
            context,
            ProgressPayload(current_node="NORMALIZATION", progress=90),
        )
        branches = await self.api.get_branches(context)
        by_name = {branch.branch: branch for branch in branches}
        fusion = by_name.get(BranchName.FUSION)
        if fusion is None or fusion.candidate is None:
            raise FusionError("fusion output is missing")
        semantic = by_name.get(BranchName.SEMANTIC_REFINEMENT)
        normalized_input = (
            semantic.candidate
            if semantic is not None and semantic.candidate is not None
            else fusion.candidate
        )
        snapshot = self._snapshot(context)
        ai_call = await self.provider.normalize(
            normalized_input,
            protected_input=snapshot.manual_overrides,
        )
        result = ai_call.value
        if semantic is not None and semantic.status == BranchStatus.SUCCEEDED:
            _restore_semantic_fields(result, normalized_input)
        form = by_name.get(BranchName.FORM)
        if form and form.candidate:
            _restore_manual_fields(result, form.candidate)
        provenance_raw = fusion.metadata.get("provenance", {})
        provenance = (
            {str(key): str(value) for key, value in provenance_raw.items()}
            if isinstance(provenance_raw, dict)
            else {}
        )
        warnings = []
        for branch in branches:
            warnings.extend(branch.warnings)
            warnings.extend(item.warning for item in branch.items if item.warning)
        normalization = BranchOutput(
            branch=BranchName.NORMALIZATION,
            status=BranchStatus.SUCCEEDED,
            source_fingerprint=context.source_fingerprint,
            candidate=ExtractionCandidate.model_validate(result.model_dump()),
            metadata={"aiCall": ai_call.metadata.as_dict()},
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

    async def _save(
        self, context: RuntimeContext, output: BranchOutput
    ) -> BranchOutput:
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
    return (
        material.mime_type.lower() in DOCUMENT_MIME_TYPES
        or PurePath(material.original_file_name).suffix.lower() in DOCUMENT_EXTENSIONS
    )


def _image_cache_key(metadata: dict[str, int | str], namespace: str) -> str:
    fingerprint = metadata.get("processedSha256")
    if not isinstance(fingerprint, str) or len(fingerprint) != 64:
        raise PipelineError("processed image fingerprint is missing")
    return hashlib.sha256(f"{fingerprint}:{namespace}".encode("utf-8")).hexdigest()


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
    failure_diagnostics = [
        error
        for item in items
        if item.status == BranchStatus.FAILED
        and isinstance((error := item.metadata.get("error")), dict)
    ]
    return BranchOutput(
        branch=branch,
        status=status,
        source_fingerprint=context.source_fingerprint,
        items=items,
        warnings=_strings(warnings),
        metadata={"failures": failure_diagnostics} if failure_diagnostics else {},
    )


def _failed_item(source_id: str, exc: Exception, branch: BranchName) -> BranchItem:
    if isinstance(exc, ProviderError):
        return BranchItem(
            source_id=source_id,
            status=BranchStatus.FAILED,
            warning=_provider_error_message(branch, exc.error_type),
            metadata={
                "error": {
                    "type": exc.error_type.value,
                    "attempts": exc.attempts,
                    "elapsedMs": exc.elapsed_ms,
                }
            },
        )
    if isinstance(exc, CommerceFetchError):
        return BranchItem(
            source_id=source_id,
            status=BranchStatus.FAILED,
            warning=str(exc),
            metadata={
                "error": {
                    "type": exc.error_type.value,
                    "attempts": exc.attempts,
                    "elapsedMs": exc.elapsed_ms,
                }
            },
        )
    if branch == BranchName.COMMERCE:
        return BranchItem(
            source_id=source_id,
            status=BranchStatus.FAILED,
            warning="商品页面解析失败",
            metadata={
                "error": {"type": "COMMERCE_UNKNOWN", "attempts": 1, "elapsedMs": 0}
            },
        )
    return BranchItem(
        source_id=source_id,
        status=BranchStatus.FAILED,
        warning=_safe_error(exc),
    )


def _provider_error_message(branch: BranchName, error_type: ProviderErrorType) -> str:
    actions = {
        BranchName.DOCUMENT: "文档 AI 抽取",
        BranchName.IMAGE: "图片 AI 识别",
        BranchName.COMMERCE: "商品页面 AI 抽取",
        BranchName.SEMANTIC_REFINEMENT: "语义整理",
    }
    action = actions.get(branch, "AI 处理")
    suffixes = {
        ProviderErrorType.TIMEOUT: "超时",
        ProviderErrorType.NETWORK: "连接失败",
        ProviderErrorType.RATE_LIMIT: "服务繁忙，请稍后重试",
        ProviderErrorType.SERVICE: "服务暂时不可用",
        ProviderErrorType.RESPONSE_INVALID: "返回格式异常",
        ProviderErrorType.REQUEST_REJECTED: "请求被拒绝",
        ProviderErrorType.OUTPUT_TRUNCATED: "输出超出限制",
        ProviderErrorType.UNKNOWN: "失败",
    }
    return f"{action}{suffixes[error_type]}"


def _commerce_failed_output(
    context: RuntimeContext,
    source_id: str,
    exc: Exception,
    *,
    source_host: str | None = None,
    page_title: str | None = None,
    artifact_storage_key: str | None = None,
) -> BranchOutput:
    item = _failed_item(source_id, exc, BranchName.COMMERCE)
    if source_host or page_title or artifact_storage_key:
        item = item.model_copy(
            update={
                "artifact_storage_key": artifact_storage_key,
                "metadata": {
                    **item.metadata,
                    **({"sourceHost": source_host} if source_host else {}),
                    **({"pageTitle": page_title} if page_title else {}),
                },
            }
        )
    error = item.metadata.get("error")
    metadata: dict[str, object] = {}
    if isinstance(error, dict):
        metadata["failures"] = [error]
    if source_host:
        metadata["sourceHost"] = source_host
    return BranchOutput(
        branch=BranchName.COMMERCE,
        status=BranchStatus.FAILED,
        source_fingerprint=context.source_fingerprint,
        items=[item],
        warnings=[item.warning] if item.warning else [],
        metadata=metadata,
    )


def _safe_error(exc: Exception) -> str:
    message = " ".join(str(exc).split())
    return (message or type(exc).__name__)[:500]


def _commerce_page_metadata(page: CommercePage) -> dict[str, object]:
    metadata: dict[str, object] = {"sourceHost": page.source_host}
    for key in ("brand", "seller", "deliveryPromise"):
        value = page.model_metadata.get(key)
        if isinstance(value, str) and value.strip():
            metadata[key] = " ".join(value.split())[:500]
    return metadata


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
    for field in (
        "product_category",
        "product_name",
        "duration_seconds",
        "aspect_ratio",
        "resolution",
        "delivery_channels",
        "visual_style_baseline",
    ):
        value = getattr(form, field)
        if isinstance(value, str) and value.strip():
            setattr(result, field, value.strip())
        elif isinstance(value, int) and value > 0:
            setattr(result, field, value)
    if form.disabled_elements:
        setattr(result, "disabled_elements", _strings(form.disabled_elements))


def _restore_semantic_fields(result: object, semantic: ExtractionCandidate) -> None:
    for field in (
        "core_pain_points",
        "decision_drivers",
        "usage_scenarios",
        "purchase_scenarios",
        "emotional_scenarios",
    ):
        values = getattr(semantic, field)
        if values is not None:
            setattr(result, field, _strings(values)[:5])
