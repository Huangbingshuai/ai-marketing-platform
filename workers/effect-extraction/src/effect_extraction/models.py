from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal, NotRequired, TypedDict

from pydantic import BaseModel, ConfigDict, Field


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class InputState(TypedDict):
    project_id: str


class OutputState(TypedDict):
    extract_result_id: str


class GraphState(TypedDict):
    project_id: str
    extract_result_id: NotRequired[str]


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    run_id: str
    project_id: str
    draft_id: str
    product_id: str
    request_id: str
    attempt_token: str
    source_fingerprint: str


class ExtractionRequest(ApiModel):
    schema_version: Literal[2] = 2
    run_id: str
    project_id: str
    request_id: str


class VideoConfig(ApiModel):
    aspect_ratio: str
    duration_seconds: int
    resolution: str
    frame_rate: int
    subtitle_strategy: str
    voiceover_strategy: str
    bgm_strategy: str
    style_tone: str
    delivery_channel: str
    disabled_elements: list[str] = Field(default_factory=list)


class SnapshotMaterial(ApiModel):
    id: str
    type: str
    original_file_name: str
    mime_type: str
    size_bytes: int = Field(ge=0)
    updated_at: datetime | None = None
    storage_key: str | None = Field(default=None, exclude=True)


class SnapshotProduct(ApiModel):
    id: str
    name: str
    category: str
    sku: str
    commerce_url: str | None = None
    effective_config: VideoConfig


class SnapshotDependencyRevision(ApiModel):
    source_package_revision: int
    effective_video_config_revision: int
    execution_input_hash: str


class SnapshotDependency(ApiModel):
    source_type: Literal["NODE_STATE", "WORKING_ARTIFACT", "EXECUTION_INPUT"]
    source_node_id: str | None = None
    source_artifact_id: str | None = None
    source_key: str
    source_revision: int | None = None
    source_hash: str | None = None


class ExtractionSnapshot(ApiModel):
    schema_version: Literal[2] = 2
    project_id: str
    draft_id: str
    mode: Literal["SINGLE", "BATCH"]
    source_revision: int
    global_video_config: VideoConfig | None = None
    product: SnapshotProduct
    materials: list[SnapshotMaterial] = Field(default_factory=list)
    dependency_snapshot: SnapshotDependencyRevision | None = None
    dependencies: list[SnapshotDependency] = Field(default_factory=list)
    manual_overrides: dict[str, Any] = Field(default_factory=dict)

class ClaimResponse(ApiModel):
    terminal: bool
    run_id: str
    source_fingerprint: str | None = None
    attempt_token: str | None = None
    input: ExtractionSnapshot | None = None


class ExtractionCandidate(ApiModel):
    """All properties are present for strict structured output; values may be null."""

    product_category: str | None
    product_name: str | None
    core_specification: str | None
    price_range: str | None
    visual_features: str | None
    core_selling_points: list[str] | None
    secondary_selling_points: list[str] | None
    trust_backings: list[str] | None
    target_audience: str | None
    core_pain_points: list[str] | None
    decision_drivers: list[str] | None
    marketing_goal: str | None
    usage_scenarios: list[str] | None
    purchase_scenarios: list[str] | None
    emotional_scenarios: list[str] | None
    duration_seconds: int | None
    aspect_ratio: str | None
    resolution: str | None
    delivery_channels: str | None
    disabled_elements: list[str] | None
    visual_style_baseline: str | None

    @classmethod
    def empty(cls) -> ExtractionCandidate:
        return cls(**{name: None for name in cls.model_fields})


class ExtractionResult(ApiModel):
    product_category: str
    product_name: str
    core_specification: str
    price_range: str
    visual_features: str
    core_selling_points: list[str] = Field(min_length=1, max_length=3)
    secondary_selling_points: list[str] = Field(max_length=6)
    trust_backings: list[str] = Field(max_length=6)
    target_audience: str
    core_pain_points: list[str] = Field(max_length=5)
    decision_drivers: list[str] = Field(max_length=5)
    marketing_goal: str
    usage_scenarios: list[str] = Field(max_length=5)
    purchase_scenarios: list[str] = Field(max_length=5)
    emotional_scenarios: list[str] = Field(max_length=5)
    duration_seconds: int = Field(ge=1, le=3600)
    aspect_ratio: str
    resolution: str
    delivery_channels: str
    disabled_elements: list[str]
    visual_style_baseline: str


class SemanticField(StrEnum):
    CORE_PAIN_POINTS = "corePainPoints"
    DECISION_DRIVERS = "decisionDrivers"
    USAGE_SCENARIOS = "usageScenarios"
    PURCHASE_SCENARIOS = "purchaseScenarios"
    EMOTIONAL_SCENARIOS = "emotionalScenarios"


class SemanticRelation(StrEnum):
    SAME_MEANING = "SAME_MEANING"
    PARENT_CHILD = "PARENT_CHILD"
    SAME_FAMILY = "SAME_FAMILY"


class SemanticGroup(ApiModel):
    field: SemanticField
    member_fact_ids: list[str] = Field(min_length=2)
    canonical_value: str = Field(min_length=1, max_length=240)
    relation: SemanticRelation


class SemanticRefinementDecision(ApiModel):
    groups: list[SemanticGroup]


class BranchName(StrEnum):
    DOCUMENT = "DOCUMENT"
    IMAGE = "IMAGE"
    COMMERCE = "COMMERCE"
    FORM = "FORM"
    FUSION = "FUSION"
    SEMANTIC_REFINEMENT = "SEMANTIC_REFINEMENT"
    NORMALIZATION = "NORMALIZATION"


class BranchStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    PARTIAL = "PARTIAL"
    SKIPPED = "SKIPPED"
    FAILED = "FAILED"


class BranchItem(ApiModel):
    source_id: str
    status: BranchStatus
    candidate: ExtractionCandidate | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    artifact_storage_key: str | None = None
    warning: str | None = None


class BranchOutput(ApiModel):
    branch: BranchName
    status: BranchStatus
    source_fingerprint: str
    candidate: ExtractionCandidate | None = None
    items: list[BranchItem] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class FinalizePayload(ApiModel):
    result: ExtractionResult
    provenance: dict[str, str]
    conflict_report: list[str]
    warnings: list[str]


class FinalizeResponse(ApiModel):
    extract_result_id: str


class ArtifactResponse(ApiModel):
    artifact_id: str
    storage_key: str
    size_bytes: int = Field(ge=0)
    replayed: bool


class FailurePayload(ApiModel):
    error_code: str
    error_message: str
    retryable: bool = False
    warnings: list[str] = Field(default_factory=list)


class ProgressPayload(ApiModel):
    progress: int = Field(ge=0, le=99)
    current_node: str
