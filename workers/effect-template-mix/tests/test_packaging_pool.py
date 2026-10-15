import asyncio
from typing import Any
import pytest
from effect_template_mix.packaging import run_packaging_shards
from effect_template_mix.api import ApiError


@pytest.mark.parametrize('count', [1, 10, 100])
async def test_stable_shards_run_at_most_four_and_skip_success(count: int) -> None:
    active = maximum = 0
    done: list[int] = []
    rows = [{'id': i, 'shardIndex': i // 4, 'status': 'COMPLETED' if i % 7 == 0 else 'QUEUED'} for i in range(count)]
    async def execute(item: dict[str, Any]) -> None:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(.001)
        active -= 1
        done.append(item['id'])
    await run_packaging_shards(rows, 4, execute)
    assert maximum <= 4 and active == 0
    if count == 100:
        assert maximum == 4
    assert sorted(done) == [r['id'] for r in rows if r['status'] != 'COMPLETED']


async def test_next_shard_starts_before_slowest_previous_item_finishes() -> None:
    released = asyncio.Event()
    async def execute(item: dict[str, Any]) -> None:
        if item['id'] == 0:
            await asyncio.wait_for(released.wait(), 1)
        if item['id'] == 4:
            released.set()
    await run_packaging_shards([{'id': i, 'shardIndex': i // 4, 'status': 'QUEUED'} for i in range(8)], 4, execute)
    assert released.is_set()


async def test_lease_failure_cancels_inflight_and_never_starts_next_shard() -> None:
    started: list[int] = []
    cancelled: list[int] = []
    async def execute(item: dict[str, Any]) -> None:
        started.append(item['id'])
        if item['id'] == 0:
            await asyncio.sleep(.001)
            raise RuntimeError('lease expired')
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.append(item['id'])
    with pytest.raises(ExceptionGroup):
        await run_packaging_shards([{'id': i, 'status': 'QUEUED', 'shardIndex': i // 4} for i in range(100)], 4, execute)
    assert started == [0, 1, 2, 3] and sorted(cancelled) == [1, 2, 3]


async def test_cancel_drains_children() -> None:
    count = 0
    async def execute(_: dict[str, Any]) -> None:
        nonlocal count
        count += 1
        try:
            await asyncio.sleep(10)
        finally:
            count -= 1
    task = asyncio.create_task(run_packaging_shards([{'id': i, 'status': 'QUEUED', 'shardIndex': i // 4} for i in range(100)], 4, execute))
    await asyncio.sleep(.01)
    assert count == 4
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert count == 0


async def test_one_api_outage_drains_paid_siblings_without_cancelling_or_starting_new_items() -> None:
    started: list[int] = []
    saved: list[int] = []
    async def execute(item: dict[str, Any]) -> None:
        started.append(item['id'])
        await asyncio.sleep(.001 if item['id'] == 0 else .01)
        if item['id'] == 0:
            raise ApiError('temporary persistence outage', retryable=True)
        saved.append(item['id'])
    with pytest.raises(ExceptionGroup):
        await run_packaging_shards([{'id': i, 'status': 'QUEUED'} for i in range(10)], 4, execute)
    assert started == [0, 1, 2, 3]
    assert sorted(saved) == [1, 2, 3]


async def test_100_fake_provider_items_resume_without_repeating_saved_requests() -> None:
    class RateLimited(Exception):
        pass

    class FakeProvider:
        active = 0
        maximum = 0
        limited_once = False

        def __init__(self) -> None:
            self.calls: dict[tuple[int, str], int] = {}

        async def request(self, item_id: int, stage: str) -> str:
            key = (item_id, stage)
            self.calls[key] = self.calls.get(key, 0) + 1
            self.active += 1
            self.maximum = max(self.maximum, self.active)
            try:
                await asyncio.sleep(.001 if stage != 'music' else .002)
                if item_id == 7 and stage == 'voice' and not self.limited_once:
                    self.limited_once = True
                    raise RateLimited()
                return f'{item_id}:{stage}:saved'
            finally:
                self.active -= 1

    provider = FakeProvider()
    rows: list[dict[str, Any]] = [{'id': i, 'shardIndex': i // 4, 'status': 'QUEUED', 'checkpoint': {}} for i in range(100)]

    async def execute(item: dict[str, Any]) -> None:
        try:
            for stage in ('vision', 'script', 'voice', 'music'):
                if stage not in item['checkpoint']:
                    item['checkpoint'][stage] = await provider.request(item['id'], stage)
            item['status'] = 'COMPLETED'
        except RateLimited:
            item['status'] = 'FAILED'

    await run_packaging_shards(rows, 4, execute)
    assert sum(r['status'] == 'COMPLETED' for r in rows) == 99
    await run_packaging_shards(rows, 4, execute)
    assert all(r['status'] == 'COMPLETED' for r in rows)
    assert provider.maximum == 4 and provider.active == 0
    assert all(provider.calls[(i, 'music')] == 1 for i in range(100))
    assert provider.calls[(7, 'vision')] == provider.calls[(7, 'script')] == 1
