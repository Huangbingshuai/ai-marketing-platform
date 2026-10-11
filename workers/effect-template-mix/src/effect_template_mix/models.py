from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Role = Literal["HOOK", "PAIN_POINT", "PRODUCT", "SELLING_POINT", "TRANSFORMATION", "END"]


class QueueMessage(BaseModel):
    schemaVersion: Literal[1]
    projectId: str
    runId: str
    requestId: str


class Slot(BaseModel):
    id: str
    role: Role
    label: str
    duration: float = Field(gt=0)


class Material(BaseModel):
    id: str
    code: str
    name: str
    duration: float = Field(gt=0)
    promptId: str
    prompt: str
    promptSummary: str | None = None
    artifactId: str
    artifactKey: str
    artifactRevision: int
    contentHash: str
    fileObjectId: str


class VideoImportMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal[2]
    taskType: Literal["VIDEO_IMPORT_DESCRIPTION"]
    projectId: str
    runId: str
    requestId: str


class VideoImportClaim(BaseModel):
    claimed: bool
    attemptToken: str | None = None
    durationSeconds: float | None = Field(default=None, ge=4, le=30)
    mimeType: str | None = None
    sizeBytes: int | None = Field(default=None, gt=0, le=512 * 1024 * 1024)
    contentHash: str | None = None


class VideoImportFailure(BaseModel):
    model_config = ConfigDict(extra="forbid")
    projectId: str
    failureCode: Literal["VIDEO_READ_FAILED", "VIDEO_INTEGRITY_FAILED", "FRAME_EXTRACTION_FAILED", "AI_TIMEOUT", "AI_CONNECTION_FAILED", "AI_RATE_LIMITED", "AI_SERVICE_FAILED", "AI_OUTPUT_TRUNCATED", "AI_OUTPUT_INVALID", "TEMPLATE_INVALID", "TASK_TIMEOUT", "TASK_INTERRUPTED", "UNKNOWN"]


class VideoImportDimensions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    narrative: str = Field(min_length=1, max_length=120)
    scene: str = Field(min_length=1, max_length=120)
    persona: str = Field(min_length=1, max_length=160)
    productRelation: str = Field(min_length=1, max_length=240)
    camera: str = Field(min_length=1, max_length=160)
    emotion: str = Field(min_length=1, max_length=120)


class VideoImportDescription(BaseModel):
    model_config = ConfigDict(extra="forbid")
    promptText: str = Field(min_length=1, max_length=4000)
    primaryPurpose: Literal["HOOK", "PRODUCT_DISPLAY", "EFFECT", "CTA"]
    compatiblePurposes: list[Literal["HOOK", "PRODUCT_DISPLAY", "EFFECT", "CTA"]] = Field(min_length=1, max_length=4)
    creativeCore: str = Field(min_length=1, max_length=160)
    dimensions: VideoImportDimensions

    @model_validator(mode="after")
    def validate_purposes(self) -> "VideoImportDescription":
        if not self.promptText.strip() or not self.creativeCore.strip() or any(not value.strip() for value in self.dimensions.model_dump().values()) or len(set(self.compatiblePurposes)) != len(self.compatiblePurposes) or self.primaryPurpose not in self.compatiblePurposes:
            raise ValueError("description and consistent unique purposes required")
        return self


class IncrementalInput(BaseModel):
    materialIds: list[str]
    oldVariantIds: list[str]
    packageNewVariants: bool
    combinationStrategy: Literal["ADAPTIVE"] | None = None
    emptySlotPolicy: Literal["ALLOW_EMPTY_POOLS"] | None = None


class IncrementalBinding(BaseModel):
    slotId: str
    materialId: str


class IncrementalVariant(BaseModel):
    difference: str = Field(min_length=1, max_length=1000)
    bindings: list[IncrementalBinding]


class OmittedMaterial(BaseModel):
    materialId: str
    reason: str


class IncrementalPlan(BaseModel):
    variants: list[IncrementalVariant]
    omitted: list[OmittedMaterial]


class IncrementalReview(BaseModel):
    acceptedIndexes: list[int]
    reason: str


class Snapshot(BaseModel):
    durationFilteredImports: bool = False
    durationFilteredMaterials: bool = False
    schemaVersion: Literal[1]
    template: dict[str, Any]
    draftRevision: int
    targetVariantId: str | None
    materialRoleAssignments: dict[str, Role] = Field(default_factory=dict)
    manualMaterialRoles: dict[str, Role] = Field(default_factory=dict)
    trimOnly: bool = False
    lockedBindings: list[dict[str, Any]]
    reuseCounts: dict[str, int] = Field(default_factory=dict)
    promptArtifacts: list[dict[str, Any]]
    materials: list[Material]
    incremental: IncrementalInput | None = None
    maxOutputVariants: int = Field(default=100, ge=1, le=100)
    requireAllMaterials: bool = False
    replaceExistingVariants: bool = False
    existingVariantBindings: list[list[IncrementalBinding]] = Field(default_factory=list)

    @property
    def slots(self) -> list[Slot]:
        return [Slot.model_validate(item) for item in self.template["slots"]]


class Claim(BaseModel):
    terminal: bool
    attemptToken: str | None = None
    snapshot: Snapshot | None = None
    checkpoint: dict[str, Any] | None = None


class Scores(BaseModel):
    HOOK: float = Field(ge=0, le=1)
    PAIN_POINT: float = Field(ge=0, le=1)
    PRODUCT: float = Field(ge=0, le=1)
    SELLING_POINT: float = Field(ge=0, le=1)
    TRANSFORMATION: float = Field(ge=0, le=1)
    END: float = Field(ge=0, le=1)


class Classification(BaseModel):
    materialId: str
    source: Literal["AI", "MANUAL"] = "AI"
    scores: Scores
    reasons: dict[Role, str]


class ClassificationResult(BaseModel):
    classifications: list[Classification]


class ClassificationCheckpoint(BaseModel):
    classifications: list[Classification]
    progress: int = Field(ge=10, le=30)


class SampledMaterial(BaseModel):
    materialId: str
    frameTimestampsSeconds: list[float] = Field(min_length=1, max_length=12)


class SamplingCheckpoint(BaseModel):
    materialIds: list[str] = Field(default_factory=list)
    samples: list[SampledMaterial] = Field(default_factory=list)


class TrimCheckpoint(BaseModel):
    trims: list["TrimOutput"]
    progress: int = Field(ge=55, le=90)


class Selection(BaseModel):
    intentionallyEmptySlotIds: list[str] | None = None
    variantIndex: int = Field(default=0, ge=0)
    slotId: str
    role: Role
    materialId: str
    matchScore: float
    matchLevel: Literal["NORMAL", "LOW_MATCH"]
    classificationReason: str
    duration: float


class TrimChoice(BaseModel):
    trimStartSeconds: float = Field(ge=0)
    trimReason: str = Field(min_length=1, max_length=300)


class TrimOutput(BaseModel):
    variantIndex: int = Field(default=0, ge=0)
    slotId: str
    materialId: str
    trimStartSeconds: float
    trimReason: str


class Runtime(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    project_id: str
    run_id: str
    attempt_token: str
