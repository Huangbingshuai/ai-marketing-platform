from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


DEFAULT_ARK_MODEL = "doubao-seed-2-1-turbo-260628"
ARK_KEY_PLACEHOLDERS = {
    "replace-with-your-ark-api-key",
    "your-ark-api-key",
    "<your-ark-api-key>",
}


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
    ark_model: str = Field(default=DEFAULT_ARK_MODEL, alias="ARK_MODEL")
    ark_document_model: str | None = Field(default=None, alias="ARK_DOCUMENT_MODEL")
    ark_image_model: str | None = Field(default=None, alias="ARK_IMAGE_MODEL")
    ark_normalization_model: str | None = Field(default=None, alias="ARK_NORMALIZATION_MODEL")

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
        self.ark_model = self.ark_model.strip()
        for field_name in (
            "ark_document_model",
            "ark_image_model",
            "ark_normalization_model",
        ):
            value = getattr(self, field_name)
            setattr(self, field_name, value.strip() or None if value is not None else None)
        if self.extraction_ai_provider == "ark":
            api_key = (
                self.ark_api_key.get_secret_value().strip().lower()
                if self.ark_api_key is not None
                else ""
            )
            if not api_key or api_key in ARK_KEY_PLACEHOLDERS:
                raise ValueError("ARK_API_KEY is required when EXTRACTION_AI_PROVIDER=ark")
            if not self.ark_model:
                raise ValueError("ARK_MODEL cannot be empty when EXTRACTION_AI_PROVIDER=ark")
        if not self.effect_extraction_queue.strip():
            raise ValueError("EFFECT_EXTRACTION_QUEUE cannot be empty")
        return self

    @property
    def resolved_document_model(self) -> str:
        return self.ark_document_model or self.ark_model

    @property
    def resolved_image_model(self) -> str:
        return self.ark_image_model or self.ark_model

    @property
    def resolved_normalization_model(self) -> str:
        return self.ark_normalization_model or self.ark_model


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    return WorkerSettings()  # type: ignore[call-arg]
