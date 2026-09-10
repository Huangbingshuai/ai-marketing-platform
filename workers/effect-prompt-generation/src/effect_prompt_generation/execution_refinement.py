"""Provider-only sparse edits. No product, action or camera semantics live here."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal

from pydantic import Field

from .models import ApiModel, CreativeCandidate, CreativeCandidateDraft
from .shot_plan import compile_material_shot_plan


class ExecutionConflict(ApiModel):
    paths: list[str] = Field(min_length=1, max_length=16)
    reason: str = Field(min_length=1, max_length=240)


class ExecutionTextReplacement(ApiModel):
    path: str = Field(min_length=1, max_length=120)
    value: str | None = Field(max_length=480)


class ExecutionEditDecision(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    decision: Literal["KEEP", "REPAIR"]
    conflicts: list[ExecutionConflict] = Field(max_length=12)
    replacements: list[ExecutionTextReplacement] = Field(max_length=64)


class ExecutionEditBatch(ApiModel):
    items: list[ExecutionEditDecision] = Field(min_length=1, max_length=5)


def editable_execution_paths(candidate: CreativeCandidate) -> list[str]:
    """Enumerate only existing text leaves, never identity, facts or timing."""
    data = candidate.model_dump(mode="json", by_alias=True)
    paths: list[str] = []

    def visit(value: Any, path: str) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                visit(child, f"{path}/{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, f"{path}/{index}")
        elif isinstance(value, str) or value is None:
            paths.append(path)

    for root in ("creativeCore", "dimensions", "shotPlan"):
        if data[root] is not None:
            visit(data[root], f"/{root}")
    return paths


def execution_edit_schema(candidates: Sequence[CreativeCandidate]) -> dict[str, Any]:
    schema = ExecutionEditBatch.model_json_schema(by_alias=True)
    schema["properties"]["items"].update(minItems=len(candidates), maxItems=len(candidates))
    schema["$defs"]["ExecutionEditDecision"]["properties"]["slotId"]["enum"] = [
        candidate.slot_id for candidate in candidates
    ]
    paths = sorted({path for candidate in candidates for path in editable_execution_paths(candidate)})
    schema["$defs"]["ExecutionTextReplacement"]["properties"]["path"]["enum"] = paths
    schema["$defs"]["ExecutionConflict"]["properties"]["paths"]["items"]["enum"] = paths
    return schema


def apply_execution_edits(
    original: CreativeCandidate, decision: ExecutionEditDecision, *, duration_seconds: int,
) -> CreativeCandidate:
    if decision.slot_id != original.slot_id:
        raise ValueError("execution edit identity mismatch")
    if decision.decision == "KEEP":
        if decision.conflicts or decision.replacements:
            raise ValueError("KEEP cannot contain edits or conflicts")
        return original
    if not decision.conflicts or not decision.replacements:
        raise ValueError("REPAIR requires conflicts and replacements")
    allowed = set(editable_execution_paths(original))
    paths = [replacement.path for replacement in decision.replacements]
    if len(paths) != len(set(paths)) or not set(paths) <= allowed:
        raise ValueError("invalid or duplicate execution edit path")
    if any(not set(conflict.paths) <= allowed for conflict in decision.conflicts):
        raise ValueError("invalid execution conflict path")
    data = original.model_dump(mode="json", by_alias=True, exclude={"content", "generated_at"})
    for replacement in decision.replacements:
        parts = replacement.path.split("/")[1:]
        parent: Any = data
        for part in parts[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]
        parent[parts[-1]] = replacement.value
    # Existing candidate schema owns field lengths/types; this is not a semantic review.
    revised = CreativeCandidateDraft.model_validate(data)
    content = original.content
    if revised.shot_plan != original.shot_plan:
        content = compile_material_shot_plan(revised.shot_plan, target_duration_seconds=duration_seconds)
    return original.model_copy(update={
        "creative_core": revised.creative_core, "dimensions": revised.dimensions,
        "shot_plan": revised.shot_plan, "content": content,
    })
