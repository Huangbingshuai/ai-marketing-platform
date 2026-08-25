from __future__ import annotations

import operator
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from typing import Annotated, Any, Literal, NotRequired, TypedDict

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    prompt_result_id: str


class GraphState(TypedDict):
    project_id: str
    round: NotRequired[int]
    target_count: NotRequired[int]
    retained_count: NotRequired[int]
    dimension_pools: NotRequired[DimensionPools]
    pending_shards: NotRequired[list[ShardPlan]]
    active_shard: NotRequired[dict[str, Any]]
    completed_shard_keys: NotRequired[list[str]]
    generated_candidate_count: Annotated[int, operator.add]
    accepted_count: NotRequired[int]
    semantic_pairs: NotRequired[list[PairViolation]]
    visual_pairs: NotRequired[list[PairViolation]]
    metrics: NotRequired[PromptMetrics]
    needs_replenish: NotRequired[bool]
    prompt_result_id: NotRequired[str]


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    run_id: str
    project_id: str
    workflow_run_id: str
    product_id: str
    request_id: str
    attempt_token: str
    source_fingerprint: str


class PromptGenerationRequest(ApiModel):
    schema_version: Literal[1] = 1
    run_id: str
    project_id: str
    request_id: str


class PromptBatchSettings(ApiModel):
    count: int = Field(ge=10, le=200)
    duration_seconds: int = Field(ge=10, le=120)
    semantic_limit: int = Field(ge=5, le=15)
    visual_limit: int = Field(ge=10, le=20)


class PromptDimensions(ApiModel):
    narrative: str = Field(min_length=1, max_length=120)
    scene: str = Field(min_length=1, max_length=120)
    persona: str = Field(min_length=1, max_length=160)
    selling_point: str = Field(min_length=1, max_length=240)
    camera: str = Field(min_length=1, max_length=160)
    emotion: str = Field(min_length=1, max_length=120)

    @field_validator("narrative", "scene", "persona", "selling_point", "camera", "emotion")
    @classmethod
    def clean_dimension(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("dimension cannot be blank")
        return cleaned


class PromptItem(ApiModel):
    id: str = Field(min_length=1, max_length=160)
    code: str = Field(min_length=1, max_length=40)
    origin: Literal["AI", "MANUAL"]
    fragment_type: str = Field(min_length=1, max_length=120)
    dimensions: PromptDimensions
    content: str = Field(min_length=1, max_length=12_000)
    manual_edited: bool
    created_at: datetime
    updated_at: datetime

    @field_validator("fragment_type", "content")
    @classmethod
    def clean_text(cls, value: str) -> str:
        cleaned = "\n".join(line.rstrip() for line in value.strip().splitlines()).strip()
        if not cleaned:
            raise ValueError("text cannot be blank")
        return cleaned


class PromptMetrics(ApiModel):
    target_count: int = Field(ge=10, le=200)
    accepted_count: int = Field(ge=0, le=200)
    generated_candidate_count: int = Field(ge=0)
    removed_semantic_duplicates: int = Field(ge=0)
    removed_visual_duplicates: int = Field(ge=0)
    removed_dimension_conflicts: int = Field(ge=0)
    semantic_duplicate_rate: float = Field(ge=0, le=100)
    visual_overlap_rate: float = Field(ge=0, le=100)
    replenishment_rounds: int = Field(ge=0, le=3)


class PromptBatchResult(ApiModel):
    schema_version: Literal[1] = 1
    settings: PromptBatchSettings
    items: list[PromptItem] = Field(max_length=200)
    metrics: PromptMetrics
    quality_status: Literal["PASS", "NEEDS_REVIEW"]

    @model_validator(mode="after")
    def result_counts_match(self) -> PromptBatchResult:
        if self.metrics.accepted_count != len(self.items):
            raise ValueError("metrics.acceptedCount must equal items length")
        if self.metrics.target_count != self.settings.count:
            raise ValueError("metrics.targetCount must equal settings.count")
        return self


class InsightArtifact(ApiModel):
    id: str
    revision: int = Field(ge=1)
    content_hash: str = Field(min_length=1)
    result: dict[str, Any]


class PromptGenerationSnapshot(ApiModel):
    schema_version: Literal[1] = 1
    project_id: str
    workflow_run_id: str
    product_id: str
    operation: Literal["BATCH_GENERATE", "ITEM_REGENERATE"]
    target_item_id: str | None = None
    settings: PromptBatchSettings
    insight_artifact: InsightArtifact
    retained_manual_items: list[PromptItem] = Field(default_factory=list, max_length=200)
    base_result_revision: int | None = Field(default=None, ge=1)
    target_item: PromptItem | None = None
    target_item_index: int | None = Field(default=None, ge=0, le=199)

    @model_validator(mode="after")
    def validate_operation(self) -> PromptGenerationSnapshot:
        if self.operation == "ITEM_REGENERATE" and not self.target_item_id:
            raise ValueError("targetItemId is required for ITEM_REGENERATE")
        if len(self.retained_manual_items) > self.settings.count:
            raise ValueError("retained manual items exceed target count")
        return self


class ClaimResponse(ApiModel):
    terminal: bool
    run_id: str
    source_fingerprint: str | None = None
    attempt_token: str | None = None
    input: PromptGenerationSnapshot | None = None


class NodeId(StrEnum):
    LOAD_AND_SNAPSHOT = "LOAD_AND_SNAPSHOT"
    STRATEGY_PLANNING = "STRATEGY_PLANNING"
    DIMENSION_COMBINATION = "DIMENSION_COMBINATION"
    CANDIDATE_GENERATION = "CANDIDATE_GENERATION"
    NORMALIZATION = "NORMALIZATION"
    SEMANTIC_DEDUP = "SEMANTIC_DEDUP"
    VISUAL_DEDUP = "VISUAL_DEDUP"
    QUALITY_GATE = "QUALITY_GATE"
    REPLENISH = "REPLENISH"
    RESULT_SAVE = "RESULT_SAVE"


class StageStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    PARTIAL = "PARTIAL"
    SKIPPED = "SKIPPED"
    FAILED = "FAILED"


class StageOutput(ApiModel):
    node_id: NodeId
    status: StageStatus
    summary: str = Field(max_length=500)
    warnings: list[str] = Field(default_factory=list)
    metadata: dict[str, int | float | str | bool | None] = Field(default_factory=dict)


class DimensionPools(ApiModel):
    narratives: list[str] = Field(min_length=1, max_length=24)
    scenes: list[str] = Field(min_length=1, max_length=24)
    personas: list[str] = Field(min_length=1, max_length=24)
    selling_points: list[str] = Field(min_length=1, max_length=12)
    cameras: list[str] = Field(min_length=1, max_length=24)
    emotions: list[str] = Field(min_length=1, max_length=24)
    fragment_types: list[str] = Field(min_length=1, max_length=12)

    @field_validator(
        "narratives", "scenes", "personas", "selling_points", "cameras", "emotions", "fragment_types"
    )
    @classmethod
    def clean_pool(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()
        for raw in values:
            value = " ".join(raw.split())
            key = value.casefold()
            if value and key not in seen:
                seen.add(key)
                result.append(value)
        if not result:
            raise ValueError("dimension pool cannot be empty")
        return result


class PlannedCombination(ApiModel):
    slot_id: str
    ordinal: int = Field(ge=1)
    fragment_type: str
    dimensions: PromptDimensions


class ShardPlan(ApiModel):
    round: int = Field(ge=0, le=3)
    shard_index: int = Field(ge=0)
    combinations: list[PlannedCombination] = Field(min_length=1, max_length=8)

    @property
    def key(self) -> str:
        return f"{self.round}:{self.shard_index}"


class GeneratedText(ApiModel):
    slot_id: str
    fragment_type: str
    content: str = Field(min_length=1, max_length=12_000)


class GeneratedTextBatch(ApiModel):
    items: list[GeneratedText] = Field(min_length=1, max_length=8)


class GeneratedCandidate(ApiModel):
    slot_id: str
    ordinal: int = Field(ge=1)
    round: int = Field(ge=0, le=3)
    shard_index: int = Field(ge=0)
    fragment_type: str
    dimensions: PromptDimensions
    content: str = Field(min_length=1, max_length=12_000)
    generated_at: datetime


class ShardRecord(ApiModel):
    round: int = Field(ge=0, le=3)
    shard_index: int = Field(ge=0)
    status: StageStatus
    combination_plan: list[PlannedCombination] = Field(default_factory=list)
    items: list[GeneratedCandidate] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
    updated_at: datetime | None = None

    @property
    def key(self) -> str:
        return f"{self.round}:{self.shard_index}"


class ShardsResponse(ApiModel):
    run_id: str
    shards: list[ShardRecord] = Field(default_factory=list)


class PairViolation(ApiModel):
    left_id: str
    right_id: str
    score: float = Field(ge=0, le=1)


class CompleteResponse(ApiModel):
    prompt_result_id: str


class FailurePayload(ApiModel):
    error_code: str
    error_message: str
    retryable: bool = False
    warnings: list[str] = Field(default_factory=list)


class ProgressPayload(ApiModel):
    progress: int | None = Field(default=None, ge=0, le=99)
    current_node: NodeId | None = None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
