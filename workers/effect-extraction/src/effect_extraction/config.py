from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_ARK_MODEL = "doubao-seed-2-1-turbo-260628"
DEFAULT_ARK_SEMANTIC_MODEL = "doubao-seed-2-0-lite-260428"
DEFAULT_ARK_EMBEDDING_MODEL = "doubao-embedding-vision-251215"
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
    effect_extraction_worker_token: SecretStr = Field(
        alias="EFFECT_EXTRACTION_WORKER_TOKEN"
    )
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
    ark_commerce_model: str | None = Field(default=None, alias="ARK_COMMERCE_MODEL")
    ark_image_model: str | None = Field(default=None, alias="ARK_IMAGE_MODEL")
    ark_semantic_model: str | None = Field(default=None, alias="ARK_SEMANTIC_MODEL")
    ark_normalization_model: str | None = Field(
        default=None, alias="ARK_NORMALIZATION_MODEL"
    )
    ark_extraction_embedding_model: str = Field(
        default=DEFAULT_ARK_EMBEDDING_MODEL,
        alias="ARK_EXTRACTION_EMBEDDING_MODEL",
    )
    semantic_embedding_max_concurrency: int = Field(
        default=8,
        alias="SEMANTIC_EMBEDDING_MAX_CONCURRENCY",
        ge=1,
        le=32,
    )

    commerce_renderer_url: AnyHttpUrl | None = Field(
        default=None, alias="COMMERCE_RENDERER_URL"
    )
    commerce_renderer_token: SecretStr | None = Field(
        default=None, alias="COMMERCE_RENDERER_TOKEN"
    )
    commerce_static_connect_timeout_seconds: float = Field(
        default=5.0, alias="COMMERCE_STATIC_CONNECT_TIMEOUT_SECONDS", gt=0
    )
    commerce_static_read_timeout_seconds: float = Field(
        default=15.0, alias="COMMERCE_STATIC_READ_TIMEOUT_SECONDS", gt=0
    )
    commerce_renderer_timeout_seconds: float = Field(
        default=30.0, alias="COMMERCE_RENDERER_CLIENT_TIMEOUT_SECONDS", gt=0
    )
    max_commerce_text_chars: int = Field(
        default=80_000, alias="MAX_COMMERCE_TEXT_CHARS", ge=1_000, le=200_000
    )

    docling_artifacts_path: str | None = Field(
        default=None, alias="DOCLING_ARTIFACTS_PATH"
    )
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
    api_timeout_seconds: float = Field(
        default=60.0, alias="INTERNAL_API_TIMEOUT_SECONDS", gt=0
    )
    ark_timeout_seconds: float = Field(default=120.0, alias="ARK_TIMEOUT_SECONDS", gt=0)
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @model_validator(mode="after")
    def validate_provider(self) -> WorkerSettings:
        self.ark_model = self.ark_model.strip()
        self.ark_extraction_embedding_model = (
            self.ark_extraction_embedding_model.strip()
        )
        for field_name in (
            "ark_document_model",
            "ark_commerce_model",
            "ark_image_model",
            "ark_semantic_model",
            "ark_normalization_model",
        ):
            value = getattr(self, field_name)
            setattr(
                self, field_name, value.strip() or None if value is not None else None
            )
        if self.extraction_ai_provider == "ark":
            api_key = (
                self.ark_api_key.get_secret_value().strip().lower()
                if self.ark_api_key is not None
                else ""
            )
            if not api_key or api_key in ARK_KEY_PLACEHOLDERS:
                raise ValueError(
                    "ARK_API_KEY is required when EXTRACTION_AI_PROVIDER=ark"
                )
            if not self.ark_model:
                raise ValueError(
                    "ARK_MODEL cannot be empty when EXTRACTION_AI_PROVIDER=ark"
                )
            if not self.ark_extraction_embedding_model:
                raise ValueError(
                    "ARK_EXTRACTION_EMBEDDING_MODEL cannot be empty when "
                    "EXTRACTION_AI_PROVIDER=ark"
                )
        if not self.effect_extraction_queue.strip():
            raise ValueError("EFFECT_EXTRACTION_QUEUE cannot be empty")
        renderer_token = (
            self.commerce_renderer_token.get_secret_value().strip()
            if self.commerce_renderer_token is not None
            else ""
        )
        if (self.commerce_renderer_url is None) != (not renderer_token):
            raise ValueError(
                "COMMERCE_RENDERER_URL and COMMERCE_RENDERER_TOKEN must be configured together"
            )
        return self

    @property
    def resolved_document_model(self) -> str:
        return self.ark_document_model or self.ark_model

    @property
    def resolved_image_model(self) -> str:
        return self.ark_image_model or self.ark_model

    @property
    def resolved_commerce_model(self) -> str:
        return self.ark_commerce_model or self.ark_document_model or self.ark_model

    @property
    def resolved_normalization_model(self) -> str:
        return self.ark_normalization_model or self.ark_model

    @property
    def resolved_semantic_model(self) -> str:
        return self.ark_semantic_model or DEFAULT_ARK_SEMANTIC_MODEL


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    return WorkerSettings()  # type: ignore[call-arg]
