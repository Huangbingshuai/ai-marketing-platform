from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock
from types import SimpleNamespace
from pathlib import Path
from typing import Any, TypeVar, cast

import pytest
from pydantic import BaseModel, ValidationError

from customized_extraction.models import (
    AuditReport,
    BriefField,
    Candidate,
    LABELS,
    RepairContext,
    RawAuditReport,
    ConflictAlternatives,
)
from customized_extraction.pipeline import validate_provenance, PartialFailure
from customized_extraction.provider import Provider
from customized_extraction.quality import (
    audit_document,
    collect_repair_context,
    review_candidate,
    complete_conflict_alternatives,
    repair_candidate,
    validate_audit,
)
from test_pipeline import DOC, TEXT, FakeApi, FakeProvider, pipeline
from customized_extraction.documents import template_candidate

T = TypeVar("T", bound=BaseModel)


def report(**changes: Any) -> AuditReport:
    finding = {
        "field": "productSpecifications",
        "kind": "MISSING",
        "description": "首轮遗漏净含量",
        "proposedValue": "净含量220g",
        "itemIndex": None,
        "evidence": {
            "assetId": DOC["assetId"],
            "assetVersion": 1,
            "location": "产品规格补充",
            "quote": "净含量220g",
        },
    }
    finding.update(changes)
    return AuditReport.model_validate(
        {"checkedFields": list(LABELS), "findings": [finding]}
    )


def candidate() -> Candidate:
    value = template_candidate(TEXT, DOC)
    assert value is not None
    return value


@pytest.mark.parametrize(
    "broken", ["quote", "asset", "version", "index", "fields", "missingIndex"]
)
def test_audit_rejects_unverifiable_evidence_or_incomplete_review(broken: str) -> None:
    value = report()
    if broken == "quote":
        value.findings[0].evidence.quote = "不存在的认证"
    elif broken == "asset":
        value.findings[0].evidence.assetId = "other-project"
    elif broken == "version":
        value.findings[0].evidence.assetVersion = 2
    elif broken == "index":
        value.findings[0].itemIndex = 50
    elif broken == "missingIndex":
        value.findings[0].field = "sellingPoints"
        value.findings[0].kind = "INCORRECT"
    else:
        value.checkedFields.pop()
    with pytest.raises(ValueError):
        validate_audit(value, DOC, "净含量 220g", candidate())


def test_audit_schema_rejects_unknown_field_and_unknown_finding_kind() -> None:
    for changes in [{"field": "videoDuration"}, {"kind": "CREATIVE"}]:
        with pytest.raises(ValidationError):
            report(**changes)
    contract = (
        Path(__file__).parents[3] / "packages/contracts/src/customized-extraction.ts"
    ).read_text(encoding="utf-8")
    for field in AuditReport.model_json_schema()["$defs"]["AuditFinding"]["properties"]:
        assert f"{field}:" in contract
    assert set(
        AuditReport.model_json_schema()["$defs"]["AuditFinding"]["properties"]["field"][
            "enum"
        ]
    ) == set(LABELS)


def test_raw_review_sees_original_and_repairs_first_pass_omission() -> None:
    class OmissionProvider(FakeProvider):
        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            payload = json.loads(content)
            if model is RepairContext:
                return model.model_validate(
                    {
                        "facts": [
                            {
                                "field": "productSpecifications",
                                "fact": "净含量220g",
                                "lineNumbers": [
                                    line["lineNumber"]
                                    for line in payload["lines"]
                                    if "净含量220g" in line["text"]
                                ],
                            }
                        ]
                    }
                )
            if model is RawAuditReport:
                matching = [
                    line["lineNumber"]
                    for line in payload["lines"]
                    if "净含量220g" in line["text"]
                ]
                assert matching
                assert (
                    payload["globalCandidate"]["fields"]["productSpecifications"] == ""
                )
                return model.model_validate(
                    {
                        "checkedFields": list(LABELS),
                        "findings": [
                            {
                                **report().findings[0].model_dump(exclude={"evidence"}),
                                "lineNumbers": matching,
                            }
                        ],
                    }
                )
            if model is Candidate:
                data = payload["candidate"]
                data["fields"]["productSpecifications"] = "净含量220g"
                data["fieldSources"]["productSpecifications"] = [
                    {
                        **report().findings[0].evidence.model_dump(exclude={"quote"}),
                        "itemIndex": None,
                    }
                ]
                return model.model_validate(data)
            assert (
                "净含量220g" in payload["verifiedRawFindings"][0]["evidence"]["quote"]
            )
            assert "优先于" in instruction
            return model.model_validate({"issues": []})

    async def run() -> None:
        api = FakeApi()
        api.parsed[DOC["assetId"]] = (TEXT + "\n产品规格补充：净含量220g").encode()
        c = candidate()
        checkpoints = [
            {
                "nodeId": "DOCUMENT_EXTRACT",
                "sourceId": DOC["assetId"],
                "output": c.model_dump(),
            },
            {"nodeId": "FUSION", "sourceId": "", "output": c.model_dump()},
        ]
        task = pipeline(api, OmissionProvider(), [DOC], checkpoints)
        await task.stage("SEMANTIC_REFINEMENT")
        await task.stage("NORMALIZATION")
        output = task.checkpoints[("NORMALIZATION", "")]
        assert output["fields"]["productSpecifications"] == "净含量220g"
        assert output["fields"]["sellingPoints"] == c.fields.sellingPoints
        assert task.checkpoints[("SEMANTIC_REFINEMENT", "")]["auditSummary"] == {
            "schemaVersion": 1,
            "documentCount": 1,
            "chunkCount": 1,
            "findingCount": 1,
            "correctedFields": ["productSpecifications"],
        }

    asyncio.run(run())


@pytest.mark.parametrize("change", ["brand", "sellingPoint"])
def test_repair_cannot_rewrite_unaffected_facts(change: str) -> None:
    class BadRepair(FakeProvider):
        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            data = json.loads(content)["candidate"]
            if change == "brand":
                data["fields"]["brandName"] = "其他品牌"
            else:
                data["fields"]["sellingPoints"].pop()
            return model.model_validate(data)

    async def run() -> None:
        with pytest.raises(ValueError):
            await repair_candidate(
                cast(Provider, BadRepair()),
                asyncio.Semaphore(2),
                validate_provenance,
                candidate(),
                report(),
                [DOC],
            )

    asyncio.run(run())


def test_completed_raw_audit_is_reused_after_retry_and_old_aggregate_cannot_skip_it() -> (
    None
):
    async def run() -> None:
        api = FakeApi()
        c = candidate()
        checkpoints = [
            {
                "nodeId": "DOCUMENT_EXTRACT",
                "sourceId": DOC["assetId"],
                "output": c.model_dump(),
            },
            {"nodeId": "FUSION", "sourceId": "", "output": c.model_dump()},
            {"nodeId": "SEMANTIC_REFINEMENT", "sourceId": "", "output": c.model_dump()},
            {"nodeId": "NORMALIZATION", "sourceId": "", "output": c.model_dump()},
            {
                "nodeId": "SEMANTIC_REFINEMENT",
                "sourceId": DOC["assetId"],
                "output": {
                    "auditReport": {"checkedFields": list(LABELS), "findings": []},
                    "chunkCount": 1,
                },
            },
        ]
        provider = FakeProvider()
        task = pipeline(api, provider, [DOC], checkpoints)
        assert ("NORMALIZATION", "") not in task.checkpoints
        await task.stage("SEMANTIC_REFINEMENT")
        assert provider.calls == [
            "SEMANTIC_REFINEMENT"
        ]  # only final review, raw audit checkpoint reused
        assert (
            task.checkpoints[("SEMANTIC_REFINEMENT", "")]["auditSummary"][
                "documentCount"
            ]
            == 1
        )

    asyncio.run(run())


def test_audit_visits_all_long_document_chunks_under_bounded_concurrency() -> None:
    class Counting(FakeProvider):
        active = 0
        peak = 0
        chunks: list[int] = []

        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            self.active += 1
            self.peak = max(self.peak, self.active)
            self.chunks.append(json.loads(content)["chunk"])
            await asyncio.sleep(0.001)
            self.active -= 1
            return model.model_validate({"checkedFields": list(LABELS), "findings": []})

    async def run() -> None:
        provider = Counting()
        value, count = await audit_document(
            cast(Provider, provider),
            asyncio.Semaphore(2),
            DOC,
            "\n\n".join("资料段落" * 30 for _ in range(10)),
            candidate(),
            candidate(),
            250,
        )
        assert count >= 5
        assert provider.peak == 2
        assert provider.chunks == list(range(1, count + 1))
        assert set(value.checkedFields) == set(cast(list[BriefField], list(LABELS)))

    asyncio.run(run())


def test_provider_enables_reasoning_and_larger_truncation_retry_budget() -> None:
    async def run() -> None:
        provider = Provider("https://example.invalid", "test-key", "controlled-model")
        request = AsyncMock(return_value=SimpleNamespace(value=candidate()))
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(provider, "_structured", request)
            await provider.generate("SEMANTIC_REFINEMENT", "审校", "{}", Candidate)
        options = request.call_args.kwargs
        assert options["reasoning_effort"] == "medium"
        assert options["max_output_tokens"] == 16384
        assert options["retry_max_output_tokens"] == 32768
        assert options["request_timeout"] == 300
        request.reset_mock()
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(provider, "_structured", request)
            await provider.generate(
                "SEMANTIC_REFINEMENT", "原文审校", "{}", AuditReport
            )
        assert request.call_args.kwargs["reasoning_effort"] == "low"
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(provider, "_structured", request)
            await provider.generate(
                "SEMANTIC_REFINEMENT", "修正依据", "{}", RepairContext
            )
        assert request.call_args.kwargs["reasoning_effort"] == "low"
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(provider, "_structured", request)
            await provider.generate("DOCUMENT_EXTRACT", "文档提取", "{}", Candidate)
        assert request.call_args.kwargs["reasoning_effort"] == "low"
        await provider.close()

    asyncio.run(run())


def test_invalid_raw_reference_is_corrected_once_by_model_without_accepting_bad_evidence() -> (
    None
):
    class Correcting(FakeProvider):
        count = 0

        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            self.count += 1
            data = {
                "checkedFields": list(LABELS),
                "findings": [
                    {
                        **report().findings[0].model_dump(exclude={"evidence"}),
                        "lineNumbers": [99] if self.count == 1 else [1],
                    }
                ],
            }
            if self.count != 1:
                assert "上一次审校未通过" in instruction
            return model.model_validate(data)

    async def run() -> None:
        provider = Correcting()
        value, _ = await audit_document(
            cast(Provider, provider),
            asyncio.Semaphore(1),
            DOC,
            "净含量220g",
            candidate(),
            candidate(),
            12000,
        )
        assert provider.count == 2
        assert value.findings[0].evidence.quote == "净含量220g"

    asyncio.run(run())


def test_failed_raw_audit_cannot_reach_normalization() -> None:
    class BrokenAudit(FakeProvider):
        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            if model is RawAuditReport:
                raise ValueError("controlled audit failure")
            raise AssertionError("cannot review or repair failed raw audit")

    async def run() -> None:
        api = FakeApi()
        c = candidate()
        task = pipeline(
            api,
            BrokenAudit(),
            [DOC],
            [
                {"nodeId": "FUSION", "sourceId": "", "output": c.model_dump()},
                {
                    "nodeId": "DOCUMENT_EXTRACT",
                    "sourceId": DOC["assetId"],
                    "output": c.model_dump(),
                },
            ],
        )
        with pytest.raises(PartialFailure, match="raw document audits failed"):
            await task.stage("SEMANTIC_REFINEMENT")
        assert ("SEMANTIC_REFINEMENT", "") not in task.checkpoints
        assert ("NORMALIZATION", "") not in task.checkpoints
        assert api.steps[("SEMANTIC_REFINEMENT", DOC["assetId"])]["status"] == "FAILED"

    asyncio.run(run())


def test_cross_chunk_support_prevents_false_critic_from_deleting_complementary_tone() -> (
    None
):
    class CrossChunkProvider(FakeProvider):
        context_chunks: list[int] = []

        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            payload = json.loads(content)
            if model is RawAuditReport:
                findings = []
                matching = [
                    line["lineNumber"]
                    for line in payload["lines"]
                    if "品牌表达真实自然" in line["text"]
                ]
                if matching:
                    finding = report(
                        field="brandTone", kind="INCORRECT", proposedValue="真实自然"
                    ).findings[0]
                    findings.append(
                        {
                            **finding.model_dump(exclude={"evidence"}),
                            "lineNumbers": matching,
                        }
                    )
                return model.model_validate(
                    {"checkedFields": list(LABELS), "findings": findings}
                )
            if model is RepairContext:
                assert "candidate" not in payload and "findings" not in payload
                self.context_chunks.append(payload["chunk"])
                facts = []
                for quote, fact in [
                    ("品牌表达真实自然", "真实自然"),
                    ("品牌调性克制轻盈", "克制、轻盈"),
                ]:
                    matches = [
                        line["lineNumber"]
                        for line in payload["lines"]
                        if quote in line["text"]
                    ]
                    if matches:
                        facts.append(
                            {"field": "brandTone", "fact": fact, "lineNumbers": matches}
                        )
                return model.model_validate({"facts": facts})
            if model is Candidate:
                supported_facts = [
                    f["fact"]
                    for chunk in payload["supportingContext"]
                    for f in chunk["facts"]
                ]
                assert supported_facts == ["真实自然", "克制、轻盈"]
                assert "建议也可能误报" in instruction
                return model.model_validate(payload["candidate"])
            assert payload["supportingRawContext"]
            return model.model_validate({"issues": []})

    async def run() -> None:
        api = FakeApi()
        api.parsed[DOC["assetId"]] = (
            "品牌表达真实自然\n\n"
            + "\n\n".join("背景资料。" * 40 for _ in range(5))
            + "\n\n品牌调性克制轻盈"
        ).encode()
        c = candidate()
        c.fields.brandTone = "真实自然、克制、轻盈"
        c.fieldSources.brandTone = [c.fieldSources.brandName[0].model_copy()]
        provider = CrossChunkProvider()
        task = pipeline(
            api,
            provider,
            [DOC],
            [
                {
                    "nodeId": "DOCUMENT_EXTRACT",
                    "sourceId": DOC["assetId"],
                    "output": c.model_dump(),
                },
                {"nodeId": "FUSION", "sourceId": "", "output": c.model_dump()},
            ],
        )
        task.chunk_chars = 350
        await task.stage("SEMANTIC_REFINEMENT")
        output = task.checkpoints[("SEMANTIC_REFINEMENT", "")]
        assert output["fields"]["brandTone"] == c.fields.brandTone
        assert output["auditSummary"]["correctedFields"] == []
        assert len(provider.context_chunks) >= 3
        assert provider.context_chunks == list(
            range(1, len(provider.context_chunks) + 1)
        )

    asyncio.run(run())


@pytest.mark.parametrize("failure", ["line", "duplicateLine", "field", "request"])
def test_repair_context_rejects_unverified_evidence_and_failures(failure: str) -> None:
    class BrokenContext(FakeProvider):
        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            if failure == "request":
                raise RuntimeError("controlled context failure")
            return model.model_validate(
                {
                    "facts": [
                        {
                            "field": "brandName"
                            if failure == "field"
                            else "productSpecifications",
                            "fact": "净含量220g",
                            "lineNumbers": [2]
                            if failure == "line"
                            else [1, 1]
                            if failure == "duplicateLine"
                            else [1],
                        }
                    ]
                }
            )

    async def run() -> None:
        with pytest.raises((ValueError, RuntimeError)):
            await collect_repair_context(
                cast(Provider, BrokenContext()),
                asyncio.Semaphore(2),
                [(DOC, "净含量220g")],
                report(),
                12000,
            )

    asyncio.run(run())


def test_existing_conflict_must_receive_explicit_review_with_one_bounded_retry() -> (
    None
):
    class Reviewing(FakeProvider):
        count = 0

        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            self.count += 1
            if self.count == 1:
                return model.model_validate({"issues": []})
            assert json.loads(content)["requiredIssueIds"] == ["weight"]
            assert "没有逐项返回" in instruction
            return model.model_validate({"issues": [issue]})

    issue = {
        "id": "weight",
        "field": "productSpecifications",
        "message": "净含量冲突",
        "sourceIds": [DOC["assetId"]],
        "alternatives": ["200g，保质期12个月", "250g，保质期12个月"],
        "blocking": True,
    }

    async def run() -> None:
        c = Candidate.model_validate({**candidate().model_dump(), "issues": [issue]})
        provider = Reviewing()
        result = await review_candidate(
            cast(Provider, provider), "逐项核对", {"candidate": c.model_dump()}, c
        )
        assert provider.count == 2
        assert result.issues == c.issues

    asyncio.run(run())


def test_shared_conflict_facts_survive_every_choice_without_rewriting_other_fields() -> (
    None
):
    class Partitioning(FakeProvider):
        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            assert model is ConflictAlternatives
            payload = json.loads(content)
            assert payload["documentValues"][0]["value"] == "200g，保质期12个月"
            assert all(
                f["field"] == "productSpecifications"
                for source in payload["supportingRawContext"]
                for f in source["facts"]
            )
            return model.model_validate(
                {
                    "commonFacts": ["保质期12个月"],
                    "choices": [
                        {"conflictingFacts": ["净含量200g/瓶"]},
                        {"conflictingFacts": ["净含量250g/瓶"]},
                    ],
                }
            )

    async def run() -> None:
        c = Candidate.model_validate(
            {
                **candidate().model_dump(),
                "issues": [
                    {
                        "id": "weight",
                        "field": "productSpecifications",
                        "message": "净含量冲突",
                        "sourceIds": [DOC["assetId"]],
                        "alternatives": ["200g，保质期12个月", "250g"],
                        "blocking": True,
                    }
                ],
            }
        )
        doc = candidate().model_dump()
        doc["fields"]["productSpecifications"] = "200g，保质期12个月"
        context = [
            {
                "assetId": DOC["assetId"],
                "assetVersion": 1,
                "location": "原文1",
                "facts": [
                    {"field": "productSpecifications", "fact": "保质期12个月"},
                    {"field": "brandTone", "fact": "自然克制"},
                ],
            }
        ]
        result = await complete_conflict_alternatives(
            cast(Provider, Partitioning()), asyncio.Semaphore(2), c, [doc], context
        )
        assert all("保质期12个月" in value for value in result.issues[0].alternatives)
        assert result.fields == c.fields and result.fieldSources == c.fieldSources
        assert result.issues[0].id == c.issues[0].id
        assert result.issues[0].sourceIds == c.issues[0].sourceIds
        assert c.issues[0].alternatives[-1] == "250g"

    asyncio.run(run())
