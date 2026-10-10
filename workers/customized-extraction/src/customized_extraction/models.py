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


class Candidate(StrictModel):
    fields: Brief
    fieldSources: Sources
    issues: list[Issue]


class Review(StrictModel):
    issues: list[Issue]
    dismissedIssueIds: list[str] = Field(default_factory=list)


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
