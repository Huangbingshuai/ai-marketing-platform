"""Run-scoped, verified source and ffprobe cache for final film exports."""

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx

from .api import ApiError


class SourceCache:
    def __init__(self, project_id: str, run_id: str, *, limit_bytes: int = 2 * 1024**3,
                 root: Path | None = None) -> None:
        scope = hashlib.sha256(f'{UUID(project_id)}:{UUID(run_id)}'.encode('ascii')).hexdigest()[:32]
        self.directory = (root or Path(tempfile.gettempdir()) / 'effect-final-output-cache') / scope
        self.directory.mkdir(parents=True, exist_ok=True)
        self.limit_bytes = limit_bytes
        self._keys: dict[str, asyncio.Lock] = {}
        self._capacity = asyncio.Lock()
        self._probes: dict[str, dict[str, Any]] = {}
        self._probe_locks: dict[str, asyncio.Lock] = {}
        self._last_touch = 0

    def _touch(self, path: Path) -> None:
        self._last_touch = max(time.time_ns(), self._last_touch + 1_000_000)
        os.utime(path, ns=(self._last_touch, self._last_touch))

    @staticmethod
    def sweep(root: Path | None = None, *, max_age_seconds: int = 86400) -> None:
        base = root or Path(tempfile.gettempdir()) / 'effect-final-output-cache'
        if not base.exists():
            return
        now = time.time()
        for run in base.iterdir():
            if run.is_dir() and now - run.stat().st_mtime > max_age_seconds:
                shutil.rmtree(run)

    def cleanup(self) -> None:
        shutil.rmtree(self.directory, ignore_errors=True)

    def _entries(self, file_id: str) -> list[Path]:
        return list(self.directory.glob(f'{self._key(file_id)}-*.bin'))

    @staticmethod
    def _key(file_id: str) -> str:
        return hashlib.sha256(file_id.encode('utf-8')).hexdigest()[:32]

    @staticmethod
    def _digest(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(block)
        return digest.hexdigest()

    async def get(self, file_id: str, destination: Path,
                  download: Callable[[Path], Awaitable[tuple[int, int]]]) -> tuple[int, int, bool]:
        """Return bytes read, retries, cache hit; destination is a hardlink kept alive through eviction."""
        key = self._key(file_id)
        os.utime(self.directory, None)
        async with self._keys.setdefault(key, asyncio.Lock()):
            async with self._capacity:
                for entry in self._entries(file_id):
                    if self._digest(entry) != entry.stem.rsplit('-', 1)[-1]:
                        entry.unlink(missing_ok=True)
                        entry.with_suffix('.probe.json').unlink(missing_ok=True)
                        continue
                    self._touch(entry)
                    os.link(entry, destination)
                    return 0, 0, True
            part = self.directory / f'{key}.{os.getpid()}.part'
            try:
                byte_count, retries = await download(part)
                digest = self._digest(part)
                target = self.directory / f'{key}-{digest}.bin'
                async with self._capacity:
                    part.replace(target)
                    self._touch(target)
                    os.link(target, destination)
                    self._evict()
                return byte_count, retries, False
            finally:
                part.unlink(missing_ok=True)

    def _evict(self) -> None:
        entries = sorted(self.directory.glob('*.bin'), key=lambda p: p.stat().st_mtime_ns)
        used = sum(p.stat().st_size for p in entries)
        for entry in entries:
            if used <= self.limit_bytes:
                break
            used -= entry.stat().st_size
            entry.unlink(missing_ok=True)
            entry.with_suffix('.probe.json').unlink(missing_ok=True)

    async def probe(self, file_id: str, path: Path,
                    inspect: Callable[[Path], Awaitable[dict[str, Any]]]) -> dict[str, Any]:
        key = self._key(file_id)
        async with self._probe_locks.setdefault(key, asyncio.Lock()):
            digest = await asyncio.to_thread(self._digest, path)
            probe_key = f'{key}-{digest}'
            if probe_key in self._probes:
                return self._probes[probe_key]
            sidecar = self.directory / f'{key}-{digest}.probe.json'
            if sidecar.exists():
                try:
                    result = json.loads(sidecar.read_text(encoding='utf-8'))
                    if isinstance(result, dict) and 'streams' in result and 'format' in result:
                        self._probes[probe_key] = result
                        return result
                except (OSError, ValueError):
                    pass
            result = await inspect(path)
            temporary = sidecar.with_suffix('.part')
            temporary.write_text(json.dumps(result), encoding='utf-8')
            temporary.replace(sidecar)
            self._probes[probe_key] = result
            return result


async def retry_request(operation: Callable[[], Awaitable[Any]], *, attempts: int = 4) -> tuple[Any, int]:
    """Initial request plus up to three bounded retries for transient failures."""
    for index in range(attempts):
        try:
            return await operation(), index
        except ApiError as exc:
            if not exc.retryable or index == attempts - 1:
                raise
        except (httpx.TransportError, TimeoutError, ConnectionError, OSError) as exc:
            if index == attempts - 1:
                raise ApiError('internal API unavailable', retryable=True) from exc
        await asyncio.sleep(2**index)
    raise AssertionError('unreachable')
