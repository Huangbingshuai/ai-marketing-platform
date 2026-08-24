from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkerSettings(BaseSettings):
    """Environment-owned settings; secrets are never rendered by repr/logging."""

    model_config = SettingsConfigDict(
        env_file=None,
        case_sensitive=True,
        extra="ignore",
    )

    internal_api_base_url: AnyHttpUrl = Field(alias="INTERNAL_API_BASE_URL")
    effect_extraction_worker_token: SecretStr = Field(alias="EFFECT_EXTRACTION_WORKER_TOKEN")
    rabbitmq_url: SecretStr = Field(alias="RABBITMQ_URL")
    effect_extraction_queue: str = Field(
        default="effect.extraction.requested", alias="EFFECT_EXTRACTION_QUEUE"
    )

    extraction_ai_provider: Literal["mock", "ark"] = Field(
        default="ark", alias="EXTRACTION_AI_PROVIDER"
    )
    ark_base_url: str = Field(
        default="https://ark.cn-beijing.volces.com/api/v3", alias="ARK_BASE_URL"
    )
    ark_api_key: SecretStr | None = Field(default=None, alias="ARK_API_KEY")
    ark_model: str | None = Field(default=None, alias="ARK_MODEL")

    docling_artifacts_path: str | None = Field(default=None, alias="DOCLING_ARTIFACTS_PATH")
    docling_max_file_size: int = Field(
        default=50 * 1024 * 1024, alias="DOCLING_MAX_FILE_SIZE", ge=1
    )
    docling_max_num_pages: int = Field(default=200, alias="DOCLING_MAX_NUM_PAGES", ge=1)
    max_document_text_chars: int = Field(
        default=60_000, alias="MAX_DOCUMENT_TEXT_CHARS", ge=1_000
    )
    image_max_input_bytes: int = Field(
        default=20 * 1024 * 1024, alias="IMAGE_MAX_INPUT_BYTES", ge=1
    )
    image_max_dimension: int = Field(default=2048, alias="IMAGE_MAX_DIMENSION", ge=256)
    image_max_output_bytes: int = Field(
        default=4 * 1024 * 1024, alias="IMAGE_MAX_OUTPUT_BYTES", ge=32_768
    )
    api_timeout_seconds: float = Field(default=60.0, alias="INTERNAL_API_TIMEOUT_SECONDS", gt=0)
    ark_timeout_seconds: float = Field(default=120.0, alias="ARK_TIMEOUT_SECONDS", gt=0)
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @model_validator(mode="after")
    def validate_provider(self) -> WorkerSettings:
        if self.extraction_ai_provider == "ark":
            if self.ark_api_key is None or not self.ark_api_key.get_secret_value().strip():
                raise ValueError("ARK_API_KEY is required when EXTRACTION_AI_PROVIDER=ark")
            if self.ark_model is None or not self.ark_model.strip():
                raise ValueError("ARK_MODEL is required when EXTRACTION_AI_PROVIDER=ark")
            if not self.ark_model.strip().startswith("ep-"):
                raise ValueError("ARK_MODEL must be an Ark Endpoint ID beginning with 'ep-'")
        if not self.effect_extraction_queue.strip():
            raise ValueError("EFFECT_EXTRACTION_QUEUE cannot be empty")
        return self


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    return WorkerSettings()  # type: ignore[call-arg]
