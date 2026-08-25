from __future__ import annotations

import asyncio
import importlib
import ipaddress
import json
import socket
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol, cast
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from .models import ExtractionCandidate

MAX_STATIC_BYTES = 3 * 1024 * 1024
MAX_RENDERED_BYTES = 2 * 1024 * 1024
MAX_CLEAN_TEXT_CHARS = 80_000
MAX_REDIRECTS = 3
MIN_USEFUL_TEXT_CHARS = 200

Resolver = Callable[[str, int], Awaitable[list[str]]]


class CommerceErrorType(StrEnum):
    URL_REJECTED = "COMMERCE_URL_REJECTED"
    DNS_FAILED = "COMMERCE_DNS_FAILED"
    TIMEOUT = "COMMERCE_FETCH_TIMEOUT"
    NETWORK = "COMMERCE_FETCH_NETWORK"
    HTTP_STATUS = "COMMERCE_HTTP_STATUS"
    CONTENT_TYPE = "COMMERCE_CONTENT_TYPE"
    TOO_LARGE = "COMMERCE_CONTENT_TOO_LARGE"
    ACCESS_RESTRICTED = "COMMERCE_ACCESS_RESTRICTED"
    EMPTY_CONTENT = "COMMERCE_EMPTY_CONTENT"
    RENDERER = "COMMERCE_RENDERER_FAILED"


_SAFE_MESSAGES: dict[CommerceErrorType, str] = {
    CommerceErrorType.URL_REJECTED: "商品链接不符合安全访问要求",
    CommerceErrorType.DNS_FAILED: "商品页面地址暂时无法解析",
    CommerceErrorType.TIMEOUT: "商品页面读取超时",
    CommerceErrorType.NETWORK: "商品页面暂时无法访问",
    CommerceErrorType.HTTP_STATUS: "商品页面暂时无法读取",
    CommerceErrorType.CONTENT_TYPE: "该链接不是可解析的商品页面",
    CommerceErrorType.TOO_LARGE: "商品页面内容过大，暂时无法解析",
    CommerceErrorType.ACCESS_RESTRICTED: "商品页面需要登录或验证，暂时无法读取",
    CommerceErrorType.EMPTY_CONTENT: "商品页面中未读取到有效商品信息",
    CommerceErrorType.RENDERER: "商品页面动态内容暂时无法读取",
}


class CommerceFetchError(RuntimeError):
    def __init__(
        self,
        error_type: CommerceErrorType,
        *,
        retryable: bool = False,
        attempts: int = 1,
        elapsed_ms: int = 0,
    ) -> None:
        super().__init__(_SAFE_MESSAGES[error_type])
        self.error_type = error_type
        self.retryable = retryable
        self.attempts = max(1, attempts)
        self.elapsed_ms = max(0, elapsed_ms)


@dataclass(frozen=True, slots=True)
class ValidatedUrl:
    value: str
    host: str
    port: int


@dataclass(frozen=True, slots=True)
class RenderedPage:
    html: str
    final_url: str


@dataclass(frozen=True, slots=True)
class CommercePage:
    markdown: str
    source_host: str
    page_title: str | None
    deterministic_candidate: ExtractionCandidate
    model_metadata: dict[str, Any]
    used_renderer: bool


class CommerceRenderer(Protocol):
    async def render(self, url: str) -> RenderedPage: ...


class CommerceFetcher(Protocol):
    async def fetch(self, url: str) -> CommercePage: ...


async def _default_resolver(host: str, port: int) -> list[str]:
    def resolve() -> list[str]:
        records = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        return list(dict.fromkeys(str(record[4][0]) for record in records))

    try:
        return await asyncio.to_thread(resolve)
    except socket.gaierror as exc:
        raise CommerceFetchError(CommerceErrorType.DNS_FAILED, retryable=True) from exc


async def validate_public_url(url: str, *, resolver: Resolver = _default_resolver) -> ValidatedUrl:
    raw = url.strip()
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise CommerceFetchError(CommerceErrorType.URL_REJECTED) from exc
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise CommerceFetchError(CommerceErrorType.URL_REJECTED)
    if parsed.username is not None or parsed.password is not None:
        raise CommerceFetchError(CommerceErrorType.URL_REJECTED)
    resolved_port = port or (443 if parsed.scheme.lower() == "https" else 80)
    if resolved_port not in {80, 443}:
        raise CommerceFetchError(CommerceErrorType.URL_REJECTED)
    try:
        host = parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".")
    except UnicodeError as exc:
        raise CommerceFetchError(CommerceErrorType.URL_REJECTED) from exc
    if not host or host == "localhost" or host.endswith(".localhost"):
        raise CommerceFetchError(CommerceErrorType.URL_REJECTED)

    addresses = await resolver(host, resolved_port)
    if not addresses:
        raise CommerceFetchError(CommerceErrorType.DNS_FAILED, retryable=True)
    try:
        parsed_addresses = [ipaddress.ip_address(address) for address in addresses]
    except ValueError as exc:
        raise CommerceFetchError(CommerceErrorType.DNS_FAILED, retryable=True) from exc
    if any(not address.is_global for address in parsed_addresses):
        raise CommerceFetchError(CommerceErrorType.URL_REJECTED)

    default_port = (parsed.scheme.lower() == "https" and resolved_port == 443) or (
        parsed.scheme.lower() == "http" and resolved_port == 80
    )
    display_host = f"[{host}]" if ":" in host else host
    netloc = display_host if default_port else f"{display_host}:{resolved_port}"
    normalized = urlunsplit(
        (parsed.scheme.lower(), netloc, parsed.path or "/", parsed.query, "")
    )
    return ValidatedUrl(value=normalized, host=host, port=resolved_port)


class HttpCommerceRenderer:
    """Client for the isolated renderer; the renderer must repeat the SSRF checks itself."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 30.0,
        resolver: Resolver = _default_resolver,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/") + "/"
        self._token = token
        self._timeout = timeout
        self._resolver = resolver
        self._transport = transport

    async def render(self, url: str) -> RenderedPage:
        started = time.perf_counter()
        await validate_public_url(url, resolver=self._resolver)
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout,
                transport=self._transport,
                trust_env=False,
                headers={
                    "authorization": f"Bearer {self._token}",
                    "accept": "application/json",
                },
            ) as client:
                response = await client.post("render", json={"url": url})
        except httpx.TimeoutException as exc:
            raise CommerceFetchError(
                CommerceErrorType.TIMEOUT,
                retryable=True,
                elapsed_ms=_elapsed_ms(started),
            ) from exc
        except httpx.NetworkError as exc:
            raise CommerceFetchError(
                CommerceErrorType.RENDERER,
                retryable=True,
                elapsed_ms=_elapsed_ms(started),
            ) from exc
        if response.is_error:
            raise CommerceFetchError(
                CommerceErrorType.RENDERER,
                retryable=response.status_code == 429 or response.status_code >= 500,
                elapsed_ms=_elapsed_ms(started),
            )
        try:
            payload: Any = response.json()
            if isinstance(payload, Mapping) and payload.get("success") is True:
                payload = payload.get("data")
            if not isinstance(payload, Mapping):
                raise ValueError("renderer payload is not an object")
            html = payload.get("html")
            final_url = payload.get("finalUrl", url)
            if not isinstance(html, str) or not isinstance(final_url, str):
                raise ValueError("renderer payload fields are invalid")
        except (ValueError, TypeError) as exc:
            raise CommerceFetchError(
                CommerceErrorType.RENDERER, elapsed_ms=_elapsed_ms(started)
            ) from exc
        if len(html.encode("utf-8")) > MAX_RENDERED_BYTES:
            raise CommerceFetchError(
                CommerceErrorType.TOO_LARGE, elapsed_ms=_elapsed_ms(started)
            )
        await validate_public_url(final_url, resolver=self._resolver)
        return RenderedPage(html=html, final_url=final_url)


class HttpxCommerceFetcher:
    def __init__(
        self,
        *,
        renderer: CommerceRenderer | None = None,
        resolver: Resolver = _default_resolver,
        transport: httpx.AsyncBaseTransport | None = None,
        connect_timeout: float = 5.0,
        read_timeout: float = 15.0,
    ) -> None:
        self._renderer = renderer
        self._resolver = resolver
        self._transport = transport
        self._timeout = httpx.Timeout(
            connect=connect_timeout,
            read=read_timeout,
            write=connect_timeout,
            pool=connect_timeout,
        )

    async def fetch(self, url: str) -> CommercePage:
        started = time.perf_counter()
        validated = await validate_public_url(url, resolver=self._resolver)
        try:
            html, final = await self._fetch_html(validated)
            page = extract_commerce_page(html, source_host=final.host, used_renderer=False)
            if _needs_renderer(page) and self._renderer is not None:
                rendered = await self._renderer.render(final.value)
                rendered_url = await validate_public_url(
                    rendered.final_url, resolver=self._resolver
                )
                page = extract_commerce_page(
                    rendered.html, source_host=rendered_url.host, used_renderer=True
                )
            if _is_access_restricted(page.markdown):
                raise CommerceFetchError(
                    CommerceErrorType.ACCESS_RESTRICTED,
                    elapsed_ms=_elapsed_ms(started),
                )
            if _needs_renderer(page):
                raise CommerceFetchError(
                    CommerceErrorType.EMPTY_CONTENT,
                    elapsed_ms=_elapsed_ms(started),
                )
            return page
        except CommerceFetchError:
            raise
        except httpx.TimeoutException as exc:
            raise CommerceFetchError(
                CommerceErrorType.TIMEOUT,
                retryable=True,
                elapsed_ms=_elapsed_ms(started),
            ) from exc
        except httpx.NetworkError as exc:
            raise CommerceFetchError(
                CommerceErrorType.NETWORK,
                retryable=True,
                elapsed_ms=_elapsed_ms(started),
            ) from exc

    async def _fetch_html(self, initial: ValidatedUrl) -> tuple[str, ValidatedUrl]:
        current = initial
        async with httpx.AsyncClient(
            timeout=self._timeout,
            transport=self._transport,
            follow_redirects=False,
            trust_env=False,
            headers={
                "accept": "text/html,application/xhtml+xml",
                "user-agent": "AI-Marketing-CommerceExtractor/1.0",
            },
        ) as client:
            for redirect_count in range(MAX_REDIRECTS + 1):
                async with client.stream("GET", current.value) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location or redirect_count >= MAX_REDIRECTS:
                            raise CommerceFetchError(CommerceErrorType.HTTP_STATUS)
                        current = await validate_public_url(
                            urljoin(current.value, location), resolver=self._resolver
                        )
                        continue
                    if response.is_error:
                        raise CommerceFetchError(
                            CommerceErrorType.HTTP_STATUS,
                            retryable=response.status_code == 429 or response.status_code >= 500,
                        )
                    content_type = response.headers.get("content-type", "").lower()
                    if not (
                        content_type.startswith("text/html")
                        or content_type.startswith("application/xhtml+xml")
                    ):
                        raise CommerceFetchError(CommerceErrorType.CONTENT_TYPE)
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > MAX_STATIC_BYTES:
                            raise CommerceFetchError(CommerceErrorType.TOO_LARGE)
                    encoding = response.encoding or "utf-8"
                    return bytes(content).decode(encoding, errors="replace"), current
        raise CommerceFetchError(CommerceErrorType.HTTP_STATUS)


def extract_commerce_page(
    html: str, *, source_host: str, used_renderer: bool
) -> CommercePage:
    document = _html_document(html)
    title = _page_title(document)
    open_graph = _open_graph(document)
    product = _structured_product(document)
    model_metadata = _model_metadata(product, open_graph, title)
    candidate = _deterministic_candidate(model_metadata)
    markdown = _clean_markdown(html, document, title)[:MAX_CLEAN_TEXT_CHARS]
    return CommercePage(
        markdown=markdown,
        source_host=source_host,
        page_title=title,
        deterministic_candidate=candidate,
        model_metadata=model_metadata,
        used_renderer=used_renderer,
    )


def merge_commerce_candidates(
    deterministic: ExtractionCandidate, inferred: ExtractionCandidate
) -> ExtractionCandidate:
    merged = inferred.model_copy(deep=True)
    for field_name in ExtractionCandidate.model_fields:
        value = getattr(deterministic, field_name)
        if value is not None and value != []:
            setattr(merged, field_name, value)
    return merged


def has_candidate_data(candidate: ExtractionCandidate) -> bool:
    return any(value is not None and value != [] for value in candidate.model_dump().values())


def _html_document(html: str) -> Any:
    lxml_html = importlib.import_module("lxml.html")
    try:
        return lxml_html.fromstring(html)
    except (ValueError, TypeError) as exc:
        raise CommerceFetchError(CommerceErrorType.EMPTY_CONTENT) from exc


def _page_title(document: Any) -> str | None:
    values = document.xpath("//title/text()")
    return _compact(values[0], 200) if values else None


def _open_graph(document: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for element in document.xpath("//meta[@content]"):
        key = element.get("property") or element.get("name")
        value = element.get("content")
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        normalized = key.strip().lower()
        if normalized in {
            "og:title",
            "og:description",
            "product:price:amount",
            "product:price:currency",
            "description",
        }:
            compact = _compact(value, 2_000)
            if compact:
                result[normalized] = compact
    return result


def _structured_product(document: Any) -> dict[str, Any]:
    for element in document.xpath("//script[@type='application/ld+json']"):
        raw = element.text
        if not isinstance(raw, str) or not raw.strip():
            continue
        try:
            payload: Any = json.loads(raw)
        except json.JSONDecodeError:
            continue
        found = _find_product(payload)
        if found is not None:
            return found
    return {}


def _find_product(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        raw_type = value.get("@type")
        types = raw_type if isinstance(raw_type, list) else [raw_type]
        if any(str(item).casefold() == "product" for item in types):
            return dict(value)
        graph = value.get("@graph")
        found = _find_product(graph)
        if found is not None:
            return found
        for child in value.values():
            found = _find_product(child)
            if found is not None:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _find_product(item)
            if found is not None:
                return found
    return None


def _model_metadata(
    product: Mapping[str, Any], open_graph: Mapping[str, str], title: str | None
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    name = _first_string(product.get("name"), open_graph.get("og:title"), title)
    category = _first_string(product.get("category"))
    description = _first_string(
        product.get("description"),
        open_graph.get("og:description"),
        open_graph.get("description"),
    )
    if name:
        result["name"] = _compact(name, 300)
    if category:
        result["category"] = _compact(category, 200)
    if description:
        result["description"] = _compact(description, 4_000)

    offers = product.get("offers")
    if isinstance(offers, list):
        offers = offers[0] if offers else None
    if isinstance(offers, Mapping):
        low = _first_string(offers.get("lowPrice"), offers.get("price"))
        high = _first_string(offers.get("highPrice"))
        currency = _first_string(offers.get("priceCurrency"))
    else:
        low = open_graph.get("product:price:amount")
        high = None
        currency = open_graph.get("product:price:currency")
    if low:
        result["price"] = _compact(low, 80)
    if high:
        result["highPrice"] = _compact(high, 80)
    if currency:
        result["currency"] = _compact(currency, 20)

    properties = product.get("additionalProperty")
    specs: list[str] = []
    if isinstance(properties, list):
        for prop in properties[:20]:
            if not isinstance(prop, Mapping):
                continue
            prop_name = _first_string(prop.get("name"))
            prop_value = _first_string(prop.get("value"))
            if prop_name and prop_value:
                specs.append(f"{_compact(prop_name, 80)}：{_compact(prop_value, 160)}")
    if specs:
        result["specifications"] = specs

    rating = product.get("aggregateRating")
    if isinstance(rating, Mapping):
        rating_value = _first_string(rating.get("ratingValue"))
        review_count = _first_string(rating.get("reviewCount"), rating.get("ratingCount"))
        if rating_value:
            result["ratingValue"] = _compact(rating_value, 40)
        if review_count:
            result["reviewCount"] = _compact(review_count, 40)
    return result


def _deterministic_candidate(metadata: Mapping[str, Any]) -> ExtractionCandidate:
    candidate = ExtractionCandidate.empty()
    candidate.product_name = _optional_string(metadata.get("name"))
    candidate.product_category = _optional_string(metadata.get("category"))
    specs = metadata.get("specifications")
    if isinstance(specs, list):
        candidate.core_specification = "；".join(
            str(item) for item in specs if isinstance(item, str)
        )[:500] or None
    price = _optional_string(metadata.get("price"))
    high = _optional_string(metadata.get("highPrice"))
    currency = _optional_string(metadata.get("currency"))
    if price:
        amount = f"{price}～{high}" if high and high != price else price
        candidate.price_range = f"{currency + ' ' if currency else ''}{amount}"[:120]
    rating = _optional_string(metadata.get("ratingValue"))
    count = _optional_string(metadata.get("reviewCount"))
    if rating and count:
        candidate.trust_backings = [f"页面标注评分 {rating}，评价数 {count}"]
    return candidate


def _clean_markdown(html: str, document: Any, title: str | None) -> str:
    markdown: str | None = None
    try:
        trafilatura = importlib.import_module("trafilatura")
        extracted = trafilatura.extract(
            html,
            output_format="markdown",
            include_comments=False,
            include_tables=True,
            favor_precision=True,
        )
        markdown = cast(str | None, extracted)
    except (ImportError, AttributeError, TypeError, ValueError):
        markdown = None
    if not markdown:
        for element in document.xpath("//script|//style|//noscript|//svg"):
            parent = element.getparent()
            if parent is not None:
                parent.remove(element)
        markdown = "\n".join(
            text.strip() for text in document.itertext() if isinstance(text, str) and text.strip()
        )
    cleaned = "\n".join(line.rstrip() for line in markdown.splitlines()).strip()
    if title and title.casefold() not in cleaned[:500].casefold():
        cleaned = f"# {title}\n\n{cleaned}" if cleaned else f"# {title}"
    return cleaned


def _needs_renderer(page: CommercePage) -> bool:
    return len(page.markdown.strip()) < MIN_USEFUL_TEXT_CHARS and not has_candidate_data(
        page.deterministic_candidate
    )


def _is_access_restricted(markdown: str) -> bool:
    compact = markdown.casefold()[:5_000]
    indicators = (
        "captcha",
        "verify you are human",
        "访问验证",
        "安全验证",
        "请登录后查看",
        "滑动验证",
    )
    return len(compact) < 2_000 and any(indicator in compact for indicator in indicators)


def _first_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
    return None


def _optional_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _compact(value: Any, limit: int) -> str:
    return " ".join(str(value).split())[:limit]


def _elapsed_ms(started: float) -> int:
    return max(0, round((time.perf_counter() - started) * 1000))
