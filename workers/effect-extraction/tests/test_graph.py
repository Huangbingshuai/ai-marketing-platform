from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import pytest

from effect_extraction.graph import build_graph
from effect_extraction.models import RuntimeContext


@dataclass
class RecordingPipeline:
    finished: set[str] = field(default_factory=set)

    async def snapshot(self, project_id: str, context: RuntimeContext) -> None:
        assert project_id == "project-1"

    async def document_branch(self, context: RuntimeContext) -> None:
        await asyncio.sleep(0.04)
        self.finished.add("documents")

    async def image_branch(self, context: RuntimeContext) -> None:
        await asyncio.sleep(0.01)
        self.finished.add("images")

    async def commerce_branch(self, context: RuntimeContext) -> None:
        self.finished.add("commerce")

    async def form_branch(self, context: RuntimeContext) -> None:
        self.finished.add("form")

    async def fuse_sources(self, context: RuntimeContext) -> None:
        assert self.finished == {"documents", "images", "commerce", "form"}
        self.finished.add("fusion")

    async def normalize_and_finalize(self, context: RuntimeContext) -> str:
        assert "fusion" in self.finished
        return "result-1"


@pytest.mark.asyncio
async def test_graph_waits_for_all_branches_and_exposes_only_result_id() -> None:
    pipeline = RecordingPipeline()
    graph = build_graph(pipeline)  # type: ignore[arg-type]
    result = await graph.ainvoke(
        {"project_id": "project-1"},
        context=RuntimeContext(
            run_id="run-1",
            project_id="project-1",
            draft_id="draft-1",
            product_id="product-1",
            request_id="request-1",
            attempt_token="attempt-1",
            source_fingerprint="fingerprint-1",
        ),
    )
    assert result == {"extract_result_id": "result-1"}
    assert "project_id" not in result
