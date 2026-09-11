"""Fact-first task planning. All creative decisions belong to the AI provider."""
from __future__ import annotations

from collections.abc import Sequence
from .models import InsightApplicationMap, MaterialBrief, MaterialPlanResponse


def validate_material_tasks(
    response: MaterialPlanResponse,
    application: InsightApplicationMap,
    task_ids: Sequence[str],
) -> list[MaterialBrief]:
    actual = [row.task_id for row in response.tasks]
    if len(actual) != len(set(actual)) or set(actual) != set(task_ids):
        raise ValueError("material task identities/count mismatch")
    usable = {fact.fact_id for fact in application.usable}
    for row in response.tasks:
        if len(row.fact_ids) != len(set(row.fact_ids)) or not set(row.fact_ids) <= usable:
            raise ValueError("material task contains duplicate or unknown fact identifiers")
        if len(row.priority_dimensions) != len(set(row.priority_dimensions)):
            raise ValueError("material task repeats priority dimension")
    by_id = {row.task_id: row for row in response.tasks}
    return [by_id[key] for key in task_ids]
