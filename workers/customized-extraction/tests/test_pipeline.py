from __future__ import annotations

import json
import asyncio
from pathlib import Path
from typing import Any, TypeVar, cast
from uuid import uuid4

import pytest
from pydantic import BaseModel, ValidationError

from customized_extraction.documents import template_candidate, combine_chunks
from customized_extraction.models import (
    Candidate,
    Brief,
    LABELS,
    NODES,
    QueueMessage,
    Review,
    Issue,
    AuditReport,
    RepairContext,
    RawAuditReport,
    ConflictAlternatives,
    ConflictFieldPlan,
    ConflictPlanReview,
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
        self.parsed: dict[str, bytes] = {DOC["assetId"]: TEXT.encode()}
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
        if model in (AuditReport, RawAuditReport):
            assert "虚构认证示例" not in content
            return model.model_validate({"checkedFields": list(LABELS), "findings": []})
        if model is Review:
            return model.model_validate({"issues": []})
        if model is RepairContext:
            return model.model_validate({"facts": []})
        if model is ConflictFieldPlan:
            payload = json.loads(content)
            return model.model_validate(
                {
                    "decisions": [
                        {
                            "id": issue["id"],
                            "kind": "CONFLICT",
                            "reason": "受控净含量冲突",
                            "anchor": payload["currentValue"],
                            "choices": [
                                {"replacement": value}
                                for value in [
                                    "200g，保质期12个月",
                                    "250g，保质期12个月",
                                ]
                            ],
                        }
                        for issue in payload["issues"]
                    ]
                }
            )
        if model is ConflictPlanReview:
            return model.model_validate(
                {
                    "verdicts": [
                        {
                            "id": decision["id"],
                            "valid": True,
                            "reason": "受控原文核对通过",
                        }
                        for field in json.loads(content)
                        for decision in field["plan"]["decisions"]
                    ]
                }
            )
        if model is ConflictAlternatives:
            return model.model_validate(
                {
                    "commonFacts": [],
                    "choices": [
                        {"conflictingFacts": [value]}
                        for value in json.loads(content)["issue"]["alternatives"]
                    ],
                }
            )
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
    assert provider.calls == ["SEMANTIC_REFINEMENT", "SEMANTIC_REFINEMENT"]
    assert [api.steps[n, ""]["status"] for n in NODES] == ["SUCCEEDED"] * 6
    assert set(api.downloads) == {DOC["assetId"]}
    assert max(api.progress) >= 80


@pytest.mark.asyncio
async def test_legacy_form_is_mapped_by_model_using_only_entered_values() -> None:
    class LegacyProvider(FakeProvider):
        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            if stage == "DOCUMENT_EXTRACT":
                self.calls.append(stage)
                assert "品牌或产品介绍" in content
                assert "青梅果肉" in content
                assert "虚构认证示例" not in content
                candidate = template_candidate(TEXT, DOC)
                assert candidate is not None
                return model.model_validate(candidate.model_dump())
            return await super().generate(stage, instruction, content, model)

    api, provider = FakeApi(), LegacyProvider()
    api.raw[DOC["assetId"]] = (
        "| 填写项 | 填写内容 | 备注 / 示例 |\n"
        "| 项目名称 | 青梅酱短片 | 虚构认证示例 |\n"
        "| 品牌或产品介绍 | 青梅果肉 | 虚构认证示例 |"
    ).encode()
    doc = {**DOC, "sizeBytes": len(api.raw[DOC["assetId"]])}
    await pipeline(api, provider, [doc]).run()
    assert api.completed is not None
    assert provider.calls == [
        "DOCUMENT_EXTRACT",
        "SEMANTIC_REFINEMENT",
        "SEMANTIC_REFINEMENT",
    ]


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
    assert api.downloads.count(first["assetId"]) == 2


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
    assert provider.calls == []


@pytest.mark.asyncio
async def test_chunks_run_with_global_bound_and_keep_input_order() -> None:
    class ConcurrentProvider(FakeProvider):
        def __init__(self) -> None:
            super().__init__()
            self.active = 0
            self.peak = 0

        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            if stage != "DOCUMENT_EXTRACT":
                return await super().generate(stage, instruction, content, model)
            payload = json.loads(content)
            if isinstance(payload, list):
                return model.model_validate(
                    combine_chunks(
                        [Candidate.model_validate(v) for v in payload]
                    ).model_dump()
                )
            index = payload["chunk"]
            self.active += 1
            self.peak = max(self.peak, self.active)
            await asyncio.sleep(0.02 if index % 2 else 0.005)
            self.active -= 1
            value = template_candidate(TEXT, DOC)
            assert value
            value.fields.sellingPoints = [f"独立事实{index}"]
            value.fieldSources.sellingPoints = [value.fieldSources.sellingPoints[0]]
            return model.model_validate(value.model_dump())

    api, provider = FakeApi(), ConcurrentProvider()
    api.raw[DOC["assetId"]] = ("自由文档段落，不是标准表格。\n\n" * 5).encode()
    doc = {**DOC, "sizeBytes": len(api.raw[DOC["assetId"]])}
    execution = pipeline(api, provider, [doc])
    execution.chunk_chars = 20
    await execution.run()
    assert provider.peak == 2
    assert provider.active == 0
    assert api.completed
    assert api.completed["fields"]["sellingPoints"] == [
        f"独立事实{i}" for i in range(1, 6)
    ]


@pytest.mark.asyncio
async def test_balanced_fusion_keeps_all_documents_with_bounded_calls() -> None:
    class MergeProvider(FakeProvider):
        active = 0
        peak = 0
        merges = 0

        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            assert stage == "FUSION"
            self.active += 1
            self.peak = max(self.peak, self.active)
            self.merges += 1
            await asyncio.sleep(0.005)
            self.active -= 1
            return model.model_validate(
                combine_chunks(
                    [Candidate.model_validate(v) for v in json.loads(content)]
                ).model_dump()
            )

    api, provider = FakeApi(), MergeProvider()
    docs = [{**DOC, "assetId": str(uuid4())} for _ in range(4)]
    checkpoints = []
    for index, doc in enumerate(docs):
        candidate = template_candidate(TEXT.replace("青梅酱", f"产品{index}"), doc)
        assert candidate
        checkpoints.append(
            {
                "nodeId": "DOCUMENT_EXTRACT",
                "sourceId": doc["assetId"],
                "output": candidate.model_dump(),
            }
        )
    execution = pipeline(api, provider, docs, checkpoints)
    await execution.stage("FUSION")
    assert provider.peak == 2
    assert provider.merges == 3
    fused = Candidate.model_validate(execution.checkpoints["FUSION", ""])
    assert {s.assetId for s in fused.fieldSources.productName} == {
        d["assetId"] for d in docs
    }


@pytest.mark.asyncio
async def test_blank_companion_does_not_trigger_paid_fusion() -> None:
    api, provider = FakeApi(), FakeProvider()
    first = {**DOC, "sizeBytes": len(api.raw[DOC["assetId"]])}
    second = {**DOC, "assetId": str(uuid4())}
    api.raw[second["assetId"]] = (
        "| 填写项 | 填写内容 | 示例 |\n| 产品名称 | | 示例产品 |".encode()
    )
    second["sizeBytes"] = len(api.raw[second["assetId"]])
    await pipeline(api, provider, [first, second]).run()
    assert provider.calls == ["SEMANTIC_REFINEMENT", "SEMANTIC_REFINEMENT"]
    assert api.completed and api.completed["fields"]["productName"] == "青梅酱"


@pytest.mark.asyncio
async def test_review_can_complete_existing_conflict_candidates_without_duplicating_issue() -> (
    None
):
    candidate = template_candidate(TEXT, DOC)
    assert candidate
    original = Issue(
        id="weight",
        field="productSpecifications",
        message="净含量冲突",
        sourceIds=[DOC["assetId"]],
        alternatives=["200g，保质期12个月", "250g"],
        blocking=True,
    )
    candidate.issues = [original]
    document_candidate = candidate.model_copy(deep=True)
    document_candidate.fields.productSpecifications = "200g，保质期12个月"
    document_candidate.fieldSources.productSpecifications = (
        document_candidate.fieldSources.productName
    )
    repaired = original.model_copy(
        update={"alternatives": ["200g，保质期12个月", "250g，保质期12个月"]}
    )

    class ReviewProvider(FakeProvider):
        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            assert stage == "SEMANTIC_REFINEMENT"
            if model in (
                AuditReport,
                RawAuditReport,
                RepairContext,
                ConflictAlternatives,
                ConflictFieldPlan,
                ConflictPlanReview,
            ):
                return await super().generate(stage, instruction, content, model)
            assert (
                json.loads(content)["documentCandidates"][0]["fields"][
                    "productSpecifications"
                ]
                == "200g，保质期12个月"
            )
            return model.model_validate({"issues": [repaired.model_dump()]})

    execution = pipeline(
        FakeApi(),
        ReviewProvider(),
        [DOC],
        [
            {"nodeId": "FUSION", "sourceId": "", "output": candidate.model_dump()},
            {
                "nodeId": "DOCUMENT_EXTRACT",
                "sourceId": DOC["assetId"],
                "output": document_candidate.model_dump(),
            },
        ],
    )
    await execution.stage("SEMANTIC_REFINEMENT")
    reviewed = Candidate.model_validate(
        {
            key: execution.checkpoints["SEMANTIC_REFINEMENT", ""][key]
            for key in ("fields", "fieldSources", "issues")
        }
    )
    assert len(reviewed.issues) == 1
    assert reviewed.issues[0].id == repaired.id
    assert reviewed.issues[0].alternatives == repaired.alternatives
    assert reviewed.issues[0].resolution is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "decision,remaining,invalid",
    [
        ({"issues": [], "dismissedIssueIds": ["name-alias"]}, 1, False),
        ({"issues": []}, 2, True),
        ({"issues": [], "dismissedIssueIds": ["unknown"]}, 1, True),
        ({"issues": [], "dismissedIssueIds": ["name-alias", "name-alias"]}, 1, True),
    ],
)
async def test_review_requires_explicit_valid_decision_to_dismiss_conflict(
    decision: dict[str, Any],
    remaining: int,
    invalid: bool,
) -> None:
    candidate = template_candidate(TEXT, DOC)
    assert candidate
    candidate.issues = [
        Issue(
            id="name-alias",
            field="productName",
            message="名称记录不同",
            sourceIds=[DOC["assetId"]],
            alternatives=["弧电G65氮化镓充电器", "弧电G65"],
            blocking=True,
        )
    ]
    weight = Issue(
        id="real-weight-conflict",
        field="productSpecifications",
        message="净含量冲突",
        sourceIds=[DOC["assetId"]],
        alternatives=["200g，保质期12个月", "250g，保质期12个月"],
        blocking=True,
    )
    candidate.issues.append(weight)
    if decision.get("dismissedIssueIds") == ["name-alias"]:
        decision = {**decision, "issues": [weight.model_dump()]}

    class DecisionProvider(FakeProvider):
        async def generate(
            self,
            stage: str,
            instruction: str,
            content: str,
            model: type[T],
        ) -> T:
            if model in (
                AuditReport,
                RawAuditReport,
                RepairContext,
                ConflictAlternatives,
                ConflictFieldPlan,
                ConflictPlanReview,
            ):
                return await super().generate(stage, instruction, content, model)
            return model.model_validate(decision)

    execution = pipeline(
        FakeApi(),
        DecisionProvider(),
        [DOC],
        [
            {"nodeId": "FUSION", "sourceId": "", "output": candidate.model_dump()},
            {
                "nodeId": "DOCUMENT_EXTRACT",
                "sourceId": DOC["assetId"],
                "output": candidate.model_dump(),
            },
        ],
    )
    if invalid:
        with pytest.raises(
            ValueError, match="dismissed issue identifiers|cover all existing issues"
        ):
            await execution.stage("SEMANTIC_REFINEMENT")
        assert ("SEMANTIC_REFINEMENT", "") not in execution.checkpoints
    else:
        await execution.stage("SEMANTIC_REFINEMENT")
        actual = Candidate.model_validate(
            {
                key: execution.checkpoints["SEMANTIC_REFINEMENT", ""][key]
                for key in ("fields", "fieldSources", "issues")
            }
        )
        assert len(actual.issues) == remaining
        assert actual.issues[0].id == weight.id
        assert actual.issues[0].alternatives == weight.alternatives
        assert actual.fields == candidate.fields
