from __future__ import annotations
import asyncio
import json
import logging
from time import perf_counter
from typing import Any, TypedDict, cast
from langgraph.graph import START, END, StateGraph
from extraction_runtime.docling_parser import DocumentParser
from extraction_runtime.documents import split_document_markdown
from .api import Api
from .models import AuditReport, BriefField, Candidate, Review, Source, NODES, LABELS
from .documents import (
    template_candidate,
    filled_template_text,
    restore_docx_form_linebreaks,
)
from .provider import Provider
from .activity import SemanticActivity
from .quality import (
    AuditValidationError,
    audit_document,
    merge_candidates,
    repair_candidate,
    validate_audit,
    collect_repair_context,
    review_candidate,
    FINAL_REVIEW_INSTRUCTION,
    complete_conflict_alternatives,
    CONFLICT_POLICY_VERSION,
)


class PartialFailure(RuntimeError):
    pass


class ProvenanceError(ValueError):
    """Safe mechanical error, never includes document/model text."""


def validate_provenance(candidate: Candidate, documents: list[dict[str, Any]]) -> None:
    """Reject invalid checkpoints before they can be reused by a later attempt."""
    pinned = {(d["assetId"], d["assetVersion"]) for d in documents}
    document_ids = {d["assetId"] for d in documents}
    for key, value in candidate.fields.model_dump().items():
        sources = cast(list[Source], getattr(candidate.fieldSources, key))
        if value and not sources:
            raise ProvenanceError(f"field has no document provenance: {key}")
        for source in sources:
            if (
                (source.assetId, source.assetVersion) not in pinned
                or not source.location.strip()
                or len(source.location) > 1000
            ):
                raise ProvenanceError(
                    f"source is outside the pinned document input: {key}"
                )
        if key == "sellingPoints":
            indices = {s.itemIndex for s in sources}
            if any(
                not point.strip() or len(point) > 10000 for point in value
            ) or indices != set(range(len(value))):
                raise ProvenanceError("selling point provenance indices are invalid")
        elif len(value) > 50000:
            raise ProvenanceError(f"field exceeds the contract limit: {key}")
    issue_ids: set[str] = set()
    for issue in candidate.issues:
        if (
            not issue.id.strip()
            or issue.id in issue_ids
            or len(issue.id) > 200
            or len(issue.message) > 1000
            or any(len(v) > 50000 for v in issue.alternatives)
            or not set(issue.sourceIds).issubset(document_ids)
        ):
            raise ProvenanceError(
                "issue identifiers or document references are invalid"
            )
        issue_ids.add(issue.id)
        if issue.resolution is not None:
            r = issue.resolution
            current = getattr(candidate.fields, issue.field)
            if r.baseValue != current or current.count(r.before) != 1:
                raise ProvenanceError("conflict resolution base is invalid")
            start = current.find(r.before)
            compiled = [
                current[:start] + value + current[start + len(r.before) :]
                for value in r.replacements
            ]
            if (
                any(not value.strip() for value in r.replacements)
                or len(set(r.replacements)) != len(r.replacements)
                or compiled != issue.alternatives
            ):
                raise ProvenanceError("conflict resolution does not match alternatives")


class State(TypedDict):
    task_id: str


class Pipeline:
    def __init__(
        self,
        api: Api,
        parser: DocumentParser,
        provider: Provider,
        input_data: dict[str, Any],
        checkpoints: list[dict[str, Any]],
        concurrency: int = 2,
        chunk_chars: int = 12000,
    ) -> None:
        self.api, self.parser, self.provider = api, parser, provider
        self.input = input_data
        self.checkpoints = {
            (c["nodeId"], c["sourceId"]): c["output"] for c in checkpoints
        }
        # Old unfinished tasks may reuse parsing/extraction, but cannot bypass the new raw audit.
        semantic = self.checkpoints.get(("SEMANTIC_REFINEMENT", ""), {})
        summary = semantic.get("auditSummary") if isinstance(semantic, dict) else None
        if (
            not isinstance(summary, dict)
            or summary.get("schemaVersion") != 1
            or semantic.get("conflictPolicyVersion") != CONFLICT_POLICY_VERSION
        ):
            self.checkpoints.pop(("SEMANTIC_REFINEMENT", ""), None)
            self.checkpoints.pop(("NORMALIZATION", ""), None)
        self.semaphore = asyncio.Semaphore(concurrency)
        self.model_semaphore = asyncio.Semaphore(concurrency)
        self.chunk_chars = chunk_chars
        self.current_node = NODES[0]
        self.progress = 0
        self.activity: SemanticActivity | None = None

    async def heartbeat(self) -> None:
        while True:
            await asyncio.sleep(20)
            await self.api.call(
                "PUT",
                "progress",
                {"progress": self.progress, "nodeId": self.current_node},
            )

    async def checkpoint(
        self, node: str, source: str, output: Any, status: str = "SUCCEEDED"
    ) -> None:
        await self.api.call(
            "PUT",
            "steps",
            {"nodeId": node, "sourceId": source, "status": status, "output": output},
        )
        if status == "SUCCEEDED":
            self.checkpoints[(node, source)] = output

    async def documents(self, node: str) -> None:
        async def one(doc: dict[str, Any]) -> None:
            key = node, doc["assetId"]
            if key in self.checkpoints:
                return
            async with self.semaphore:
                await self.checkpoint(node, doc["assetId"], {}, "RUNNING")
                try:
                    if node == "DOCUMENT_PARSE":
                        raw = await self.api.content(doc["assetId"])
                        if len(raw) != doc["sizeBytes"]:
                            raise ValueError("document size mismatch")
                        if (
                            not doc["name"]
                            .lower()
                            .endswith((".docx", ".pdf", ".xlsx", ".txt", ".md"))
                        ):
                            raise ValueError("legacy document must be converted")
                        parsed = await self.parser.parse(raw, file_name=doc["name"])
                        if doc["name"].lower().endswith(".docx"):
                            parsed = restore_docx_form_linebreaks(parsed, raw)
                        await self.api.upload(doc["assetId"], parsed)
                        output: Any = {"parsed": True}
                    else:
                        text = (
                            await self.api.content(doc["assetId"], parsed=True)
                        ).decode("utf-8")
                        candidate = template_candidate(text, doc)
                        if candidate is None:
                            chunks = split_document_markdown(
                                filled_template_text(text), max_chars=self.chunk_chars
                            )

                            async def extract_chunk(
                                index: int, chunk: str
                            ) -> Candidate:
                                content = json.dumps(
                                    {
                                        "document": {
                                            k: doc[k]
                                            for k in ("assetId", "assetVersion", "name")
                                        },
                                        "chunk": index + 1,
                                        "text": chunk,
                                    },
                                    ensure_ascii=False,
                                )
                                async with self.model_semaphore:
                                    return await self.provider.generate(
                                        node,
                                        "提取本段资料中的12个信息字段；空字段保持空字符串或空数组。",
                                        content,
                                        Candidate,
                                    )

                            values = await asyncio.gather(
                                *(
                                    extract_chunk(index, chunk)
                                    for index, chunk in enumerate(chunks)
                                ),
                                return_exceptions=True,
                            )
                            for value in values:
                                if isinstance(value, BaseException):
                                    raise value
                            candidates = cast(list[Candidate], values)
                            for value in candidates:
                                validate_provenance(value, [doc])
                            candidate = await merge_candidates(
                                self.provider,
                                self.model_semaphore,
                                validate_provenance,
                                candidates,
                                [doc],
                                "DOCUMENT_EXTRACT",
                            )
                        validate_provenance(candidate, [doc])
                        output = candidate.model_dump()
                    await self.checkpoint(node, doc["assetId"], output)
                    done = sum(
                        (node, d["assetId"]) in self.checkpoints
                        for d in self.input["documents"]
                    )
                    self.progress = NODES.index(node) * 16 + int(
                        15 * done / len(self.input["documents"])
                    )
                    await self.api.call(
                        "PUT", "progress", {"progress": self.progress, "nodeId": node}
                    )
                except Exception as error:
                    if isinstance(error, ProvenanceError):
                        logging.warning(
                            "Extraction validation task=%s node=%s reason=%s",
                            self.api.task_id,
                            node,
                            error,
                        )
                    await self.checkpoint(node, doc["assetId"], {}, "FAILED")
                    raise

        results = await asyncio.gather(
            *(one(d) for d in self.input["documents"]), return_exceptions=True
        )
        if any(isinstance(r, BaseException) for r in results):
            await self.checkpoint(node, "", {}, "PARTIAL")
            raise PartialFailure("one or more documents failed")

    async def audit_documents(
        self, candidate: Candidate
    ) -> tuple[list[AuditReport], int, int]:
        done: set[str] = set()

        async def progress(doc: dict[str, Any]) -> None:
            done.add(doc["assetId"])
            if self.activity:
                await self.activity.counter("RAW_AUDIT", "DOCUMENT")(
                    len(done), len(self.input["documents"])
                )
            self.progress = 64 + int(12 * len(done) / len(self.input["documents"]))
            await self.api.call(
                "PUT",
                "progress",
                {"progress": self.progress, "nodeId": "SEMANTIC_REFINEMENT"},
            )

        async def one(doc: dict[str, Any]) -> tuple[AuditReport, int]:
            async with self.semaphore:
                audit_progress: dict[str, Any] = {}
                progress_lock = asyncio.Lock()
                try:
                    parsed = (
                        await self.api.content(doc["assetId"], parsed=True)
                    ).decode("utf-8")
                    text = filled_template_text(parsed)
                    # Empty forms do not carry facts; their examples never become model input.
                    template = template_candidate(parsed, doc)
                    if template is not None and not any(
                        template.fields.model_dump().values()
                    ):
                        await self.checkpoint(
                            "SEMANTIC_REFINEMENT", doc["assetId"], {}, "SKIPPED"
                        )
                        await progress(doc)
                        return AuditReport(checkedFields=[], findings=[]), 0
                    cached = self.checkpoints.get(
                        ("SEMANTIC_REFINEMENT", doc["assetId"])
                    )
                    if cached and "auditReport" in cached:
                        report = AuditReport.model_validate(cached["auditReport"])
                        validate_audit(report, doc, text, candidate)
                        count = int(cached["chunkCount"])
                        if count < 1:
                            raise ValueError(
                                "raw audit checkpoint has invalid chunk count"
                            )
                        await progress(doc)
                        return report, count
                    await self.checkpoint(
                        "SEMANTIC_REFINEMENT", doc["assetId"], {}, "RUNNING"
                    )
                    document_candidate = Candidate.model_validate(
                        self.checkpoints[("DOCUMENT_EXTRACT", doc["assetId"])]
                    )

                    async def chunk_progress(completed: int, total: int) -> None:
                        async with progress_lock:
                            audit_progress["auditProgress"] = {
                                "completed": completed,
                                "total": total,
                            }
                            await self.checkpoint(
                                "SEMANTIC_REFINEMENT",
                                doc["assetId"],
                                dict(audit_progress),
                                "RUNNING",
                            )

                    report, count = await audit_document(
                        self.provider,
                        self.model_semaphore,
                        doc,
                        text,
                        document_candidate,
                        candidate,
                        self.chunk_chars,
                        chunk_progress,
                    )
                    await self.checkpoint(
                        "SEMANTIC_REFINEMENT",
                        doc["assetId"],
                        {
                            "auditReport": report.model_dump(),
                            "chunkCount": count,
                            **audit_progress,
                        },
                    )
                    await progress(doc)
                    return report, count
                except Exception as error:
                    if isinstance(error, AuditValidationError):
                        logging.warning(
                            "Extraction audit validation task=%s reason=%s",
                            self.api.task_id,
                            error,
                        )
                    await self.checkpoint(
                        "SEMANTIC_REFINEMENT", doc["assetId"], audit_progress, "FAILED"
                    )
                    raise

        values = await asyncio.gather(
            *(one(doc) for doc in self.input["documents"]), return_exceptions=True
        )
        if any(isinstance(value, BaseException) for value in values):
            if self.activity:
                await self.activity.fail("PARTIAL")
            else:
                await self.checkpoint("SEMANTIC_REFINEMENT", "", {}, "PARTIAL")
            raise PartialFailure("one or more raw document audits failed")
        audited = [
            (report, count)
            for report, count in cast(list[tuple[AuditReport, int]], values)
            if count
        ]
        return (
            [report for report, _ in audited],
            sum(count for _, count in audited),
            len(audited),
        )

    async def stage(self, node: str) -> None:
        self.current_node = node
        self.progress = NODES.index(node) * 16
        await self.api.call(
            "PUT", "progress", {"progress": self.progress, "nodeId": node}
        )
        if (node, "") in self.checkpoints:
            return
        await self.checkpoint(node, "", {}, "RUNNING")
        if node == "LOAD_AND_SNAPSHOT":
            await self.checkpoint(node, "", {"documents": len(self.input["documents"])})
        elif node in {"DOCUMENT_PARSE", "DOCUMENT_EXTRACT"}:
            await self.documents(node)
            await self.checkpoint(node, "", {"processed": len(self.input["documents"])})
        elif node == "FUSION":
            candidates = [
                Candidate.model_validate(
                    self.checkpoints[("DOCUMENT_EXTRACT", d["assetId"])]
                )
                for d in self.input["documents"]
            ]
            fused = await merge_candidates(
                self.provider,
                self.model_semaphore,
                validate_provenance,
                candidates,
                self.input["documents"],
                node,
            )
            validate_provenance(fused, self.input["documents"])
            await self.checkpoint(node, "", fused.model_dump())
        elif node == "SEMANTIC_REFINEMENT":

            async def save_activity(output: dict[str, Any], status: str) -> None:
                await self.checkpoint(node, "", output, status)

            self.activity = activity = SemanticActivity(save_activity)
            await activity.counter("RAW_AUDIT", "DOCUMENT")(
                0, len(self.input["documents"])
            )
            candidate = Candidate.model_validate(self.checkpoints[("FUSION", "")])
            reports, chunk_count, document_count = await self.audit_documents(candidate)
            await activity.set("RAW_AUDIT", "SUCCEEDED")
            audit = AuditReport(
                checkedFields=reports[0].checkedFields if reports else [],
                findings=[finding for report in reports for finding in report.findings],
            )
            original_fields = candidate.fields.model_dump()
            context_fields = {f.field for f in audit.findings} | {
                i.field for i in candidate.issues
            }
            await activity.set(
                "EVIDENCE_RECHECK", "RUNNING" if context_fields else "SKIPPED"
            )
            context = (
                await collect_repair_context(
                    self.provider,
                    self.model_semaphore,
                    [
                        (
                            doc,
                            filled_template_text(
                                (
                                    await self.api.content(doc["assetId"], parsed=True)
                                ).decode("utf-8")
                            ),
                        )
                        for doc in self.input["documents"]
                    ],
                    audit,
                    self.chunk_chars,
                    cast(list[BriefField], [issue.field for issue in candidate.issues]),
                    activity.counter("EVIDENCE_RECHECK", "CHUNK"),
                )
                if audit.findings or candidate.issues
                else []
            )
            if context_fields:
                await activity.set("EVIDENCE_RECHECK", "SUCCEEDED")
            await activity.set(
                "TARGETED_REPAIR", "RUNNING" if audit.findings else "SKIPPED"
            )
            candidate = await repair_candidate(
                self.provider,
                self.model_semaphore,
                validate_provenance,
                candidate,
                audit,
                self.input["documents"],
                context,
            )
            if audit.findings:
                await activity.set("TARGETED_REPAIR", "SUCCEEDED")
            self.progress = 78
            await self.api.call(
                "PUT", "progress", {"progress": self.progress, "nodeId": node}
            )
            has_facts = any(candidate.fields.model_dump().values())
            await activity.set("FINAL_REVIEW", "RUNNING" if has_facts else "SKIPPED")
            review = (
                await review_candidate(
                    self.provider,
                    FINAL_REVIEW_INSTRUCTION,
                    {
                        "candidate": candidate.model_dump(),
                        "documentCandidates": [
                            self.checkpoints[("DOCUMENT_EXTRACT", d["assetId"])]
                            for d in self.input["documents"]
                        ],
                        "verifiedRawFindings": [f.model_dump() for f in audit.findings],
                        "supportingRawContext": context,
                    },
                    candidate,
                )
                if has_facts
                else Review(issues=[])
            )
            # Only explicit AI decisions can clear false positives; omission keeps conflicts.
            issues = {i.id: i for i in candidate.issues}
            dismissed = set(review.dismissedIssueIds)
            if (
                len(dismissed) != len(review.dismissedIssueIds)
                or not dismissed.issubset(issues)
                or dismissed.intersection(i.id for i in review.issues)
            ):
                raise ProvenanceError("review dismissed issue identifiers are invalid")
            issues = {
                key: issue for key, issue in issues.items() if key not in dismissed
            }
            issues.update({i.id: i for i in review.issues})
            candidate.issues = list(issues.values())
            if has_facts:
                await activity.set("FINAL_REVIEW", "SUCCEEDED")
            new_issue_fields = {i.field for i in candidate.issues} - context_fields
            await activity.set(
                "CONFLICT_EVIDENCE", "RUNNING" if new_issue_fields else "SKIPPED"
            )
            if new_issue_fields:
                context.extend(
                    await collect_repair_context(
                        self.provider,
                        self.model_semaphore,
                        [
                            (
                                doc,
                                filled_template_text(
                                    (
                                        await self.api.content(
                                            doc["assetId"], parsed=True
                                        )
                                    ).decode("utf-8")
                                ),
                            )
                            for doc in self.input["documents"]
                        ],
                        AuditReport(checkedFields=[], findings=[]),
                        self.chunk_chars,
                        cast(list[BriefField], sorted(new_issue_fields)),
                        activity.counter("CONFLICT_EVIDENCE", "CHUNK"),
                    )
                )
                await activity.set("CONFLICT_EVIDENCE", "SUCCEEDED")
            had_issues = bool(candidate.issues)
            await activity.set(
                "CONFLICT_COMPLETION", "RUNNING" if had_issues else "SKIPPED"
            )
            candidate = await complete_conflict_alternatives(
                self.provider,
                self.model_semaphore,
                candidate,
                [
                    self.checkpoints[("DOCUMENT_EXTRACT", doc["assetId"])]
                    for doc in self.input["documents"]
                ],
                context,
                activity.counter("CONFLICT_COMPLETION", "ISSUE")
                if candidate.issues
                else None,
            )
            validate_provenance(candidate, self.input["documents"])
            if had_issues:
                await activity.set("CONFLICT_COMPLETION", "SUCCEEDED")
            await self.checkpoint(
                node,
                "",
                {
                    **candidate.model_dump(),
                    "conflictPolicyVersion": CONFLICT_POLICY_VERSION,
                    "activity": activity.snapshot(),
                    "auditSummary": {
                        "schemaVersion": 1,
                        "documentCount": document_count,
                        "chunkCount": chunk_count,
                        "findingCount": len(audit.findings),
                        "correctedFields": [
                            key
                            for key in LABELS
                            if original_fields[key] != getattr(candidate.fields, key)
                        ],
                    },
                },
            )
        elif node == "NORMALIZATION":
            candidate = Candidate.model_validate(
                {
                    key: self.checkpoints[("SEMANTIC_REFINEMENT", "")][key]
                    for key in ("fields", "fieldSources", "issues")
                }
            )
            if not any(candidate.fields.model_dump().values()):
                raise ValueError("empty template contains no facts")
            validate_provenance(candidate, self.input["documents"])
            await self.checkpoint(node, "", candidate.model_dump())

    async def run(self) -> None:
        graph = StateGraph(State)
        for node in NODES:

            async def execute(state: State, node_id: str = node) -> dict[str, Any]:
                started = perf_counter()
                succeeded = False
                try:
                    await self.stage(node_id)
                    succeeded = True
                except PartialFailure:
                    raise
                except Exception as error:
                    if isinstance(error, (ProvenanceError, AuditValidationError)):
                        logging.warning(
                            "Extraction validation task=%s node=%s reason=%s",
                            self.api.task_id,
                            node_id,
                            error,
                        )
                    if node_id == "SEMANTIC_REFINEMENT" and self.activity:
                        await self.activity.fail("FAILED")
                    else:
                        await self.checkpoint(node_id, "", {}, "FAILED")
                    raise
                finally:
                    logging.info(
                        "Extraction stage task=%s node=%s succeeded=%s elapsed_ms=%d",
                        self.api.task_id,
                        node_id,
                        succeeded,
                        (perf_counter() - started) * 1000,
                    )
                return {}

            graph.add_node(node, execute)
        graph.add_edge(START, NODES[0])
        for left, right in zip(NODES, NODES[1:]):
            graph.add_edge(left, right)
        graph.add_edge(NODES[-1], END)
        await graph.compile().ainvoke({"task_id": self.api.task_id})
        await self.api.call(
            "POST", "complete", {"candidate": self.checkpoints[("NORMALIZATION", "")]}
        )
