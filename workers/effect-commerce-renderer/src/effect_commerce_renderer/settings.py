from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="COMMERCE_RENDERER_",
        case_sensitive=False,
        extra="ignore",
        populate_by_name=True,
    )

    token: SecretStr = Field(
        min_length=16,
        validation_alias="COMMERCE_RENDERER_TOKEN",
    )
    host: str = Field(default="0.0.0.0", validation_alias="COMMERCE_RENDERER_HOST")
    port: int = Field(
        default=8080,
        ge=1,
        le=65535,
        validation_alias="COMMERCE_RENDERER_PORT",
    )
    max_concurrency: int = Field(default=2, ge=1, le=16)
    timeout_seconds: float = Field(default=25.0, ge=1.0, le=60.0)
    max_dom_bytes: int = Field(
        default=2 * 1024 * 1024,
        ge=1024,
        le=8 * 1024 * 1024,
    )
    settle_milliseconds: int = Field(default=750, ge=0, le=5_000)
