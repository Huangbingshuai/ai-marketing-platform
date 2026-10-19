from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator
from uuid import UUID


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Brief(StrictModel):
    brandName: str
    projectName: str
    projectBackground: str
    brandTone: str
    visualConsistencyRules: str
    avoidedElements: str
    productName: str
    productDescription: str
    productSpecifications: str
    productAppearance: str
    sellingPoints: list[str]
    targetAudience: str


class Source(StrictModel):
    assetId: str
    assetVersion: int = Field(ge=1)
    location: str
    itemIndex: int | None


class Sources(StrictModel):
    brandName: list[Source]
    projectName: list[Source]
    projectBackground: list[Source]
    brandTone: list[Source]
    visualConsistencyRules: list[Source]
    avoidedElements: list[Source]
    productName: list[Source]
    productDescription: list[Source]
    productSpecifications: list[Source]
    productAppearance: list[Source]
    sellingPoints: list[Source]
    targetAudience: list[Source]


class ConflictResolution(StrictModel):
    schemaVersion: Literal[1]
    baseValue: str = Field(max_length=50000)
    before: str = Field(max_length=50000)
    replacements: list[str] = Field(min_length=2)


class Issue(StrictModel):
    id: str
    field: Literal[
        "brandName",
        "projectName",
        "projectBackground",
        "brandTone",
        "visualConsistencyRules",
        "avoidedElements",
        "productName",
        "productDescription",
        "productSpecifications",
        "productAppearance",
        "targetAudience",
    ]
    message: str
    sourceIds: list[str]
    alternatives: list[str]
    blocking: bool
    resolution: ConflictResolution | None = None


class Candidate(StrictModel):
    fields: Brief
    fieldSources: Sources
    issues: list[Issue]


class Review(StrictModel):
    issues: list[Issue]
    dismissedIssueIds: list[str] = Field(default_factory=list)


BriefField = Literal[
    "brandName",
    "projectName",
    "projectBackground",
    "brandTone",
    "visualConsistencyRules",
    "avoidedElements",
    "productName",
    "productDescription",
    "productSpecifications",
    "productAppearance",
    "sellingPoints",
    "targetAudience",
]


class AuditEvidence(StrictModel):
    assetId: str
    assetVersion: int = Field(ge=1)
    location: str = Field(min_length=1, max_length=1000)
    quote: str = Field(min_length=1, max_length=2000)


class AuditFindingContent(StrictModel):
    field: BriefField
    kind: Literal["MISSING", "INCORRECT", "MISATTRIBUTED", "CONFLICT"]
    description: str = Field(min_length=1, max_length=1000)
    proposedValue: str = Field(max_length=50000)
    itemIndex: int | None = Field(ge=0)


class AuditFinding(AuditFindingContent):
    evidence: AuditEvidence


class AuditReport(StrictModel):
    checkedFields: list[BriefField]
    findings: list[AuditFinding]


class RawAuditFinding(AuditFindingContent):
    lineNumbers: list[int] = Field(min_length=1, max_length=4)


class RawAuditReport(StrictModel):
    """Provider-only references; the runtime pins exact quotes and source identity."""

    checkedFields: list[BriefField]
    findings: list[RawAuditFinding]


class ContextFact(StrictModel):
    field: BriefField
    fact: str = Field(min_length=1, max_length=50000)
    lineNumbers: list[int] = Field(min_length=1)


class RepairContext(StrictModel):
    """Private model output, not a replacement for the public brief contract."""

    facts: list[ContextFact]


class ConflictChoice(StrictModel):
    conflictingFacts: list[str] = Field(min_length=1)


class ConflictAlternatives(StrictModel):
    """AI partitions semantics; runtime formats every choice with the shared facts."""

    commonFacts: list[str]
    choices: list[ConflictChoice] = Field(min_length=2)


class ScopedConflictChoice(StrictModel):
    replacement: str = Field(min_length=1, max_length=50000)


class ConflictDecision(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    kind: Literal["CONFLICT", "DISMISS", "INFORMATION"]
    reason: str = Field(min_length=1, max_length=1000)
    anchor: str = Field(max_length=50000)
    choices: list[ScopedConflictChoice]


class ConflictFieldPlan(StrictModel):
    """Private semantic decisions; the public Issue contract remains unchanged."""

    decisions: list[ConflictDecision] = Field(min_length=1)


class ConflictScopeVerdict(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    valid: bool
    reason: str = Field(min_length=1, max_length=1000)


class ConflictPlanReview(StrictModel):
    verdicts: list[ConflictScopeVerdict] = Field(min_length=1)


class QueueMessage(StrictModel):
    schemaVersion: Literal[1]
    projectId: str
    runId: str
    requestId: str

    @field_validator("projectId", "runId", "requestId")
    @classmethod
    def uuid_identifier(cls, value: str) -> str:
        if UUID(value).version != 4:
            raise ValueError("identifier must be UUID v4")
        return value


LABELS = {
    "brandName": "品牌名称",
    "projectName": "项目名称",
    "projectBackground": "项目背景",
    "brandTone": "品牌调性",
    "visualConsistencyRules": "视觉统一规则",
    "avoidedElements": "画面禁用元素",
    "productName": "产品名称",
    "productDescription": "产品介绍",
    "productSpecifications": "产品规格",
    "productAppearance": "产品外观",
    "sellingPoints": "核心卖点",
    "targetAudience": "目标受众",
}
NODES = [
    "LOAD_AND_SNAPSHOT",
    "DOCUMENT_PARSE",
    "DOCUMENT_EXTRACT",
    "FUSION",
    "SEMANTIC_REFINEMENT",
    "NORMALIZATION",
]


def empty_brief() -> Brief:
    return Brief.model_validate(
        {key: [] if key == "sellingPoints" else "" for key in LABELS}
    )


def empty_sources() -> Sources:
    return Sources.model_validate({key: [] for key in LABELS})
