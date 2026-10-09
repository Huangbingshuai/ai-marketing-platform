from __future__ import annotations

import json
from pathlib import Path
from typing import Any, TypeVar, cast
from uuid import uuid4

import pytest
from pydantic import BaseModel, ValidationError

from customized_extraction.documents import template_candidate
from customized_extraction.models import (
    Candidate,
    Brief,
    LABELS,
    NODES,
    QueueMessage,
    Review,
)
from customized_extraction.pipeline import Pipeline, PartialFailure, validate_provenance
from customized_extraction.api import Api
from customized_extraction.provider import Provider
from extraction_runtime.docling_parser import LocalDoclingParser

T = TypeVar("T", bound=BaseModel)
DOC: dict[str, Any] = {
    "assetId": str(uuid4()),
    "assetVersion": 1,
    "name": "简报.txt",
    "sizeBytes": 1,
}
TEXT = "| 填写项 | 填写内容 | 备注 / 示例 |\n| --- | --- | --- |\n| 产品名称 | 青梅酱 | 示例产品 |\n| 品牌名称 | 梅间 | 示例品牌 |\n| 核心卖点 | 清爽青梅香<br>果肉质感 | 虚构认证示例 |"


class FakeApi:
    task_id = str(uuid4())

    def __init__(self) -> None:
        self.raw: dict[str, bytes] = {DOC["assetId"]: TEXT.encode()}
        self.parsed: dict[str, bytes] = {}
        self.steps: dict[tuple[str, str], dict[str, Any]] = {}
        self.progress: list[int] = []
        self.completed: dict[str, Any] | None = None
        self.downloads: list[str] = []

    async def content(self, source_id: str, parsed: bool = False) -> bytes:
        self.downloads.append(source_id)
        return (self.parsed if parsed else self.raw)[source_id]

    async def upload(self, source_id: str, text: str) -> None:
        self.parsed[source_id] = text.encode()

    async def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> Any:
        assert body is not None
        if path == "steps":
            self.steps[body["nodeId"], body["sourceId"]] = body
        elif path == "progress":
            self.progress.append(body["progress"])
        elif path == "complete":
            self.completed = body["candidate"]
        return {}


class FakeProvider:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def generate(
        self, stage: str, instruction: str, content: str, model: type[T]
    ) -> T:
        self.calls.append(stage)
        assert "brandReferences" not in content
        if model is Review:
            return model.model_validate({"issues": []})
        if stage == "FUSION":
            return model.model_validate(json.loads(content)[0])
        raise AssertionError("standard template must not send examples to model")


def pipeline(
    api: FakeApi,
    provider: FakeProvider,
    documents: list[dict[str, Any]],
    checkpoints: list[dict[str, Any]] | None = None,
) -> Pipeline:
    parser = LocalDoclingParser(
        artifacts_path=None, max_file_size=100000, max_num_pages=5
    )
    return Pipeline(
        cast(Api, api),
        parser,
        cast(Provider, provider),
        {"documents": documents, "brandReferences": [{"assetId": "brand-image"}]},
        checkpoints or [],
    )


def test_template_uses_only_filled_column_and_preserves_each_selling_point() -> None:
    candidate = template_candidate(TEXT, DOC)
    assert candidate is not None
    assert candidate.fields.productName == "青梅酱"
    assert candidate.fields.sellingPoints == ["清爽青梅香", "果肉质感"]
    assert candidate.fields.productSpecifications == ""
    assert "虚构认证" not in candidate.model_dump_json()
    assert [s.itemIndex for s in candidate.fieldSources.sellingPoints] == [0, 1]
    assert all(
        s.assetId == DOC["assetId"] for s in candidate.fieldSources.sellingPoints
    )


@pytest.mark.parametrize("broken", ["asset", "version", "location", "selling_index"])
def test_invalid_provenance_is_not_a_reusable_successful_checkpoint(
    broken: str,
) -> None:
    candidate = template_candidate(TEXT, DOC)
    assert candidate is not None
    source = candidate.fieldSources.sellingPoints[0]
    if broken == "asset":
        source.assetId = "brand-image"
    elif broken == "version":
        source.assetVersion = 2
    elif broken == "location":
        source.location = " "
    else:
        source.itemIndex = 10
    with pytest.raises(ValueError):
        validate_provenance(candidate, [DOC])


def test_wire_fields_and_graph_match_typescript_contract() -> None:
    contract = (
        Path(__file__).parents[3] / "packages/contracts/src/customized-extraction.ts"
    ).read_text(encoding="utf-8")
    assert set(Brief.model_fields) == set(LABELS)
    for key, label in LABELS.items():
        assert f"{key}: '{label}'" in contract
    for node in NODES:
        assert f"id: '{node}'" in contract


def test_queue_rejects_missing_scope_and_invalid_identifiers() -> None:
    with pytest.raises(ValidationError):
        QueueMessage.model_validate({"schemaVersion": 1, "runId": "not-a-uuid"})


@pytest.mark.asyncio
async def test_linear_graph_saves_every_stage_and_never_reads_brand_image() -> None:
    api, provider = FakeApi(), FakeProvider()
    doc = {**DOC, "sizeBytes": len(api.raw[DOC["assetId"]])}
    await pipeline(api, provider, [doc]).run()
    assert api.completed is not None
    assert Candidate.model_validate(api.completed).fields.productName == "青梅酱"
    assert provider.calls == ["SEMANTIC_REFINEMENT"]
    assert [api.steps[n, ""]["status"] for n in NODES] == ["SUCCEEDED"] * 6
    assert set(api.downloads) == {DOC["assetId"]}
    assert max(api.progress) >= 80


@pytest.mark.asyncio
async def test_partial_failure_retains_success_and_retry_uses_same_snapshot_checkpoints() -> (
    None
):
    api, provider = FakeApi(), FakeProvider()
    first = {**DOC, "sizeBytes": len(api.raw[DOC["assetId"]])}
    second = {**first, "assetId": str(uuid4())}
    with pytest.raises(PartialFailure):
        await pipeline(api, provider, [first, second]).run()
    assert api.completed is None
    assert api.steps["DOCUMENT_PARSE", first["assetId"]]["status"] == "SUCCEEDED"
    checkpoints = [s for s in api.steps.values() if s["status"] == "SUCCEEDED"]
    api.raw[second["assetId"]] = TEXT.encode()
    api.downloads.clear()
    await pipeline(api, provider, [first, second], checkpoints).run()
    assert api.completed is not None
    # First document is read only as parsed text, never downloaded/reparsed again.
    assert api.downloads.count(first["assetId"]) == 1


@pytest.mark.asyncio
async def test_empty_template_is_not_completed_with_example_facts() -> None:
    api, provider = FakeApi(), FakeProvider()
    api.raw[DOC["assetId"]] = b"| filling | column |"
    empty = "| 填写项 | 填写内容 | 备注 / 示例 |\n| 产品名称 | | 青梅酱 |"
    api.raw[DOC["assetId"]] = empty.encode()
    doc = {**DOC, "sizeBytes": len(api.raw[DOC["assetId"]])}
    with pytest.raises(ValueError, match="empty template"):
        await pipeline(api, provider, [doc]).run()
    assert api.completed is None
    assert api.steps["NORMALIZATION", ""]["status"] == "FAILED"
