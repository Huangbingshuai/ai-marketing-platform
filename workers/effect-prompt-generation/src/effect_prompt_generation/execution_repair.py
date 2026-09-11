"""Mechanical full-plan replacement and model-verdict selection; no text semantics."""

from __future__ import annotations

import hashlib
import json

from .models import (
    CreativeCandidate,
    CreativeEvaluation,
    ExecutionRepairDraft,
    MaterialShotPlan,
)
from .shot_plan import compile_material_shot_plan


def candidate_hash(candidate: CreativeCandidate) -> str:
    payload = candidate.model_dump(mode="json", by_alias=True, exclude={"generated_at"})
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def restore_execution_candidate(
    original: CreativeCandidate,
    evaluation: CreativeEvaluation,
    *,
    duration: int,
) -> CreativeCandidate | None:
    checkpoint = evaluation.execution_repair
    if checkpoint is None or checkpoint.original_hash != candidate_hash(original):
        return None
    if checkpoint.status == "STARTED":
        # A process may stop after persisting the checkpoint but before the
        # replacement and both reviews finish.  Treat that shard as incomplete
        # so a later attempt reruns it instead of silently accepting the
        # original candidate as if the repair had completed.
        return None
    if checkpoint.status != "ACCEPTED":
        return original if checkpoint.candidate is None else None
    repaired = checkpoint.candidate
    if repaired is None or repaired.shot_plan is None or original.shot_plan is None:
        return None
    # The AI may reorganize the complete shot plan. Identity, facts, the
    # creative intent and the other five dimensions remain immutable here.
    excluded = {"shot_plan", "content", "dimensions"}
    if original.model_dump(exclude=excluded) != repaired.model_dump(exclude=excluded):
        return None
    if original.dimensions.model_dump(
        exclude={"camera"}
    ) != repaired.dimensions.model_dump(exclude={"camera"}):
        return None
    if repaired.content != compile_material_shot_plan(
        repaired.shot_plan, target_duration_seconds=duration
    ):
        return None
    return repaired


def has_execution_diagnosis(
    candidate: CreativeCandidate, evaluation: CreativeEvaluation
) -> bool:
    if (
        candidate.shot_plan is None
        or evaluation.hard_issues
        or not evaluation.execution_findings
    ):
        return False
    sequences = {beat.sequence for beat in candidate.shot_plan.beats}
    for finding in evaluation.execution_findings:
        # Located AI findings are authoritative; the capped warning summary
        # need not repeat every diagnosis. Only validate structural locations.
        if finding.field in {"INITIAL_STATE", "FINAL_FRAME"}:
            if finding.sequence != 0:
                return False
        elif finding.sequence not in sequences:
            return False
    return True


def apply_execution_rewrite(
    candidate: CreativeCandidate,
    draft: ExecutionRepairDraft,
    *,
    duration: int,
) -> CreativeCandidate:
    if draft.slot_id != candidate.slot_id or candidate.shot_plan is None:
        raise ValueError("repair target does not match candidate")
    plan = MaterialShotPlan.model_validate(draft.shot_plan)
    dimensions = candidate.dimensions.model_copy(deep=True)
    if draft.camera_dimension is not None:
        dimensions.camera = draft.camera_dimension
    return candidate.model_copy(
        update={
            "shot_plan": plan,
            "dimensions": dimensions,
            "content": compile_material_shot_plan(
                plan, target_duration_seconds=duration
            ),
        }
    )


# Temporary import compatibility for code outside the current pipeline. The
# current flow always supplies a complete replacement plan, never sparse text
# patches.
apply_execution_patch = apply_execution_rewrite


def repair_improves(original: CreativeEvaluation, revised: CreativeEvaluation) -> bool:
    # These are explicit AI verdicts/numeric comparisons, not Worker inference.
    # A second model scoring pass is noisy.  Requiring every revised score to
    # equal or exceed the original caused physically corrected plans to be
    # discarded for one- or two-point fluctuations.  Keep strict quality floors
    # and bounded regression instead; the focused audit must still be clean.
    return (
        not revised.hard_issues
        and not revised.execution_findings
        and not {"CAMERA_ACTION_MISMATCH", "VISUALLY_UNEXECUTABLE"}.intersection(
            revised.warnings
        )
        and set(original.realized_fact_ids).issubset(revised.realized_fact_ids)
        and revised.scores.product_relevance
        >= max(65, original.scores.product_relevance - 5)
        and revised.scores.creative_coherence
        >= max(60, original.scores.creative_coherence - 5)
        and revised.scores.visual_executability
        >= max(60, original.scores.visual_executability - 5)
        and revised.scores.commercial_usefulness
        >= max(60, original.scores.commercial_usefulness - 5)
        and revised.scores.visual_clarity
        >= max(55, original.scores.visual_clarity - 5)
        and revised.scores.overall_quality
        >= max(70, original.scores.overall_quality - 4)
    )
