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
from .document_facts import extract_structured_document_facts
from .fusion import FusionError, branch_candidate, fuse
from .image_processing import ImageProcessor
from .models import (
    BranchItem,
    BranchName,
    BranchOutput,
    BranchStatus,
    ExtractionCandidate,
    ExtractionResult,
    ExtractionSnapshot,
    FailurePayload,
    FinalizePayload,
    ProgressPayload,
    RuntimeContext,
    SnapshotMaterial,
)
from .providers import AiProvider, ProviderError, ProviderErrorType
from .semantic_refinement import (
    SEMANTIC_FIELDS,
    refine_candidate_semantics,
    semantic_fallback_metadata,
    user_only_candidate,
)

MAX_SELLING_POINTS = 100
SEMANTIC_RESULT_LIMITS: dict[str, int] = {"selling_points": MAX_SELLING_POINTS}

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
                structured_candidate = extract_structured_document_facts(markdown)
                truncated = len(markdown) > self.max_document_text_chars
                model_text = markdown[: self.max_document_text_chars]
                ai_call = None
                if structured_candidate is None:
                    ai_call = await self.provider.extract_document(
                        model_text, source_name=material.original_file_name
                    )
                if structured_candidate is not None:
                    extracted_candidate = structured_candidate
                else:
                    assert ai_call is not None
                    extracted_candidate = ai_call.value
                document_candidate = extracted_candidate
                items.append(
                    BranchItem(
                        source_id=material.id,
                        status=BranchStatus.SUCCEEDED,
                        candidate=document_candidate,
                        artifact_storage_key=storage_key,
                        metadata={
                            "markdownChars": len(markdown),
                            "modelInputChars": (
                                0
                                if structured_candidate is not None
                                else len(model_text)
                            ),
                            "modelInputTruncated": (
                                structured_candidate is None and truncated
                            ),
                            "extractionMode": (
                                "STRUCTURED_TABLE"
                                if structured_candidate is not None
                                else "AI_FALLBACK"
                            ),
                            **(
                                {"aiCall": ai_call.metadata.as_dict()}
                                if ai_call is not None
                                else {}
                            ),
                        },
                        warning=(
                            "文档过长，模型候选抽取使用了受限长度文本；完整 Markdown 已保留"
                            if structured_candidate is None and truncated
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
                    if cached_candidate is not None and not snapshot.bypass_image_cache:
                        return BranchItem(
                            source_id=material.id,
                            status=BranchStatus.SUCCEEDED,
                            candidate=cached_candidate,
                            metadata={
                                **processed.metadata,
                                "cache": {"hit": True},
                            },
                        )
                    try:
                        ai_call = await self.provider.analyze_image(
                            processed.data_uri,
                            source_name=material.original_file_name,
                            image_metadata=processed.metadata,
                        )
                    except ProviderError as exc:
                        if cached_candidate is None:
                            raise
                        warning = _provider_error_message(
                            BranchName.IMAGE, exc.error_type
                        )
                        return BranchItem(
                            source_id=material.id,
                            status=BranchStatus.PARTIAL,
                            candidate=cached_candidate,
                            warning=f"{warning}，已使用上次识别结果",
                            metadata={
                                **processed.metadata,
                                "cache": {
                                    "hit": True,
                                    "fallback": True,
                                    **(
                                        {"bypassed": True}
                                        if snapshot.bypass_image_cache
                                        else {}
                                    ),
                                },
                                "error": _provider_error_diagnostic(exc),
                            },
                        )
                    if ai_call.cacheable:
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
                            "cache": {
                                "hit": False,
                                **(
                                    {"bypassed": True}
                                    if snapshot.bypass_image_cache
                                    else {}
                                ),
                            },
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
        candidate = ExtractionCandidate.empty()
        candidate.product_name = snapshot.product.name.strip() or None
        candidate.product_category = snapshot.product.category.strip() or None
        return await self._save(
            context,
            BranchOutput(
                branch=BranchName.FORM,
                status=BranchStatus.SUCCEEDED,
                source_fingerprint=context.source_fingerprint,
                candidate=candidate,
                warnings=[],
                metadata={},
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
        snapshot = self._snapshot(context)
        semantic_candidate, user_facts, image_suggestions, reference_facts = (
            _prepare_semantic_candidate(
                fusion.candidate,
                branches,
                manual_overrides=snapshot.manual_overrides,
            )
        )
        fallback_candidate = user_only_candidate(semantic_candidate, user_facts)
        try:
            result = await refine_candidate_semantics(
                semantic_candidate,
                provider=self.provider,
                user_facts=user_facts,
                image_suggestions=image_suggestions,
                reference_facts=reference_facts,
            )
            validation = result.metadata.get("validation") or {}
            correction_count = int(validation.get("correctionCount", 0))
            corrected = correction_count > 0
            output = BranchOutput(
                branch=BranchName.SEMANTIC_REFINEMENT,
                status=(BranchStatus.PARTIAL if corrected else BranchStatus.SUCCEEDED),
                source_fingerprint=context.source_fingerprint,
                candidate=result.candidate,
                warnings=(
                    [
                        f"语义整理已安全忽略 {correction_count} 项无效结构，"
                        "其余图片建议已正常应用"
                    ]
                    if corrected
                    else []
                ),
                metadata=result.metadata,
            )
            LOGGER.info(
                "semantic refinement completed user_facts=%s user_notices=%s "
                "image_suggestions=%s image_kept=%s image_moved=%s image_dropped=%s "
                "corrections=%s correction_codes=%s latency_ms=%s attempts=%s",
                result.metadata.get("userFactCount", 0),
                result.metadata.get("userNoticeCount", 0),
                result.metadata.get("imageSuggestionInputCount", 0),
                result.metadata.get("imageSuggestionKeptCount", 0),
                result.metadata.get("imageSuggestionMovedCount", 0),
                result.metadata.get("imageSuggestionDroppedCount", 0),
                correction_count,
                ",".join(validation.get("correctionCodes", [])) or "none",
                (result.metadata.get("aiCall") or {}).get("latencyMs", 0),
                (result.metadata.get("aiCall") or {}).get("attempts", 0),
            )
        except ProviderError as exc:
            warning = _provider_error_message(
                BranchName.SEMANTIC_REFINEMENT, exc.error_type
            )
            output = BranchOutput(
                branch=BranchName.SEMANTIC_REFINEMENT,
                status=BranchStatus.PARTIAL,
                source_fingerprint=context.source_fingerprint,
                candidate=fallback_candidate,
                warnings=[f"{warning}，已保留用户事实，图片建议未加入信息卡"],
                metadata=semantic_fallback_metadata(
                    user_facts=user_facts,
                    image_suggestions=image_suggestions,
                    reference_facts=reference_facts,
                    failure={
                        "type": exc.error_type.value,
                        "attempts": exc.attempts,
                        "elapsedMs": exc.elapsed_ms,
                    },
                ),
            )
        except (TypeError, ValueError):
            output = BranchOutput(
                branch=BranchName.SEMANTIC_REFINEMENT,
                status=BranchStatus.PARTIAL,
                source_fingerprint=context.source_fingerprint,
                candidate=fallback_candidate,
                warnings=["语义整理结果无效，已保留用户事实，图片建议未加入信息卡"],
                metadata=semantic_fallback_metadata(
                    user_facts=user_facts,
                    image_suggestions=image_suggestions,
                    failure={
                        "type": "SEMANTIC_INPUT_INVALID",
                        "attempts": 1,
                        "elapsedMs": 0,
                    },
                ),
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
        semantic_candidate = branch_candidate(semantic) if semantic else None
        normalized_input = semantic_candidate or fusion.candidate
        snapshot = self._snapshot(context)
        form = by_name.get(BranchName.FORM)
        document = by_name.get(BranchName.DOCUMENT)
        commerce = by_name.get(BranchName.COMMERCE)
        image = by_name.get(BranchName.IMAGE)
        form_candidate = branch_candidate(form) if form else None
        document_candidate = branch_candidate(document) if document else None
        commerce_candidate = branch_candidate(commerce) if commerce else None
        image_candidate = branch_candidate(image) if image else None
        normalization_metadata: dict[str, object]
        try:
            result = _normalize_candidate_deterministically(normalized_input)
            normalization_metadata = {
                "normalization": {
                    "mode": "DETERMINISTIC",
                    "modelCalled": False,
                }
            }
        except (TypeError, ValueError) as exc:
            LOGGER.warning(
                "deterministic normalization failed; using AI fallback error_type=%s",
                type(exc).__name__,
            )
            ai_call = await self.provider.normalize(
                normalized_input,
                protected_input=_protected_user_input(
                    snapshot.manual_overrides,
                    form_candidate,
                    document_candidate,
                    commerce_candidate,
                ),
            )
            result = ai_call.value
            normalization_metadata = {
                "normalization": {
                    "mode": "AI_FALLBACK",
                    "modelCalled": True,
                },
                "aiCall": ai_call.metadata.as_dict(),
            }
        _restore_authoritative_sources(
            result,
            form=form_candidate,
            document=document_candidate,
            commerce=commerce_candidate,
            image=image_candidate,
        )
        _restore_semantic_fields(result, semantic_candidate)
        result = ExtractionResult.model_validate(result.model_dump(mode="json"))
        provenance_raw = fusion.metadata.get("provenance", {})
        fused_provenance = (
            {str(key): str(value) for key, value in provenance_raw.items()}
            if isinstance(provenance_raw, dict)
            else {}
        )
        provenance = _reconciled_final_provenance(
            fused_provenance,
            result=result,
            form=form_candidate,
            document=document_candidate,
            commerce=commerce_candidate,
            image=image_candidate,
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
            metadata=normalization_metadata,
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
    partial = sum(item.status == BranchStatus.PARTIAL for item in items)
    usable = succeeded + partial
    if succeeded == len(items):
        status = BranchStatus.SUCCEEDED
    elif usable > 0:
        status = BranchStatus.PARTIAL
    else:
        status = BranchStatus.FAILED
    warnings = [item.warning for item in items if item.warning]
    failure_diagnostics = [
        error
        for item in items
        if item.status in {BranchStatus.FAILED, BranchStatus.PARTIAL}
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
            metadata={"error": _provider_error_diagnostic(exc)},
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


def _provider_error_diagnostic(exc: ProviderError) -> dict[str, int | str]:
    return {
        "type": exc.error_type.value,
        "attempts": exc.attempts,
        "elapsedMs": exc.elapsed_ms,
    }


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
        key = value
        if value and key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _candidate_text(candidate: ExtractionCandidate | None, field: str) -> str | None:
    if candidate is None:
        return None
    value = getattr(candidate, field)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _candidate_items(candidate: ExtractionCandidate | None, field: str) -> list[str]:
    if candidate is None:
        return []
    return _strings(getattr(candidate, field) or [])


def _first_text(field: str, *candidates: ExtractionCandidate | None) -> str:
    for candidate in candidates:
        value = _candidate_text(candidate, field)
        if value is not None:
            return value
    return "待补充"


def _merged_items(
    field: str,
    *candidates: ExtractionCandidate | None,
    limit: int,
) -> list[str]:
    return _strings(
        [
            item
            for candidate in candidates
            for item in _candidate_items(candidate, field)
        ]
    )[:limit]


def _normalize_candidate_deterministically(
    candidate: ExtractionCandidate,
) -> ExtractionResult:
    selling_points = _candidate_items(candidate, "selling_points")[:MAX_SELLING_POINTS]
    if not selling_points:
        raise FusionError("未提取到可用卖点，请补充产品资料后重新提炼")
    return ExtractionResult(
        product_category=_candidate_text(candidate, "product_category") or "待补充",
        product_name=_candidate_text(candidate, "product_name") or "待补充",
        core_specification=_candidate_text(candidate, "core_specification") or "待补充",
        price_range=_candidate_text(candidate, "price_range") or "待补充",
        visual_features=_candidate_text(candidate, "visual_features") or "待补充",
        selling_points=selling_points,
    )


def _items_preserving_order(
    candidate: ExtractionCandidate | None,
    field: str,
) -> list[str]:
    if candidate is None:
        return []
    result: list[str] = []
    for raw in getattr(candidate, field) or []:
        value = " ".join(str(raw).split()).strip()
        if value:
            result.append(value)
    return result


def _manual_items(
    manual_overrides: dict[str, object],
    *,
    field: str,
    alias: str,
) -> list[str] | None:
    sentinel = object()
    raw = manual_overrides.get(alias, manual_overrides.get(field, sentinel))
    if raw is sentinel or not isinstance(raw, list):
        return None
    values = [" ".join(str(item).split()).strip() for item in raw]
    return [value for value in values if value]


def _manual_text(
    manual_overrides: dict[str, object],
    *,
    field: str,
    alias: str,
) -> str | None:
    raw = manual_overrides.get(alias, manual_overrides.get(field))
    if not isinstance(raw, str):
        return None
    value = " ".join(raw.split()).strip()
    return value or None


def _prepare_semantic_candidate(
    fusion_candidate: ExtractionCandidate,
    branches: Sequence[BranchOutput],
    *,
    manual_overrides: dict[str, object],
) -> tuple[
    ExtractionCandidate,
    list[dict[str, str]],
    list[dict[str, str]],
    list[dict[str, str]],
]:
    """Separate immutable user facts from mutable image suggestions."""

    by_name = {branch.branch: branch for branch in branches}
    form = (
        branch_candidate(by_name[BranchName.FORM])
        if BranchName.FORM in by_name
        else None
    )
    document = (
        branch_candidate(by_name[BranchName.DOCUMENT])
        if BranchName.DOCUMENT in by_name
        else None
    )
    commerce = (
        branch_candidate(by_name[BranchName.COMMERCE])
        if BranchName.COMMERCE in by_name
        else None
    )
    image = (
        branch_candidate(by_name[BranchName.IMAGE])
        if BranchName.IMAGE in by_name
        else None
    )

    prepared = fusion_candidate.model_copy(deep=True)
    user_facts: list[dict[str, str]] = []
    image_suggestions: list[dict[str, str]] = []
    reference_facts: list[dict[str, str]] = []
    for field, attr in SEMANTIC_FIELDS:
        manual_values = _manual_items(
            manual_overrides,
            field=attr,
            alias=field.value,
        )
        user_values = (
            manual_values
            if manual_values is not None
            else [
                *_items_preserving_order(document, attr),
                *_items_preserving_order(commerce, attr),
            ]
        )[:MAX_SELLING_POINTS]
        image_values = _items_preserving_order(image, attr)
        setattr(prepared, attr, [*user_values, *image_values] or None)
        user_facts.extend(
            {
                "factId": f"user-{field.value}-{index:02d}",
                "field": field.value,
                "value": value,
                "sourceType": "USER_FACT",
            }
            for index, value in enumerate(user_values, start=1)
        )
        image_suggestions.extend(
            {
                "factId": f"image-{field.value}-{index:02d}",
                "field": field.value,
                "value": value,
                "sourceType": "IMAGE_SUGGESTION",
            }
            for index, value in enumerate(image_values, start=1)
        )

    reference_fields = (
        ("productCategory", "product_category"),
        ("productName", "product_name"),
        ("coreSpecification", "core_specification"),
        ("visualFeatures", "visual_features"),
    )
    for alias, attr in reference_fields:
        manual_value = _manual_text(
            manual_overrides,
            field=attr,
            alias=alias,
        )
        value = manual_value or next(
            (
                candidate_value
                for candidate in (form, document, commerce)
                if (candidate_value := _candidate_text(candidate, attr)) is not None
            ),
            None,
        )
        if not value:
            continue
        reference_facts.append(
            {
                "factId": f"reference-{alias}",
                "field": alias,
                "value": value,
                "sourceType": "USER_REFERENCE",
            }
        )

    return prepared, user_facts, image_suggestions, reference_facts


def _semantic_value_key(value: str) -> str:
    return " ".join(value.split()).strip()


def _semantic_values(
    candidate: ExtractionCandidate | None,
    attr: str,
) -> set[str]:
    if candidate is None:
        return set()
    return {
        key
        for value in getattr(candidate, attr) or []
        if (key := _semantic_value_key(value))
    }


def _reconciled_final_provenance(
    fused_provenance: dict[str, str],
    *,
    result: ExtractionResult,
    form: ExtractionCandidate | None,
    document: ExtractionCandidate | None,
    commerce: ExtractionCandidate | None,
    image: ExtractionCandidate | None,
) -> dict[str, str]:
    """Remove pre-refinement IMAGE sources that do not survive final semantics."""

    provenance = dict(fused_provenance)
    authoritative_sources = (
        (BranchName.FORM, form),
        (BranchName.DOCUMENT, document),
        (BranchName.COMMERCE, commerce),
    )
    image_values = {
        value
        for _, semantic_attr in SEMANTIC_FIELDS
        for value in _semantic_values(image, semantic_attr)
    }
    for _, attr in SEMANTIC_FIELDS:
        sources: list[str] = []
        for value in getattr(result, attr) or []:
            key = _semantic_value_key(value)
            source = next(
                (
                    branch
                    for branch, candidate in authoritative_sources
                    if key in _semantic_values(candidate, attr)
                ),
                BranchName.IMAGE if key in image_values else None,
            )
            if source is not None and source.value not in sources:
                sources.append(source.value)
        if sources:
            provenance[attr] = ">".join(sources)
        else:
            provenance.pop(attr, None)
    return provenance


def _restore_authoritative_sources(
    result: object,
    *,
    form: ExtractionCandidate | None,
    document: ExtractionCandidate | None,
    commerce: ExtractionCandidate | None,
    image: ExtractionCandidate | None,
) -> None:
    """Keep user-provided facts authoritative and use image AI only as visible suggestions."""

    setattr(
        result,
        "product_category",
        _first_text("product_category", form, document, commerce, image),
    )
    setattr(
        result,
        "product_name",
        _first_text("product_name", form, document, commerce, image),
    )
    setattr(
        result,
        "core_specification",
        _first_text("core_specification", document, commerce, image),
    )
    setattr(result, "price_range", _first_text("price_range", document, commerce))
    setattr(
        result,
        "visual_features",
        _first_text("visual_features", document, commerce, image),
    )

    selling_points = _merged_items(
        "selling_points", form, document, commerce, image, limit=MAX_SELLING_POINTS
    )
    if selling_points:
        setattr(result, "selling_points", selling_points)


def _restore_semantic_fields(
    result: object,
    semantic: ExtractionCandidate | None,
) -> None:
    """Apply only validated existing-fact merges after authoritative restoration."""

    if semantic is None:
        return
    for field, limit in SEMANTIC_RESULT_LIMITS.items():
        items = _candidate_items(semantic, field)[:limit]
        if field == "selling_points" and not items:
            continue
        setattr(result, field, items)


def _protected_user_input(
    manual_overrides: dict[str, object],
    *candidates: ExtractionCandidate | None,
) -> dict[str, object]:
    protected: dict[str, object] = {}
    for candidate in candidates:
        if candidate is None:
            continue
        for key, value in candidate.model_dump(mode="json", by_alias=True).items():
            if value not in (None, [], ""):
                protected.setdefault(key, value)
    protected.update(manual_overrides)
    return protected
