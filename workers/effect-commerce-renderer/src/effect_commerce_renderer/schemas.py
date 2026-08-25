from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, max_length=2_000)


class RenderResponse(BaseModel):
    html: str
    finalUrl: str
    host: str
    title: str | None = None


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    detail: ErrorDetail
