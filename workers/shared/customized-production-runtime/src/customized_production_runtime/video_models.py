"""Versioned video-production contracts. JSON Schemas are checked into packages/contracts."""

from __future__ import annotations
from typing import Annotated, Literal, Any
from pydantic import Field, model_validator
from .models import Model, Id, Text, Short
from .pipeline import Binding

Millis = Annotated[int, Field(ge=0, le=3_600_000)]
PositiveMillis = Annotated[int, Field(gt=0, le=3_600_000)]
Offset = Annotated[int, Field(ge=0, le=100000)]


class SourceRef(Model):
    unitId: Id
    start: Offset
    end: Annotated[int, Field(gt=0, le=100000)]


class SourceUnit(Model):
    id: Id
    text: Text
    start: Annotated[int, Field(ge=0, le=1000000)]
    end: Annotated[int, Field(gt=0, le=1000000)]
    kind: Literal["TEXT", "VOICE", "ON_SCREEN_TEXT"]
    speaker: Short


class Event(Model):
    id: Id
    description: Text
    sourceRefs: Annotated[list[SourceRef], Field(min_length=1, max_length=100)]


class Scene(Model):
    id: Id
    name: Id
    sceneAssetId: Id
    setting: Text
    spatialBaseline: Text


class Clip(Model):
    id: Id
    title: Short
    sceneId: Id
    shotIds: Annotated[list[Id], Field(min_length=1, max_length=500)]
    transition: Text
    startState: Text
    endState: Text


class Shot(Model):
    id: Id
    title: Short
    shotType: Short
    cameraMovement: Short
    durationSeconds: Annotated[float, Field(ge=0.001, le=3600)]
    visual: Text
    audio: Text
    atmosphere: Text
    information: Text
    framing: Text
    angle: Text
    startState: Text
    endState: Text
    sourceEventIds: Annotated[list[Id], Field(max_length=1000)]
    bindings: Annotated[list[Binding], Field(max_length=100)]


class CuePart(Model):
    shotId: Id
    startMs: Millis
    endMs: PositiveMillis
    textStart: Offset
    textEnd: Annotated[int, Field(gt=0, le=100000)]


class Cue(Model):
    id: Id
    kind: Literal["DIALOGUE", "VO", "OS", "ANNOUNCEMENT", "ON_SCREEN_TEXT"]
    speaker: Short
    sourceRef: SourceRef
    parts: Annotated[list[CuePart], Field(min_length=1, max_length=1000)]


class DurationPolicy(Model):
    mode: Literal["REFERENCE", "FIXED"]
    seconds: Annotated[float, Field(ge=1, le=3600)]


class Timing(Model):
    explanation: Text
    estimatedSpeechSeconds: Annotated[float, Field(ge=0, le=3600)]
    uncertainty: Text


class Capability(Model):
    key: Id
    status: Literal["CONFIGURED", "PENDING_MODEL_CHECK"]
    minClipMs: PositiveMillis
    maxClipMs: PositiveMillis
    version: Id


class Source(Model):
    id: Id
    revision: Annotated[int, Field(gt=0)]
    hash: Id


class VideoPlan(Model):
    durationPolicy: DurationPolicy
    timing: Timing
    capability: Capability
    sourceUnits: Annotated[list[SourceUnit], Field(max_length=5000)]
    sources: Annotated[list[Source], Field(max_length=20)]
    events: Annotated[list[Event], Field(max_length=1000)]
    scenes: Annotated[list[Scene], Field(min_length=1, max_length=200)]
    clips: Annotated[list[Clip], Field(min_length=1, max_length=500)]
    shots: Annotated[list[Shot], Field(min_length=1, max_length=1000)]
    cues: Annotated[list[Cue], Field(max_length=2000)]


class ClipLayout(Model):
    id: Id
    title: Short
    sceneId: Id
    durationSeconds: Annotated[float, Field(gt=0, le=3600)]
    eventIds: Annotated[list[Id], Field(max_length=1000)]
    transition: Text
    startState: Text
    endState: Text


class CueAllocation(Model):
    clipId: Id
    textStart: Offset
    textEnd: Annotated[int, Field(gt=0, le=100000)]


class CueLayout(Model):
    id: Id
    kind: Literal["DIALOGUE", "VO", "OS", "ANNOUNCEMENT", "ON_SCREEN_TEXT"]
    speaker: Short
    sourceRef: SourceRef
    allocations: Annotated[list[CueAllocation], Field(min_length=1, max_length=500)]


class DirectorPlan(Model):
    summary: Text
    feasible: bool
    inputIssue: Literal[
        "NONE",
        "DURATION_CAPACITY_CONFLICT",
        "ASSET_INPUT_GAP",
        "SOURCE_CONSTRAINT_CONFLICT",
    ]
    timing: Timing
    suggestedSeconds: Annotated[float, Field(ge=0, le=3600)]
    events: Annotated[list[Event], Field(max_length=1000)]
    scenes: Annotated[list[Scene], Field(max_length=200)]
    clips: Annotated[list[ClipLayout], Field(max_length=500)]
    cues: Annotated[list[CueLayout], Field(max_length=2000)]


class CueParts(Model):
    cueId: Id
    parts: Annotated[list[CuePart], Field(min_length=1, max_length=1000)]


class ShotBatch(Model):
    clips: Annotated[list[Clip], Field(min_length=1, max_length=500)]
    shots: Annotated[list[Shot], Field(min_length=1, max_length=1000)]
    cueParts: Annotated[list[CueParts], Field(max_length=2000)]


class Evidence(Model):
    entity: Literal[
        "SHOT", "CLIP", "SCENE", "CUE", "EVENT", "SOURCE", "TIMING", "PROMPT"
    ]
    id: Id
    field: Id


class Finding(Model):
    id: Id
    severity: Literal["ERROR", "WARNING"]
    category: Literal[
        "FACT",
        "COVERAGE",
        "CAPACITY",
        "STATE",
        "SPACE",
        "SHOT_STRUCTURE",
        "BINDING",
        "CAPABILITY",
    ]
    title: Short
    impact: Text
    evidence: Annotated[list[Evidence], Field(min_length=1, max_length=30)]
    affectedShotIds: Annotated[list[Id], Field(max_length=1000)]
    affectedClipIds: Annotated[list[Id], Field(max_length=500)]
    suggestedFix: Text
    repairKind: Literal["FIELDS", "STRUCTURE", "INPUT"]


class Resolution(Model):
    issueId: Id
    status: Literal["RESOLVED", "PARTIAL", "UNRESOLVED"]
    evidence: Annotated[list[Evidence], Field(min_length=1, max_length=30)]
    explanation: Text


class Check(Model):
    dimension: Literal[
        "原稿兑现",
        "时间容量",
        "镜头表达",
        "产品事实",
        "动作与空间",
        "素材绑定",
        "模型能力",
    ]
    conclusion: Text


class Audit(Model):
    summary: Text
    checks: Annotated[list[Check], Field(min_length=7, max_length=7)]
    findings: Annotated[list[Finding], Field(max_length=100)]
    resolutions: Annotated[list[Resolution], Field(max_length=100)]


class SeverityChange(Model):
    issueId: Id
    fromSeverity: Literal["ERROR", "WARNING"]
    toSeverity: Literal["ERROR", "WARNING"]
    reason: Literal["NEW_EVIDENCE", "INITIAL_REVIEW_CORRECTION"]
    explanation: Annotated[str, Field(min_length=1, max_length=1000)]
    evidence: Annotated[list[Evidence], Field(min_length=1, max_length=30)]


class ScopedAudit(Audit):
    severityChanges: Annotated[list[SeverityChange], Field(max_length=100)]


class PromptQuote(Model):
    issueId: Id
    excerpt: Annotated[str, Field(min_length=1, max_length=2000)]


class PromptAudit(Audit):
    promptEvidence: Annotated[list[PromptQuote], Field(max_length=100)]


class PromptScopedAudit(ScopedAudit):
    promptEvidence: Annotated[list[PromptQuote], Field(max_length=100)]


class ShotFields(Model):
    shotId: Id
    # Null means unchanged. A typed allowlist, never arbitrary JSON paths.
    title: Short | None
    shotType: Short | None
    cameraMovement: Short | None
    visual: Text | None
    audio: Text | None
    atmosphere: Text | None
    information: Text | None
    framing: Text | None
    angle: Text | None
    startState: Text | None
    endState: Text | None
    bindings: list[Binding] | None


class RangeReplacement(Model):
    clipIds: Annotated[list[Id], Field(min_length=1, max_length=500)]
    replacement: ShotBatch
    scenes: Annotated[list[Scene], Field(max_length=200)]
    reason: Text


class Repair(Model):
    baseHash: Id
    issueIds: Annotated[list[Id], Field(min_length=1, max_length=100)]
    fields: Annotated[list[ShotFields], Field(max_length=1000)]
    ranges: Annotated[list[RangeReplacement], Field(max_length=30)]
    timingExplanation: Text


class RetimedShotFields(ShotFields):
    durationSeconds: Annotated[float, Field(ge=0.001, le=3600)] | None = None


class TimingRepair(Model):
    baseHash: Id
    issueIds: Annotated[list[Id], Field(min_length=1, max_length=100)]
    fields: Annotated[list[RetimedShotFields], Field(max_length=1000)]
    ranges: Annotated[list[RangeReplacement], Field(max_length=30)]
    timingExplanation: Text
    cueUpdates: Annotated[list[CueParts], Field(max_length=2000)] = []


class ClipTarget(Model):
    kind: Literal["CLIP"]
    id: Id


class ClipPrompt(Model):
    target: ClipTarget
    content: Annotated[str, Field(min_length=1, max_length=20000)]
    assetIds: Annotated[list[Id], Field(max_length=100)]


class PromptMechanicalRecovery(Model):
    version: Literal[1]
    epoch: Annotated[int, Field(ge=1, le=9007199254740991, strict=True)]
    phase: Literal["audit", "recheck"]
    history: list[dict[str, Any]]

    @model_validator(mode="before")
    @classmethod
    def strict_version(cls, value: Any) -> Any:
        if not isinstance(value, dict) or type(value.get("version")) is not int:
            raise ValueError("invalid mechanical recovery version")
        return value
