from __future__ import annotations

import json

import httpx
import pytest

import effect_extraction.commerce as commerce_module
from effect_extraction.commerce import (
    CommerceErrorType,
    CommerceFetchError,
    HttpCommerceRenderer,
    HttpxCommerceFetcher,
    RenderedPage,
    extract_commerce_page,
    validate_public_url,
)


async def public_resolver(host: str, port: int) -> list[str]:
    return ["8.8.8.8"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "http://user:password@example.com/product",
        "https://example.com:8443/product",
        "http://localhost/product",
    ],
)
async def test_validate_public_url_rejects_unsafe_shapes(url: str) -> None:
    with pytest.raises(CommerceFetchError) as raised:
        await validate_public_url(url, resolver=public_resolver)
    assert raised.value.error_type == CommerceErrorType.URL_REJECTED


@pytest.mark.asyncio
async def test_validate_public_url_rejects_any_private_dns_answer() -> None:
    async def rebinding_resolver(host: str, port: int) -> list[str]:
        return ["8.8.8.8", "127.0.0.1"]

    with pytest.raises(CommerceFetchError) as raised:
        await validate_public_url(
            "https://shop.example/product", resolver=rebinding_resolver
        )
    assert raised.value.error_type == CommerceErrorType.URL_REJECTED


def test_extract_commerce_page_prefers_json_ld_product_facts() -> None:
    html = """
    <html><head><title>站点标题</title>
    <meta property="og:title" content="推荐位商品">
    <script type="application/ld+json">
    {
      "@context": "https://schema.org", "@type": "Product",
      "name": "广式腊肠礼盒", "category": "腊味",
      "description": "六分瘦四分肥，天然肠衣",
      "additionalProperty": [{"name": "净含量", "value": "500g"}],
      "offers": {"price": "59", "priceCurrency": "CNY"},
      "aggregateRating": {"ratingValue": "4.9", "reviewCount": "1200"}
    }
    </script></head><body><main>广式腊肠礼盒 商品详情 六分瘦四分肥，天然肠衣，适合家庭佐餐。
    这是用于确保正文达到有效长度的公开商品说明，页面中的事实需要经过结构化模型抽取后参与多源融合。</main></body></html>
    """
    page = extract_commerce_page(html, source_host="shop.example", used_renderer=False)
    assert page.deterministic_candidate.product_name == "广式腊肠礼盒"
    assert page.deterministic_candidate.product_category == "腊味"
    assert page.deterministic_candidate.core_specification == "净含量：500g"
    assert page.deterministic_candidate.price_range == "CNY 59"
    assert page.deterministic_candidate.trust_backings == [
        "页面标注评分 4.9，评价数 1200"
    ]
    assert page.model_metadata["description"] == "六分瘦四分肥，天然肠衣"
    assert "<script" not in page.markdown


def test_generic_platform_title_is_not_treated_as_product_name() -> None:
    page = extract_commerce_page(
        """
        <html><head>
          <title>京东(JD.COM)-正品低价、品质保障、配送及时、轻松购物！</title>
        </head><body><div id="app"></div></body></html>
        """,
        source_host="item.jd.com",
        used_renderer=False,
    )

    assert page.deterministic_candidate.product_name is None
    assert page.model_metadata == {}


def test_extracts_public_jd_embedded_product_facts() -> None:
    page = extract_commerce_page(
        """
        <html><head><title>思香逢广味腊肠礼盒-京东</title></head><body>
        <script>
        window._itemOnly = ({
          "item": {
            "brandName": "思香逢",
            "skuId": "100136583762",
            "skuName": "思香逢广东腊肠4袋1000克礼盒",
            "saleProp": {"1": "规格"},
            "newColorSize": [{
              "skuId": "100136583762",
              "1": "广味腊肠4袋1000克礼盒"
            }]
          }
        });
        window._itemInfo = ({
          "product": {
            "skuId": "100136583762",
            "skuName": "思香逢广东腊肠4袋1000克礼盒",
            "brandName": "思香逢",
            "model": "广味腊肠1000克",
            "weight": "1.372kg",
            "productArea": "中国大陆",
            "upc": "6973121398469",
            "extend": {"features": {"shortTitle": "思香逢广味腊肠4袋"}}
          },
          "priceFloor": {"price": "59.90"},
          "stock": {
            "promiseResult": "预计<b>明天</b>送达",
            "D": {"shopName": "思香逢京东自营旗舰店"}
          }
        });
        </script>
        </body></html>
        """,
        source_host="item.m.jd.com",
        used_renderer=False,
    )

    assert page.deterministic_candidate.product_name == "思香逢广东腊肠4袋1000克礼盒"
    assert page.deterministic_candidate.price_range == "CNY 59.90"
    assert page.deterministic_candidate.core_specification == (
        "规格：广味腊肠4袋1000克礼盒；型号：广味腊肠1000克；"
        "重量：1.372kg；产地：中国大陆；商品编码：6973121398469"
    )
    assert page.model_metadata["brand"] == "思香逢"
    assert page.model_metadata["seller"] == "思香逢京东自营旗舰店"
    assert page.model_metadata["deliveryPromise"] == "预计明天送达"
    assert page.model_metadata["shortTitle"] == "思香逢广味腊肠4袋"


@pytest.mark.asyncio
async def test_static_fetch_revalidates_redirect_target() -> None:
    async def resolver(host: str, port: int) -> list[str]:
        return ["127.0.0.1"] if host == "internal.example" else ["8.8.8.8"]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302, headers={"location": "http://internal.example/admin"}
        )

    fetcher = HttpxCommerceFetcher(
        resolver=resolver, transport=httpx.MockTransport(handler)
    )
    with pytest.raises(CommerceFetchError) as raised:
        await fetcher.fetch("https://shop.example/product")
    assert raised.value.error_type == CommerceErrorType.URL_REJECTED


@pytest.mark.asyncio
async def test_static_fetch_rejects_non_html_and_oversized_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content_type_fetcher = HttpxCommerceFetcher(
        resolver=public_resolver,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, headers={"content-type": "application/pdf"}, content=b"pdf"
            )
        ),
    )
    with pytest.raises(CommerceFetchError) as content_type_error:
        await content_type_fetcher.fetch("https://shop.example/product")
    assert content_type_error.value.error_type == CommerceErrorType.CONTENT_TYPE

    monkeypatch.setattr(commerce_module, "MAX_STATIC_BYTES", 8)
    oversized_fetcher = HttpxCommerceFetcher(
        resolver=public_resolver,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                headers={"content-type": "text/html"},
                content=b"<html>too large</html>",
            )
        ),
    )
    with pytest.raises(CommerceFetchError) as oversized_error:
        await oversized_fetcher.fetch("https://shop.example/product")
    assert oversized_error.value.error_type == CommerceErrorType.TOO_LARGE


@pytest.mark.asyncio
async def test_static_fetch_classifies_captcha_without_leaking_page_content() -> None:
    fetcher = HttpxCommerceFetcher(
        resolver=public_resolver,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text="<html><body>访问验证：请完成滑动验证</body></html>",
            )
        ),
    )
    with pytest.raises(CommerceFetchError) as raised:
        await fetcher.fetch("https://shop.example/product?private=secret")
    assert raised.value.error_type == CommerceErrorType.ACCESS_RESTRICTED
    assert str(raised.value) == "商品页面需要登录或验证，暂时无法读取"
    assert "secret" not in str(raised.value)


@pytest.mark.asyncio
async def test_static_fetch_classifies_jd_risk_redirect_as_access_restricted() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "item.jd.com":
            return httpx.Response(
                302,
                headers={
                    "location": (
                        "https://cfe.m.jd.com/privatedomain/risk_handler/03101900/"
                    )
                },
            )
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text="<html><body>request blocked</body></html>",
        )

    fetcher = HttpxCommerceFetcher(
        resolver=public_resolver,
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(CommerceFetchError) as raised:
        await fetcher.fetch("https://item.jd.com/100136583762.html")

    assert raised.value.error_type == CommerceErrorType.ACCESS_RESTRICTED


@pytest.mark.asyncio
async def test_static_fetch_uses_renderer_when_html_is_only_a_js_shell() -> None:
    class Renderer:
        async def render(self, url: str) -> RenderedPage:
            return RenderedPage(
                html=(
                    "<html><head><title>动态商品</title></head><body>"
                    + "动态商品详情，净含量 500g，六分瘦四分肥。" * 20
                    + "</body></html>"
                ),
                final_url=url,
            )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text="<html><body><div id='app'></div></body></html>",
        )

    fetcher = HttpxCommerceFetcher(
        renderer=Renderer(),
        resolver=public_resolver,
        transport=httpx.MockTransport(handler),
    )
    page = await fetcher.fetch("https://shop.example/product")
    assert page.used_renderer is True
    assert page.page_title == "动态商品"
    assert "净含量 500g" in page.markdown


@pytest.mark.asyncio
async def test_static_fetch_uses_public_mobile_alternate_before_renderer() -> None:
    class Renderer:
        async def render(self, url: str) -> RenderedPage:
            raise AssertionError("mobile alternate should avoid browser rendering")

    desktop_html = """
    <html><head>
      <title>京东(JD.COM)-正品低价、品质保障、配送及时、轻松购物！</title>
      <meta name="mobile-agent"
            content="format=html5; url=//item.m.jd.com/product/100136583762.html">
    </head><body><div id="app"></div></body></html>
    """
    mobile_html = """
    <html><head><title>思香逢广东腊肠4袋1000克礼盒-京东</title></head><body>
      <script>
      window._itemOnly = ({"item": {
        "skuId": "100136583762",
        "skuName": "思香逢广东腊肠4袋1000克礼盒",
        "brandName": "思香逢"
      }});
      window._itemInfo = ({"product": {
        "skuId": "100136583762",
        "skuName": "思香逢广东腊肠4袋1000克礼盒",
        "brandName": "思香逢",
        "weight": "1.372kg"
      }});
      </script>
    </body></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=mobile_html if request.url.host == "item.m.jd.com" else desktop_html,
        )

    fetcher = HttpxCommerceFetcher(
        renderer=Renderer(),
        resolver=public_resolver,
        transport=httpx.MockTransport(handler),
    )
    page = await fetcher.fetch("https://item.jd.com/100136583762.html")

    assert page.used_renderer is False
    assert page.source_host == "item.m.jd.com"
    assert page.deterministic_candidate.product_name == "思香逢广东腊肠4袋1000克礼盒"
    assert page.model_metadata["brand"] == "思香逢"


@pytest.mark.asyncio
async def test_jd_homepage_redirect_uses_known_public_mobile_product_page() -> None:
    mobile_html = """
    <html><head><title>思香逢广东腊肠4袋1000克礼盒-京东</title></head><body>
      <script>
      window._itemOnly = ({"item": {
        "skuId": "100136583762",
        "skuName": "思香逢广东腊肠4袋1000克礼盒",
        "brandName": "思香逢"
      }});
      window._itemInfo = ({"product": {
        "skuId": "100136583762",
        "skuName": "思香逢广东腊肠4袋1000克礼盒",
        "brandName": "思香逢"
      }});
      </script>
    </body></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "item.jd.com":
            return httpx.Response(302, headers={"location": "https://www.jd.com/"})
        if request.url.host == "item.m.jd.com":
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=mobile_html,
            )
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text="<html><head><title>京东首页</title></head><body>"
            + "首页导航与推荐内容" * 100
            + "</body></html>",
        )

    fetcher = HttpxCommerceFetcher(
        resolver=public_resolver,
        transport=httpx.MockTransport(handler),
    )
    page = await fetcher.fetch("https://item.jd.com/100136583762.html")

    assert page.source_host == "item.m.jd.com"
    assert page.deterministic_candidate.product_name == "思香逢广东腊肠4袋1000克礼盒"


@pytest.mark.asyncio
async def test_renderer_client_uses_bearer_and_does_not_expose_url_in_error() -> None:
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers["authorization"]
        captured["body"] = request.content.decode()
        return httpx.Response(
            200,
            json={
                "html": "<html><body>商品详情</body></html>",
                "finalUrl": "https://shop.example/product",
                "host": "shop.example",
                "title": "商品",
            },
        )

    renderer = HttpCommerceRenderer(
        "http://renderer.test/",
        "renderer-secret",
        resolver=public_resolver,
        transport=httpx.MockTransport(handler),
    )
    rendered = await renderer.render("https://shop.example/product")
    assert rendered.final_url == "https://shop.example/product"
    assert captured["authorization"] == "Bearer renderer-secret"
    assert json.loads(captured["body"]) == {"url": "https://shop.example/product"}
