from __future__ import annotations

import hashlib
import json
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal, NotRequired, TypedDict

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


def _contract_sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _contract_sha256_json(value: object) -> str:
    return _contract_sha256_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    )


def _contract_disabled_elements(values: list[str]) -> list[str]:
    unique: dict[str, str] = {}
    for value in values:
        cleaned = " ".join(value.split()).rstrip("。；;，,").strip()
        if not cleaned:
            continue
        key = unicodedata.normalize("NFKC", cleaned).casefold()
        unique.setdefault(key, cleaned)
    return list(unique.values())


class InputState(TypedDict):
    project_id: str


class OutputState(TypedDict):
    prompt_result_id: str


class GraphState(TypedDict):
    project_id: str
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
    run_id: str
    project_id: str
    request_id: str


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


class CreativeDimensionKey(StrEnum):
    NARRATIVE = "NARRATIVE"
    SCENE = "SCENE"
    PERSONA = "PERSONA"
    PRODUCT_RELATION = "PRODUCT_RELATION"
    CAMERA = "CAMERA"
    EMOTION = "EMOTION"


class CreativeSemanticProfile(ApiModel):
    narrative_family: str = Field(min_length=1, max_length=80)
    scene_family: str = Field(min_length=1, max_length=80)
    persona_family: str = Field(min_length=1, max_length=80)
    product_action_family: str = Field(min_length=1, max_length=80)
    camera_family: str = Field(min_length=1, max_length=80)
    emotion_family: str = Field(min_length=1, max_length=80)

    @field_validator(
        "narrative_family",
        "scene_family",
        "persona_family",
        "product_action_family",
        "camera_family",
        "emotion_family",
    )
    @classmethod
    def clean_family(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("semantic family cannot be blank")
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


class PromptBatchSettings(ApiModel):
    target_count: int = Field(ge=10, le=200)
    default_duration_seconds: int = Field(ge=4, le=30)


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
    RESOLUTION = "RESOLUTION"
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


class FactVisualUsage(StrEnum):
    IDENTITY_ANCHOR = "IDENTITY_ANCHOR"
    DIRECTLY_VISIBLE = "DIRECTLY_VISIBLE"
    ACTION_DEMONSTRABLE = "ACTION_DEMONSTRABLE"
    CONTEXT_ONLY = "CONTEXT_ONLY"
    TEXT_ONLY = "TEXT_ONLY"
    FORBIDDEN_VISUAL_PROOF = "FORBIDDEN_VISUAL_PROOF"


class FactVisualPolicyDraft(ApiModel):
    fact_id: str = Field(min_length=1, max_length=120)
    visual_usage: FactVisualUsage
    visual_instruction: str = Field(default="", max_length=120)
    context_instruction: str = Field(default="", max_length=120)
    compatible_fact_ids: list[str] = Field(default_factory=list, max_length=3)
    forbidden_inferences: list[str] = Field(default_factory=list, max_length=2)

    @field_validator(
        "visual_instruction",
        "context_instruction",
    )
    @classmethod
    def clean_instruction(cls, value: str) -> str:
        return " ".join(value.split())

    @field_validator("compatible_fact_ids", "forbidden_inferences")
    @classmethod
    def unique_texts(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(" ".join(value.split()) for value in values if value.strip()))


class FactVisualStrategyResponse(ApiModel):
    policies: list[FactVisualPolicyDraft] = Field(min_length=1, max_length=80)


class FactVisualStrategy(ApiModel):
    source_content_hash: str = Field(min_length=1, max_length=128)
    template_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    strategy_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    policies: list[FactVisualPolicyDraft] = Field(min_length=1, max_length=80)

    @property
    def by_id(self) -> dict[str, FactVisualPolicyDraft]:
        return {policy.fact_id: policy for policy in self.policies}


class PromptItem(ApiModel):
    id: str = Field(min_length=1, max_length=160)
    code: str = Field(min_length=1, max_length=40)
    origin: Literal["AI", "MANUAL"]
    fragment_type: FragmentType
    primary_purpose: FragmentType
    compatible_purposes: list[FragmentType] = Field(min_length=1, max_length=6)
    classification_status: Literal["PENDING", "VERIFIED"]
    product_relevance: int = Field(ge=0, le=100)
    material_tags: list[str] = Field(default_factory=list, max_length=12)
    target_duration_seconds: int = Field(ge=4, le=30)
    creative_core: str = Field(min_length=1, max_length=160)
    dimensions: CreativeDimensions
    content: str = Field(min_length=1, max_length=12_000)
    insight_bindings: list[InsightBinding] = Field(default_factory=list, max_length=16)
    manual_edited: bool
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def validate_purposes(self) -> PromptItem:
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


class SemanticEvaluation(ApiModel):
    status: Literal["PENDING", "VERIFIED"]
    evaluated_count: int = Field(ge=0, le=200)
    duplicate_group_count: int | None = Field(default=None, ge=0, le=200)
    duplicate_count: int | None = Field(default=None, ge=0, le=200)
    duplicate_rate: float | None = Field(default=None, ge=0, le=100)


class CountMetric(ApiModel):
    code: str = Field(min_length=1, max_length=120)
    count: int = Field(ge=1, le=2_000)


class PromptMetrics(ApiModel):
    target_count: int = Field(ge=10, le=200)
    candidate_target_count: int = Field(ge=10, le=240)
    generated_candidate_count: int = Field(ge=0)
    accepted_count: int = Field(ge=0, le=200)
    rejected_count: int = Field(ge=0)
    replenishment_rounds: int = Field(ge=0, le=3)
    exact_duplicate_count: int = Field(ge=0)
    semantic_evaluation: SemanticEvaluation
    purpose_distribution: list[PurposeDistribution] = Field(min_length=6, max_length=6)
    average_scores: CreativeAverageScores
    hard_issue_counts: list[CountMetric] = Field(default_factory=list)
    warning_counts: list[CountMetric] = Field(default_factory=list)
    insight_coverage: InsightCoverage


class SharedPromptSection(ApiModel):
    key: str = Field(pattern=r"^[A-Z][A-Z0-9_]{0,63}$")
    title: str = Field(min_length=1, max_length=120)
    source: Literal["SYSTEM", "USER"]
    content: str = Field(max_length=30_000)
    editable: bool
    source_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class SharedPrompt(ApiModel):
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
        if self.content_hash != _contract_sha256_text(expected):
            raise ValueError("shared prompt contentHash must match compiledContent")
        additional = next(
            (section for section in self.sections if section.key == "USER_ADDITIONAL"),
            None,
        )
        if additional is not None and additional.source_hash != _contract_sha256_text(
            additional.content
        ):
            raise ValueError("USER_ADDITIONAL sourceHash must match its content")
        return self


class SharedRenderConstraints(ApiModel):
    disabled_elements: list[str] = Field(default_factory=list, max_length=100)
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def validate_disabled_elements_hash(self) -> SharedRenderConstraints:
        normalized = _contract_disabled_elements(self.disabled_elements)
        if normalized != self.disabled_elements:
            raise ValueError("disabledElements must be normalized and unique")
        if self.content_hash != _contract_sha256_json(normalized):
            raise ValueError("sharedConstraints contentHash must match disabledElements")
        return self


class RenderProfile(ApiModel):
    ratio: Literal["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]
    resolution: Literal["480p", "720p", "1080p"]
    capability_key: Literal[
        "SEEDANCE_2_0", "SEEDANCE_2_0_FAST", "SEEDANCE_1_5_PRO", "SEEDANCE_1_0"
    ] = "SEEDANCE_2_0"
    shared_constraints: SharedRenderConstraints


class PromptBatchResult(ApiModel):
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
            raise ValueError("metrics.targetCount must equal settings.targetCount")
        disabled = self.render_profile.shared_constraints.disabled_elements
        disabled_section = next(
            (
                section
                for section in self.shared_prompt.sections
                if section.key == "DISABLED_ELEMENTS"
            ),
            None,
        )
        additional_section = next(
            (
                section
                for section in self.shared_prompt.sections
                if section.key == "USER_ADDITIONAL"
            ),
            None,
        )
        expected_disabled_content = (
            f"画面中不得出现以下内容：{'；'.join(disabled)}。" if disabled else ""
        )
        if (
            disabled_section is None
            or disabled_section.source != "SYSTEM"
            or disabled_section.editable
            or disabled_section.content != expected_disabled_content
            or disabled_section.source_hash != _contract_sha256_json(disabled)
        ):
            raise ValueError("DISABLED_ELEMENTS section must match renderProfile")
        if (
            additional_section is None
            or additional_section.source != "USER"
            or not additional_section.editable
        ):
            raise ValueError("USER_ADDITIONAL section is required")
        return self


class InsightArtifact(ApiModel):
    id: str
    revision: int = Field(ge=1)
    content_hash: str = Field(min_length=1)
    result: dict[str, Any]


class PromptGenerationSnapshot(ApiModel):
    project_id: str
    workflow_run_id: str
    product_id: str
    operation: Literal["BATCH_GENERATE", "ITEM_REGENERATE", "ITEM_EVALUATE"]
    target_item_id: str | None = None
    settings: PromptBatchSettings
    insight_artifact: InsightArtifact
    retained_manual_items: list[PromptItem] = Field(
        default_factory=list, max_length=200
    )
    selection_policy: Literal["MMR_CONTENT"]
    similarity_anchors: list[PromptItem] = Field(
        default_factory=list, max_length=200
    )
    shared_prompt: SharedPrompt | None = None
    base_result_revision: int | None = Field(default=None, ge=1)
    target_item: PromptItem | None = None
    target_item_index: int | None = Field(default=None, ge=0, le=199)
    replacement_dimensions: CreativeDimensions | None = None
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
        if (
            self.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"}
            and not self.target_item_id
        ):
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
    FACT_VISUAL_STRATEGY_COMPILATION = "FACT_VISUAL_STRATEGY_COMPILATION"
    SHARED_PROMPT_COMPILATION = "SHARED_PROMPT_COMPILATION"
    COHERENT_CREATIVE_GENERATION = "COHERENT_CREATIVE_GENERATION"
    CREATIVE_EVALUATION_CLASSIFICATION = "CREATIVE_EVALUATION_CLASSIFICATION"
    EXACT_SELECTION_AND_SUPPLEMENT = "EXACT_SELECTION_AND_SUPPLEMENT"
    RESULT_SAVE = "RESULT_SAVE"
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


class CreativeDirection(ApiModel):
    direction_id: str = Field(min_length=1, max_length=120)
    compatible_fact_ids: list[str] = Field(min_length=1, max_length=32)
    creative_direction: str = Field(min_length=1, max_length=240)
    priority_dimensions: list[CreativeDimensionKey] = Field(min_length=2, max_length=2)
    semantic_profile: CreativeSemanticProfile
    avoid_families: list[str] = Field(default_factory=list, max_length=2)

    @model_validator(mode="after")
    def normalize_direction(self) -> CreativeDirection:
        self.compatible_fact_ids = list(dict.fromkeys(self.compatible_fact_ids))
        self.priority_dimensions = list(dict.fromkeys(self.priority_dimensions))
        self.avoid_families = list(
            dict.fromkeys(
                " ".join(item.split())
                for item in self.avoid_families
                if item.strip()
            )
        )
        if len(self.priority_dimensions) != 2:
            raise ValueError("priorityDimensions must contain two distinct dimensions")
        return self


class CreativeDirectionResponse(ApiModel):
    directions: list[CreativeDirection] = Field(min_length=8, max_length=16)


class CreativeDirectionPlan(ApiModel):
    directions: list[CreativeDirection] = Field(min_length=8, max_length=16)
    source_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    plan_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    template_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    reused_checkpoint: bool = False

    @model_validator(mode="after")
    def unique_directions(self) -> CreativeDirectionPlan:
        direction_ids = [item.direction_id for item in self.directions]
        direction_texts = [item.creative_direction.casefold() for item in self.directions]
        if len(set(direction_ids)) != len(direction_ids):
            raise ValueError("creative direction ids must be unique")
        if len(set(direction_texts)) != len(direction_texts):
            raise ValueError("creative directions must be distinct")
        return self

    @property
    def vocabulary(self) -> dict[str, set[str]]:
        profiles = [item.semantic_profile for item in self.directions]
        return {
            "narrative_family": {item.narrative_family for item in profiles},
            "scene_family": {item.scene_family for item in profiles},
            "persona_family": {item.persona_family for item in profiles},
            "product_action_family": {
                item.product_action_family for item in profiles
            },
            "camera_family": {item.camera_family for item in profiles},
            "emotion_family": {item.emotion_family for item in profiles},
        }


class StrategyCheckpoint(ApiModel):
    node_id: NodeId
    source_fingerprint: str = Field(min_length=1, max_length=128)
    allocation_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    template_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    plan: FactVisualStrategy | CreativeDirectionPlan


class CreativeFactAssignment(ApiModel):
    primary_fact_id: str = Field(min_length=1, max_length=120)
    support_fact_ids: list[str] = Field(default_factory=list, max_length=2)
    product_anchor_fact_ids: list[str] = Field(min_length=1, max_length=2)
    product_boundary_fact_ids: list[str] = Field(default_factory=list, max_length=2)
    visual_task_fact_id: str | None = Field(default=None, min_length=1, max_length=120)
    business_context_fact_ids: list[str] = Field(default_factory=list, max_length=2)
    assignment_hash: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def normalize_fact_ids(self) -> CreativeFactAssignment:
        self.support_fact_ids = [
            fact_id
            for fact_id in dict.fromkeys(self.support_fact_ids)
            if fact_id != self.primary_fact_id
        ]
        self.product_anchor_fact_ids = list(dict.fromkeys(self.product_anchor_fact_ids))
        self.product_boundary_fact_ids = list(
            dict.fromkeys(self.product_boundary_fact_ids)
        )
        self.visual_task_fact_id = self.visual_task_fact_id or self.primary_fact_id
        self.business_context_fact_ids = [
            fact_id
            for fact_id in dict.fromkeys(self.business_context_fact_ids)
            if fact_id != self.visual_task_fact_id
        ]
        return self

    @property
    def allowed_fact_ids(self) -> list[str]:
        return list(
            dict.fromkeys(
                [
                    self.primary_fact_id,
                    *(
                        [self.visual_task_fact_id]
                        if self.visual_task_fact_id is not None
                        else []
                    ),
                    *self.support_fact_ids,
                    *self.business_context_fact_ids,
                    *self.product_anchor_fact_ids,
                    *self.product_boundary_fact_ids,
                ]
            )
        )


class CreativeTask(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    ordinal: int = Field(ge=1)
    round: int = Field(ge=0, le=4)
    supplement_kind: Literal["INITIAL", "QUANTITY", "DIVERSITY"] | None = None
    target_duration_seconds: int = Field(ge=4, le=30)
    fact_assignment: CreativeFactAssignment | None = None
    creative_direction: CreativeDirection | None = None
    # Kept only so persisted earlier shard plans remain readable.
    preferred_fact_ids: list[str] = Field(default_factory=list, max_length=12)


class CreativeCandidate(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    ordinal: int = Field(ge=1)
    round: int = Field(ge=0, le=4)
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
    round: int = Field(ge=0, le=4)
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
    semantic_profile: CreativeSemanticProfile | None = None
    hard_issues: list[str] = Field(default_factory=list, max_length=20)
    warnings: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("semantic_profile", mode="before")
    @classmethod
    def tolerate_partial_semantic_profile(cls, value: Any) -> Any:
        if value is None or not isinstance(value, dict):
            return value
        normalized = dict(value)
        fields = (
            ("narrative_family", "narrativeFamily"),
            ("scene_family", "sceneFamily"),
            ("persona_family", "personaFamily"),
            ("product_action_family", "productActionFamily"),
            ("camera_family", "cameraFamily"),
            ("emotion_family", "emotionFamily"),
        )
        for snake_name, alias in fields:
            key = alias if alias in normalized else snake_name
            raw = normalized.get(key)
            if not isinstance(raw, str) or not raw.strip():
                normalized[key] = "OTHER"
        return normalized

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


class CreativeEvaluationDraft(ApiModel):
    """Strict Ark output before Worker-owned deterministic fields are derived."""

    slot_id: str = Field(min_length=1, max_length=160)
    primary_purpose: FragmentType
    compatible_purposes: list[FragmentType] = Field(
        default_factory=list, max_length=3
    )
    fact_evidence: list[FactEvidence] = Field(default_factory=list, max_length=3)
    scores: CreativeScores
    hard_issues: list[str] = Field(default_factory=list, max_length=5)
    warnings: list[str] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def normalize_other_purposes(self) -> CreativeEvaluationDraft:
        # Ark commonly interprets compatible purposes as purposes *other than* the
        # primary one. Keep the model-owned draft unambiguous and let the Worker
        # add primaryPurpose exactly once when constructing the public result.
        self.compatible_purposes = [
            purpose
            for purpose in dict.fromkeys(self.compatible_purposes)
            if purpose != self.primary_purpose
        ]
        self.hard_issues = list(dict.fromkeys(self.hard_issues))
        self.warnings = list(dict.fromkeys(self.warnings))
        return self


class CreativeEvaluationDraftBatch(ApiModel):
    items: list[CreativeEvaluationDraft] = Field(min_length=1, max_length=10)


class CreativeEvaluationBatch(ApiModel):
    items: list[CreativeEvaluation] = Field(min_length=1, max_length=10)


class ClassificationShardPlan(ApiModel):
    round: int = Field(ge=0, le=4)
    shard_index: int = Field(ge=0)
    candidate_ids: list[str] = Field(min_length=1, max_length=10)

    @property
    def key(self) -> str:
        return f"CLASSIFICATION:{self.round}:{self.shard_index}"


class ShardPhase(StrEnum):
    CREATIVE = "CREATIVE"
    CLASSIFICATION = "CLASSIFICATION"


class ShardRecord(ApiModel):
    phase: ShardPhase
    round: int = Field(ge=0, le=4)
    shard_index: int = Field(ge=0)
    status: StageStatus
    creative_plan: list[CreativeTask] = Field(default_factory=list)
    creative_items: list[CreativeCandidate] = Field(default_factory=list)
    classification_plan: list[str] = Field(default_factory=list)
    evaluations: list[CreativeEvaluation] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None
    updated_at: datetime | None = None

    @property
    def key(self) -> str:
        if self.phase == ShardPhase.CREATIVE:
            return f"CREATIVE:{self.round}:{self.shard_index}"
        return f"CLASSIFICATION:{self.round}:{self.shard_index}"


class ShardsResponse(ApiModel):
    run_id: str
    shards: list[ShardRecord] = Field(default_factory=list)


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
