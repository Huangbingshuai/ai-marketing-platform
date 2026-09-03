from typing import Any, cast

from effect_extraction.browser_renderer import PlaywrightCommerceRenderer


async def public_resolver(host: str, port: int) -> list[str]:
    return ["8.8.8.8"]


class FakeRequest:
    def __init__(self, url: str, resource_type: str) -> None:
        self.url = url
        self.resource_type = resource_type


class FakeRoute:
    def __init__(self) -> None:
        self.aborted = False
        self.continued = False

    async def abort(self, error_code: str | None = None) -> None:
        self.aborted = True

    async def continue_(self) -> None:
        self.continued = True


class FakeWebSocketRoute:
    def __init__(self) -> None:
        self.code: int | None = None
        self.reason: str | None = None

    async def close(
        self, *, code: int | None = None, reason: str | None = None
    ) -> None:
        self.code = code
        self.reason = reason


def make_renderer() -> PlaywrightCommerceRenderer:
    return PlaywrightCommerceRenderer(
        max_concurrency=2,
        timeout_seconds=25,
        max_dom_bytes=2 * 1024 * 1024,
        settle_milliseconds=750,
        resolver=public_resolver,
    )


async def test_route_blocks_heavy_resources() -> None:
    renderer = make_renderer()
    route = FakeRoute()
    await renderer._handle_route(  # noqa: SLF001
        cast(Any, route),
        cast(Any, FakeRequest("https://example.com/a.png", "image")),
    )

    assert route.aborted is True
    assert route.continued is False


async def test_route_blocks_unsafe_subrequest() -> None:
    renderer = make_renderer()
    route = FakeRoute()
    await renderer._handle_route(  # noqa: SLF001
        cast(Any, route),
        cast(Any, FakeRequest("http://127.0.0.1/internal", "xhr")),
    )

    assert route.aborted is True
    assert route.continued is False


async def test_route_allows_public_lightweight_resource() -> None:
    renderer = make_renderer()
    route = FakeRoute()
    await renderer._handle_route(  # noqa: SLF001
        cast(Any, route),
        cast(Any, FakeRequest("https://example.com/product.js", "script")),
    )

    assert route.aborted is False
    assert route.continued is True


async def test_websocket_connections_are_closed() -> None:
    websocket = FakeWebSocketRoute()
    await PlaywrightCommerceRenderer._block_websocket(  # noqa: SLF001
        cast(Any, websocket)
    )

    assert websocket.code == 1008
    assert websocket.reason == "WebSocket connections are disabled"
