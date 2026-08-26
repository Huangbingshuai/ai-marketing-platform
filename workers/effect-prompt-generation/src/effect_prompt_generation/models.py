from __future__ import annotations

import operator
from dataclasses import dataclass
from datetime import UTC, datetime
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
    insight_map: NotRequired[InsightApplicationMap]
    shared_prompt: NotRequired[SharedPrompt]
    strategy_plan: NotRequired[StrategyPlan]
    pending_shards: NotRequired[list[ShardPlan]]
    active_shard: NotRequired[dict[str, Any]]
    completed_shard_keys: NotRequired[list[str]]
    generated_candidate_count: Annotated[int, operator.add]
    accepted_count: NotRequired[int]
    semantic_pairs: NotRequired[list[PairViolation]]
    visual_pairs: NotRequired[list[PairViolation]]
    metrics: NotRequired[PromptMetrics]
    needs_replenish: NotRequired[bool]
    missing_fact_ids: NotRequired[list[str]]
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
    schema_version: Literal[5] = 5
    run_id: str
    project_id: str
    request_id: str


class PromptDimensions(ApiModel):
    narrative: str = Field(min_length=1, max_length=120)
    scene: str = Field(min_length=1, max_length=120)
    persona: str = Field(min_length=1, max_length=160)
    selling_point: str = Field(min_length=1, max_length=240)
    camera: str = Field(min_length=1, max_length=160)
    emotion: str = Field(min_length=1, max_length=120)

    @field_validator(
        "narrative", "scene", "persona", "selling_point", "camera", "emotion"
    )
    @classmethod
    def clean_dimension(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("dimension cannot be blank")
        return cleaned


class FragmentType(StrEnum):
    HOOK = "HOOK"
    PAIN = "PAIN"
    PRODUCT_DISPLAY = "PRODUCT_DISPLAY"
    SELLING_POINT_EXPLANATION = "SELLING_POINT_EXPLANATION"
    CTA = "CTA"
    OUTRO = "OUTRO"


FRAGMENT_TYPE_LABELS: dict[FragmentType, str] = {
    FragmentType.HOOK: "钩子片段",
    FragmentType.PAIN: "痛点片段",
    FragmentType.PRODUCT_DISPLAY: "产品展示片段",
    FragmentType.SELLING_POINT_EXPLANATION: "卖点讲解片段",
    FragmentType.CTA: "结尾转化片段",
    FragmentType.OUTRO: "片尾品牌片段",
}

DEFAULT_FRAGMENT_COUNTS: dict[FragmentType, int] = {
    FragmentType.HOOK: 10,
    FragmentType.PAIN: 8,
    FragmentType.PRODUCT_DISPLAY: 12,
    FragmentType.SELLING_POINT_EXPLANATION: 10,
    FragmentType.CTA: 6,
    FragmentType.OUTRO: 4,
}


class EvidenceMode(StrEnum):
    VISIBLE_ATTRIBUTE = "VISIBLE_ATTRIBUTE"
    USAGE_ACTION = "USAGE_ACTION"
    VISIBLE_RESULT = "VISIBLE_RESULT"
    PROCESS_ONLY = "PROCESS_ONLY"
    TEXT_ONLY = "TEXT_ONLY"


class FragmentConfig(ApiModel):
    count: int = Field(ge=1, le=200)
    duration_seconds: int = Field(ge=4, le=15)


class PromptBatchSettings(ApiModel):
    fragment_configs: dict[FragmentType, FragmentConfig]
    semantic_limit: int = Field(ge=5, le=15)
    visual_limit: int = Field(ge=10, le=20)

    @model_validator(mode="after")
    def fragment_config_total(self) -> PromptBatchSettings:
        if set(self.fragment_configs) != set(FragmentType):
            raise ValueError("fragmentConfigs must contain every fragment type")
        if not 10 <= self.target_count <= 200:
            raise ValueError("fragmentConfigs total count must be between 10 and 200")
        return self

    @property
    def target_count(self) -> int:
        return sum(config.count for config in self.fragment_configs.values())


class InsightField(StrEnum):
    PRODUCT_NAME = "PRODUCT_NAME"
    PRODUCT_CATEGORY = "PRODUCT_CATEGORY"
    CORE_SPECIFICATION = "CORE_SPECIFICATION"
    PRICE_RANGE = "PRICE_RANGE"
    VISUAL_FEATURES = "VISUAL_FEATURES"
    CORE_SELLING_POINT = "CORE_SELLING_POINT"
    SECONDARY_SELLING_POINT = "SECONDARY_SELLING_POINT"
    TRUST_BACKING = "TRUST_BACKING"
    TARGET_AUDIENCE = "TARGET_AUDIENCE"
    CORE_PAIN_POINT = "CORE_PAIN_POINT"
    DECISION_DRIVER = "DECISION_DRIVER"
    MARKETING_GOAL = "MARKETING_GOAL"
    USAGE_SCENARIO = "USAGE_SCENARIO"
    PURCHASE_SCENARIO = "PURCHASE_SCENARIO"
    EMOTIONAL_SCENARIO = "EMOTIONAL_SCENARIO"
    SOURCE_DURATION = "SOURCE_DURATION"
    ASPECT_RATIO = "ASPECT_RATIO"
    DELIVERY_CHANNELS = "DELIVERY_CHANNELS"
    DISABLED_ELEMENT = "DISABLED_ELEMENT"
    VISUAL_STYLE_BASELINE = "VISUAL_STYLE_BASELINE"


class InsightFactPolicy(StrEnum):
    REQUIRED = "REQUIRED"
    ADAPTIVE = "ADAPTIVE"
    EXCLUDED = "EXCLUDED"
    CONSTRAINT = "CONSTRAINT"


class InsightBindingRole(StrEnum):
    PRIMARY = "PRIMARY"
    CONTEXT = "CONTEXT"
    EVIDENCE = "EVIDENCE"


class InsightReference(ApiModel):
    fact_id: str = Field(min_length=1, max_length=120)
    field: InsightField
    value: str = Field(min_length=1, max_length=500)
    value_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class InsightBinding(InsightReference):
    role: InsightBindingRole


class ExcludedInsight(InsightReference):
    reason: Literal["UNCERTAIN", "EMPTY", "UNSUPPORTED"]


class InsightCoverage(ApiModel):
    required: list[InsightReference] = Field(default_factory=list)
    covered: list[InsightReference] = Field(default_factory=list)
    missing: list[InsightReference] = Field(default_factory=list)
    adaptive: list[InsightReference] = Field(default_factory=list)
    deferred: list[InsightReference] = Field(default_factory=list)
    excluded: list[ExcludedInsight] = Field(default_factory=list)
    applied_constraints: list[InsightReference] = Field(default_factory=list)


class InsightFact(InsightReference):
    policy: InsightFactPolicy
    eligible_fragment_types: list[FragmentType] = Field(default_factory=list)
    preferred_role: InsightBindingRole = InsightBindingRole.CONTEXT
    exclusion_reason: Literal["UNCERTAIN", "EMPTY", "UNSUPPORTED"] | None = None


class InsightApplicationMap(ApiModel):
    required: list[InsightFact] = Field(default_factory=list)
    adaptive: list[InsightFact] = Field(default_factory=list)
    excluded: list[InsightFact] = Field(default_factory=list)
    constraints: list[InsightFact] = Field(default_factory=list)

    @property
    def usable(self) -> list[InsightFact]:
        return [*self.required, *self.adaptive]

    @property
    def by_id(self) -> dict[str, InsightFact]:
        return {fact.fact_id: fact for fact in [*self.usable, *self.constraints]}


class PromptItem(ApiModel):
    id: str = Field(min_length=1, max_length=160)
    code: str = Field(min_length=1, max_length=40)
    origin: Literal["AI", "MANUAL"]
    fragment_type: FragmentType
    material_tags: list[str] = Field(min_length=1, max_length=12)
    target_duration_seconds: int = Field(ge=4, le=15)
    dimensions: PromptDimensions
    content: str = Field(min_length=1, max_length=12_000)
    insight_bindings: list[InsightBinding] = Field(default_factory=list, max_length=16)
    manual_edited: bool
    created_at: datetime
    updated_at: datetime

    @field_validator("content")
    @classmethod
    def clean_text(cls, value: str) -> str:
        cleaned = "\n".join(
            line.rstrip() for line in value.strip().splitlines()
        ).strip()
        if not cleaned:
            raise ValueError("text cannot be blank")
        return cleaned


class FragmentTypeDistribution(ApiModel):
    fragment_type: FragmentType
    target_count: int = Field(ge=0, le=200)
    actual_count: int = Field(ge=0, le=200)


class SellingPointCoverage(ApiModel):
    required: list[str] = Field(default_factory=list)
    covered: list[str] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)


class ExecutionInvalidReason(ApiModel):
    code: str = Field(min_length=1, max_length=120)
    # 补齐最多会生成目标数量的 1.25 倍候选并重复三轮，原因累计数可高于最终 200 条上限。
    count: int = Field(ge=1, le=2_000)


class PromptMetrics(ApiModel):
    target_count: int = Field(ge=10, le=200)
    accepted_count: int = Field(ge=0, le=200)
    generated_candidate_count: int = Field(ge=0)
    fallback_count: int = Field(ge=0, le=200)
    removed_semantic_duplicates: int = Field(ge=0)
    removed_visual_duplicates: int = Field(ge=0)
    removed_dimension_conflicts: int = Field(ge=0)
    removed_execution_invalid: int = Field(ge=0)
    execution_invalid_reasons: list[ExecutionInvalidReason] = Field(
        default_factory=list
    )
    semantic_duplicate_rate: float = Field(ge=0, le=100)
    visual_overlap_rate: float = Field(ge=0, le=100)
    replenishment_rounds: int = Field(ge=0, le=3)
    fragment_type_distribution: list[FragmentTypeDistribution] = Field(
        min_length=6, max_length=6
    )
    selling_point_coverage: SellingPointCoverage
    insight_coverage: InsightCoverage


class SharedPromptSection(ApiModel):
    key: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,63}$")
    title: str = Field(min_length=1, max_length=120)
    source: Literal["SYSTEM", "USER"]
    content: str = Field(max_length=30_000)
    editable: bool
    source_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class SharedPrompt(ApiModel):
    schema_version: Literal[1] = 1
    sections: list[SharedPromptSection] = Field(min_length=1, max_length=20)
    compiled_content: str = Field(max_length=60_000)
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def validate_compilation(self) -> SharedPrompt:
        if len({section.key for section in self.sections}) != len(self.sections):
            raise ValueError("shared prompt section keys must be unique")
        expected = "\n".join(
            section.content.strip()
            for section in self.sections
            if section.content.strip()
        )
        if self.compiled_content != expected:
            raise ValueError("compiledContent must match non-empty sections")
        return self


class SharedRenderConstraints(ApiModel):
    disabled_elements: list[str] = Field(default_factory=list, max_length=100)
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class RenderProfile(ApiModel):
    ratio: Literal["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]
    resolution: Literal["480p", "720p", "1080p"]
    capability_key: Literal[
        "SEEDANCE_2_0", "SEEDANCE_2_0_FAST", "SEEDANCE_1_5_PRO", "SEEDANCE_1_0"
    ] = "SEEDANCE_2_0"
    shared_constraints: SharedRenderConstraints


class PromptBatchResult(ApiModel):
    schema_version: Literal[5] = 5
    settings: PromptBatchSettings
    render_profile: RenderProfile
    shared_prompt: SharedPrompt
    items: list[PromptItem] = Field(max_length=200)
    metrics: PromptMetrics
    quality_status: Literal["PASS", "NEEDS_REVIEW"]

    @model_validator(mode="after")
    def result_counts_match(self) -> PromptBatchResult:
        if self.metrics.accepted_count != len(self.items):
            raise ValueError("metrics.acceptedCount must equal items length")
        if self.metrics.target_count != self.settings.target_count:
            raise ValueError("metrics.targetCount must equal fragmentConfigs total")
        return self


class InsightArtifact(ApiModel):
    id: str
    revision: int = Field(ge=1)
    content_hash: str = Field(min_length=1)
    result: dict[str, Any]


class PromptGenerationSnapshot(ApiModel):
    schema_version: Literal[5] = 5
    project_id: str
    workflow_run_id: str
    product_id: str
    operation: Literal["BATCH_GENERATE", "ITEM_REGENERATE"]
    target_item_id: str | None = None
    settings: PromptBatchSettings
    insight_artifact: InsightArtifact
    retained_manual_items: list[PromptItem] = Field(
        default_factory=list, max_length=200
    )
    shared_prompt: SharedPrompt | None = None
    base_result_revision: int | None = Field(default=None, ge=1)
    target_item: PromptItem | None = None
    target_item_index: int | None = Field(default=None, ge=0, le=199)
    replacement_dimensions: PromptDimensions | None = None
    regeneration_instruction: str | None = Field(default=None, max_length=500)

    @field_validator("regeneration_instruction")
    @classmethod
    def clean_regeneration_instruction(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        return cleaned or None

    @model_validator(mode="after")
    def validate_operation(self) -> PromptGenerationSnapshot:
        if self.operation == "ITEM_REGENERATE" and not self.target_item_id:
            raise ValueError("targetItemId is required for ITEM_REGENERATE")
        if self.operation == "ITEM_REGENERATE" and (
            self.target_item is None or self.target_item_index is None
        ):
            raise ValueError(
                "targetItem and targetItemIndex are required for ITEM_REGENERATE"
            )
        if self.operation == "BATCH_GENERATE" and (
            self.replacement_dimensions is not None
            or self.regeneration_instruction is not None
        ):
            raise ValueError(
                "batch generation cannot contain item regeneration settings"
            )
        if len(self.retained_manual_items) > self.settings.target_count:
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
    INSIGHT_MAPPING = "INSIGHT_MAPPING"
    SHARED_PROMPT_COMPILATION = "SHARED_PROMPT_COMPILATION"
    STRATEGY_PLANNING = "STRATEGY_PLANNING"
    DIMENSION_COMBINATION = "DIMENSION_COMBINATION"
    FRAGMENT_TYPE_ROUTER = "FRAGMENT_TYPE_ROUTER"
    GENERATE_HOOK = "GENERATE_HOOK"
    GENERATE_PAIN = "GENERATE_PAIN"
    GENERATE_PRODUCT_DISPLAY = "GENERATE_PRODUCT_DISPLAY"
    GENERATE_SELLING_POINT_EXPLANATION = "GENERATE_SELLING_POINT_EXPLANATION"
    GENERATE_CTA = "GENERATE_CTA"
    GENERATE_OUTRO = "GENERATE_OUTRO"
    NORMALIZATION = "NORMALIZATION"
    SEMANTIC_DEDUP = "SEMANTIC_DEDUP"
    VISUAL_DEDUP = "VISUAL_DEDUP"
    INSIGHT_COVERAGE = "INSIGHT_COVERAGE"
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


class SellingPointEvidence(ApiModel):
    selling_point: str = Field(min_length=1, max_length=240)
    evidence_mode: EvidenceMode
    allowed_visual_evidence: str = Field(min_length=1, max_length=400)
    forbidden_inference: str = Field(min_length=1, max_length=400)


class DimensionPools(ApiModel):
    scenes: list[str] = Field(min_length=1, max_length=24)
    personas: list[str] = Field(min_length=1, max_length=24)
    selling_points: list[str] = Field(min_length=1, max_length=12)
    evidence_plans: list[SellingPointEvidence] = Field(min_length=1, max_length=12)

    @field_validator("scenes", "personas", "selling_points")
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


class FragmentStrategyPool(ApiModel):
    fragment_type: FragmentType
    opening_states: list[str] = Field(min_length=3, max_length=12)
    action_arcs: list[str] = Field(min_length=3, max_length=12)
    cameras: list[str] = Field(min_length=3, max_length=12)
    emotions: list[str] = Field(min_length=3, max_length=12)
    ending_states: list[str] = Field(min_length=3, max_length=12)

    @field_validator(
        "opening_states", "action_arcs", "cameras", "emotions", "ending_states"
    )
    @classmethod
    def clean_strategy_pool(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()
        for raw in values:
            value = " ".join(raw.split())
            key = value.casefold()
            if value and key not in seen:
                seen.add(key)
                result.append(value)
        if len(result) < 3:
            raise ValueError(
                "fragment strategy pool must contain three distinct values"
            )
        return result


class MarketingRelationshipBundle(ApiModel):
    bundle_id: str = Field(min_length=1, max_length=120)
    fact_ids: list[str] = Field(min_length=1, max_length=12)
    eligible_fragment_types: list[FragmentType] = Field(min_length=1, max_length=6)
    scene: str = Field(min_length=1, max_length=120)
    persona: str = Field(min_length=1, max_length=160)
    selling_point: str = Field(min_length=1, max_length=240)


class StrategyPlan(ApiModel):
    dimension_pools: DimensionPools
    fragment_strategy_pools: list[FragmentStrategyPool] = Field(
        min_length=6, max_length=6
    )
    relationship_bundles: list[MarketingRelationshipBundle] = Field(
        min_length=1, max_length=48
    )

    @model_validator(mode="after")
    def every_fragment_has_one_strategy_pool(self) -> StrategyPlan:
        fragment_types = [item.fragment_type for item in self.fragment_strategy_pools]
        if len(set(fragment_types)) != len(fragment_types) or set(
            fragment_types
        ) != set(FragmentType):
            raise ValueError(
                "fragmentStrategyPools must contain every fragment type exactly once"
            )
        return self


class PlannedCombination(ApiModel):
    slot_id: str
    ordinal: int = Field(ge=1)
    fragment_type: FragmentType
    material_tags: list[str] = Field(min_length=1, max_length=12)
    target_duration_seconds: int = Field(ge=4, le=15)
    planning_version: Literal["legacy", "six-branch-v1"] = "legacy"
    opening_state: str = Field(
        default="首帧建立主体与环境关系", min_length=1, max_length=240
    )
    visible_action: str = Field(min_length=1, max_length=400)
    ending_state: str = Field(
        default="动作结束后保持稳定构图", min_length=1, max_length=240
    )
    evidence_mode: EvidenceMode
    allowed_visual_evidence: str = Field(min_length=1, max_length=400)
    forbidden_inference: str = Field(min_length=1, max_length=400)
    relationship_bundle_id: str = Field(
        default="legacy-test", min_length=1, max_length=120
    )
    insight_bindings: list[InsightBinding] = Field(default_factory=list, max_length=16)
    dimensions: PromptDimensions


class ShardPlan(ApiModel):
    round: int = Field(ge=0, le=3)
    shard_index: int = Field(ge=0)
    combinations: list[PlannedCombination] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def homogeneous_fragment_type(self) -> ShardPlan:
        if len({item.fragment_type for item in self.combinations}) != 1:
            raise ValueError("shard combinations must share one fragmentType")
        return self

    @property
    def fragment_type(self) -> FragmentType:
        return self.combinations[0].fragment_type

    @property
    def key(self) -> str:
        return f"{self.round}:{self.shard_index}"


class GeneratedPromptText(ApiModel):
    slot_id: str
    prompt_text: str = Field(min_length=80, max_length=260)
    used_fact_ids: list[str] = Field(default_factory=list, max_length=16)


class GeneratedPromptTextBatch(ApiModel):
    items: list[GeneratedPromptText] = Field(min_length=1, max_length=8)


class GeneratedCandidate(ApiModel):
    slot_id: str
    ordinal: int = Field(ge=1)
    round: int = Field(ge=0, le=3)
    shard_index: int = Field(ge=0)
    fragment_type: FragmentType
    material_tags: list[str] = Field(min_length=1, max_length=12)
    target_duration_seconds: int = Field(ge=3, le=10)
    dimensions: PromptDimensions
    content: str = Field(min_length=1, max_length=12_000)
    insight_bindings: list[InsightBinding] = Field(default_factory=list, max_length=16)
    execution_invalid_reasons: list[str] = Field(default_factory=list)
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
    return datetime.now(UTC)
