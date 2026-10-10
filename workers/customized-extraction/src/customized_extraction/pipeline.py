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
from .models import Candidate, Review, Source, NODES
from .documents import (
    template_candidate,
    filled_template_text,
    combine_chunks,
    restore_docx_form_linebreaks,
    restore_selling_point_sources,
)
from .provider import Provider


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
        self.semaphore = asyncio.Semaphore(concurrency)
        self.model_semaphore = asyncio.Semaphore(concurrency)
        self.chunk_chars = chunk_chars
        self.current_node = NODES[0]
        self.progress = 0

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
                            candidate = combine_chunks(cast(list[Candidate], values))
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
            # Blank forms carry no facts; merging them adds cost and risks importing examples.
            candidates = [
                c for c in candidates if any(c.fields.model_dump().values()) or c.issues
            ]
            if not candidates:
                fused = Candidate.model_validate(
                    self.checkpoints[
                        ("DOCUMENT_EXTRACT", self.input["documents"][0]["assetId"])
                    ]
                )
            elif len(candidates) == 1:
                fused = candidates[0]
            else:

                async def merge(left: Candidate, right: Candidate) -> Candidate:
                    async with self.model_semaphore:
                        result = await self.provider.generate(
                            node,
                            "合并两份信息卡，完整保留独立事实和来源；独立卖点尽量保持原文，不合并、不改写。sellingPoints 合并后 fieldSources 的 itemIndex 必须重新按最终数组从0编号，不沿用各输入的局部索引。相互矛盾的文本字段列入 issues，blocking=true；候选值保留该字段不冲突的共同信息。不要把不同段落补充误判为冲突。有文档依据的同一产品全名与简称不构成名称冲突，采用完整名称。待设计的包装版式仅归入外观，不重复混入规格。",
                            json.dumps(
                                [left.model_dump(), right.model_dump()],
                                ensure_ascii=False,
                            ),
                            Candidate,
                        )
                        result = restore_selling_point_sources(result, [left, right])
                        validate_provenance(result, self.input["documents"])
                        return result

                # Balanced rounds retain the same N-1 merges without serialising independent pairs.
                while len(candidates) > 1:
                    merged = await asyncio.gather(
                        *(
                            merge(candidates[i], candidates[i + 1])
                            for i in range(0, len(candidates) - 1, 2)
                        ),
                        return_exceptions=True,
                    )
                    for value in merged:
                        if isinstance(value, BaseException):
                            raise value
                    candidates = cast(list[Candidate], merged) + (
                        candidates[-1:] if len(candidates) % 2 else []
                    )
                fused = candidates[0]
            validate_provenance(fused, self.input["documents"])
            await self.checkpoint(node, "", fused.model_dump())
        elif node == "SEMANTIC_REFINEMENT":
            candidate = Candidate.model_validate(self.checkpoints[("FUSION", "")])
            review = (
                await self.provider.generate(
                    node,
                    "根据 documentCandidates 核对 candidate 中无依据断言与实质矛盾。判断顺序：先判断各文档是否在说同一产品，再判断同一属性的断言是否互斥。完整名称与同产品补充资料的简称、型号代称不是互斥事实；一份文档未提及某字段也不构成冲突。不得仅因两份文档 productName 文本不同生成 issue；已保留明确完整名称且其他文档只是简称时属于正常项。返回全部仍成立的 issues，包括核对后保持不变的既有条目；正常项不创建提示，不改写原始事实。不强制补齐空字段。已有冲突须逐条重新阅读 documentCandidates 的完整字段，先找出所有非冲突事实，再仅替换互斥部分，为每个 alternatives 重建完整字段值；不得直接照抄可能残缺的融合候选。修订已有 issue 时沿用其 id。dismissedIssueIds 仅填经原始文档核对后明确属于误报的已有 issue id，例如同产品全名与简称；不存在误报时返回空数组。不能因缺少证据、自己偏好某个候选、或候选措辞相似而消除真实规格冲突；仅省略 issue 不能消除它。必须逐一复核已有冲突的 alternatives：每项都是用户选用后替换整个字段的完整值，不是冲突片段。某一规格冲突不代表整组规格冲突；一份文档未提及某项事实不等于否认，其他文档明确且没有反证的事实须保留在每个候选中。即使融合时字段被清空，也须从 documentCandidates 找回这些共同信息。仅当资料已明确保质期12个月、仅净含量200g和250g冲突时，两项候选都必须含保质期12个月。不得增加无依据事实。",
                    json.dumps(
                        {
                            "candidate": candidate.model_dump(),
                            "documentCandidates": [
                                self.checkpoints[("DOCUMENT_EXTRACT", d["assetId"])]
                                for d in self.input["documents"]
                            ],
                        },
                        ensure_ascii=False,
                    ),
                    Review,
                )
                if any(candidate.fields.model_dump().values())
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
            validate_provenance(candidate, self.input["documents"])
            await self.checkpoint(node, "", candidate.model_dump())
        elif node == "NORMALIZATION":
            candidate = Candidate.model_validate(
                self.checkpoints[("SEMANTIC_REFINEMENT", "")]
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
                    if isinstance(error, ProvenanceError):
                        logging.warning(
                            "Extraction validation task=%s node=%s reason=%s",
                            self.api.task_id,
                            node_id,
                            error,
                        )
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
