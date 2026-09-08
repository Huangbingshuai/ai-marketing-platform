from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class QueueMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    schema_version: int = Field(alias="schemaVersion")
    project_id: str = Field(alias="projectId", min_length=1)
    task_id: str = Field(alias="runId", min_length=1)
    request_id: str = Field(alias="requestId", min_length=1)


class TextContent(BaseModel):
    type: Literal["text"]
    text: str = Field(min_length=1)


class ProviderRequest(BaseModel):
    model: str = Field(min_length=1)
    content: list[TextContent] = Field(min_length=1, max_length=1)
    duration: int = Field(ge=1, le=30)
    ratio: str = Field(min_length=1, max_length=20)
    resolution: str = Field(min_length=1, max_length=20)


class SourcePackage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    artifact_id: str = Field(alias="artifactId", min_length=1)
    revision: int = Field(ge=1)
    content_hash: str = Field(alias="contentHash", min_length=64, max_length=64)


class InputImage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    file_object_id: str = Field(alias="fileObjectId", min_length=1)
    original_file_name: str = Field(alias="originalFileName", min_length=1)
    mime_type: str = Field(alias="mimeType", min_length=1)
    size_bytes: int = Field(alias="sizeBytes", ge=1, le=30 * 1024 * 1024 - 1)
    content_hash: str = Field(alias="contentHash", min_length=64, max_length=64)
    sort_order: int = Field(alias="sortOrder", ge=0)


class InputVideo(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    file_object_id: str = Field(alias="fileObjectId", min_length=1)
    original_file_name: str = Field(alias="originalFileName", min_length=1)
    mime_type: Literal["video/mp4", "video/quicktime"] = Field(alias="mimeType")
    size_bytes: int = Field(alias="sizeBytes", ge=1, le=50 * 1024 * 1024)
    content_hash: str = Field(alias="contentHash", min_length=64, max_length=64)
    duration_seconds: float = Field(alias="durationSeconds", gt=0, le=15)


class RepairRegion(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)


class RepairInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    source_version: int = Field(alias="sourceVersion", ge=1)
    start_ms: int = Field(alias="startMs", ge=0)
    end_ms: int = Field(alias="endMs", ge=1)
    instruction: str = Field(min_length=1, max_length=1000)
    region: RepairRegion | None = None


class RenderSnapshot(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    prompt_id: str = Field(alias="promptId", min_length=1)
    prompt_code: str = Field(alias="promptCode", min_length=1)
    prompt_text: str = Field(alias="promptText", min_length=1)
    primary_purpose: str = Field(alias="primaryPurpose", min_length=1)
    compatible_purposes: list[str] = Field(alias="compatiblePurposes")
    prompt_content_hash: str = Field(alias="promptContentHash", min_length=64, max_length=64)
    shared_prompt_hash: str = Field(alias="sharedPromptHash", min_length=64, max_length=64)
    render_settings_hash: str = Field(alias="renderSettingsHash", min_length=64, max_length=64)
    source_package: SourcePackage = Field(alias="sourcePackage")
    operation: Literal["GENERATE", "REPAIR"] = "GENERATE"
    input_images: list[InputImage] = Field(alias="inputImages", max_length=30)
    input_video: InputVideo | None = Field(default=None, alias="inputVideo")
    repair: RepairInput | None = None
    request: ProviderRequest

    @model_validator(mode="after")
    def validate_operation_inputs(self) -> RenderSnapshot:
        if self.operation == "REPAIR":
            if self.input_video is None or self.repair is None:
                raise ValueError("repair snapshots require inputVideo and repair")
            if self.input_images:
                raise ValueError("repair snapshots must not include inputImages")
            if self.repair.end_ms > self.request.duration * 1000:
                raise ValueError("repair range exceeds the requested duration")
            if self.repair.end_ms <= self.repair.start_ms:
                raise ValueError("repair range must have a positive duration")
        elif not self.input_images:
            raise ValueError("generation snapshots require inputImages")
        return self


class ClaimResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    terminal: bool
    task_id: str = Field(alias="taskId")
    task_version: int | None = Field(alias="taskVersion")
    attempt_token: str | None = Field(alias="attemptToken")
    source_fingerprint: str | None = Field(alias="sourceFingerprint")
    provider_task_id: str | None = Field(alias="providerTaskId")
    input: RenderSnapshot | None


class RuntimeContext(BaseModel):
    project_id: str
    task_id: str
    task_version: int
    request_id: str
    attempt_token: str


class RenderOutput(BaseModel):
    provider_task_id: str
    content: bytes
    file_name: str
    mime_type: str = "video/mp4"
    duration: int | None = None
    ratio: str | None = None
    resolution: str | None = None
