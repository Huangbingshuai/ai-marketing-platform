from __future__ import annotations
import asyncio
import json
from typing import Any, TypedDict, cast
from langgraph.graph import START, END, StateGraph
from extraction_runtime.docling_parser import DocumentParser
from extraction_runtime.documents import split_document_markdown
from .api import Api
from .models import Candidate, Review, Source, NODES
from .documents import template_candidate, combine_chunks
from .provider import Provider


class PartialFailure(RuntimeError):
    pass


def validate_provenance(candidate: Candidate, documents: list[dict[str, Any]]) -> None:
    """Reject invalid checkpoints before they can be reused by a later attempt."""
    pinned = {(d["assetId"], d["assetVersion"]) for d in documents}
    document_ids = {d["assetId"] for d in documents}
    for key, value in candidate.fields.model_dump().items():
        sources = cast(list[Source], getattr(candidate.fieldSources, key))
        if value and not sources:
            raise ValueError("field has no document provenance")
        for source in sources:
            if (
                (source.assetId, source.assetVersion) not in pinned
                or not source.location.strip()
                or len(source.location) > 1000
            ):
                raise ValueError("source is outside the pinned document input")
        if key == "sellingPoints":
            indices = {s.itemIndex for s in sources}
            if any(
                not point.strip() or len(point) > 10000 for point in value
            ) or indices != set(range(len(value))):
                raise ValueError("selling point provenance indices are invalid")
        elif len(value) > 50000:
            raise ValueError("field exceeds the contract limit")
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
            raise ValueError("issue identifiers or document references are invalid")
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
                        await self.api.upload(doc["assetId"], parsed)
                        output: Any = {"parsed": True}
                    else:
                        text = (
                            await self.api.content(doc["assetId"], parsed=True)
                        ).decode("utf-8")
                        candidate = template_candidate(text, doc)
                        if candidate is None:
                            chunks = split_document_markdown(
                                text, max_chars=self.chunk_chars
                            )
                            values = []
                            for index, chunk in enumerate(chunks):
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
                                values.append(
                                    await self.provider.generate(
                                        node,
                                        "提取本段资料中的12个信息字段；空字段保持空字符串或空数组。",
                                        content,
                                        Candidate,
                                    )
                                )
                            candidate = combine_chunks(values)
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
                except Exception:
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
            if len(candidates) == 1:
                fused = candidates[0]
            else:
                # Hierarchical merge bounds each request while retaining every input document.
                fused = candidates[0]
                for candidate in candidates[1:]:
                    fused = await self.provider.generate(
                        node,
                        "合并两份信息卡，完整保留独立事实和来源；相互矛盾的文本字段列入 issues，blocking=true。不要把不同段落补充误判为冲突。",
                        json.dumps(
                            [fused.model_dump(), candidate.model_dump()],
                            ensure_ascii=False,
                        ),
                        Candidate,
                    )
            validate_provenance(fused, self.input["documents"])
            await self.checkpoint(node, "", fused.model_dump())
        elif node == "SEMANTIC_REFINEMENT":
            candidate = Candidate.model_validate(self.checkpoints[("FUSION", "")])
            review = await self.provider.generate(
                node,
                "核对品牌/产品混淆、无依据断言、资料歧义或无法确定的产品身份。仅返回待确认 issues；正常项不创建提示，不改写原始事实。不强制补齐空字段。",
                candidate.model_dump_json(),
                Review,
            )
            existing = {i.id for i in candidate.issues}
            candidate.issues.extend(i for i in review.issues if i.id not in existing)
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
                try:
                    await self.stage(node_id)
                except PartialFailure:
                    raise
                except Exception:
                    await self.checkpoint(node_id, "", {}, "FAILED")
                    raise
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
