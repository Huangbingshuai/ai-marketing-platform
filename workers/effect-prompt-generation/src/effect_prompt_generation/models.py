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
    graph_version: NotRequired[str]
    operation: NotRequired[str]
    round: NotRequired[int]
    target_count: NotRequired[int]
    retained_count: NotRequired[int]
    insight_map: NotRequired[InsightApplicationMap]
    shared_prompt: NotRequired[SharedPrompt]
    fact_allocations: NotRequired[dict[FragmentType, FragmentFactAllocation]]
    expected_fragment_types: NotRequired[list[FragmentType]]
    active_strategy_allocation: NotRequired[dict[str, Any]]
    strategy_checkpoint_types: NotRequired[list[FragmentType]]
    fragment_strategy_plans: Annotated[list[FragmentMarketingPlan], operator.add]
    fragment_relationship_plans: Annotated[list[FragmentRelationshipPlan], operator.add]
    active_relationship_allocation: NotRequired[dict[str, Any]]
    relationship_checkpoint_types: NotRequired[list[FragmentType]]
    dimension_coordinate_plans: Annotated[list[FragmentDimensionCoordinatePlan], operator.add]
    active_coordinate_request: NotRequired[dict[str, Any]]
    coordinate_checkpoint_types: NotRequired[list[FragmentType]]
    blueprint_quotas: NotRequired[list[BlueprintBundleQuota]]
    blueprint_deficits: NotRequired[dict[str, int]]
    pending_blueprint_shards: NotRequired[list[BlueprintShardPlan]]
    active_blueprint_shard: NotRequired[dict[str, Any]]
    generated_blueprints: Annotated[list[GeneratedBlueprint], operator.add]
    strategy_plan: NotRequired[StrategyPlan]
    pending_shards: NotRequired[list[ShardPlan]]
    active_shard: NotRequired[dict[str, Any]]
    completed_shard_keys: NotRequired[list[str]]
    completed_blueprint_shard_keys: NotRequired[list[str]]
    generated_candidate_count: Annotated[int, operator.add]
    accepted_count: NotRequired[int]
    semantic_pairs: NotRequired[list[PairViolation]]
    visual_pairs: NotRequired[list[PairViolation]]
    metrics: NotRequired[PromptMetrics]
    needs_replenish: NotRequired[bool]
    missing_fact_ids: NotRequired[list[str]]
    prompt_result_id: NotRequired[str]
    pending_creative_shards: NotRequired[list[CreativeShardPlan]]
    active_creative_shard: NotRequired[dict[str, Any]]
    pending_classification_shards: NotRequired[list[ClassificationShardPlan]]
    active_classification_shard: NotRequired[dict[str, Any]]
    creative_candidate_count: Annotated[int, operator.add]
    classified_candidate_count: Annotated[int, operator.add]
    needs_supplement: NotRequired[bool]


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


class CreativeDimensions(ApiModel):
    narrative: str = Field(min_length=1, max_length=120)
    scene: str = Field(min_length=1, max_length=120)
    persona: str = Field(min_length=1, max_length=160)
    product_relation: str = Field(min_length=1, max_length=240)
    camera: str = Field(min_length=1, max_length=160)
    emotion: str = Field(min_length=1, max_length=120)

    @field_validator(
        "narrative", "scene", "persona", "product_relation", "camera", "emotion"
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


class PromptBatchSettingsV6(ApiModel):
    target_count: int = Field(ge=10, le=200)
    default_duration_seconds: int = Field(ge=4, le=15)

    @property
    def fragment_configs(self) -> dict[FragmentType, FragmentConfig]:
        raise RuntimeError("V11 settings do not define fragmentConfigs")

    @property
    def semantic_limit(self) -> int:
        raise RuntimeError("V11 settings do not define semanticLimit")

    @property
    def visual_limit(self) -> int:
        raise RuntimeError("V11 settings do not define visualLimit")


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


class PromptItemV6(ApiModel):
    id: str = Field(min_length=1, max_length=160)
    code: str = Field(min_length=1, max_length=40)
    origin: Literal["AI", "MANUAL"]
    fragment_type: FragmentType
    primary_purpose: FragmentType
    compatible_purposes: list[FragmentType] = Field(min_length=1, max_length=6)
    classification_status: Literal["PENDING", "VERIFIED"]
    product_relevance: int = Field(ge=0, le=100)
    material_tags: list[str] = Field(min_length=1, max_length=12)
    target_duration_seconds: int = Field(ge=4, le=15)
    dimensions: CreativeDimensions
    content: str = Field(min_length=1, max_length=12_000)
    insight_bindings: list[InsightBinding] = Field(default_factory=list, max_length=16)
    manual_edited: bool
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def validate_purposes(self) -> PromptItemV6:
        purposes = list(dict.fromkeys(self.compatible_purposes))
        if self.primary_purpose not in purposes:
            raise ValueError("compatiblePurposes must include primaryPurpose")
        if self.fragment_type != self.primary_purpose:
            raise ValueError("fragmentType must equal primaryPurpose")
        self.compatible_purposes = purposes
        return self

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


class PurposeDistribution(ApiModel):
    purpose: FragmentType
    primary_count: int = Field(ge=0, le=200)
    compatible_count: int = Field(ge=0, le=200)


class CreativeAverageScores(ApiModel):
    product_relevance: float = Field(ge=0, le=100)
    creative_coherence: float = Field(ge=0, le=100)
    visual_executability: float = Field(ge=0, le=100)
    commercial_usefulness: float = Field(ge=0, le=100)
    visual_clarity: float = Field(ge=0, le=100)


class CountMetric(ApiModel):
    code: str = Field(min_length=1, max_length=120)
    count: int = Field(ge=1, le=2_000)


class PromptMetricsV6(ApiModel):
    target_count: int = Field(ge=10, le=200)
    candidate_target_count: int = Field(ge=10, le=240)
    generated_candidate_count: int = Field(ge=0)
    accepted_count: int = Field(ge=0, le=200)
    rejected_count: int = Field(ge=0)
    replenishment_rounds: int = Field(ge=0, le=1)
    exact_duplicate_count: int = Field(ge=0)
    purpose_distribution: list[PurposeDistribution] = Field(min_length=6, max_length=6)
    average_scores: CreativeAverageScores
    hard_issue_counts: list[CountMetric] = Field(default_factory=list)
    warning_counts: list[CountMetric] = Field(default_factory=list)


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


class PromptBatchResultV6(ApiModel):
    schema_version: Literal[6] = 6
    settings: PromptBatchSettingsV6
    render_profile: RenderProfile
    shared_prompt: SharedPrompt
    items: list[PromptItemV6] = Field(max_length=200)
    metrics: PromptMetricsV6
    quality_status: Literal["PASS", "NEEDS_REVIEW"]

    @model_validator(mode="after")
    def result_counts_match(self) -> PromptBatchResultV6:
        if self.metrics.accepted_count != len(self.items):
            raise ValueError("metrics.acceptedCount must equal items length")
        if self.metrics.target_count != self.settings.target_count:
            raise ValueError("metrics.targetCount must equal settings.targetCount")
        return self


class InsightArtifact(ApiModel):
    id: str
    revision: int = Field(ge=1)
    content_hash: str = Field(min_length=1)
    result: dict[str, Any]


class PromptGenerationSnapshot(ApiModel):
    schema_version: Literal[5, 6] = 5
    graph_version: Literal[
        "V8_SINGLE_STRATEGY",
        "V9_SIX_BRANCH_STRATEGY",
        "V10_RELATION_COORDINATE_BLUEPRINT",
        "V11_COHERENT_CREATIVE_GENERATION",
    ] = "V9_SIX_BRANCH_STRATEGY"
    project_id: str
    workflow_run_id: str
    product_id: str
    operation: Literal["BATCH_GENERATE", "ITEM_REGENERATE", "ITEM_EVALUATE"]
    target_item_id: str | None = None
    settings: PromptBatchSettings | PromptBatchSettingsV6
    insight_artifact: InsightArtifact
    retained_manual_items: list[PromptItem | PromptItemV6] = Field(
        default_factory=list, max_length=200
    )
    shared_prompt: SharedPrompt | None = None
    base_result_revision: int | None = Field(default=None, ge=1)
    target_item: PromptItem | PromptItemV6 | None = None
    target_item_index: int | None = Field(default=None, ge=0, le=199)
    replacement_dimensions: PromptDimensions | CreativeDimensions | None = None
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
        if self.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"} and not self.target_item_id:
            raise ValueError("targetItemId is required for item operations")
        if self.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"} and (
            self.target_item is None or self.target_item_index is None
        ):
            raise ValueError(
                "targetItem and targetItemIndex are required for item operations"
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
    strategy_checkpoints: list[StrategyCheckpoint] = Field(default_factory=list)
    stage_checkpoints: list[StrategyCheckpoint] = Field(default_factory=list)


class NodeId(StrEnum):
    LOAD_AND_SNAPSHOT = "LOAD_AND_SNAPSHOT"
    INSIGHT_MAPPING = "INSIGHT_MAPPING"
    SHARED_PROMPT_COMPILATION = "SHARED_PROMPT_COMPILATION"
    STRATEGY_PLANNING = "STRATEGY_PLANNING"
    GLOBAL_FACT_ALLOCATION = "GLOBAL_FACT_ALLOCATION"
    STRATEGY_FRAGMENT_ROUTER = "STRATEGY_FRAGMENT_ROUTER"
    PLAN_HOOK_STRATEGY = "PLAN_HOOK_STRATEGY"
    PLAN_PAIN_STRATEGY = "PLAN_PAIN_STRATEGY"
    PLAN_PRODUCT_DISPLAY_STRATEGY = "PLAN_PRODUCT_DISPLAY_STRATEGY"
    PLAN_SELLING_POINT_EXPLANATION_STRATEGY = (
        "PLAN_SELLING_POINT_EXPLANATION_STRATEGY"
    )
    PLAN_CTA_STRATEGY = "PLAN_CTA_STRATEGY"
    PLAN_OUTRO_STRATEGY = "PLAN_OUTRO_STRATEGY"
    STRATEGY_MERGE_VALIDATION = "STRATEGY_MERGE_VALIDATION"
    RELATIONSHIP_FRAGMENT_ROUTER = "RELATIONSHIP_FRAGMENT_ROUTER"
    PLAN_HOOK_RELATIONSHIPS = "PLAN_HOOK_RELATIONSHIPS"
    PLAN_PAIN_RELATIONSHIPS = "PLAN_PAIN_RELATIONSHIPS"
    PLAN_PRODUCT_DISPLAY_RELATIONSHIPS = "PLAN_PRODUCT_DISPLAY_RELATIONSHIPS"
    PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS = "PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS"
    PLAN_CTA_RELATIONSHIPS = "PLAN_CTA_RELATIONSHIPS"
    PLAN_OUTRO_RELATIONSHIPS = "PLAN_OUTRO_RELATIONSHIPS"
    RELATIONSHIP_MERGE_VALIDATION = "RELATIONSHIP_MERGE_VALIDATION"
    DIMENSION_COORDINATE_ROUTER = "DIMENSION_COORDINATE_ROUTER"
    PLAN_HOOK_COORDINATES = "PLAN_HOOK_COORDINATES"
    PLAN_PAIN_COORDINATES = "PLAN_PAIN_COORDINATES"
    PLAN_PRODUCT_DISPLAY_COORDINATES = "PLAN_PRODUCT_DISPLAY_COORDINATES"
    PLAN_SELLING_POINT_EXPLANATION_COORDINATES = "PLAN_SELLING_POINT_EXPLANATION_COORDINATES"
    PLAN_CTA_COORDINATES = "PLAN_CTA_COORDINATES"
    PLAN_OUTRO_COORDINATES = "PLAN_OUTRO_COORDINATES"
    COORDINATE_MERGE_VALIDATION = "COORDINATE_MERGE_VALIDATION"
    BLUEPRINT_QUOTA_ALLOCATION = "BLUEPRINT_QUOTA_ALLOCATION"
    BLUEPRINT_FRAGMENT_ROUTER = "BLUEPRINT_FRAGMENT_ROUTER"
    GENERATE_HOOK_BLUEPRINTS = "GENERATE_HOOK_BLUEPRINTS"
    GENERATE_PAIN_BLUEPRINTS = "GENERATE_PAIN_BLUEPRINTS"
    GENERATE_PRODUCT_DISPLAY_BLUEPRINTS = "GENERATE_PRODUCT_DISPLAY_BLUEPRINTS"
    GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS = "GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS"
    GENERATE_CTA_BLUEPRINTS = "GENERATE_CTA_BLUEPRINTS"
    GENERATE_OUTRO_BLUEPRINTS = "GENERATE_OUTRO_BLUEPRINTS"
    BLUEPRINT_ORTHOGONAL_GATE = "BLUEPRINT_ORTHOGONAL_GATE"
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
    COHERENT_CREATIVE_GENERATION = "COHERENT_CREATIVE_GENERATION"
    CREATIVE_EVALUATION_CLASSIFICATION = "CREATIVE_EVALUATION_CLASSIFICATION"
    EXACT_SELECTION_AND_SUPPLEMENT = "EXACT_SELECTION_AND_SUPPLEMENT"
    ITEM_EVALUATE = "ITEM_EVALUATE"


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
    metadata: dict[str, Any] = Field(default_factory=dict)


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
    primary_fact_id: str | None = Field(default=None, max_length=120)
    creative_intent: str = Field(default="清晰表达当前片段职责", min_length=1, max_length=160)
    opening_state: str = Field(default="首帧建立主体与环境关系", min_length=1, max_length=240)
    action_arc: str = Field(default="主体完成一个连续可见动作", min_length=1, max_length=400)
    camera: str = Field(default="中景稳定记录主体动作", min_length=1, max_length=160)
    emotion: str = Field(default="真实自然", min_length=1, max_length=120)
    ending_state: str = Field(default="动作结束后保持稳定构图", min_length=1, max_length=240)


class FragmentFactAllocation(ApiModel):
    fragment_type: FragmentType
    target_count: int = Field(ge=1, le=200)
    bundle_target: int = Field(ge=1, le=4)
    mandatory_fact_ids: list[str] = Field(default_factory=list, max_length=64)
    candidate_fact_ids: list[str] = Field(min_length=1, max_length=128)
    allocation_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class FragmentMarketingBundle(ApiModel):
    bundle_id: str = Field(min_length=1, max_length=120)
    primary_fact_id: str = Field(min_length=1, max_length=120)
    fact_ids: list[str] = Field(min_length=1, max_length=8)
    creative_intent: str = Field(min_length=1, max_length=160)
    scene: str = Field(min_length=1, max_length=120)
    persona: str = Field(min_length=1, max_length=160)
    opening_state: str = Field(min_length=1, max_length=240)
    action_arc: str = Field(min_length=1, max_length=400)
    camera: str = Field(min_length=1, max_length=160)
    emotion: str = Field(min_length=1, max_length=120)
    ending_state: str = Field(min_length=1, max_length=240)


class FragmentMarketingPlan(ApiModel):
    fragment_type: FragmentType
    bundles: list[FragmentMarketingBundle] = Field(min_length=1, max_length=4)
    allocation_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    prompt_version: str = Field(min_length=1, max_length=120)
    reused_checkpoint: bool = False


class FragmentRelationshipBundle(ApiModel):
    bundle_id: str = Field(min_length=1, max_length=120)
    fragment_type: FragmentType
    primary_fact_id: str = Field(min_length=1, max_length=120)
    fact_ids: list[str] = Field(min_length=1, max_length=8)
    creative_intent: str = Field(min_length=1, max_length=160)


class FragmentRelationshipModelResponse(ApiModel):
    """Permissive transport shape; the provider freezes system-owned fields afterwards."""

    fragment_type: FragmentType
    bundles: list[FragmentRelationshipBundle] = Field(min_length=1, max_length=12)
    allocation_hash: str = Field(min_length=1, max_length=120)
    prompt_version: str = Field(min_length=1, max_length=120)


class FragmentRelationshipPlan(ApiModel):
    fragment_type: FragmentType
    bundles: list[FragmentRelationshipBundle] = Field(min_length=1, max_length=4)
    allocation_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    prompt_version: str = Field(min_length=1, max_length=120)
    reused_checkpoint: bool = False


class DimensionCoordinate(ApiModel):
    coordinate_id: str = Field(min_length=1, max_length=120)
    value: str = Field(min_length=1, max_length=240)
    compatible_bundle_ids: list[str] = Field(min_length=1, max_length=16)
    # Ark may over-return transport references even with strict JSON Schema. The provider
    # filters them to the relationship allocation and caps the persisted plan at eight.
    source_fact_ids: list[str] = Field(default_factory=list, max_length=32)
    normalized_signature: str = Field(min_length=1, max_length=240)


class FragmentDimensionCoordinatePlan(ApiModel):
    fragment_type: FragmentType
    relationship_allocation_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    narratives: list[DimensionCoordinate] = Field(min_length=2, max_length=24)
    scenes: list[DimensionCoordinate] = Field(min_length=2, max_length=24)
    personas: list[DimensionCoordinate] = Field(min_length=2, max_length=24)
    selling_points: list[DimensionCoordinate] = Field(min_length=1, max_length=24)
    cameras: list[DimensionCoordinate] = Field(min_length=2, max_length=24)
    emotions: list[DimensionCoordinate] = Field(min_length=2, max_length=24)
    prompt_version: str = Field(min_length=1, max_length=120)
    reused_checkpoint: bool = False


class BlueprintBundleQuota(ApiModel):
    fragment_type: FragmentType
    bundle_id: str = Field(min_length=1, max_length=120)
    primary_fact_id: str = Field(min_length=1, max_length=120)
    target_count: int = Field(ge=1, le=200)
    candidate_count: int = Field(ge=1, le=200)


class BlueprintTask(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    ordinal: int = Field(ge=1)
    round: int = Field(ge=0, le=3)
    fragment_type: FragmentType
    bundle_id: str = Field(min_length=1, max_length=120)
    primary_fact_id: str = Field(min_length=1, max_length=120)
    fact_ids: list[str] = Field(min_length=1, max_length=8)
    target_duration_seconds: int = Field(ge=4, le=15)
    material_tags: list[str] = Field(min_length=1, max_length=12)


class GeneratedBlueprint(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    fragment_type: FragmentType
    bundle_id: str = Field(min_length=1, max_length=120)
    primary_fact_id: str = Field(min_length=1, max_length=120)
    used_fact_ids: list[str] = Field(min_length=1, max_length=8)
    narrative_coordinate_id: str = Field(min_length=1, max_length=120)
    scene_coordinate_id: str = Field(min_length=1, max_length=120)
    persona_coordinate_id: str = Field(min_length=1, max_length=120)
    selling_point_coordinate_id: str = Field(min_length=1, max_length=120)
    camera_coordinate_id: str = Field(min_length=1, max_length=120)
    emotion_coordinate_id: str = Field(min_length=1, max_length=120)
    opening_state: str = Field(min_length=1, max_length=240)
    action_arc: str = Field(min_length=1, max_length=400)
    ending_state: str = Field(min_length=1, max_length=240)


class GeneratedBlueprintBatch(ApiModel):
    items: list[GeneratedBlueprint] = Field(min_length=1, max_length=8)


class BlueprintShardPlan(ApiModel):
    round: int = Field(ge=0, le=3)
    shard_index: int = Field(ge=0)
    tasks: list[BlueprintTask] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def homogeneous_fragment_type(self) -> BlueprintShardPlan:
        if len({item.fragment_type for item in self.tasks}) != 1:
            raise ValueError("blueprint shard tasks must share one fragmentType")
        return self

    @property
    def fragment_type(self) -> FragmentType:
        return self.tasks[0].fragment_type

    @property
    def key(self) -> str:
        return f"BLUEPRINT:{self.round}:{self.shard_index}"


class StrategyCheckpoint(ApiModel):
    node_id: NodeId
    source_fingerprint: str = Field(min_length=1, max_length=128)
    allocation_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    prompt_version: str = Field(min_length=1, max_length=120)
    plan: FragmentMarketingPlan | FragmentRelationshipPlan | FragmentDimensionCoordinatePlan


class CompactMarketingRelationshipBundle(ApiModel):
    bundle_id: str = Field(min_length=1, max_length=120)
    fragment_type: FragmentType
    fact_ids: list[str] = Field(min_length=1, max_length=8)


class CompactStrategyPlan(ApiModel):
    relationship_bundles: list[CompactMarketingRelationshipBundle] = Field(
        min_length=1, max_length=24
    )


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
    planning_version: Literal[
        "legacy", "six-branch-v1", "six-ai-branch-v2", "v10-coordinate-blueprint"
    ] = "legacy"
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
    target_duration_seconds: int = Field(ge=4, le=15)
    dimensions: PromptDimensions
    content: str = Field(min_length=1, max_length=12_000)
    insight_bindings: list[InsightBinding] = Field(default_factory=list, max_length=16)
    execution_invalid_reasons: list[str] = Field(default_factory=list)
    generated_at: datetime


class CreativeTask(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    ordinal: int = Field(ge=1)
    round: int = Field(ge=0, le=1)
    target_duration_seconds: int = Field(ge=4, le=15)
    preferred_fact_ids: list[str] = Field(default_factory=list, max_length=12)


class CreativeCandidate(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    ordinal: int = Field(ge=1)
    round: int = Field(ge=0, le=1)
    creative_core: str = Field(min_length=1, max_length=160)
    declared_fact_ids: list[str] = Field(min_length=1, max_length=12)
    dimensions: CreativeDimensions
    content: str = Field(min_length=20, max_length=600)
    generated_at: datetime | None = None

    @field_validator("declared_fact_ids")
    @classmethod
    def unique_fact_ids(cls, values: list[str]) -> list[str]:
        result = list(dict.fromkeys(values))
        if not result:
            raise ValueError("declaredFactIds cannot be empty")
        return result


class CreativeCandidateBatch(ApiModel):
    items: list[CreativeCandidate] = Field(min_length=1, max_length=5)


class CreativeShardPlan(ApiModel):
    round: int = Field(ge=0, le=1)
    shard_index: int = Field(ge=0)
    tasks: list[CreativeTask] = Field(min_length=1, max_length=5)
    avoid_semantic_signatures: list[str] = Field(default_factory=list, max_length=200)
    avoid_visual_signatures: list[str] = Field(default_factory=list, max_length=200)
    rejection_reasons: list[str] = Field(default_factory=list, max_length=20)

    @property
    def key(self) -> str:
        return f"CREATIVE:{self.round}:{self.shard_index}"


class FactEvidence(ApiModel):
    fact_id: str = Field(min_length=1, max_length=120)
    evidence_text: str = Field(min_length=1, max_length=160)


class CreativeScores(ApiModel):
    product_relevance: float = Field(ge=0, le=100)
    creative_coherence: float = Field(ge=0, le=100)
    visual_executability: float = Field(ge=0, le=100)
    commercial_usefulness: float = Field(ge=0, le=100)
    visual_clarity: float = Field(ge=0, le=100)

    @property
    def overall_quality(self) -> float:
        return round(
            self.product_relevance * 0.30
            + self.creative_coherence * 0.25
            + self.visual_executability * 0.20
            + self.commercial_usefulness * 0.15
            + self.visual_clarity * 0.10,
            4,
        )


class CreativeEvaluation(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    primary_purpose: FragmentType
    compatible_purposes: list[FragmentType] = Field(min_length=1, max_length=6)
    fact_evidence: list[FactEvidence] = Field(default_factory=list, max_length=12)
    realized_fact_ids: list[str] = Field(default_factory=list, max_length=12)
    scores: CreativeScores
    semantic_signature: str = Field(min_length=1, max_length=240)
    visual_signature: str = Field(min_length=1, max_length=240)
    hard_issues: list[str] = Field(default_factory=list, max_length=20)
    warnings: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_purposes_and_evidence(self) -> CreativeEvaluation:
        purposes = list(dict.fromkeys(self.compatible_purposes))
        if self.primary_purpose not in purposes:
            raise ValueError("compatiblePurposes must include primaryPurpose")
        evidence_ids = list(dict.fromkeys(item.fact_id for item in self.fact_evidence))
        if list(dict.fromkeys(self.realized_fact_ids)) != evidence_ids:
            raise ValueError("realizedFactIds must match factEvidence")
        self.compatible_purposes = purposes
        self.realized_fact_ids = evidence_ids
        self.hard_issues = list(dict.fromkeys(self.hard_issues))
        self.warnings = list(dict.fromkeys(self.warnings))
        return self


class CreativeEvaluationBatch(ApiModel):
    items: list[CreativeEvaluation] = Field(min_length=1, max_length=10)


class ClassificationShardPlan(ApiModel):
    round: int = Field(ge=0, le=1)
    shard_index: int = Field(ge=0)
    candidate_ids: list[str] = Field(min_length=1, max_length=10)

    @property
    def key(self) -> str:
        return f"CLASSIFICATION:{self.round}:{self.shard_index}"


class ShardPhase(StrEnum):
    BLUEPRINT = "BLUEPRINT"
    PROMPT = "PROMPT"
    CREATIVE = "CREATIVE"
    CLASSIFICATION = "CLASSIFICATION"


class ShardRecord(ApiModel):
    phase: ShardPhase = ShardPhase.PROMPT
    round: int = Field(ge=0, le=3)
    shard_index: int = Field(ge=0)
    status: StageStatus
    combination_plan: list[PlannedCombination] = Field(default_factory=list)
    blueprint_plan: list[BlueprintTask] = Field(default_factory=list)
    blueprints: list[GeneratedBlueprint] = Field(default_factory=list)
    creative_plan: list[CreativeTask] = Field(default_factory=list)
    creative_items: list[CreativeCandidate] = Field(default_factory=list)
    classification_plan: list[str] = Field(default_factory=list)
    evaluations: list[CreativeEvaluation] = Field(default_factory=list)
    items: list[GeneratedCandidate] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
    updated_at: datetime | None = None

    @property
    def key(self) -> str:
        if self.phase == ShardPhase.BLUEPRINT:
            return f"BLUEPRINT:{self.round}:{self.shard_index}"
        if self.phase == ShardPhase.CREATIVE:
            return f"CREATIVE:{self.round}:{self.shard_index}"
        if self.phase == ShardPhase.CLASSIFICATION:
            return f"CLASSIFICATION:{self.round}:{self.shard_index}"
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
    current_node: NodeId | None = None


class ProgressPayload(ApiModel):
    progress: int | None = Field(default=None, ge=0, le=99)
    current_node: NodeId | None = None


def utc_now() -> datetime:
    return datetime.now(UTC)
