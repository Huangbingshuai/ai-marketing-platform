from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit, urlunsplit


class UnsafeTargetError(ValueError):
    """Raised when a target is not safe for server-side rendering."""


@dataclass(frozen=True, slots=True)
class ValidatedTarget:
    url: str
    host: str
    port: int


_BLOCKED_HOSTS = frozenset(
    {
        "metadata.google.internal",
        "metadata.azure.internal",
        "instance-data.ec2.internal",
    }
)


class UrlSafetyPolicy:
    async def validate(self, raw_url: str) -> ValidatedTarget:
        parsed = self._parse(raw_url)
        host = self._normalise_host(parsed.hostname)
        port = self._validated_port(parsed)
        self._reject_metadata_host(host)
        await self._require_public_dns(host, port)

        safe_netloc = f"[{host}]" if ":" in host else host
        if parsed.port is not None:
            safe_netloc = f"{safe_netloc}:{port}"
        safe_url = urlunsplit(
            (parsed.scheme.lower(), safe_netloc, parsed.path or "/", parsed.query, "")
        )
        return ValidatedTarget(url=safe_url, host=host, port=port)

    @staticmethod
    def _parse(raw_url: str) -> SplitResult:
        try:
            parsed = urlsplit(raw_url.strip())
        except ValueError as exc:
            raise UnsafeTargetError("invalid target") from exc
        if parsed.scheme.lower() not in {"http", "https"}:
            raise UnsafeTargetError("unsupported scheme")
        if parsed.username is not None or parsed.password is not None:
            raise UnsafeTargetError("credentials are not allowed")
        if parsed.hostname is None:
            raise UnsafeTargetError("missing host")
        return parsed

    @staticmethod
    def _normalise_host(hostname: str | None) -> str:
        if not hostname:
            raise UnsafeTargetError("missing host")
        host = hostname.rstrip(".").lower()
        try:
            ipaddress.ip_address(host)
            return host
        except ValueError:
            pass
        try:
            normalised = host.encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise UnsafeTargetError("invalid host") from exc
        if not normalised or len(normalised) > 253:
            raise UnsafeTargetError("invalid host")
        return normalised

    @staticmethod
    def _validated_port(parsed: SplitResult) -> int:
        try:
            port = parsed.port
        except ValueError as exc:
            raise UnsafeTargetError("invalid port") from exc
        resolved = port or (443 if parsed.scheme.lower() == "https" else 80)
        if resolved not in {80, 443}:
            raise UnsafeTargetError("port is not allowed")
        return resolved

    @staticmethod
    def _reject_metadata_host(host: str) -> None:
        if host in _BLOCKED_HOSTS or any(host.endswith(f".{item}") for item in _BLOCKED_HOSTS):
            raise UnsafeTargetError("metadata target is not allowed")

    async def _require_public_dns(self, host: str, port: int) -> None:
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is not None:
            self._require_global_address(literal)
            return

        loop = asyncio.get_running_loop()
        try:
            answers = await loop.getaddrinfo(
                host,
                port,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
            )
        except (socket.gaierror, OSError) as exc:
            raise UnsafeTargetError("host cannot be resolved") from exc
        if not answers:
            raise UnsafeTargetError("host cannot be resolved")
        for answer in answers:
            address = ipaddress.ip_address(answer[4][0])
            self._require_global_address(address)

    @staticmethod
    def _require_global_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> None:
        if not address.is_global:
            raise UnsafeTargetError("non-public target is not allowed")
