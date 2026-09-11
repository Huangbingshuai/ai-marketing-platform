from __future__ import annotations

import hashlib
import json
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal, NotRequired, TypedDict

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


MIN_PROMPT_COUNT = 10
MAX_PROMPT_COUNT = 100
MAX_CANDIDATE_COUNT = 240
MIN_PROMPT_DURATION_SECONDS = 4
MAX_PROMPT_DURATION_SECONDS = 15


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
    prompt_result_id: str | None


class GraphState(TypedDict):
    project_id: str
    prompt_result_id: NotRequired[str | None]


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
    PRODUCT_DISPLAY = "PRODUCT_DISPLAY"
    EFFECT = "EFFECT"
    CTA = "CTA"


FRAGMENT_TYPE_LABELS: dict[FragmentType, str] = {
    FragmentType.HOOK: "钩子片段",
    FragmentType.PRODUCT_DISPLAY: "产品展示片段",
    FragmentType.EFFECT: "效果片段",
    FragmentType.CTA: "结尾转化片段",
}


class EvidenceMode(StrEnum):
    VISIBLE_ATTRIBUTE = "VISIBLE_ATTRIBUTE"
    USAGE_ACTION = "USAGE_ACTION"
    VISIBLE_RESULT = "VISIBLE_RESULT"
    PROCESS_ONLY = "PROCESS_ONLY"
    TEXT_ONLY = "TEXT_ONLY"


class PromptBatchSettings(ApiModel):
    target_count: int = Field(ge=MIN_PROMPT_COUNT, le=MAX_PROMPT_COUNT)
    default_duration_seconds: int = Field(
        ge=MIN_PROMPT_DURATION_SECONDS,
        le=MAX_PROMPT_DURATION_SECONDS,
    )
    style_mode: Literal["AI_AUTO", "FIXED"] = "AI_AUTO"
    style_tone: str | None = Field(default=None, max_length=120)
    delivery_channel: str = Field(default="抖音", min_length=1, max_length=120)
    disabled_elements: list[str] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def validate_generation_settings(self) -> PromptBatchSettings:
        if self.style_mode == "FIXED" and not (self.style_tone or "").strip():
            raise ValueError("FIXED style mode requires styleTone")
        if self.style_mode == "AI_AUTO" and self.style_tone is not None:
            raise ValueError("AI_AUTO style mode requires null styleTone")
        normalized = _contract_disabled_elements(self.disabled_elements)
        if normalized != self.disabled_elements:
            raise ValueError("disabledElements must be normalized and unique")
        return self


class InsightField(StrEnum):
    SELLING_POINT = "SELLING_POINT"
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
    value: str = Field(min_length=1, max_length=1000)
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
        return list(
            dict.fromkeys(" ".join(value.split()) for value in values if value.strip())
        )


class FactVisualStrategyResponse(ApiModel):
    policies: list[FactVisualPolicyDraft] = Field(min_length=1, max_length=105)


class FactVisualStrategy(ApiModel):
    source_content_hash: str = Field(min_length=1, max_length=128)
    template_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    strategy_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    policies: list[FactVisualPolicyDraft] = Field(min_length=1, max_length=105)

    @property
    def by_id(self) -> dict[str, FactVisualPolicyDraft]:
        return {policy.fact_id: policy for policy in self.policies}


class PromptItem(ApiModel):
    id: str = Field(min_length=1, max_length=160)
    code: str = Field(min_length=1, max_length=40)
    origin: Literal["AI", "MANUAL"]
    fragment_type: FragmentType
    primary_purpose: FragmentType
    compatible_purposes: list[FragmentType] = Field(min_length=1, max_length=4)
    classification_status: Literal["PENDING", "VERIFIED", "NEEDS_REVISION"]
    product_relevance: int = Field(ge=0, le=100)
    target_duration_seconds: int = Field(
        ge=MIN_PROMPT_DURATION_SECONDS,
        le=MAX_PROMPT_DURATION_SECONDS,
    )
    creative_core: str = Field(min_length=1, max_length=160)
    dimensions: CreativeDimensions
    content: str = Field(min_length=1, max_length=12_000)
    insight_bindings: list[InsightBinding] = Field(default_factory=list, max_length=16)
    review_issues: list[str] = Field(default_factory=list, max_length=10)
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
        self.review_issues = list(dict.fromkeys(self.review_issues))
        if self.classification_status == "NEEDS_REVISION" and not self.review_issues:
            raise ValueError("NEEDS_REVISION requires reviewIssues")
        if self.classification_status != "NEEDS_REVISION":
            self.review_issues = []
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
    primary_count: int = Field(ge=0, le=MAX_PROMPT_COUNT)
    compatible_count: int = Field(ge=0, le=MAX_PROMPT_COUNT)


class CreativeAverageScores(ApiModel):
    product_relevance: float = Field(ge=0, le=100)
    creative_coherence: float = Field(ge=0, le=100)
    visual_executability: float = Field(ge=0, le=100)
    commercial_usefulness: float = Field(ge=0, le=100)
    visual_clarity: float = Field(ge=0, le=100)


class SemanticEvaluation(ApiModel):
    status: Literal["PENDING", "VERIFIED"]
    # 生成阶段会先评估扩大后的候选池；最终公共批次仍只会保存
    # 不超过 MAX_PROMPT_COUNT 条已选 Prompt。
    evaluated_count: int = Field(ge=0, le=MAX_CANDIDATE_COUNT)
    duplicate_group_count: int | None = Field(
        default=None, ge=0, le=MAX_CANDIDATE_COUNT
    )
    duplicate_count: int | None = Field(default=None, ge=0, le=MAX_CANDIDATE_COUNT)
    duplicate_rate: float | None = Field(default=None, ge=0, le=100)


class CountMetric(ApiModel):
    code: str = Field(min_length=1, max_length=120)
    count: int = Field(ge=1, le=2_000)


class PromptMetrics(ApiModel):
    target_count: int = Field(ge=MIN_PROMPT_COUNT, le=MAX_PROMPT_COUNT)
    candidate_target_count: int = Field(ge=MIN_PROMPT_COUNT, le=MAX_CANDIDATE_COUNT)
    generated_candidate_count: int = Field(ge=0)
    accepted_count: int = Field(ge=0, le=MAX_PROMPT_COUNT)
    rejected_count: int = Field(ge=0)
    replenishment_rounds: int = Field(ge=0, le=3)
    exact_duplicate_count: int = Field(ge=0)
    semantic_evaluation: SemanticEvaluation
    purpose_distribution: list[PurposeDistribution] = Field(min_length=4, max_length=4)
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
            raise ValueError(
                "sharedConstraints contentHash must match disabledElements"
            )
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


class ProductImageReference(ApiModel):
    file_object_id: str = Field(min_length=1)
    original_file_name: str = Field(min_length=1, max_length=255)
    mime_type: Literal[
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/vnd.adobe.photoshop",
        "application/octet-stream",
    ]
    size_bytes: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")


class PromptGenerationSnapshot(ApiModel):
    project_id: str
    workflow_run_id: str
    product_id: str
    operation: Literal["BATCH_GENERATE", "ITEM_REGENERATE", "ITEM_EVALUATE"]
    target_item_id: str | None = None
    settings: PromptBatchSettings
    insight_artifact: InsightArtifact
    product_images: list[ProductImageReference] = Field(default_factory=list)
    fact_visual_strategy_source_hash: str | None = Field(
        default=None,
        pattern=r"^[0-9a-fA-F]{64}$",
    )
    retained_manual_items: list[PromptItem] = Field(
        default_factory=list, max_length=200
    )
    selection_policy: Literal["MMR_CONTENT"]
    similarity_anchors: list[PromptItem] = Field(default_factory=list, max_length=200)
    shared_prompt: SharedPrompt | None = None
    base_result_id: str | None = None
    base_result_revision: int | None = Field(default=None, ge=1)
    target_item: PromptItem | None = None
    target_item_index: int | None = Field(default=None, ge=0, le=199)
    regeneration_target_duration_seconds: int | None = Field(
        default=None,
        ge=MIN_PROMPT_DURATION_SECONDS,
        le=MAX_PROMPT_DURATION_SECONDS,
    )
    replacement_dimensions: CreativeDimensions | None = None
    regeneration_instruction: str | None = Field(default=None, max_length=500)
    regeneration_mode: (
        Literal[
            "FULL_REGENERATE",
            "AUTO_DIVERSE",
            "PRESERVE_PRODUCT_RELATION",
            "NEW_CREATIVE",
            "CUSTOM",
        ]
        | None
    ) = None
    regeneration_reasons: list[
        Literal[
            "PRODUCT_RELATION_WEAK",
            "CREATIVE_ORDINARY",
            "TOO_SIMILAR",
            "SCENE_UNSUITABLE",
            "ACTION_UNREASONABLE",
            "CAMERA_TOO_COMPLEX",
            "CUSTOM",
        ]
    ] = Field(default_factory=list, max_length=7)
    preserved_dimensions: list[
        Literal["narrative", "scene", "persona", "productRelation", "camera", "emotion"]
    ] = Field(default_factory=list, max_length=6)

    @field_validator("regeneration_instruction")
    @classmethod
    def clean_regeneration_instruction(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        return cleaned or None

    @model_validator(mode="after")
    def validate_operation(self) -> PromptGenerationSnapshot:
        if self.product_images and self.fact_visual_strategy_source_hash is None:
            raise ValueError(
                "factVisualStrategySourceHash is required when productImages are present"
            )
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
            or self.regeneration_target_duration_seconds is not None
            or self.regeneration_instruction is not None
            or self.regeneration_mode is not None
            or self.regeneration_reasons
            or self.preserved_dimensions
        ):
            raise ValueError(
                "batch generation cannot contain item regeneration settings"
            )
        if (
            self.operation != "ITEM_EVALUATE"
            and len(self.retained_manual_items) > self.settings.target_count
        ):
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


class CreativeDirectionFactApplication(ApiModel):
    fact_id: str = Field(min_length=1, max_length=120)
    creative_usage: str = Field(min_length=4, max_length=180)


class CreativeTerritoryAction(ApiModel):
    action_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    label: str = Field(min_length=2, max_length=80)
    boundary: str = Field(min_length=4, max_length=160)


class CreativeTerritoryFactCompatibility(ApiModel):
    fact_id: str = Field(min_length=1, max_length=120)
    natural_usage: str = Field(min_length=4, max_length=120)
    unsupported_conditions: list[str] = Field(default_factory=list, max_length=4)

    @field_validator("unsupported_conditions")
    @classmethod
    def clean_unsupported_conditions(cls, values: list[str]) -> list[str]:
        return list(
            dict.fromkeys(" ".join(item.split()) for item in values if item.strip())
        )


class CreativeTerritoryDraft(ApiModel):
    territory_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    label: str = Field(min_length=2, max_length=80)
    compatible_fact_ids: list[str] = Field(min_length=1, max_length=64)
    fact_compatibilities: list[CreativeTerritoryFactCompatibility] = Field(
        max_length=64,
    )
    required_fact_ids: list[str] = Field(default_factory=list, max_length=64)
    scene_boundary: str = Field(min_length=4, max_length=180)
    actions: list[CreativeTerritoryAction] = Field(min_length=1, max_length=8)
    differentiation_goal: str = Field(min_length=4, max_length=180)

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_fact_compatibilities(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        migrated = dict(value)
        if (
            "factCompatibilities" not in migrated
            and "fact_compatibilities" not in migrated
        ):
            # Historical checkpoints remain parseable, then current landscape
            # validation rejects the empty guidance and replans with the new
            # required structured-output field.
            migrated["factCompatibilities"] = []
        return migrated

    @model_validator(mode="after")
    def unique_ids(self) -> CreativeTerritoryDraft:
        self.compatible_fact_ids = list(dict.fromkeys(self.compatible_fact_ids))
        self.required_fact_ids = list(dict.fromkeys(self.required_fact_ids))
        self.fact_compatibilities = list(
            {item.fact_id: item for item in self.fact_compatibilities}.values()
        )
        action_ids = [item.action_id for item in self.actions]
        if len(set(action_ids)) != len(action_ids):
            raise ValueError("creative territory action ids must be unique")
        return self


class CreativeTerritory(CreativeTerritoryDraft):
    required_fact_ids: list[str] = Field(default_factory=list, max_length=64)
    target_slots: int = Field(ge=1, le=32)


class CreativeDiversityLandscapeResponse(ApiModel):
    territories: list[CreativeTerritoryDraft] = Field(min_length=1, max_length=10)


class CreativeFactTerritoryAssignment(ApiModel):
    fact_id: str = Field(min_length=1, max_length=120)
    territory_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    natural_usage: str = Field(min_length=4, max_length=120)
    unsupported_conditions: list[str] = Field(default_factory=list, max_length=4)


class CreativeFactTerritoryAssignmentResponse(ApiModel):
    assignments: list[CreativeFactTerritoryAssignment] = Field(
        min_length=0,
        max_length=100,
    )


class CreativeLandscapeFactIssue(ApiModel):
    territory_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    fact_id: str = Field(min_length=1, max_length=120)
    verdict: Literal["WEAK", "UNSUPPORTED"]
    reason: str = Field(min_length=2, max_length=180)


class CreativeTerritoryAuditResponse(ApiModel):
    territory_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    fact_issues: list[CreativeLandscapeFactIssue] = Field(
        default_factory=list,
        max_length=64,
    )
    summary: str = Field(default="", max_length=180)

    @model_validator(mode="after")
    def normalize_summary(self) -> CreativeTerritoryAuditResponse:
        if not self.summary.strip():
            self.summary = (
                "发现需调整的事实关系" if self.fact_issues else "创意空间复核完成"
            )
        return self


class CreativeLandscapeAuditResponse(ApiModel):
    reviewed_territory_ids: list[str] = Field(min_length=1, max_length=10)
    fact_issues: list[CreativeLandscapeFactIssue] = Field(
        default_factory=list,
        max_length=64,
    )
    requires_revision: bool
    revision_territory_ids: list[str] = Field(default_factory=list, max_length=10)
    summary: str = Field(min_length=2, max_length=240)

    @model_validator(mode="after")
    def normalize_revision_ids(self) -> CreativeLandscapeAuditResponse:
        self.revision_territory_ids = list(dict.fromkeys(self.revision_territory_ids))
        if self.requires_revision and not self.revision_territory_ids:
            raise ValueError("landscape audit revision requires territory ids")
        if not self.requires_revision:
            self.revision_territory_ids = []
        return self


class CreativeLandscapeAudit(ApiModel):
    reviewed_territory_ids: list[str] = Field(min_length=1, max_length=10)
    fact_issues: list[CreativeLandscapeFactIssue] = Field(
        default_factory=list,
        max_length=64,
    )
    requires_revision: bool = False
    revision_territory_ids: list[str] = Field(default_factory=list, max_length=10)
    summary: str = Field(min_length=2, max_length=240)
    audit_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class CreativeDiversityLandscape(ApiModel):
    territories: list[CreativeTerritory] = Field(min_length=1, max_length=10)
    source_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    landscape_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    template_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    semantic_audit: CreativeLandscapeAudit | None = None

    @property
    def by_id(self) -> dict[str, CreativeTerritory]:
        return {item.territory_id: item for item in self.territories}


class CreativeExecutionRoute(ApiModel):
    """One AI-authored visual-event route for a direction sibling.

    The Worker treats these values as opaque creative text.  It only preserves
    stable route IDs and assigns different routes deterministically.
    """

    route_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    visual_event: str = Field(min_length=4, max_length=160)
    event_outline: str | None = Field(default=None, min_length=4, max_length=100)
    scene_relation: str = Field(min_length=4, max_length=120)
    product_action: str = Field(min_length=4, max_length=120)
    ending_state: str = Field(min_length=4, max_length=120)


class CreativeDirection(ApiModel):
    direction_id: str = Field(min_length=1, max_length=120)
    territory_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    primary_action_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    proposed_action: CreativeTerritoryAction | None = None
    fact_applications: list[CreativeDirectionFactApplication] = Field(
        min_length=1,
        max_length=4,
    )
    creative_direction: str = Field(min_length=1, max_length=240)
    priority_dimensions: list[CreativeDimensionKey] = Field(min_length=2, max_length=2)
    semantic_profile: CreativeSemanticProfile
    avoid_families: list[str] = Field(default_factory=list, max_length=2)
    execution_routes: list[CreativeExecutionRoute] = Field(
        default_factory=list,
        max_length=5,
    )

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_fact_ids(cls, value: Any) -> Any:
        """Keep old checkpoints readable without exposing the old output schema."""

        if not isinstance(value, dict):
            return value
        migrated = dict(value)
        if "territoryId" not in migrated and "territory_id" not in migrated:
            migrated["territoryId"] = "LEGACY_TERRITORY"
        if "primaryActionId" not in migrated and "primary_action_id" not in migrated:
            migrated["primaryActionId"] = "LEGACY_ACTION"
        avoid_key = (
            "avoidFamilies" if "avoidFamilies" in migrated else "avoid_families"
        )
        raw_avoid_families = migrated.get(avoid_key)
        if isinstance(raw_avoid_families, list):
            # Ark occasionally returns more than the requested two avoidance hints.
            # Keeping the first two is a structural limit only; it does not ask the
            # Worker to interpret or rewrite their business meaning.
            migrated[avoid_key] = raw_avoid_families[:2]
        if "factApplications" in migrated or "fact_applications" in migrated:
            return migrated
        legacy_ids = list(
            migrated.pop("compatibleFactIds", None)
            or migrated.pop("compatible_fact_ids", None)
            or []
        )
        migrated["factApplications"] = [
            {
                "factId": fact_id,
                "creativeUsage": "历史方向仅记录了兼容事实，当前任务会重新规划事实用法",
            }
            for fact_id in dict.fromkeys(legacy_ids)
            if fact_id
        ]
        return migrated

    @model_validator(mode="after")
    def normalize_direction(self) -> CreativeDirection:
        self.fact_applications = list(
            {item.fact_id: item for item in self.fact_applications}.values()
        )
        self.priority_dimensions = list(dict.fromkeys(self.priority_dimensions))
        self.avoid_families = list(
            dict.fromkeys(
                " ".join(item.split()) for item in self.avoid_families if item.strip()
            )
        )
        if len(self.priority_dimensions) != 2:
            raise ValueError("priorityDimensions must contain two distinct dimensions")
        route_ids = [item.route_id for item in self.execution_routes]
        if len(route_ids) != len(set(route_ids)):
            raise ValueError("executionRoutes must use distinct route ids")
        return self

    @property
    def fact_ids(self) -> list[str]:
        return [item.fact_id for item in self.fact_applications]


class CreativeDirectionResponse(ApiModel):
    # A large batch may use up to 80 base directions. Planning is split by
    # territory before the compact all-batch overlap audit.
    directions: list[CreativeDirection] = Field(min_length=1, max_length=80)


class CreativeDirectionFactAudit(ApiModel):
    fact_id: str = Field(min_length=1, max_length=120)
    verdict: Literal["NATURAL", "WEAK", "UNSUPPORTED"]
    reason: str = Field(min_length=2, max_length=500)


class CreativeDirectionAuditItem(ApiModel):
    direction_id: str = Field(min_length=1, max_length=120)
    realized_territory_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    realized_action_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    aligned: bool
    fact_reviews: list[CreativeDirectionFactAudit] | None = None
    issues: list[str] = Field(default_factory=list)

    @field_validator("issues")
    @classmethod
    def clean_issues(cls, values: list[str]) -> list[str]:
        return list(
            dict.fromkeys(" ".join(item.split()) for item in values if item.strip())
        )[:4]


class CreativeDirectionAuditResponse(ApiModel):
    items: list[CreativeDirectionAuditItem] = Field(min_length=1, max_length=80)
    requires_revision: bool
    revision_direction_ids: list[str] = Field(default_factory=list, max_length=80)
    summary: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def normalize_revision_ids(self) -> CreativeDirectionAuditResponse:
        self.revision_direction_ids = list(dict.fromkeys(self.revision_direction_ids))
        if not self.summary.strip():
            self.summary = (
                "发现需修订的创意方向"
                if self.requires_revision
                else "创意方向复核完成"
            )
        return self


class CreativeDirectionAudit(ApiModel):
    # Full plans still require 8+ directions; supplementary review batches can
    # contain just one or two. Their exact IDs are validated against the input.
    items: list[CreativeDirectionAuditItem] = Field(min_length=1, max_length=80)
    requires_revision: bool = False
    revision_direction_ids: list[str] = Field(default_factory=list, max_length=80)
    summary: str = Field(min_length=2, max_length=240)
    audit_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class CreativeDirectionOverlapGroup(ApiModel):
    group_id: str = Field(pattern=r"^[A-Z][A-Z0-9_]{1,63}$")
    direction_ids: list[str] = Field(min_length=2, max_length=80)
    repeated_visual_core: str = Field(min_length=4, max_length=240)
    revision_direction_ids: list[str] = Field(min_length=1, max_length=79)
    diversification_goal: str = Field(min_length=4, max_length=240)

    @model_validator(mode="after")
    def normalize_direction_ids(self) -> CreativeDirectionOverlapGroup:
        self.direction_ids = list(dict.fromkeys(self.direction_ids))
        self.revision_direction_ids = list(dict.fromkeys(self.revision_direction_ids))
        if len(self.direction_ids) < 2:
            raise ValueError("direction overlap group requires at least two directions")
        if not set(self.revision_direction_ids).issubset(self.direction_ids):
            raise ValueError("overlap revision ids must belong to the overlap group")
        return self


class CreativeDirectionCanonicalProfile(ApiModel):
    direction_id: str = Field(min_length=1, max_length=120)
    semantic_profile: CreativeSemanticProfile


class CreativeDirectionDiversityAuditResponse(ApiModel):
    groups: list[CreativeDirectionOverlapGroup] = Field(
        default_factory=list, max_length=40
    )
    requires_revision: bool
    revision_direction_ids: list[str] = Field(default_factory=list, max_length=80)
    canonical_profiles: list[CreativeDirectionCanonicalProfile] = Field(
        default_factory=list,
        max_length=80,
    )
    summary: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def normalize_revision_ids(self) -> CreativeDirectionDiversityAuditResponse:
        grouped_revision_ids = [
            direction_id
            for group in self.groups
            for direction_id in group.revision_direction_ids
        ]
        self.revision_direction_ids = list(
            dict.fromkeys([*self.revision_direction_ids, *grouped_revision_ids])
        )
        self.requires_revision = bool(self.revision_direction_ids)
        canonical_direction_ids = [
            item.direction_id for item in self.canonical_profiles
        ]
        if len(canonical_direction_ids) != len(set(canonical_direction_ids)):
            raise ValueError("canonical profiles must use unique direction ids")
        if not self.summary.strip():
            self.summary = (
                "发现需分散的重复方向"
                if self.requires_revision
                else "全批方向重复复核完成"
            )
        return self


class CreativeDirectionDiversityAudit(CreativeDirectionDiversityAuditResponse):
    audit_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class CreativeDirectionReviewProgress(ApiModel):
    """Internal same-Run recovery data, never a public result or AI input."""

    run_id: str
    request_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    planning_attempt: int = Field(ge=0, le=3)
    semantic_revision_count: int = Field(ge=0, le=1)
    completed_batches: dict[str, CreativeDirectionAuditResponse] = Field(
        default_factory=dict, max_length=128
    )


class CreativeDirectionPlan(ApiModel):
    directions: list[CreativeDirection] = Field(min_length=8, max_length=80)
    source_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    plan_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    template_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    landscape: CreativeDiversityLandscape | None = None
    semantic_audit: CreativeDirectionAudit | None = None
    diversity_audit: CreativeDirectionDiversityAudit | None = None
    reused_checkpoint: bool = False
    review_progress: CreativeDirectionReviewProgress | None = None

    @model_validator(mode="after")
    def unique_directions(self) -> CreativeDirectionPlan:
        direction_ids = [item.direction_id for item in self.directions]
        direction_texts = [
            item.creative_direction.casefold() for item in self.directions
        ]
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
            "product_action_family": {item.product_action_family for item in profiles},
            "camera_family": {item.camera_family for item in profiles},
            "emotion_family": {item.emotion_family for item in profiles},
        }


class MaterialBrief(ApiModel):
    """One AI-authored material task, not a territory/direction quota."""

    task_id: str = Field(min_length=1, max_length=80)
    fact_ids: list[str] = Field(min_length=1, max_length=100)
    visual_event: str = Field(min_length=4, max_length=240)
    difference: str = Field(min_length=4, max_length=160)
    priority_dimensions: list[CreativeDimensionKey] = Field(default_factory=list, max_length=3)


class MaterialPlanResponse(ApiModel):
    tasks: list[MaterialBrief] = Field(min_length=1, max_length=100)


class MaterialPlanRound(ApiModel):
    round: int = Field(ge=0, le=4)
    request_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    tasks: list[MaterialBrief] = Field(max_length=100)


class MaterialBatchPlan(ApiModel):
    source_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    template_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    rounds: list[MaterialPlanRound] = Field(default_factory=list, max_length=5)


class StrategyCheckpoint(ApiModel):
    node_id: NodeId
    source_fingerprint: str = Field(min_length=1, max_length=128)
    allocation_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    template_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    plan: FactVisualStrategy | CreativeDirectionPlan | MaterialBatchPlan


class CreativeFactAssignment(ApiModel):
    fact_ids: list[str] = Field(min_length=1, max_length=100)
    assignment_hash: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_roles(cls, value: Any) -> Any:
        """Read persisted focus and multi-role plans without writing those shapes."""

        if not isinstance(value, dict) or ("factIds" in value or "fact_ids" in value):
            return value
        current_ids = list(
            value.get("allowedFactIds") or value.get("allowed_fact_ids") or []
        )
        current_focus = value.get("focusFactId") or value.get("focus_fact_id")
        business_context = list(
            value.get("businessContextFactIds")
            or value.get("business_context_fact_ids")
            or []
        )
        legacy_groups = (
            business_context,
            [
                legacy_primary
                for legacy_primary in [
                    value.get("primaryFactId") or value.get("primary_fact_id"),
                    value.get("visualTaskFactId") or value.get("visual_task_fact_id"),
                ]
                if legacy_primary
            ],
            list(value.get("supportFactIds") or value.get("support_fact_ids") or []),
            list(
                value.get("productAnchorFactIds")
                or value.get("product_anchor_fact_ids")
                or []
            ),
            list(
                value.get("productBoundaryFactIds")
                or value.get("product_boundary_fact_ids")
                or []
            ),
        )
        return {
            "factIds": list(
                dict.fromkeys(
                    [
                        *([current_focus] if current_focus else []),
                        *current_ids,
                        *[
                            fact_id
                            for group in legacy_groups
                            for fact_id in group
                            if fact_id
                        ],
                    ]
                )
            )[:8],
            "assignmentHash": value.get("assignmentHash")
            or value.get("assignment_hash"),
        }

    @model_validator(mode="after")
    def normalize_fact_ids(self) -> CreativeFactAssignment:
        self.fact_ids = list(dict.fromkeys(self.fact_ids))
        return self


class CreativeTask(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    ordinal: int = Field(ge=1)
    round: int = Field(ge=0, le=4)
    supplement_kind: Literal["INITIAL", "QUANTITY", "COVERAGE", "DIVERSITY"] | None = (
        None
    )
    target_duration_seconds: int = Field(
        ge=MIN_PROMPT_DURATION_SECONDS,
        le=MAX_PROMPT_DURATION_SECONDS,
    )
    fact_assignment: CreativeFactAssignment | None = None
    material_brief: MaterialBrief | None = None
    creative_direction: CreativeDirection | None = None
    execution_route: CreativeExecutionRoute | None = None
    sibling_variant_index: int = Field(default=1, ge=1, le=32)
    sibling_variant_total: int = Field(default=1, ge=1, le=32)
    regeneration_variant_role: (
        Literal[
            "PRESENTATION_VARIATION",
            "PRODUCT_FOCUS_VARIATION",
            "FEEDBACK_OPTIMIZATION",
        ]
        | None
    ) = None
    # A coverage supplement uses these assigned facts as the explicit repair
    # target. The model owns the semantic realization; the Worker only carries
    # and validates stable fact IDs.
    coverage_focus_fact_ids: list[str] = Field(default_factory=list, max_length=12)
    # Kept only so persisted earlier shard plans remain readable.
    preferred_fact_ids: list[str] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def normalize_coverage_focus_fact_ids(self) -> CreativeTask:
        self.coverage_focus_fact_ids = list(dict.fromkeys(self.coverage_focus_fact_ids))
        if self.fact_assignment is not None:
            assigned = set(self.fact_assignment.fact_ids)
            if any(fact_id not in assigned for fact_id in self.coverage_focus_fact_ids):
                raise ValueError(
                    "coverageFocusFactIds must be contained in factAssignment"
                )
        if self.sibling_variant_index > self.sibling_variant_total:
            raise ValueError("siblingVariantIndex cannot exceed siblingVariantTotal")
        if self.execution_route is not None and self.creative_direction is None:
            raise ValueError("executionRoute requires creativeDirection")
        if (
            self.execution_route is not None
            and self.creative_direction is not None
            and self.execution_route.route_id
            not in {item.route_id for item in self.creative_direction.execution_routes}
        ):
            raise ValueError("executionRoute must belong to creativeDirection")
        return self


class MaterialShotOverview(ApiModel):
    visual_intent: str = Field(min_length=1, max_length=160)
    visual_style: str = Field(min_length=1, max_length=120)


class MaterialShotScene(ApiModel):
    environment: str = Field(min_length=1, max_length=180)
    lighting: str = Field(min_length=1, max_length=120)
    initial_state: str = Field(min_length=1, max_length=240)


class MaterialShotBeat(ApiModel):
    sequence: int = Field(ge=1, le=6)
    duration_weight: int = Field(default=1, ge=1, le=5)
    framing: str = Field(min_length=1, max_length=100)
    action: str = Field(min_length=1, max_length=320)
    camera: str = Field(min_length=1, max_length=180)
    focus: str | None = Field(default=None, min_length=1, max_length=120)
    motion_source: str | None = Field(default=None, min_length=1, max_length=160)
    visible_result: str = Field(min_length=1, max_length=200)
    sound: str | None = Field(default=None, max_length=160)

    @field_validator("focus", "motion_source")
    @classmethod
    def normalize_optional_json_null(cls, value: str | None) -> str | None:
        # Protocol placeholder only. Do not infer a missing focus or movement.
        if isinstance(value, str) and value.strip().casefold() == "null":
            return None
        return value

    @field_validator("sound")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.split()).strip()
        if normalized.casefold() in {"null", "none", "n/a", "na"} or normalized in {
            "无",
            "没有",
            "不适用",
        }:
            return None
        return normalized or None


class MaterialShotPlan(ApiModel):
    overview: MaterialShotOverview
    scene: MaterialShotScene
    beats: list[MaterialShotBeat] = Field(min_length=1, max_length=6)
    final_frame: str = Field(min_length=1, max_length=240)

    @model_validator(mode="after")
    def validate_beat_sequence(self) -> MaterialShotPlan:
        sequence = [beat.sequence for beat in self.beats]
        if sequence != list(range(1, len(self.beats) + 1)):
            raise ValueError("shot plan beat sequence must be contiguous from 1")
        return self


class CreativeCandidateDraft(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    ordinal: int = Field(ge=1)
    round: int = Field(ge=0, le=4)
    creative_core: str = Field(min_length=1, max_length=160)
    declared_fact_ids: list[str] = Field(min_length=1, max_length=100)
    dimensions: CreativeDimensions
    shot_plan: MaterialShotPlan

    @field_validator("declared_fact_ids")
    @classmethod
    def unique_fact_ids(cls, values: list[str]) -> list[str]:
        result = list(dict.fromkeys(values))
        if not result:
            raise ValueError("declaredFactIds cannot be empty")
        return result


class CreativeCandidateDraftBatch(ApiModel):
    items: list[CreativeCandidateDraft] = Field(min_length=1, max_length=5)


class CreativeCandidate(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    ordinal: int = Field(ge=1)
    round: int = Field(ge=0, le=4)
    creative_core: str = Field(min_length=1, max_length=160)
    declared_fact_ids: list[str] = Field(min_length=1, max_length=100)
    dimensions: CreativeDimensions
    content: str = Field(min_length=20, max_length=12_000)
    shot_plan: MaterialShotPlan | None = None
    generated_at: datetime | None = None

    @model_validator(mode="before")
    @classmethod
    def discard_legacy_generation_evidence(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        migrated = dict(value)
        # Persisted shards from the previous internal contract may still carry
        # literal quote evidence. It never affected the public Prompt result and
        # is deliberately discarded: generation declares its assigned fact IDs,
        # while the independent evaluator owns all semantic realization checks.
        for key in (
            "factEvidence",
            "fact_evidence",
            "focusFactId",
            "focus_fact_id",
            "focusFactEvidence",
            "focus_fact_evidence",
        ):
            migrated.pop(key, None)
        return migrated

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
    evidence_text: str | None = Field(default=None, max_length=160)
    evidence_source: (
        Literal[
            "CONTENT",
            "CREATIVE_CORE",
            "NARRATIVE",
            "SCENE",
            "PERSONA",
            "PRODUCT_RELATION",
        ]
        | None
    ) = None
    support_level: Literal["EXACT", "SEMANTIC_FULL", "PARTIAL", "NONE"] = "EXACT"

    @field_validator("evidence_source", mode="before")
    @classmethod
    def discard_unknown_evidence_source(cls, value: Any) -> Any:
        """Treat an unknown optional transport label as omitted evidence metadata."""

        if value is None:
            return None
        normalized = str(value).strip().upper()
        allowed = {
            "CONTENT",
            "CREATIVE_CORE",
            "NARRATIVE",
            "SCENE",
            "PERSONA",
            "PRODUCT_RELATION",
        }
        return normalized if normalized in allowed else None


class AbstractVisualProofFinding(ApiModel):
    """Model-owned semantic diagnosis with auditable candidate evidence."""

    fact_id: str = Field(min_length=1, max_length=120)
    evidence_text: str = Field(min_length=1, max_length=160)
    evidence_source: Literal[
        "CONTENT",
        "CREATIVE_CORE",
        "NARRATIVE",
        "SCENE",
        "PERSONA",
        "PRODUCT_RELATION",
    ]
    violated_policy: Literal[
        "CONTEXT_ONLY",
        "TEXT_ONLY",
        "FORBIDDEN_VISUAL_PROOF",
    ]


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


ShotRepairField = Literal[
    "FRAMING", "ACTION", "CAMERA", "FOCUS", "MOTION_SOURCE", "VISIBLE_RESULT",
    "INITIAL_STATE", "FINAL_FRAME",
]


class ExecutionFinding(ApiModel):
    code: Literal["CAMERA_ACTION_MISMATCH", "VISUALLY_UNEXECUTABLE"]
    sequence: int = Field(ge=0, le=6)
    field: ShotRepairField
    diagnosis: str = Field(min_length=1, max_length=180)


class ShotFieldPatch(ApiModel):
    sequence: int = Field(ge=0, le=6)
    field: ShotRepairField
    value: str = Field(min_length=1, max_length=320)


class ExecutionRepairDraft(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    patches: list[ShotFieldPatch] = Field(min_length=1, max_length=12)
    camera_dimension: str | None = Field(default=None, min_length=1, max_length=160)


class ExecutionRepairCheckpoint(ApiModel):
    original_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    status: Literal["STARTED", "ACCEPTED", "KEPT_ORIGINAL"]
    candidate: CreativeCandidate | None = None


class CreativeEvaluation(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    primary_purpose: FragmentType
    compatible_purposes: list[FragmentType] = Field(min_length=1, max_length=4)
    fact_evidence: list[FactEvidence] = Field(default_factory=list, max_length=12)
    realized_fact_ids: list[str] = Field(default_factory=list, max_length=12)
    scores: CreativeScores
    semantic_signature: str = Field(min_length=1, max_length=240)
    visual_signature: str = Field(min_length=1, max_length=240)
    semantic_profile: CreativeSemanticProfile | None = None
    abstract_visual_proof_findings: list[AbstractVisualProofFinding] = Field(
        default_factory=list,
        max_length=5,
    )
    hard_issues: list[str] = Field(default_factory=list, max_length=20)
    warnings: list[str] = Field(default_factory=list, max_length=20)
    execution_findings: list[ExecutionFinding] = Field(default_factory=list, max_length=3)
    execution_repair: ExecutionRepairCheckpoint | None = None
    inferred_creative_core: str | None = Field(
        default=None, min_length=1, max_length=160
    )
    inferred_dimensions: CreativeDimensions | None = None

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
        evidence_ids = list(
            dict.fromkeys(
                item.fact_id
                for item in self.fact_evidence
                if item.support_level in {"EXACT", "SEMANTIC_FULL"}
            )
        )
        if list(dict.fromkeys(self.realized_fact_ids)) != evidence_ids:
            raise ValueError("realizedFactIds must match factEvidence")
        self.compatible_purposes = purposes
        self.realized_fact_ids = evidence_ids
        self.abstract_visual_proof_findings = list(
            {
                (
                    item.fact_id,
                    item.evidence_source,
                    item.evidence_text,
                    item.violated_policy,
                ): item
                for item in self.abstract_visual_proof_findings
            }.values()
        )
        self.hard_issues = list(dict.fromkeys(self.hard_issues))
        self.warnings = list(dict.fromkeys(self.warnings))
        return self


class CreativeEvaluationDraft(ApiModel):
    """Strict Ark output before Worker-owned deterministic fields are derived."""

    slot_id: str = Field(min_length=1, max_length=160)
    primary_purpose: FragmentType
    # Accept a primary-inclusive response too; normalization below only removes
    # duplicate IDs/the primary ID, never infers another purpose.
    compatible_purposes: list[FragmentType] = Field(default_factory=list, max_length=4)
    fact_evidence: list[FactEvidence] = Field(default_factory=list, max_length=100)
    scores: CreativeScores
    semantic_profile: CreativeSemanticProfile | None = None
    abstract_visual_proof_findings: list[AbstractVisualProofFinding] = Field(
        default_factory=list,
        max_length=5,
    )
    hard_issues: list[str] = Field(default_factory=list, max_length=5)
    warnings: list[str] = Field(default_factory=list, max_length=3)
    execution_findings: list[ExecutionFinding] = Field(default_factory=list, max_length=3)
    inferred_creative_core: str | None = Field(
        default=None,
        min_length=1,
        max_length=160,
    )
    inferred_dimensions: CreativeDimensions | None = None

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
        self.abstract_visual_proof_findings = list(
            {
                (
                    item.fact_id,
                    item.evidence_source,
                    item.evidence_text,
                    item.violated_policy,
                ): item
                for item in self.abstract_visual_proof_findings
            }.values()
        )
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
    prompt_result_id: str | None = None


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
