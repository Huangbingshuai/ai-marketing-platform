import asyncio
import hashlib
import os
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock
from types import SimpleNamespace

import pytest
import httpx

from effect_template_mix.api import ApiError
from effect_template_mix.api import InternalApi
from effect_template_mix import final_output
from effect_template_mix.final_output import FinalOutputHandler
from effect_template_mix.final_output_cache import SourceCache, retry_request


PROJECT = '11111111-1111-4111-8111-111111111111'
RUN = '22222222-2222-4222-8222-222222222222'


async def test_concurrent_same_source_downloads_once_and_probes_once(tmp_path: Path) -> None:
    cache = SourceCache(PROJECT, RUN, root=tmp_path)
    calls = 0
    async def download(path: Path) -> tuple[int, int]:
        nonlocal calls
        calls += 1
        await asyncio.sleep(.01)
        path.write_bytes(b'source')
        return 6, 0
    first = tmp_path / 'first.bin'
    second = tmp_path / 'second.bin'
    results = await asyncio.gather(cache.get('file', first, download), cache.get('file', second, download))
    assert calls == 1
    assert sorted(result[2] for result in results) == [False, True]
    assert first.read_bytes() == second.read_bytes() == b'source'
    inspect = AsyncMock(return_value={'streams': [], 'format': {}})
    await asyncio.gather(cache.probe('file', first, inspect), cache.probe('file', second, inspect))
    assert inspect.await_count == 1


async def test_corrupt_source_is_rejected_and_redownloaded(tmp_path: Path) -> None:
    cache = SourceCache(PROJECT, RUN, root=tmp_path)
    count = 0
    async def download(path: Path) -> tuple[int, int]:
        nonlocal count
        count += 1
        path.write_bytes(b'good')
        return 4, 0
    await cache.get('file', tmp_path / 'one', download)
    entry = next(cache.directory.glob('*.bin'))
    entry.write_bytes(b'evil')
    _, _, hit = await cache.get('file', tmp_path / 'two', download)
    assert not hit and count == 2
    assert (tmp_path / 'two').read_bytes() == b'good'


async def test_lru_scope_and_cleanup(tmp_path: Path) -> None:
    cache = SourceCache(PROJECT, RUN, root=tmp_path, limit_bytes=4)
    async def source(data: bytes, path: Path) -> tuple[int, int]:
        path.write_bytes(data)
        return len(data), 0
    await cache.get('old', tmp_path / 'old', lambda p: source(b'aaaa', p))
    await cache.get('new', tmp_path / 'new', lambda p: source(b'bbbb', p))
    assert not cache._entries('old')
    assert cache._entries('new')
    assert (tmp_path / 'old').read_bytes() == b'aaaa'  # linked render input survives eviction
    other = SourceCache(PROJECT, '33333333-3333-4333-8333-333333333333', root=tmp_path)
    cross_project = SourceCache('44444444-4444-4444-8444-444444444444', RUN, root=tmp_path)
    assert not other._entries('new') and not cross_project._entries('new')
    old_time = time.time() - 86401
    os.utime(cache.directory, (old_time, old_time))
    SourceCache.sweep(tmp_path)
    assert not cache.directory.exists()
    other.cleanup()
    cross_project.cleanup()


async def test_retry_transient_error_three_times_then_succeed(monkeypatch: Any) -> None:
    delays: list[int] = []
    async def immediate(seconds: int) -> None:
        delays.append(seconds)
    monkeypatch.setattr('effect_template_mix.final_output_cache.asyncio.sleep', immediate)
    attempts = 0
    async def operation() -> str:
        nonlocal attempts
        attempts += 1
        if attempts < 4:
            raise ApiError('temporary', retryable=True)
        return 'ok'
    assert await retry_request(operation) == ('ok', 3)
    assert attempts == 4 and delays == [1, 2, 4]


async def test_nonretryable_error_does_not_retry() -> None:
    attempts = 0
    async def operation() -> None:
        nonlocal attempts
        attempts += 1
        raise ApiError('stale lease', retryable=False)
    with pytest.raises(ApiError):
        await retry_request(operation)
    assert attempts == 1


@pytest.mark.parametrize('lost_lease', [False, True])
async def test_item_failure_is_isolated_but_lost_lease_stops_writeback(
    tmp_path: Path, monkeypatch: Any, lost_lease: bool,
) -> None:
    run_id = '55555555-5555-4555-8555-555555555555' if lost_lease else '66666666-6666-4666-8666-666666666666'
    items = [{'id': name, 'status': 'QUEUED', 'snapshot': {'resolution': '720p',
        'timeline': {'clips': [{'fileObjectId': 'clip'}]}, 'packaging': {'voices': {}}}}
        for name in ('broken', 'healthy')]
    api = AsyncMock(spec=InternalApi)
    api.ROOT = 'internal/workers/effect-template-mix'
    events: list[tuple[str, str]] = []
    async def request(method: str, path: str, **kwargs: Any) -> Any:
        if path.endswith('/claim'):
            return {'terminal': False, 'attemptToken': 'token', 'items': items}
        events.append((method, path))
        if path.endswith('/broken/video'):
            raise ApiError('输出租约已失效' if lost_lease else 'bad upload', retryable=False)
        return None
    api.request.side_effect = request
    class Response:
        def raise_for_status(self) -> None:
            pass
        async def aiter_bytes(self):
            yield b'media'
    class Stream:
        async def __aenter__(self) -> Response:
            return Response()
        async def __aexit__(self, *_: Any) -> None:
            pass
    api.client = SimpleNamespace(stream=lambda *_args, **_kwargs: Stream())
    async def fake_render(_snapshot: Any, _paths: Any, directory: Path, _progress: Any) -> Path:
        output = directory / 'final.mp4'
        output.write_bytes(b'fake video')
        return output
    monkeypatch.setattr(final_output, 'render', fake_render)
    message = AsyncMock()
    await FinalOutputHandler(api, 1000).handle(message, {'projectId': PROJECT, 'runId': run_id})
    message.ack.assert_awaited_once()
    if lost_lease:
        assert not any(path.endswith('/finish') for _, path in events)
        assert not any(path.endswith('/broken/progress') and call.kwargs.get('json', {}).get('errorMessage')
            for call in api.request.call_args_list for path in [call.args[1]])
    else:
        assert any(path.endswith('/healthy/video') for _, path in events)
        assert any(path.endswith('/finish') for _, path in events)
        assert any(call.args[1].endswith('/broken/progress') and call.kwargs.get('json', {}).get('errorMessage')
            for call in api.request.call_args_list)


async def test_lost_upload_response_retries_existing_result(monkeypatch: Any) -> None:
    run_id = '77777777-7777-4777-8777-777777777777'
    api = AsyncMock(spec=InternalApi)
    api.ROOT = 'internal/workers/effect-template-mix'
    uploads = 0
    async def request(_method: str, path: str, **_kwargs: Any) -> Any:
        nonlocal uploads
        if path.endswith('/claim'):
            return {'terminal': False, 'attemptToken': 'token', 'items': [{'id': 'item', 'status': 'QUEUED',
                'snapshot': {'resolution': '720p', 'timeline': {'clips': [{'fileObjectId': 'clip'}]},
                    'packaging': {'voices': {}}}}]}
        if path.endswith('/video'):
            uploads += 1
            if uploads == 1:
                raise ApiError('response lost after commit', retryable=True)
            return {'fileObjectId': 'already-committed'}
        return None
    api.request.side_effect = request
    class Response:
        def raise_for_status(self) -> None:
            pass
        async def aiter_bytes(self):
            yield b'media'
    class Stream:
        async def __aenter__(self) -> Response:
            return Response()
        async def __aexit__(self, *_: Any) -> None:
            pass
    api.client = SimpleNamespace(stream=lambda *_args, **_kwargs: Stream())
    async def fake_render(_snapshot: Any, _paths: Any, directory: Path, _progress: Any) -> Path:
        output = directory / 'final.mp4'
        output.write_bytes(b'fake video')
        return output
    monkeypatch.setattr(final_output, 'render', fake_render)
    await FinalOutputHandler(api, 1000).handle(AsyncMock(), {'projectId': PROJECT, 'runId': run_id})
    assert uploads == 2
    assert any(call.args[1].endswith('/finish') for call in api.request.call_args_list)


@pytest.mark.parametrize('first_failure', ['network', 'http_503', 'checksum'])
async def test_source_download_retries_and_replaces_partial_file(tmp_path: Path, first_failure: str) -> None:
    api = AsyncMock(spec=InternalApi)
    count = 0
    class Response:
        def __init__(self, attempt: int) -> None:
            self.status_code = 503 if first_failure == 'http_503' and attempt == 1 else 200
            self.headers = {'content-length': '4', 'x-content-sha256':
                '0' * 64 if first_failure == 'checksum' and attempt == 1
                else hashlib.sha256(b'good').hexdigest()}
            self.attempt = attempt
        def raise_for_status(self) -> None:
            pass
        async def aiter_bytes(self):
            if first_failure == 'network' and self.attempt == 1:
                yield b'part'
                raise httpx.RemoteProtocolError('connection dropped')
            yield b'good'
    class Stream:
        def __init__(self, attempt: int) -> None:
            self.attempt = attempt
        async def __aenter__(self) -> Response:
            return Response(self.attempt)
        async def __aexit__(self, *_: Any) -> None:
            pass
    def stream(*_args: Any, **_kwargs: Any) -> Stream:
        nonlocal count
        count += 1
        return Stream(count)
    api.client = SimpleNamespace(stream=stream)
    path = tmp_path / 'source.part'
    result = await FinalOutputHandler(api, 1000)._download('endpoint', 'file', PROJECT, {}, path,
        asyncio.Semaphore(8))
    assert result == (4, 1)
    assert count == 2 and path.read_bytes() == b'good'


async def test_download_limits_four_per_item_and_eight_per_worker(monkeypatch: Any) -> None:
    run_id = '88888888-8888-4888-8888-888888888888'
    api = AsyncMock(spec=InternalApi)
    api.ROOT = 'internal/workers/effect-template-mix'
    items = [{'id': item_id, 'status': 'QUEUED', 'snapshot': {
        'resolution': '720p', 'timeline': {'clips': [
            {'fileObjectId': f'{item_id}-{index}'} for index in range(6)]},
        'packaging': {'voices': {}}}} for item_id in ('first', 'second')]
    api.request.side_effect = lambda _method, path, **_kwargs: (
        {'terminal': False, 'attemptToken': 'token', 'items': items} if path.endswith('/claim') else None)
    active = 0
    peak = 0
    by_item = {'first': 0, 'second': 0}
    item_peak = {'first': 0, 'second': 0}
    class Response:
        def __init__(self, item_id: str) -> None:
            self.item_id = item_id
        def raise_for_status(self) -> None:
            pass
        async def aiter_bytes(self):
            nonlocal active, peak
            active += 1
            by_item[self.item_id] += 1
            peak = max(peak, active)
            item_peak[self.item_id] = max(item_peak[self.item_id], by_item[self.item_id])
            await asyncio.sleep(.02)
            active -= 1
            by_item[self.item_id] -= 1
            yield b'media'
    class Stream:
        def __init__(self, item_id: str) -> None:
            self.item_id = item_id
        async def __aenter__(self) -> Response:
            return Response(self.item_id)
        async def __aexit__(self, *_: Any) -> None:
            pass
    api.client = SimpleNamespace(stream=lambda _method, path, **_kwargs:
        Stream('first' if '/items/first/' in path else 'second'))
    async def fake_render(_snapshot: Any, _paths: Any, directory: Path, _progress: Any) -> Path:
        output = directory / 'final.mp4'
        output.write_bytes(b'fake video')
        return output
    monkeypatch.setattr(final_output, 'render', fake_render)
    await FinalOutputHandler(api, 1000).handle(AsyncMock(), {'projectId': PROJECT, 'runId': run_id})
    assert peak == 8
    assert item_peak == {'first': 4, 'second': 4}


async def test_interrupted_attempt_recovers_without_rerendering_completed_item(monkeypatch: Any) -> None:
    run_id = '99999999-9999-4999-8999-999999999999'
    api = AsyncMock(spec=InternalApi)
    api.ROOT = 'internal/workers/effect-template-mix'
    items = [{'id': item_id, 'status': 'QUEUED', 'snapshot': {
        'resolution': '720p', 'timeline': {'clips': [{'fileObjectId': 'clip'}]},
        'packaging': {'voices': {}}}} for item_id in ('first', 'second')]
    uploads = {'first': 0, 'second': 0}
    finished = 0
    async def request(_method: str, path: str, **_kwargs: Any) -> Any:
        nonlocal finished
        if path.endswith('/claim'):
            return {'terminal': False, 'attemptToken': 'fresh-token', 'items': items}
        if path.endswith('/video'):
            item_id = 'first' if '/items/first/' in path else 'second'
            items[0 if item_id == 'first' else 1]['status'] = 'COMPLETED'
            uploads[item_id] += 1
        if path.endswith('/finish'):
            finished += 1
        return None
    api.request.side_effect = request
    class Response:
        def raise_for_status(self) -> None:
            pass
        async def aiter_bytes(self):
            yield b'media'
    class Stream:
        async def __aenter__(self) -> Response:
            return Response()
        async def __aexit__(self, *_: Any) -> None:
            pass
    api.client = SimpleNamespace(stream=lambda *_args, **_kwargs: Stream())
    second_started = asyncio.Event()
    release_second = asyncio.Event()
    rendered = {'first': 0, 'second': 0}
    async def fake_render(snapshot: Any, _paths: Any, directory: Path, _progress: Any) -> Path:
        item_id = snapshot['itemId']
        rendered[item_id] += 1
        if item_id == 'second' and not release_second.is_set():
            second_started.set()
            await release_second.wait()
        output = directory / 'final.mp4'
        output.write_bytes(b'fake video')
        return output
    for item in items:
        item['snapshot']['itemId'] = item['id']
    monkeypatch.setattr(final_output, 'render', fake_render)
    handler = FinalOutputHandler(api, 1000, max_concurrency=1)
    first_message = AsyncMock()
    interrupted = asyncio.create_task(handler.handle(first_message, {'projectId': PROJECT, 'runId': run_id}))
    await asyncio.wait_for(second_started.wait(), 5)
    first_message.ack.assert_awaited_once()
    interrupted.cancel()
    with pytest.raises(asyncio.CancelledError):
        await interrupted
    assert uploads == {'first': 1, 'second': 0}
    assert finished == 0
    # The API's expired-lease scanner requeues the run without resetting COMPLETED rows.
    release_second.set()
    recovery_message = AsyncMock()
    await handler.handle(recovery_message, {'projectId': PROJECT, 'runId': run_id})
    recovery_message.ack.assert_awaited_once()
    assert rendered == {'first': 1, 'second': 2}
    assert uploads == {'first': 1, 'second': 1}
    assert finished == 1
