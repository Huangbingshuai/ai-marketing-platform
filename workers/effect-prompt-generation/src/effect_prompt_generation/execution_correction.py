"""Internal AI correction response and deterministic application."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from pydantic import Field, model_validator

from .models import ApiModel, CreativeCandidate, CreativeDimensions, MaterialShotPlan
from .shot_plan import compile_material_shot_plan


class ExecutionCorrectionItem(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    changed: bool
    creative_core: str | None = Field(default=None, min_length=1, max_length=160)
    dimensions: CreativeDimensions | None = None
    shot_plan: MaterialShotPlan | None = None

    @model_validator(mode="after")
    def complete_replacement(self) -> ExecutionCorrectionItem:
        fields = (self.creative_core, self.dimensions, self.shot_plan)
        if self.changed and any(value is None for value in fields):
            raise ValueError("changed correction requires core, dimensions and plan")
        if not self.changed and any(value is not None for value in fields):
            raise ValueError("unchanged correction must not carry replacement text")
        return self


class ExecutionCorrectionBatch(ApiModel):
    items: list[ExecutionCorrectionItem] = Field(min_length=1, max_length=5)


def apply_execution_corrections(
    candidates: Sequence[CreativeCandidate],
    response: ExecutionCorrectionBatch,
    durations: Mapping[str, int],
) -> list[CreativeCandidate]:
    expected = {item.slot_id for item in candidates}
    actual = [item.slot_id for item in response.items]
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError("execution correction identity/count mismatch")
    by_id = {item.slot_id: item for item in response.items}
    result = []
    for original in candidates:
        correction = by_id[original.slot_id]
        if not correction.changed:
            result.append(original)
            continue
        assert correction.shot_plan is not None
        result.append(
            CreativeCandidate.model_validate(
                original.model_copy(
                    update={
                        "creative_core": correction.creative_core,
                        "dimensions": correction.dimensions,
                        "shot_plan": correction.shot_plan,
                        "content": compile_material_shot_plan(
                            correction.shot_plan,
                            target_duration_seconds=durations[original.slot_id],
                        ),
                    }
                ).model_dump()
            )
        )
    return result
