import uvicorn

from .settings import Settings


def main() -> None:
    settings = Settings()  # type: ignore[call-arg]
    uvicorn.run(
        "effect_commerce_renderer.app:app_factory",
        factory=True,
        host=settings.host,
        port=settings.port,
        access_log=False,
        server_header=False,
    )


if __name__ == "__main__":
    main()
