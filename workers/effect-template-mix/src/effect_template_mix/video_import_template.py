"""Private model observation format; the public import callback contract is unchanged."""
import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import VideoImportDescription, VideoImportDimensions


class ImportOverview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    visualIntent: str = Field(min_length=1, max_length=200)
    visualStyle: str = Field(min_length=1, max_length=120)
    environment: str = Field(min_length=1, max_length=200)
    lighting: str = Field(min_length=1, max_length=120)
    initialState: str = Field(min_length=1, max_length=200)


class ImportStage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    startSeconds: float = Field(ge=0, le=30, allow_inf_nan=False)
    description: str = Field(min_length=1, max_length=220)
    camera: str = Field(min_length=1, max_length=120)
    focus: str = Field(max_length=120)
    motionSource: str = Field(max_length=120)
    visibleResult: str = Field(min_length=1, max_length=200)


class VideoImportObservation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    overview: ImportOverview
    stages: list[ImportStage] = Field(min_length=1, max_length=12)
    finalFrame: str = Field(min_length=1, max_length=240)
    primaryPurpose: Literal["HOOK", "PRODUCT_DISPLAY", "EFFECT", "CTA"]
    compatiblePurposes: list[Literal["HOOK", "PRODUCT_DISPLAY", "EFFECT", "CTA"]] = Field(min_length=1, max_length=4)
    creativeCore: str = Field(min_length=1, max_length=160)
    dimensions: VideoImportDimensions


class DescriptionTemplateError(ValueError):
    """Mechanical failure only; never include generated text in its message."""


def readable_time(seconds: float) -> float:
    return math.floor(seconds * 10 + 0.5) / 10


def time_text(seconds: float) -> str:
    return f"{readable_time(seconds):.1f}".rstrip("0").rstrip(".")


def compile_import_observation(observation: VideoImportObservation, duration: float) -> VideoImportDescription:
    """Format observed fields, not a shooting plan: do not allocate invented stage weights."""
    if not math.isfinite(duration) or not 4 <= duration <= 30:
        raise DescriptionTemplateError("duration_invalid")
    fields = observation.overview.model_dump()
    if any(not value.strip() for value in fields.values()) or not observation.finalFrame.strip():
        raise DescriptionTemplateError("field_empty")
    if observation.stages[0].startSeconds != 0:
        raise DescriptionTemplateError("first_stage_not_zero")
    total = readable_time(duration)
    stages: list[tuple[float, list[str]]] = []
    previous = 0.0
    for stage in observation.stages:
        start = stage.startSeconds
        if start < previous or (start > duration and readable_time(start) > total):
            raise DescriptionTemplateError("stage_start_invalid")
        previous = start
        if any(not value.strip() for value in (stage.description, stage.camera, stage.visibleResult)):
            raise DescriptionTemplateError("stage_fields_missing")
        detail = f"{stage.description.strip()} 镜头：{stage.camera.strip()}"
        if stage.focus.strip():
            detail += f" 焦点：{stage.focus.strip()}"
        if stage.motionSource.strip():
            detail += f" 驱动：{stage.motionSource.strip()}"
        detail += f" 结果：{stage.visibleResult.strip()}"
        rounded = readable_time(start)
        # Same start or an endpoint-only observation has no independent display interval.
        if stages and (rounded == stages[-1][0] or rounded == total):
            stages[-1][1].append(detail)
        else:
            stages.append((rounded, [detail]))
    overview = observation.overview
    lines = ["【视频概览】", (
        f"目标：{overview.visualIntent.strip()} 质感：{overview.visualStyle.strip()} "
        f"场景：{overview.environment.strip()} 光线：{overview.lighting.strip()} "
        f"首帧状态：{overview.initialState.strip()}"), "【逐秒镜头】"]
    for index, (start, details) in enumerate(stages):
        end = stages[index + 1][0] if index + 1 < len(stages) else total
        if end <= start:
            raise DescriptionTemplateError("stage_interval_invalid")
        lines.extend((f"{time_text(start)}–{time_text(end)}秒", "\n".join(details)))
    lines.extend(("【结束画面】", observation.finalFrame.strip()))
    if len("\n".join(lines)) > 4000:
        raise DescriptionTemplateError("compiled_text_too_long")
    return VideoImportDescription.model_validate({
        "promptText": "\n".join(lines), "primaryPurpose": observation.primaryPurpose,
        "compatiblePurposes": observation.compatiblePurposes, "creativeCore": observation.creativeCore,
        "dimensions": observation.dimensions.model_dump(),
    })
