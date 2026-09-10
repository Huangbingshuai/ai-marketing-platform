from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .reliability import (
    DEFAULT_EVALUATION_INPUT_TOKEN_BUDGET,
    validate_output_limits,
)

DEFAULT_ARK_MODEL = "doubao-seed-2-1-turbo-260628"
DEFAULT_ARK_PROMPT_STRATEGY_MODEL = "doubao-seed-2-0-lite-260428"
ARK_KEY_PLACEHOLDERS = {
    "replace-with-your-ark-api-key",
    "your-ark-api-key",
    "<your-ark-api-key>",
}


class WorkerSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=None, case_sensitive=True, extra="ignore"
    )

    internal_api_base_url: AnyHttpUrl = Field(alias="INTERNAL_API_BASE_URL")
    effect_prompt_worker_token: SecretStr = Field(alias="EFFECT_PROMPT_WORKER_TOKEN")
    rabbitmq_url: SecretStr = Field(alias="RABBITMQ_URL")
    effect_prompt_queue: str = Field(
        default="effect.prompt-generation.requested", alias="EFFECT_PROMPT_QUEUE"
    )

    prompt_ai_provider: Literal["mock", "ark"] = Field(
        default="ark", alias="PROMPT_AI_PROVIDER"
    )
    ark_base_url: str = Field(
        default="https://ark.cn-beijing.volces.com/api/v3", alias="ARK_BASE_URL"
    )
    ark_api_key: SecretStr | None = Field(default=None, alias="ARK_API_KEY")
    ark_model: str = Field(default=DEFAULT_ARK_MODEL, alias="ARK_MODEL")
    ark_prompt_model: str | None = Field(default=None, alias="ARK_PROMPT_MODEL")
    ark_prompt_strategy_model: str | None = Field(
        default=None, alias="ARK_PROMPT_STRATEGY_MODEL"
    )
    ark_prompt_visual_strategy_model: str | None = Field(
        default=None, alias="ARK_PROMPT_VISUAL_STRATEGY_MODEL"
    )
    ark_prompt_candidate_model: str | None = Field(
        default=None, alias="ARK_PROMPT_CANDIDATE_MODEL"
    )
    ark_prompt_fragment_strategy_model: str | None = Field(
        default=None, alias="ARK_PROMPT_FRAGMENT_STRATEGY_MODEL"
    )
    ark_prompt_blueprint_model: str | None = Field(
        default=None, alias="ARK_PROMPT_BLUEPRINT_MODEL"
    )
    ark_prompt_evaluation_model: str | None = Field(
        default=None, alias="ARK_PROMPT_EVALUATION_MODEL"
    )
    ark_prompt_embedding_model: str | None = Field(
        default=None, alias="ARK_PROMPT_EMBEDDING_MODEL"
    )
    ark_prompt_embedding_api_mode: Literal["text", "multimodal"] = Field(
        default="multimodal", alias="ARK_PROMPT_EMBEDDING_API_MODE"
    )
    ark_prompt_strategy_max_output_tokens: int = Field(
        default=8192,
        alias="ARK_PROMPT_STRATEGY_MAX_OUTPUT_TOKENS",
        ge=512,
        le=32_768,
    )
    ark_prompt_candidate_max_output_tokens: int = Field(
        default=8192,
        alias="ARK_PROMPT_CANDIDATE_MAX_OUTPUT_TOKENS",
        ge=1024,
        le=65_536,
    )
    ark_prompt_fragment_strategy_max_output_tokens: int = Field(
        default=3072,
        alias="ARK_PROMPT_FRAGMENT_STRATEGY_MAX_OUTPUT_TOKENS",
        ge=1024,
        le=8192,
    )
    ark_prompt_evaluation_max_output_tokens: int = Field(
        default=6144,
        alias="ARK_PROMPT_EVALUATION_MAX_OUTPUT_TOKENS",
        ge=1024,
        le=8192,
    )
    ark_prompt_reasoning_effort: Literal["minimal", "low", "medium", "high"] = Field(
        default="minimal", alias="ARK_PROMPT_REASONING_EFFORT"
    )
    ark_prompt_visual_strategy_image_detail: Literal["low", "high"] = Field(
        default="high", alias="ARK_PROMPT_VISUAL_STRATEGY_IMAGE_DETAIL"
    )
    prompt_visual_reference_max_input_bytes: int = Field(
        default=20 * 1024 * 1024,
        alias="PROMPT_VISUAL_REFERENCE_MAX_INPUT_BYTES",
        ge=1,
    )
    prompt_visual_reference_max_dimension: int = Field(
        default=1280,
        alias="PROMPT_VISUAL_REFERENCE_MAX_DIMENSION",
        ge=256,
    )
    prompt_visual_reference_max_output_bytes: int = Field(
        default=4 * 1024 * 1024,
        alias="PROMPT_VISUAL_REFERENCE_MAX_OUTPUT_BYTES",
        ge=32_768,
    )

    prompt_max_concurrency: int = Field(
        default=4, alias="PROMPT_MAX_CONCURRENCY", ge=1, le=8
    )
    prompt_evaluation_input_token_budget: int = Field(
        default=DEFAULT_EVALUATION_INPUT_TOKEN_BUDGET,
        alias="PROMPT_EVALUATION_INPUT_TOKEN_BUDGET",
        ge=4096,
        le=65_536,
    )
    prompt_similarity_mode: Literal["vector"] = Field(
        default="vector", alias="PROMPT_SIMILARITY_MODE"
    )
    prompt_embedding_batch_size: int = Field(
        default=64, alias="PROMPT_EMBEDDING_BATCH_SIZE", ge=1, le=256
    )
    prompt_embedding_max_concurrency: int = Field(
        default=8, alias="PROMPT_EMBEDDING_MAX_CONCURRENCY", ge=1, le=16
    )
    prompt_shard_size: int = Field(default=8, alias="PROMPT_SHARD_SIZE", ge=1, le=8)
    prompt_max_ai_calls_per_run: int = Field(
        default=256, alias="PROMPT_MAX_AI_CALLS_PER_RUN", ge=1, le=256
    )
    api_timeout_seconds: float = Field(
        default=60.0, alias="INTERNAL_API_TIMEOUT_SECONDS", gt=0
    )
    ark_timeout_seconds: float = Field(default=120.0, alias="ARK_TIMEOUT_SECONDS", gt=0)
    ark_prompt_strategy_timeout_seconds: float = Field(
        default=180.0, alias="ARK_PROMPT_STRATEGY_TIMEOUT_SECONDS", gt=0
    )
    ark_prompt_candidate_timeout_seconds: float | None = Field(
        default=None, alias="ARK_PROMPT_CANDIDATE_TIMEOUT_SECONDS", gt=0
    )
    ark_prompt_fragment_strategy_timeout_seconds: float = Field(
        default=120.0, alias="ARK_PROMPT_FRAGMENT_STRATEGY_TIMEOUT_SECONDS", gt=0
    )
    ark_prompt_evaluation_timeout_seconds: float = Field(
        default=120.0, alias="ARK_PROMPT_EVALUATION_TIMEOUT_SECONDS", gt=0
    )
    ark_prompt_direction_review_timeout_seconds: float = Field(
        default=180.0, alias="ARK_PROMPT_DIRECTION_REVIEW_TIMEOUT_SECONDS", gt=0
    )
    prompt_direction_review_batch_size: int = Field(
        default=6, alias="PROMPT_DIRECTION_REVIEW_BATCH_SIZE", ge=1, le=12
    )
    prompt_direction_review_input_budget: int = Field(
        default=12000, alias="PROMPT_DIRECTION_REVIEW_INPUT_BUDGET", ge=2500
    )
    ark_prompt_provider_max_attempts: int = Field(
        default=1, alias="ARK_PROMPT_PROVIDER_MAX_ATTEMPTS", ge=1, le=3
    )
    ark_prompt_embedding_timeout_seconds: float = Field(
        default=30.0, alias="ARK_PROMPT_EMBEDDING_TIMEOUT_SECONDS", gt=0
    )
    ark_prompt_embedding_max_attempts: int = Field(
        default=3, alias="ARK_PROMPT_EMBEDDING_MAX_ATTEMPTS", ge=1, le=3
    )
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @model_validator(mode="after")
    def validate_provider(self) -> WorkerSettings:
        self.ark_model = self.ark_model.strip()
        self.ark_prompt_model = (self.ark_prompt_model or "").strip() or None
        self.ark_prompt_strategy_model = (
            self.ark_prompt_strategy_model or ""
        ).strip() or None
        self.ark_prompt_visual_strategy_model = (
            self.ark_prompt_visual_strategy_model or ""
        ).strip() or None
        self.ark_prompt_candidate_model = (
            self.ark_prompt_candidate_model or ""
        ).strip() or None
        self.ark_prompt_fragment_strategy_model = (
            self.ark_prompt_fragment_strategy_model or ""
        ).strip() or None
        self.ark_prompt_blueprint_model = (
            self.ark_prompt_blueprint_model or ""
        ).strip() or None
        self.ark_prompt_evaluation_model = (
            self.ark_prompt_evaluation_model or ""
        ).strip() or None
        self.ark_prompt_embedding_model = (
            self.ark_prompt_embedding_model or ""
        ).strip() or None
        self.effect_prompt_queue = self.effect_prompt_queue.strip()
        validate_output_limits(
            candidate_max_output_tokens=self.ark_prompt_candidate_max_output_tokens,
            evaluation_max_output_tokens=self.ark_prompt_evaluation_max_output_tokens,
            evaluation_input_token_budget=(
                self.prompt_evaluation_input_token_budget
            ),
        )
        if not self.effect_prompt_queue:
            raise ValueError("EFFECT_PROMPT_QUEUE cannot be empty")
        if not self.ark_model:
            raise ValueError("ARK_MODEL cannot be empty")
        if self.prompt_ai_provider == "ark":
            if self.ark_api_key is None:
                raise ValueError("ARK_API_KEY is required when PROMPT_AI_PROVIDER=ark")
            key = self.ark_api_key.get_secret_value().strip()
            if not key or key.casefold() in ARK_KEY_PLACEHOLDERS:
                raise ValueError("ARK_API_KEY must be a real non-placeholder key")
            if self.ark_prompt_embedding_model is None:
                raise ValueError(
                    "ARK_PROMPT_EMBEDDING_MODEL is required for Prompt vector selection"
                )
        elif not (
            self.effect_prompt_queue.endswith(".test")
            or self.effect_prompt_queue.startswith("test.")
        ):
            raise ValueError("PROMPT_AI_PROVIDER=mock requires an isolated test queue")
        return self

    @property
    def resolved_prompt_strategy_model(self) -> str:
        return (
            self.ark_prompt_strategy_model
            or self.ark_prompt_model
            or DEFAULT_ARK_PROMPT_STRATEGY_MODEL
        )

    @property
    def resolved_prompt_candidate_model(self) -> str:
        return (
            self.ark_prompt_candidate_model or self.ark_prompt_model or self.ark_model
        )

    @property
    def resolved_prompt_visual_strategy_model(self) -> str:
        return (
            self.ark_prompt_visual_strategy_model
            or self.resolved_prompt_candidate_model
        )

    @property
    def resolved_prompt_fragment_strategy_model(self) -> str:
        return (
            self.ark_prompt_fragment_strategy_model
            or self.resolved_prompt_candidate_model
        )

    @property
    def resolved_prompt_blueprint_model(self) -> str:
        return self.ark_prompt_blueprint_model or self.resolved_prompt_strategy_model

    @property
    def resolved_prompt_evaluation_model(self) -> str:
        return self.ark_prompt_evaluation_model or self.resolved_prompt_candidate_model

    @property
    def resolved_prompt_candidate_timeout_seconds(self) -> float:
        return self.ark_prompt_candidate_timeout_seconds or self.ark_timeout_seconds


@lru_cache(maxsize=1)
def get_settings() -> WorkerSettings:
    return WorkerSettings()  # type: ignore[call-arg]
