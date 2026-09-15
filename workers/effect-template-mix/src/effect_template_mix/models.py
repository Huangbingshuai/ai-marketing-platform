from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

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
    artifactId: str
    artifactKey: str
    artifactRevision: int
    contentHash: str
    fileObjectId: str


class Snapshot(BaseModel):
    schemaVersion: Literal[1]
    template: dict[str, Any]
    draftRevision: int
    targetVariantId: str | None
    lockedBindings: list[dict[str, Any]]
    reuseCounts: dict[str, int] = Field(default_factory=dict)
    promptArtifacts: list[dict[str, Any]]
    materials: list[Material]

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
    scores: Scores
    reasons: dict[Role, str]


class ClassificationResult(BaseModel):
    classifications: list[Classification]


class ClassificationCheckpoint(BaseModel):
    classifications: list[Classification]
    progress: int = Field(ge=10, le=30)


class TrimCheckpoint(BaseModel):
    trims: list["TrimOutput"]
    progress: int = Field(ge=55, le=90)


class Selection(BaseModel):
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
