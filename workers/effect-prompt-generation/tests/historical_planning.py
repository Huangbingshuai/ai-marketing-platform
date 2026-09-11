"""Explicit compatibility harness for pre-material-task checkpoint regressions.

New batches never use this entry point. New business behavior is exercised by
test_material_planning and current graph tests, not by this historical harness.
"""
from typing import Any
from effect_prompt_generation.pipeline import PromptGenerationPipeline


class HistoricalPlanningPipeline(PromptGenerationPipeline):
    async def plan_creatives(self, *args: Any, **kwargs: Any) -> Any:
        return await self._plan_legacy_item_creatives(*args, **kwargs)
