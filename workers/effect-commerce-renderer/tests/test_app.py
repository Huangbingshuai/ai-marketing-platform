from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from effect_commerce_renderer.app import create_app
from effect_commerce_renderer.renderer import RenderedPage, RenderTimeoutError
from effect_commerce_renderer.settings import Settings


class FakeRenderer:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.error: Exception | None = None

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def render(self, url: str) -> RenderedPage:
        if self.error is not None:
            raise self.error
        return RenderedPage(
            html="<html><title>Product</title><body>Example</body></html>",
            final_url="https://example.com/product",
            host="example.com",
            title="Product",
        )


def make_settings() -> Settings:
    return Settings(token=SecretStr("0123456789abcdef"))


async def test_health_and_lifespan() -> None:
    renderer = FakeRenderer()
    app = create_app(make_settings(), renderer)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            response = await client.get("/health")
            assert response.status_code == 200
            assert response.json() == {"status": "ok"}
            assert renderer.started is True
    assert renderer.stopped is True


async def test_render_requires_bearer_token() -> None:
    app = create_app(make_settings(), FakeRenderer())
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            response = await client.post(
                "/render",
                json={"url": "https://example.com/product"},
            )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "UNAUTHORIZED"


async def test_render_returns_only_contract_fields() -> None:
    headers = {"Authorization": "Bearer 0123456789abcdef"}
    app = create_app(make_settings(), FakeRenderer())
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            response = await client.post(
                "/render",
                headers=headers,
                json={"url": "https://example.com/product"},
            )

    assert response.status_code == 200
    assert response.json() == {
        "html": "<html><title>Product</title><body>Example</body></html>",
        "finalUrl": "https://example.com/product",
        "host": "example.com",
        "title": "Product",
    }


async def test_render_error_is_safe_and_does_not_echo_url() -> None:
    renderer = FakeRenderer()
    renderer.error = RenderTimeoutError("https://secret.example/product?id=123")
    headers = {"Authorization": "Bearer 0123456789abcdef"}
    app = create_app(make_settings(), renderer)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            response = await client.post(
                "/render",
                headers=headers,
                json={"url": "https://secret.example/product?id=123"},
            )

    assert response.status_code == 504
    assert response.json() == {
        "detail": {"code": "RENDER_TIMEOUT", "message": "商品页面读取超时"}
    }
    assert "secret.example" not in response.text
