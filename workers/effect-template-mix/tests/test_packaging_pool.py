import asyncio
from typing import Any
import pytest
from effect_template_mix.packaging import run_packaging_shards


@pytest.mark.parametrize('count', [1, 10, 100])
async def test_stable_shards_run_at_most_four_and_skip_success(count: int) -> None:
    active = maximum = 0
    done: list[int] = []
    rows = [{'id': i, 'shardIndex': i // 4, 'status': 'COMPLETED' if i % 7 == 0 else 'QUEUED'} for i in range(count)]
    async def execute(item: dict[str, Any]) -> None:
        nonlocal active, maximum
        assert all(r['id'] in done or r['status'] == 'COMPLETED' for r in rows if r['shardIndex'] < item['shardIndex'])
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
