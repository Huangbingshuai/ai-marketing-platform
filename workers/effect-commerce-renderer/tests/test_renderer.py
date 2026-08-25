from typing import Any, cast

import pytest
from pydantic import SecretStr

from effect_commerce_renderer.renderer import PlaywrightRenderer
from effect_commerce_renderer.settings import Settings


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

    async def close(self, *, code: int | None = None, reason: str | None = None) -> None:
        self.code = code
        self.reason = reason


class AllowPolicy:
    async def validate(self, raw_url: str) -> object:
        return object()


class RejectPolicy:
    async def validate(self, raw_url: str) -> object:
        from effect_commerce_renderer.security import UnsafeTargetError

        raise UnsafeTargetError()


def make_renderer(policy: object) -> PlaywrightRenderer:
    return PlaywrightRenderer(
        Settings(token=SecretStr("0123456789abcdef")),
        policy=cast(Any, policy),
    )


async def test_route_blocks_heavy_resources() -> None:
    renderer = make_renderer(AllowPolicy())
    route = FakeRoute()
    await renderer._handle_route(  # noqa: SLF001
        cast(Any, route),
        cast(Any, FakeRequest("https://example.com/a.png", "image")),
    )
    assert route.aborted is True
    assert route.continued is False


async def test_route_blocks_unsafe_subrequest() -> None:
    renderer = make_renderer(RejectPolicy())
    route = FakeRoute()
    await renderer._handle_route(  # noqa: SLF001
        cast(Any, route),
        cast(Any, FakeRequest("http://127.0.0.1/internal", "xhr")),
    )
    assert route.aborted is True
    assert route.continued is False


async def test_websocket_connections_are_closed() -> None:
    websocket = FakeWebSocketRoute()
    await PlaywrightRenderer._block_websocket(cast(Any, websocket))  # noqa: SLF001

    assert websocket.code == 1008
    assert websocket.reason == "WebSocket connections are disabled"
