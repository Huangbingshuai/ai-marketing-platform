import socket

import pytest

from effect_commerce_renderer.security import UnsafeTargetError, UrlSafetyPolicy


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "http://user:password@example.com",
        "http://example.com:8080",
        "http://127.0.0.1",
        "http://[::1]",
        "http://169.254.169.254/latest/meta-data",
        "http://metadata.google.internal",
    ],
)
async def test_rejects_unsafe_targets(url: str) -> None:
    with pytest.raises(UnsafeTargetError):
        await UrlSafetyPolicy().validate(url)


async def test_accepts_public_https_and_strips_fragment(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_getaddrinfo(*args: object, **kwargs: object) -> list[tuple[object, ...]]:
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]

    monkeypatch.setattr("asyncio.BaseEventLoop.getaddrinfo", fake_getaddrinfo)
    target = await UrlSafetyPolicy().validate("https://Example.COM/product?id=1#reviews")

    assert target.url == "https://example.com/product?id=1"
    assert target.host == "example.com"
    assert target.port == 443


async def test_rejects_dns_answer_when_any_address_is_private(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_getaddrinfo(*args: object, **kwargs: object) -> list[tuple[object, ...]]:
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 443)),
        ]

    monkeypatch.setattr("asyncio.BaseEventLoop.getaddrinfo", fake_getaddrinfo)
    with pytest.raises(UnsafeTargetError):
        await UrlSafetyPolicy().validate("https://example.com")
