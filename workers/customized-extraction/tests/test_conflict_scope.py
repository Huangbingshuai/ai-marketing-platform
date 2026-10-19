from __future__ import annotations

import asyncio
import json
from typing import Any, Literal, TypeVar, cast

import pytest
from pydantic import BaseModel

from customized_extraction.models import (
    Candidate,
    ConflictFieldPlan,
    ConflictPlanReview,
    Issue,
    Review,
)
from customized_extraction.pipeline import validate_provenance
from customized_extraction.provider import Provider
from customized_extraction.quality import (
    AuditValidationError,
    complete_conflict_alternatives,
)
from test_pipeline import DOC, FakeApi, FakeProvider, pipeline
from test_quality import candidate

T = TypeVar("T", bound=BaseModel)
CAPACITY = "容量待确认：430mL或480mL，两份记录同款且没有优先级"
SPEC = (
    CAPACITY + "；整杯312g；304内胆；性能均无测试结论；未确认附赠刷子、吸管或备用圈。"
)
APPEARANCE = "燕麦白；树脂牌号未知；包装图案待设计后人工确认；标准字居中、距底30mm。"


def coffee() -> Candidate:
    c = candidate()
    c.fields.productSpecifications = SPEC
    c.fields.productAppearance = APPEARANCE
    c.fieldSources.productSpecifications = c.fieldSources.productName.copy()
    c.fieldSources.productAppearance = c.fieldSources.productName.copy()
    issues: list[
        tuple[str, Literal["productSpecifications", "productAppearance"], str]
    ] = [
        ("capacity", "productSpecifications", "容量记录430/480尚未确认"),
        ("performance", "productSpecifications", "性能没有测试结论"),
        ("accessories", "productSpecifications", "未确认随杯配件"),
        ("resin", "productAppearance", "树脂牌号未知"),
        ("packaging", "productAppearance", "包装尚待设计"),
    ]
    c.issues = [
        Issue(
            id=id,
            field=field,
            message=message,
            sourceIds=[DOC["assetId"]],
            blocking=True,
            alternatives=["容量480mL的整段字段", "容量430mL的整段字段"],
        )
        for id, field, message in issues
    ]
    return c


class ScopedProvider(FakeProvider):
    def __init__(self, broken: str = "") -> None:
        super().__init__()
        self.schemas: list[str] = []
        self.broken = broken

    async def generate(
        self, stage: str, instruction: str, content: str, model: type[T]
    ) -> T:
        self.schemas.append(model.__name__)
        payload = json.loads(content)
        if model is ConflictFieldPlan:
            assert all("alternatives" not in issue for issue in payload["issues"])
            assert all(
                f["field"] == payload["field"]
                for source in payload["supportingRawContext"]
                for f in source["facts"]
            )
            decisions: list[dict[str, Any]] = []
            for issue in payload["issues"]:
                id = issue["id"]
                conflict = id in ("capacity", "weight")
                anchor = CAPACITY if id == "capacity" else "整杯312g"
                replacements = (
                    ["容量430mL", "容量480mL"]
                    if id == "capacity"
                    else ["整杯312g", "整杯320g"]
                )
                decisions.append(
                    {
                        "id": id,
                        "kind": "CONFLICT" if conflict else "DISMISS",
                        "reason": "受控原文：容量互斥，其他已正确保留为未知",
                        "anchor": anchor if conflict else "",
                        "choices": [{"replacement": text} for text in replacements]
                        if conflict
                        else [],
                    }
                )
            if self.broken == "identity":
                decisions[0]["id"] = "wrong-id"
            elif (
                self.broken == "absent" and payload["field"] == "productSpecifications"
            ):
                decisions[0]["anchor"] = "原文不存在的片段"
            elif self.broken == "empty" and payload["field"] == "productSpecifications":
                decisions[0]["anchor"] = ""
            elif self.broken == "overlap":
                for decision in decisions:
                    if decision["kind"] == "CONFLICT":
                        decision["anchor"] = SPEC
            elif self.broken == "information":
                for decision in decisions:
                    if decision["id"] == "packaging":
                        decision["kind"] = "INFORMATION"
            return model.model_validate({"decisions": decisions})
        assert model is ConflictPlanReview
        ids = [i["id"] for field in payload for i in field["issues"]]
        verdicts = [
            {"id": id, "valid": self.broken != "reject", "reason": "受控独立范围核对"}
            for id in ids
        ]
        if self.broken == "review-missing":
            verdicts.pop()
        return model.model_validate({"verdicts": verdicts})


async def refine(c: Candidate, provider: ScopedProvider) -> Candidate:
    contexts = [
        {
            "assetId": DOC["assetId"],
            "assetVersion": 1,
            "location": "补充说明",
            "facts": [
                {"field": "productSpecifications", "fact": SPEC, "quote": SPEC},
                {"field": "productAppearance", "fact": APPEARANCE, "quote": APPEARANCE},
            ],
        }
    ]
    return await complete_conflict_alternatives(
        cast(Provider, provider), asyncio.Semaphore(2), c, [c.model_dump()], contexts
    )


@pytest.mark.asyncio
async def test_coffee_unknown_facts_do_not_borrow_capacity_choices() -> None:
    c = coffee()
    provider = ScopedProvider()
    result = await refine(c, provider)
    assert result.fields == c.fields and result.fieldSources == c.fieldSources
    assert len(c.issues) == 5 and len(result.issues) == 1
    issue = result.issues[0]
    assert issue.id == "capacity" and issue.blocking and issue.resolution
    assert issue.resolution.before == CAPACITY
    assert issue.alternatives == [
        SPEC.replace(CAPACITY, v) for v in ["容量430mL", "容量480mL"]
    ]
    assert all(
        "性能均无测试结论；未确认附赠刷子、吸管或备用圈。" in value
        for value in issue.alternatives
    )
    assert provider.schemas.count("ConflictFieldPlan") == 2
    assert provider.schemas.count("ConflictPlanReview") == 1
    validate_provenance(result, [DOC])


@pytest.mark.asyncio
async def test_multiple_real_conflicts_keep_atomic_choices_for_each_scope() -> None:
    c = coffee()
    c.issues.append(
        Issue(
            id="weight",
            field="productSpecifications",
            message="重量记录不一致",
            sourceIds=[DOC["assetId"]],
            alternatives=["312g", "320g"],
            blocking=True,
        )
    )
    result = await refine(c, ScopedProvider())
    assert [i.id for i in result.issues] == ["capacity", "weight"]
    assert all(
        i.resolution and len(i.resolution.replacements) == 2 for i in result.issues
    )
    assert (
        result.issues[1].resolution and result.issues[1].resolution.before == "整杯312g"
    )


@pytest.mark.asyncio
async def test_information_without_mutually_exclusive_answers_has_no_fake_choices() -> (
    None
):
    result = await refine(coffee(), ScopedProvider("information"))
    info = next(i for i in result.issues if i.id == "packaging")
    assert not info.blocking and not info.alternatives and info.resolution is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "broken", ["identity", "absent", "empty", "reject", "review-missing"]
)
async def test_invalid_identity_scope_or_independent_review_cannot_be_saved(
    broken: str,
) -> None:
    with pytest.raises(AuditValidationError):
        await refine(coffee(), ScopedProvider(broken))


@pytest.mark.asyncio
async def test_overlapping_scopes_are_rejected_before_applying_any_candidate() -> None:
    c = coffee()
    c.issues.append(
        Issue(
            id="weight",
            field="productSpecifications",
            message="重量冲突",
            sourceIds=[DOC["assetId"]],
            alternatives=[],
            blocking=True,
        )
    )
    with pytest.raises(AuditValidationError, match="overlap"):
        await refine(c, ScopedProvider("overlap"))


def test_old_unfinished_semantic_checkpoint_cannot_bypass_new_scope_review() -> None:
    c = coffee().model_dump()
    old = {**c, "auditSummary": {"schemaVersion": 1}}
    checkpoints = [
        {"nodeId": "SEMANTIC_REFINEMENT", "sourceId": "", "output": old},
        {"nodeId": "NORMALIZATION", "sourceId": "", "output": c},
    ]
    execution = pipeline(FakeApi(), FakeProvider(), [DOC], checkpoints)
    assert ("SEMANTIC_REFINEMENT", "") not in execution.checkpoints
    assert ("NORMALIZATION", "") not in execution.checkpoints
    checkpoints[0]["output"] = {**old, "conflictPolicyVersion": 2}
    current = pipeline(FakeApi(), FakeProvider(), [DOC], checkpoints)
    assert ("SEMANTIC_REFINEMENT", "") in current.checkpoints


@pytest.mark.asyncio
async def test_dismissing_all_known_unknowns_finishes_activity_without_skipping_independent_audit() -> (
    None
):
    c = coffee()
    c.fields.productSpecifications = SPEC.replace(CAPACITY, "容量430mL")
    c.issues = c.issues[1:]

    class AllKnown(FakeProvider):
        async def generate(
            self, stage: str, instruction: str, content: str, model: type[T]
        ) -> T:
            if model is Review:
                return model.model_validate(
                    {"issues": [issue.model_dump() for issue in c.issues]}
                )
            if model is ConflictFieldPlan:
                return model.model_validate(
                    {
                        "decisions": [
                            {
                                "id": issue["id"],
                                "kind": "DISMISS",
                                "reason": "当前字段已经保留未知事实",
                                "anchor": "",
                                "choices": [],
                            }
                            for issue in json.loads(content)["issues"]
                        ]
                    }
                )
            return await super().generate(stage, instruction, content, model)

    provider = AllKnown()
    task = pipeline(
        FakeApi(),
        provider,
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
    await task.stage("SEMANTIC_REFINEMENT")
    output = task.checkpoints["SEMANTIC_REFINEMENT", ""]
    assert output["issues"] == []
    assert output["fields"] == c.fields.model_dump()
    assert (
        next(
            s for s in output["activity"]["steps"] if s["id"] == "CONFLICT_COMPLETION"
        )["status"]
        == "SUCCEEDED"
    )
    assert "SEMANTIC_REFINEMENT" in provider.calls
