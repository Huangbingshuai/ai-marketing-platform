from __future__ import annotations

import asyncio
from copy import deepcopy
from pathlib import Path
from typing import Any, TypeVar, cast

import pytest
from pydantic import BaseModel

from customized_extraction.activity import SemanticActivity, STEPS
from customized_extraction.models import Candidate, Review
from customized_extraction.pipeline import PartialFailure
from customized_extraction.quality import audit_document
from customized_extraction.provider import Provider
from customized_extraction.documents import template_candidate
from test_pipeline import DOC, TEXT, FakeApi, FakeProvider, pipeline

T = TypeVar("T", bound=BaseModel)


class RecordingApi(FakeApi):
    def __init__(self) -> None:
        super().__init__()
        self.history: list[dict[str, Any]] = []

    async def call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        if path == "steps":
            assert body is not None
            self.history.append(deepcopy(body))
        return await super().call(method, path, body)


def test_activity_step_identifiers_match_contract() -> None:
    contract = (Path(__file__).parents[3] / "packages/contracts/src/customized-extraction.ts").read_text(encoding="utf-8")
    for step in STEPS:
        assert f"{step}: '" in contract


async def test_running_review_has_completed_audit_and_explicit_skips_before_model_returns() -> None:
    entered, release = asyncio.Event(), asyncio.Event()

    class PausedProvider(FakeProvider):
        async def generate(self, stage: str, instruction: str, content: str, model: type[T]) -> T:
            if model is Review:
                entered.set()
                await release.wait()
            return await super().generate(stage, instruction, content, model)

    api, provider = RecordingApi(), PausedProvider()
    doc = {**DOC, "sizeBytes": len(api.raw[DOC["assetId"]])}
    run = asyncio.create_task(pipeline(api, provider, [doc]).run())
    try:
        await asyncio.wait_for(entered.wait(), 5)
        current = api.steps["SEMANTIC_REFINEMENT", ""]
        assert current["status"] == "RUNNING"
        states = {s["id"]: s for s in current["output"]["activity"]["steps"]}
        assert states["RAW_AUDIT"] == {"id": "RAW_AUDIT", "status": "SUCCEEDED", "completed": 1, "total": 1, "unit": "DOCUMENT"}
        assert states["EVIDENCE_RECHECK"]["status"] == "SKIPPED"
        assert states["TARGETED_REPAIR"]["status"] == "SKIPPED"
        assert states["FINAL_REVIEW"]["status"] == "RUNNING"
        assert api.completed is None
    finally:
        release.set()
        await run
    assert api.completed is not None
    final = api.steps["SEMANTIC_REFINEMENT", ""]["output"]
    assert final["activity"]["steps"][-1]["status"] == "SKIPPED"
    assert Candidate.model_validate(api.completed).fields.productName == "青梅酱"
    assert provider.calls == ["SEMANTIC_REFINEMENT", "SEMANTIC_REFINEMENT"]


async def test_failed_final_review_keeps_actual_completed_work() -> None:
    class BrokenProvider(FakeProvider):
        async def generate(self, stage: str, instruction: str, content: str, model: type[T]) -> T:
            if model is Review:
                raise RuntimeError("controlled failure")
            return await super().generate(stage, instruction, content, model)

    api = RecordingApi()
    doc = {**DOC, "sizeBytes": len(api.raw[DOC["assetId"]])}
    with pytest.raises(RuntimeError, match="controlled failure"):
        await pipeline(api, BrokenProvider(), [doc]).run()
    final = api.steps["SEMANTIC_REFINEMENT", ""]
    assert final["status"] == "FAILED"
    states = {s["id"]: s["status"] for s in final["output"]["activity"]["steps"]}
    assert states["RAW_AUDIT"] == "SUCCEEDED"
    assert states["FINAL_REVIEW"] == "FAILED"
    assert states["CONFLICT_COMPLETION"] == "PENDING"
    assert api.completed is None


async def test_partial_audit_keeps_counts_and_is_not_cached_as_success() -> None:
    class BrokenProvider(FakeProvider):
        async def generate(self, stage: str, instruction: str, content: str, model: type[T]) -> T:
            if model is not Review:
                raise RuntimeError("controlled audit failure")
            return await super().generate(stage, instruction, content, model)

    api = RecordingApi()
    doc = {**DOC, "sizeBytes": len(api.raw[DOC["assetId"]])}
    worker = pipeline(api, BrokenProvider(), [doc])
    with pytest.raises(PartialFailure):
        await worker.run()
    final = api.steps["SEMANTIC_REFINEMENT", ""]
    assert final["status"] == "PARTIAL"
    assert final["output"]["activity"]["steps"][0]["status"] == "FAILED"
    assert api.steps["SEMANTIC_REFINEMENT", DOC["assetId"]]["output"]["auditProgress"] == {"completed": 0, "total": 1}
    assert ("SEMANTIC_REFINEMENT", "") not in worker.checkpoints


async def test_chunk_counts_are_published_only_after_validated_model_results() -> None:
    entered, release = asyncio.Event(), asyncio.Event()
    text = "\n\n".join("原文事实" * 100 for _ in range(5))
    progress: list[tuple[int, int]] = []

    class PausedProvider(FakeProvider):
        async def generate(self, stage: str, instruction: str, content: str, model: type[T]) -> T:
            entered.set()
            await release.wait()
            return await super().generate(stage, instruction, content, model)

    async def report(completed: int, total: int) -> None:
        progress.append((completed, total))

    candidate = template_candidate(TEXT, DOC)
    assert candidate is not None
    run = asyncio.create_task(audit_document(cast(Provider, PausedProvider()), asyncio.Semaphore(2), DOC, text, candidate, candidate, 500, report))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert len(progress) == 1 and progress[0][0] == 0 and progress[0][1] > 1
    finally:
        release.set()
        _, count = await run
    assert progress == [(i, count) for i in range(count + 1)]


async def test_concurrent_activity_writes_are_serialized_and_snapshots_are_immutable() -> None:
    saved: list[dict[str, Any]] = []
    active, peak = 0, 0

    async def save(output: dict[str, Any], status: str) -> None:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0)
        saved.append(output)
        active -= 1

    activity = SemanticActivity(save)
    counter = activity.counter("EVIDENCE_RECHECK", "CHUNK")
    await asyncio.gather(*(counter(i, 3) for i in range(4)))
    await activity.set("EVIDENCE_RECHECK", "SUCCEEDED")
    assert peak == 1
    assert [s["activity"]["steps"][1]["completed"] for s in saved[:4]] == [0, 1, 2, 3]
    assert saved[0]["activity"]["steps"][1]["status"] == "RUNNING"
