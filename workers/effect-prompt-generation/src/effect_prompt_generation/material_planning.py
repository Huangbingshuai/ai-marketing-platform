"""Fact-first task planning. All creative decisions belong to the AI provider."""
from __future__ import annotations

from collections.abc import Sequence
from .models import InsightApplicationMap, MaterialBrief, MaterialPlanResponse


MAX_NEW_MATERIAL_FACTS = 2


def validate_material_tasks(
    response: MaterialPlanResponse,
    application: InsightApplicationMap,
    task_ids: Sequence[str],
    remaining_primary_fact_ids: Sequence[str] = (),
) -> list[MaterialBrief]:
    actual = [row.task_id for row in response.tasks]
    if len(actual) != len(set(actual)) or set(actual) != set(task_ids):
        raise ValueError("material task identities/count mismatch")
    usable = {fact.fact_id for fact in application.usable}
    for row in response.tasks:
        if len(row.fact_ids) > MAX_NEW_MATERIAL_FACTS:
            raise ValueError("material task may contain one primary and one supporting fact")
        if len(row.fact_ids) != len(set(row.fact_ids)) or not set(row.fact_ids) <= usable:
            raise ValueError("material task contains duplicate or unknown fact identifiers")
        if len(row.priority_dimensions) != len(set(row.priority_dimensions)):
            raise ValueError("material task repeats priority dimension")
    remaining = set(remaining_primary_fact_ids)
    if remaining:
        primary = [row.primary_fact_id for row in response.tasks]
        expected_distinct = min(len(remaining), len(task_ids))
        if len(set(primary) & remaining) < expected_distinct:
            raise ValueError("material task did not rotate remaining primary facts")
    by_id = {row.task_id: row for row in response.tasks}
    return [by_id[key] for key in task_ids]
