"""Persist observable semantic work, never model reasoning or simulated progress."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from typing import Any, Awaitable, Callable

STEPS = (
    "RAW_AUDIT", "EVIDENCE_RECHECK", "TARGETED_REPAIR", "FINAL_REVIEW",
    "CONFLICT_EVIDENCE", "CONFLICT_COMPLETION",
)
Progress = Callable[[int, int], Awaitable[None]]


class SemanticActivity:
    def __init__(self, save: Callable[[dict[str, Any], str], Awaitable[None]]) -> None:
        self.save = save
        self.lock = asyncio.Lock()
        self.steps: list[dict[str, Any]] = [
            {"id": step, "status": "PENDING"} for step in STEPS
        ]

    def snapshot(self) -> dict[str, Any]:
        return {"schemaVersion": 1, "steps": deepcopy(self.steps)}

    async def set(self, step_id: str, status: str, **counts: Any) -> None:
        # Concurrent document completions must not overwrite newer counts in the DB.
        async with self.lock:
            step = next(s for s in self.steps if s["id"] == step_id)
            step.update(status=status, **counts)
            await self.save({"activity": self.snapshot()}, "RUNNING")

    def counter(self, step_id: str, unit: str) -> Progress:
        async def report(completed: int, total: int) -> None:
            await self.set(step_id, "RUNNING", completed=completed, total=total, unit=unit)
        return report

    async def fail(self, status: str) -> None:
        async with self.lock:
            for step in self.steps:
                if step["status"] == "RUNNING":
                    step["status"] = "FAILED"
            await self.save({"activity": self.snapshot()}, status)
