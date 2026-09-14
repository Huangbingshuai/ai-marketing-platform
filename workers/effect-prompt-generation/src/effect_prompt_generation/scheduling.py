"""Bounded AI scheduling; never interprets creative content."""

from __future__ import annotations

import asyncio
from types import TracebackType


class AiConcurrencyLimiter:
    def __init__(self, limit: int) -> None:
        self.limit = max(1, limit)
        self.active = 0
        self._condition = asyncio.Condition()

    def reduce_after_rate_limit(self) -> None:
        # Existing requests finish normally. Waiting requests observe the new
        # bound when a holder releases; no permits or futures are discarded.
        self.limit = min(self.limit, 2)

    async def __aenter__(self) -> AiConcurrencyLimiter:
        async with self._condition:
            await self._condition.wait_for(lambda: self.active < self.limit)
            self.active += 1
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        async with self._condition:
            self.active -= 1
            self._condition.notify_all()
