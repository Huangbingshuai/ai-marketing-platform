from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal, NotRequired, TypedDict

from pydantic import BaseModel, ConfigDict, Field, field_validator


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
    schema_version: Literal[2, 3] = 2
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
    # Historical snapshots carried a separate video-config revision. Video
    # settings are no longer an extraction input, so current API snapshots omit
    # it while older in-flight jobs may still include it.
    effective_video_config_revision: int | None = None
    execution_input_hash: str


class SnapshotDependency(ApiModel):
    source_type: Literal["NODE_STATE", "WORKING_ARTIFACT", "EXECUTION_INPUT"]
    source_node_id: str | None = None
    source_artifact_id: str | None = None
    source_key: str
    source_revision: int | None = None
    source_hash: str | None = None


class ExtractionSnapshot(ApiModel):
    schema_version: Literal[2, 3] = 2
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
    bypass_image_cache: bool = False


class ClaimResponse(ApiModel):
    terminal: bool
    run_id: str
    source_fingerprint: str | None = None
    attempt_token: str | None = None
    input: ExtractionSnapshot | None = None


SellingPoint = Annotated[str, Field(min_length=1, max_length=1000)]


class ExtractionCandidate(ApiModel):
    """All properties are present for strict structured output; values may be null."""

    product_category: str | None = Field(max_length=500)
    product_name: str | None = Field(max_length=500)
    core_specification: str | None = Field(max_length=2000)
    price_range: str | None = Field(max_length=1000)
    visual_features: str | None = Field(max_length=4000)
    selling_points: list[SellingPoint] | None = Field(default=None, max_length=100)

    @classmethod
    def empty(cls) -> ExtractionCandidate:
        return cls(**{name: None for name in cls.model_fields})


class ImageVisibleFacts(ApiModel):
    """Visible product facts grounded directly in the image."""

    product_category: str | None
    product_name: str | None
    core_specification: str | None
    visual_features: str | None
    selling_points: list[SellingPoint] | None = Field(max_length=8)
    high_detail_recommended: bool

    def to_candidate(self) -> ExtractionCandidate:
        candidate = ExtractionCandidate.empty()
        for field_name in ExtractionCandidate.model_fields:
            if field_name in type(self).model_fields:
                setattr(candidate, field_name, getattr(self, field_name))
        return candidate


class ExtractionResult(ApiModel):
    product_category: str = Field(max_length=500)
    product_name: str = Field(max_length=500)
    core_specification: str = Field(max_length=2000)
    price_range: str = Field(max_length=1000)
    visual_features: str = Field(max_length=4000)
    selling_points: list[SellingPoint] = Field(min_length=1, max_length=100)

    @field_validator("selling_points")
    @classmethod
    def require_unique_selling_points(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("sellingPoints must be unique")
        return value


class SemanticField(StrEnum):
    SELLING_POINTS = "sellingPoints"


class SemanticSuggestionDisposition(StrEnum):
    KEEP = "KEEP"
    DROP = "DROP"


class SemanticSuggestionReason(StrEnum):
    INDEPENDENT_VISIBLE_FACT = "INDEPENDENT_VISIBLE_FACT"
    DUPLICATE_USER_FACT = "DUPLICATE_USER_FACT"
    DUPLICATE_AI_SUGGESTION = "DUPLICATE_AI_SUGGESTION"
    WRONG_FIELD = "WRONG_FIELD"
    LOW_INFORMATION = "LOW_INFORMATION"
    CAPACITY = "CAPACITY"


class SemanticImageEvidenceBasis(StrEnum):
    DIRECT_PRODUCT_ATTRIBUTE = "DIRECT_PRODUCT_ATTRIBUTE"
    READABLE_PRODUCT_TEXT = "READABLE_PRODUCT_TEXT"
    EXPLICIT_ACTION = "EXPLICIT_ACTION"
    EXPLICIT_SCENE = "EXPLICIT_SCENE"
    INFERRED_INTENT_OR_CLAIM = "INFERRED_INTENT_OR_CLAIM"


class SemanticUserFactIssue(StrEnum):
    POSSIBLE_DUPLICATE = "POSSIBLE_DUPLICATE"
    POSSIBLE_OVERLAP = "POSSIBLE_OVERLAP"
    AMBIGUOUS_EXPRESSION = "AMBIGUOUS_EXPRESSION"
    FIELD_OVER_RECOMMENDED_COUNT = "FIELD_OVER_RECOMMENDED_COUNT"


class SemanticSuggestionDecision(ApiModel):
    fact_id: str
    disposition: SemanticSuggestionDisposition
    target_field: SemanticField | None = None
    reason: SemanticSuggestionReason
    evidence_basis: SemanticImageEvidenceBasis


class SemanticUserFactNotice(ApiModel):
    fact_id: str
    issue: SemanticUserFactIssue
    related_fact_ids: list[str] = Field(default_factory=list, max_length=10)
    suggested_field: SemanticField | None = None


class SemanticUserFactReview(ApiModel):
    user_fact_notices: list[SemanticUserFactNotice] = Field(max_length=40)


class SemanticUserFactPairRelation(StrEnum):
    DISTINCT = "DISTINCT"
    POSSIBLE_DUPLICATE = "POSSIBLE_DUPLICATE"
    POSSIBLE_OVERLAP = "POSSIBLE_OVERLAP"


class SemanticUserFactPairDecision(ApiModel):
    pair_id: str
    relation: SemanticUserFactPairRelation


class SemanticUserFactModelReview(ApiModel):
    pair_decisions: list[SemanticUserFactPairDecision] = Field(max_length=1400)
    user_fact_notices: list[SemanticUserFactNotice] = Field(max_length=40)


class SemanticImageSuggestionReview(ApiModel):
    suggestion_decisions: list[SemanticSuggestionDecision] = Field(max_length=40)


class SemanticImageSuggestionModelDecision(ApiModel):
    """Permissive transport shape; business validation happens per decision."""

    fact_id: str = ""
    disposition: str = ""
    target_field: str | None = None
    reason: str = ""
    evidence_basis: str = ""


class SemanticImageSuggestionModelReview(ApiModel):
    suggestion_decisions: list[SemanticImageSuggestionModelDecision] = Field(
        default_factory=list,
        max_length=40,
    )


class SemanticRefinementDecision(ApiModel):
    suggestion_decisions: list[SemanticSuggestionDecision] = Field(max_length=40)
    user_fact_notices: list[SemanticUserFactNotice] = Field(max_length=40)


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
