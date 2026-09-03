from __future__ import annotations

import asyncio
import time

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

from .commerce import (
    CommerceErrorType,
    CommerceFetchError,
    RenderedPage,
    Resolver,
    _default_resolver,
    validate_public_url,
)


class PlaywrightCommerceRenderer:
    """Process-local browser fallback for the extraction node's commerce branch."""

    _BLOCKED_RESOURCE_TYPES = frozenset({"image", "media", "font"})

    def __init__(
        self,
        *,
        max_concurrency: int,
        timeout_seconds: float,
        max_dom_bytes: int,
        settle_milliseconds: int,
        resolver: Resolver = _default_resolver,
    ) -> None:
        self._timeout_seconds = timeout_seconds
        self._max_dom_bytes = max_dom_bytes
        self._settle_milliseconds = settle_milliseconds
        self._resolver = resolver
        self._semaphore = asyncio.Semaphore(max_concurrency)
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

    async def close(self) -> None:
        if self._browser is not None:
            await self._browser.close()
            self._browser = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None

    async def render(self, url: str) -> RenderedPage:
        started = time.perf_counter()
        target = await validate_public_url(url, resolver=self._resolver)
        try:
            async with asyncio.timeout(self._timeout_seconds):
                async with self._semaphore:
                    return await self._render_validated(target.value)
        except TimeoutError as exc:
            raise self._error(
                CommerceErrorType.TIMEOUT,
                started,
                retryable=True,
            ) from exc
        except PlaywrightTimeoutError as exc:
            raise self._error(
                CommerceErrorType.TIMEOUT,
                started,
                retryable=True,
            ) from exc
        except CommerceFetchError:
            raise
        except PlaywrightError as exc:
            raise self._error(
                CommerceErrorType.RENDERER,
                started,
                retryable=True,
            ) from exc

    async def _render_validated(self, url: str) -> RenderedPage:
        if self._browser is None:
            raise RuntimeError("commerce browser has not been started")
        context = await self._new_context()
        try:
            await context.route("**/*", self._handle_route)
            await context.route_web_socket("**/*", self._block_websocket)
            page = await context.new_page()
            response = await page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=int(self._timeout_seconds * 1_000),
            )
            if response is None:
                raise CommerceFetchError(
                    CommerceErrorType.RENDERER,
                    retryable=True,
                )
            content_type = response.headers.get("content-type", "").lower()
            if not any(
                item in content_type for item in ("text/html", "application/xhtml+xml")
            ):
                raise CommerceFetchError(CommerceErrorType.CONTENT_TYPE)

            final_target = await validate_public_url(
                page.url,
                resolver=self._resolver,
            )
            if self._settle_milliseconds:
                await page.wait_for_timeout(self._settle_milliseconds)
            html = await page.content()
            if len(html.encode("utf-8")) > self._max_dom_bytes:
                raise CommerceFetchError(CommerceErrorType.TOO_LARGE)
            return RenderedPage(html=html, final_url=final_target.value)
        finally:
            await context.close()

    async def _new_context(self) -> BrowserContext:
        if self._browser is None:
            raise RuntimeError("commerce browser has not been started")
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
            await validate_public_url(request.url, resolver=self._resolver)
        except CommerceFetchError:
            await route.abort("blockedbyclient")
            return
        await route.continue_()

    @staticmethod
    async def _block_websocket(websocket: WebSocketRoute) -> None:
        await websocket.close(code=1008, reason="WebSocket connections are disabled")

    @staticmethod
    def _error(
        error_type: CommerceErrorType,
        started: float,
        *,
        retryable: bool,
    ) -> CommerceFetchError:
        return CommerceFetchError(
            error_type,
            retryable=retryable,
            elapsed_ms=max(0, round((time.perf_counter() - started) * 1_000)),
        )
