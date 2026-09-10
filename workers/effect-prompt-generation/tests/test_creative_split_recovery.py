from __future__ import annotations

import asyncio
from typing import Any

import pytest

from effect_prompt_generation.providers import MockAiProvider, ProviderError, ProviderErrorType
from test_supplement_recovery import ready_pipeline


class SplitRecoveryProvider(MockAiProvider):
    def __init__(self, failure: str) -> None:
        self.failure = failure
        self.first_slot = ""
        self.calls: list[tuple[str, ...]] = []

    async def generate_creatives(self, shard: Any, **kwargs: Any) -> Any:
        slots = tuple(task.slot_id for task in shard.tasks)
        self.calls.append(slots)
        if len(slots) > 1:
            raise ProviderError("split needed", error_type=ProviderErrorType.OUTPUT_TRUNCATED, retryable=False)
        if slots[0] == self.first_slot:
            if self.failure == "cancel":
                raise asyncio.CancelledError()
            if self.failure != "none":
                raise ProviderError(
                    "first half failed",
                    retryable=self.failure == "timeout",
                    error_type=ProviderErrorType.RESPONSE_INVALID
                    if self.failure == "invalid" else ProviderErrorType.TIMEOUT,
                )
        return await super().generate_creatives(shard, **kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["invalid", "timeout", "cancel", "none"])
async def test_split_recovery_does_not_leave_paid_sibling_after_failure(failure: str) -> None:
    provider = SplitRecoveryProvider(failure)
    pipeline, runtime = await ready_pipeline(provider)
    planned = await pipeline.plan_creatives(runtime, round_number=0)
    tasks = [task for shard in planned for task in shard.tasks][:2]
    assert len(tasks) == 2
    shard = planned[0].model_copy(update={"tasks": tasks})
    provider.first_slot = tasks[0].slot_id

    if failure in {"timeout", "cancel"}:
        error = asyncio.CancelledError if failure == "cancel" else ProviderError
        with pytest.raises(error):
            await pipeline.generate_creative_shard(runtime, shard)
    else:
        result = await pipeline.generate_creative_shard(runtime, shard)
        assert [item.slot_id for item in result] == (
            [task.slot_id for task in tasks] if failure == "none" else []
        )
    # Yield to expose abandoned gather siblings: no new calls may outlive return.
    calls_at_return = list(provider.calls)
    await asyncio.sleep(0)
    assert provider.calls == calls_at_return
    assert ((tasks[1].slot_id,) in provider.calls) is (failure == "none")
