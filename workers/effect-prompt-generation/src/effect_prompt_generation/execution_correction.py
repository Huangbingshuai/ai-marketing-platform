"""Internal AI correction response and deterministic application."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import hashlib
import json
from typing import Any

from pydantic import Field, model_validator

from .models import (
    ApiModel, CreativeCandidate, CreativeDimensions, MaterialShotPlan,
    ExecutionReview, ExecutionReviewBatch, ExecutionIssue, ExecutionIssueResolution,
)
from .shot_plan import compile_material_shot_plan


class ExecutionCorrectionItem(ApiModel):
    slot_id: str = Field(min_length=1, max_length=160)
    changed: bool
    creative_core: str | None = Field(default=None, min_length=1, max_length=160)
    dimensions: CreativeDimensions | None = None
    shot_plan: MaterialShotPlan | None = None
    resolutions: list[ExecutionIssueResolution] = Field(default_factory=list, max_length=12)

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


def candidate_execution_hash(item: CreativeCandidate) -> str:
    payload = item.model_dump(mode="json", by_alias=True,
                              exclude={"generated_at", "execution_correction"})
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def execution_review_input(item: CreativeCandidate) -> dict[str, Any]:
    # Review what will actually be filmed, not the generator's self-justification.
    payload = item.model_dump(mode="json", by_alias=True,
                              exclude={"content", "generated_at", "execution_correction"})
    if item.shot_plan is None:
        payload["content"] = item.content
    else:
        for beat in payload["shotPlan"]["beats"]:
            beat.pop("informationDelta", None)
            beat.pop("continuityState", None)
    return payload


def validate_execution_reviews(
    candidates: Sequence[CreativeCandidate], response: ExecutionReviewBatch,
) -> dict[str, ExecutionReview]:
    expected = {item.slot_id for item in candidates}
    actual = [item.slot_id for item in response.items]
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError("execution review identity/count mismatch")
    reviews = {item.slot_id: item for item in response.items}
    for item in candidates:
        review = reviews[item.slot_id]
        count = len(item.shot_plan.beats) if item.shot_plan else 1
        if sorted(beat.sequence for beat in review.beats) != list(range(1, count + 1)):
            raise ValueError("execution review must cover every beat exactly once")
        ids = [issue.issue_id for issue in review.issues]
        if len(ids) != len(set(ids)):
            raise ValueError("execution review duplicate issue IDs")
        if any(not 0 <= seq <= count for issue in review.issues for seq in issue.sequences):
            raise ValueError("execution review issue sequence out of range")
        # Reconcile explicit AI decisions only. Never infer a conflict from words,
        # novelty enums or time thresholds, and never reject a semantic candidate.
        issues = list(review.issues)
        for flag, code in (("camera_conflict", "CAMERA_VIEW"), ("handoff_gap", "TOOL_CONTINUITY")):
            uncovered = [beat for beat in review.beats if getattr(beat, flag) is True
                         and not any(issue.code == code and (0 in issue.sequences
                                      or beat.sequence in issue.sequences) for issue in issues)]
            if uncovered:
                issue_id = f"AI_{code}"
                suffix = 1
                while issue_id in {issue.issue_id for issue in issues}:
                    issue_id = f"AI_{code}_{suffix}"
                    suffix += 1
                issues.append(ExecutionIssue(
                    issue_id=issue_id, code=code,  # type: ignore[arg-type]
                    sequences=[beat.sequence for beat in uncovered],
                    diagnosis="；".join(beat.evidence for beat in uncovered)[:240],
                ))
        reviews[item.slot_id] = review.model_copy(update={"issues": issues})
    return reviews


def apply_execution_corrections(
    candidates: Sequence[CreativeCandidate],
    response: ExecutionCorrectionBatch,
    durations: Mapping[str, int],
    reviews: Mapping[str, ExecutionReview] | None = None,
) -> list[CreativeCandidate]:
    expected = {item.slot_id for item in candidates}
    actual = [item.slot_id for item in response.items]
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError("execution correction identity/count mismatch")
    by_id = {item.slot_id: item for item in response.items}
    result = []
    for original in candidates:
        correction = by_id[original.slot_id]
        if reviews is not None:
            issue_ids = {issue.issue_id for issue in reviews[original.slot_id].issues}
            resolved_ids = [row.issue_id for row in correction.resolutions]
            if (not correction.changed or not issue_ids
                    or len(resolved_ids) != len(issue_ids) or set(resolved_ids) != issue_ids):
                raise ValueError("execution correction must resolve each diagnosed issue")
            count = len(correction.shot_plan.beats) if correction.shot_plan else 0
            if any(not 0 <= seq <= count for row in correction.resolutions
                   for seq in row.revised_sequences):
                raise ValueError("execution correction resolution sequence out of range")
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
