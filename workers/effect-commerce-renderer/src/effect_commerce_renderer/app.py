from __future__ import annotations

import secrets
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from .renderer import PlaywrightRenderer, RenderServiceError, Renderer
from .schemas import ErrorResponse, HealthResponse, RenderRequest, RenderResponse
from .settings import Settings


def create_app(settings: Settings | None = None, renderer: Renderer | None = None) -> FastAPI:
    resolved_settings = settings or Settings()  # type: ignore[call-arg]
    resolved_renderer = renderer or PlaywrightRenderer(resolved_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await resolved_renderer.start()
        try:
            yield
        finally:
            await resolved_renderer.stop()

    app = FastAPI(
        title="Effect Commerce Renderer",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    def require_token(
        authorization: Annotated[str | None, Header()] = None,
    ) -> None:
        prefix = "Bearer "
        if authorization is None or not authorization.startswith(prefix):
            raise HTTPException(
                status_code=401,
                detail={"code": "UNAUTHORIZED", "message": "无权访问渲染服务"},
            )
        supplied = authorization[len(prefix) :]
        expected = resolved_settings.token.get_secret_value()
        if not secrets.compare_digest(supplied.encode(), expected.encode()):
            raise HTTPException(
                status_code=401,
                detail={"code": "UNAUTHORIZED", "message": "无权访问渲染服务"},
            )

    @app.exception_handler(RenderServiceError)
    async def render_error_handler(_: Request, exc: RenderServiceError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": {"code": exc.code, "message": exc.user_message}},
        )

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse()

    @app.post(
        "/render",
        response_model=RenderResponse,
        responses={
            400: {"model": ErrorResponse},
            401: {"model": ErrorResponse},
            413: {"model": ErrorResponse},
            422: {"model": ErrorResponse},
            502: {"model": ErrorResponse},
            504: {"model": ErrorResponse},
        },
        dependencies=[Depends(require_token)],
    )
    async def render_page(payload: RenderRequest) -> RenderResponse:
        result = await resolved_renderer.render(payload.url)
        return RenderResponse(
            html=result.html,
            finalUrl=result.final_url,
            host=result.host,
            title=result.title,
        )

    return app


def app_factory() -> FastAPI:
    return create_app()
