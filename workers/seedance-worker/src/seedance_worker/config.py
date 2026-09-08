from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


PLACEHOLDER_KEYS = {
    "replace-with-your-seedance-api-key",
    "replace-with-your-ark-api-key",
    "your-api-key",
}


class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=None, case_sensitive=True, extra="ignore"
    )

    internal_api_base_url: AnyHttpUrl = Field(alias="INTERNAL_API_BASE_URL")
    worker_token: SecretStr = Field(alias="EFFECT_SEGMENT_RENDER_WORKER_TOKEN")
    rabbitmq_url: SecretStr = Field(alias="RABBITMQ_URL")
    queue_name: str = Field(
        default="effect.segment-render.requested",
        alias="EFFECT_SEGMENT_RENDER_QUEUE",
    )
    provider: Literal["ark", "mock"] = Field(
        default="ark", alias="SEGMENT_RENDER_PROVIDER"
    )
    seedance_base_url: str = Field(
        default="https://ark.cn-beijing.volces.com/api/v3",
        alias="SEEDANCE_BASE_URL",
    )
    seedance_api_key: SecretStr | None = Field(
        default=None, alias="SEEDANCE_API_KEY"
    )
    api_timeout_seconds: float = Field(
        default=60.0, alias="INTERNAL_API_TIMEOUT_SECONDS", gt=0
    )
    seedance_timeout_seconds: float = Field(
        default=900.0, alias="SEEDANCE_TIMEOUT_SECONDS", gt=0
    )
    poll_interval_seconds: float = Field(
        default=8.0, alias="SEEDANCE_POLL_INTERVAL_SECONDS", gt=0, le=30
    )
    max_inflight: int = Field(
        default=20,
        validation_alias=AliasChoices(
            "SEGMENT_RENDER_MAX_INFLIGHT", "SEGMENT_RENDER_MAX_CONCURRENCY"
        ),
        ge=1,
        le=100,
    )
    create_qps: float = Field(
        default=3.0, alias="SEGMENT_RENDER_CREATE_QPS", ge=1, le=20
    )
    download_concurrency: int = Field(
        default=3,
        alias="SEGMENT_RENDER_DOWNLOAD_CONCURRENCY",
        ge=1,
        le=20,
    )
    max_download_bytes: int = Field(
        default=512 * 1024 * 1024,
        alias="SEGMENT_RENDER_MAX_DOWNLOAD_BYTES",
        ge=1,
    )
    reference_cache_bytes: int = Field(
        default=128 * 1024 * 1024,
        alias="SEGMENT_RENDER_REFERENCE_CACHE_BYTES",
        ge=1,
    )
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @model_validator(mode="after")
    def validate_provider(self) -> WorkerSettings:
        self.queue_name = self.queue_name.strip()
        self.seedance_base_url = self.seedance_base_url.rstrip("/")
        if not self.queue_name:
            raise ValueError("EFFECT_SEGMENT_RENDER_QUEUE cannot be empty")
        if self.provider == "ark":
            if self.seedance_api_key is None:
                raise ValueError(
                    "SEEDANCE_API_KEY is required when SEGMENT_RENDER_PROVIDER=ark"
                )
            key = self.seedance_api_key.get_secret_value().strip()
            if not key or key.casefold() in PLACEHOLDER_KEYS:
                raise ValueError("SEEDANCE_API_KEY must be a real non-placeholder key")
        elif not (
            self.queue_name.startswith("test.") or self.queue_name.endswith(".test")
        ):
            raise ValueError(
                "SEGMENT_RENDER_PROVIDER=mock requires an isolated test queue"
            )
        return self


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    return WorkerSettings()  # type: ignore[call-arg]
