from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, case_sensitive=True, env_ignore_empty=True, extra="ignore")
    internal_api_base_url: AnyHttpUrl = Field(alias="INTERNAL_API_BASE_URL")
    worker_token: SecretStr = Field(alias="EFFECT_TEMPLATE_MIX_WORKER_TOKEN")
    rabbitmq_url: SecretStr = Field(alias="RABBITMQ_URL")
    queue_name: str = Field(default="effect.template-mix.requested", alias="EFFECT_TEMPLATE_MIX_QUEUE")
    ark_base_url: str = Field(default="https://ark.cn-beijing.volces.com/api/v3", alias="ARK_BASE_URL")
    ark_api_key: SecretStr = Field(alias="ARK_API_KEY")
    model: str = Field(validation_alias=AliasChoices("ARK_TEMPLATE_MIX_MODEL", "ARK_MODEL"))
    api_timeout_seconds: float = Field(default=90, alias="INTERNAL_API_TIMEOUT_SECONDS", gt=0)
    ark_timeout_seconds: float = Field(default=120, alias="ARK_TIMEOUT_SECONDS", gt=0)
    ark_max_output_tokens: int = Field(
        default=8_192,
        alias="ARK_TEMPLATE_MIX_MAX_OUTPUT_TOKENS",
        ge=512,
    )
    ark_reasoning_effort: Literal["minimal", "low", "medium", "high"] = Field(
        default="minimal",
        alias="ARK_TEMPLATE_MIX_REASONING_EFFORT",
    )
    classification_batch_size: int = Field(
        default=10,
        alias="TEMPLATE_MIX_CLASSIFICATION_BATCH_SIZE",
        ge=1,
        le=50,
    )
    classification_input_token_budget: int = Field(
        default=16_000,
        alias="TEMPLATE_MIX_CLASSIFICATION_INPUT_TOKEN_BUDGET",
        ge=4_096,
    )
    ai_max_concurrency: int = Field(
        default=2,
        alias="TEMPLATE_MIX_AI_MAX_CONCURRENCY",
        ge=1,
        le=4,
    )
    max_video_bytes: int = Field(default=512 * 1024 * 1024, alias="TEMPLATE_MIX_MAX_VIDEO_BYTES", ge=1)
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @model_validator(mode="after")
    def validate_real_provider(self) -> "Settings":
        self.queue_name = self.queue_name.strip()
        self.ark_base_url = self.ark_base_url.rstrip("/")
        self.model = self.model.strip()
        key = self.ark_api_key.get_secret_value().strip()
        if not self.queue_name or not self.model or not key or "replace-with" in key.casefold():
            raise ValueError("template mix worker requires a real Ark model and API key")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
