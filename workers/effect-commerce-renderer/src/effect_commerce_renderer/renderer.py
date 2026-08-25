from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Protocol

from playwright.async_api import (
    Browser,
    BrowserContext,
    Error as PlaywrightError,
    Playwright,
    Request,
    Route,
    TimeoutError as PlaywrightTimeoutError,
    WebSocketRoute,
    async_playwright,
)

from .security import UnsafeTargetError, UrlSafetyPolicy
from .settings import Settings


@dataclass(frozen=True, slots=True)
class RenderedPage:
    html: str
    final_url: str
    host: str
    title: str | None


class RenderServiceError(RuntimeError):
    code = "RENDER_FAILED"
    user_message = "商品页面暂时无法读取"
    status_code = 502


class UnsafeRenderTargetError(RenderServiceError):
    code = "UNSAFE_TARGET"
    user_message = "商品页面地址不允许访问"
    status_code = 400


class RenderTimeoutError(RenderServiceError):
    code = "RENDER_TIMEOUT"
    user_message = "商品页面读取超时"
    status_code = 504


class RenderTooLargeError(RenderServiceError):
    code = "DOM_TOO_LARGE"
    user_message = "商品页面内容过大，暂时无法解析"
    status_code = 413


class UnsupportedContentError(RenderServiceError):
    code = "UNSUPPORTED_CONTENT"
    user_message = "该链接不是可解析的商品页面"
    status_code = 422


class Renderer(Protocol):
    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def render(self, url: str) -> RenderedPage: ...


class PlaywrightRenderer:
    _BLOCKED_RESOURCE_TYPES = frozenset({"image", "media", "font"})

    def __init__(self, settings: Settings, policy: UrlSafetyPolicy | None = None) -> None:
        self._settings = settings
        self._policy = policy or UrlSafetyPolicy()
        self._semaphore = asyncio.Semaphore(settings.max_concurrency)
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None

    async def start(self) -> None:
        if self._browser is not None:
            return
        self._playwright = await async_playwright().start()
        try:
            self._browser = await self._playwright.chromium.launch(
                headless=True,
                args=["--disable-dev-shm-usage"],
            )
        except BaseException:
            await self._playwright.stop()
            self._playwright = None
            raise

    async def stop(self) -> None:
        if self._browser is not None:
            await self._browser.close()
            self._browser = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None

    async def render(self, url: str) -> RenderedPage:
        try:
            target = await self._policy.validate(url)
        except UnsafeTargetError as exc:
            raise UnsafeRenderTargetError() from exc

        try:
            async with asyncio.timeout(self._settings.timeout_seconds):
                async with self._semaphore:
                    return await self._render_validated(target.url)
        except TimeoutError as exc:
            raise RenderTimeoutError() from exc
        except PlaywrightTimeoutError as exc:
            raise RenderTimeoutError() from exc
        except RenderServiceError:
            raise
        except PlaywrightError as exc:
            raise RenderServiceError() from exc

    async def _render_validated(self, url: str) -> RenderedPage:
        if self._browser is None:
            raise RuntimeError("renderer has not been started")
        context = await self._new_context()
        try:
            await context.route("**/*", self._handle_route)
            await context.route_web_socket("**/*", self._block_websocket)
            page = await context.new_page()
            response = await page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=int(self._settings.timeout_seconds * 1_000),
            )
            if response is None:
                raise RenderServiceError()
            content_type = response.headers.get("content-type", "").lower()
            if not any(item in content_type for item in ("text/html", "application/xhtml+xml")):
                raise UnsupportedContentError()

            final_target = await self._policy.validate(page.url)
            if self._settings.settle_milliseconds:
                await page.wait_for_timeout(self._settings.settle_milliseconds)
            html = await page.content()
            if len(html.encode("utf-8")) > self._settings.max_dom_bytes:
                raise RenderTooLargeError()
            title = (await page.title()).strip()[:500] or None
            return RenderedPage(
                html=html,
                final_url=final_target.url,
                host=final_target.host,
                title=title,
            )
        except UnsafeTargetError as exc:
            raise UnsafeRenderTargetError() from exc
        finally:
            await context.close()

    async def _new_context(self) -> BrowserContext:
        if self._browser is None:
            raise RuntimeError("renderer has not been started")
        return await self._browser.new_context(
            accept_downloads=False,
            java_script_enabled=True,
            service_workers="block",
            storage_state={"cookies": [], "origins": []},
        )

    async def _handle_route(self, route: Route, request: Request) -> None:
        if request.resource_type in self._BLOCKED_RESOURCE_TYPES:
            await route.abort("blockedbyclient")
            return
        try:
            await self._policy.validate(request.url)
        except UnsafeTargetError:
            await route.abort("blockedbyclient")
            return
        await route.continue_()

    @staticmethod
    async def _block_websocket(websocket: WebSocketRoute) -> None:
        await websocket.close(code=1008, reason="WebSocket connections are disabled")
