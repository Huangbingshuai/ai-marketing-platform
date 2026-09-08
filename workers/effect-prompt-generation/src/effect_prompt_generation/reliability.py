from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

from .models import (
    MAX_PROMPT_DURATION_SECONDS,
    CreativeCandidate,
    CreativeTask,
)


# Ark counts the structured answer and reasoning in the same output allowance.
# Planning up to the hard limit makes a request fragile even when the JSON itself
# would fit, so sharding deliberately keeps a small reserve.
OUTPUT_PLANNING_UTILIZATION = 0.90
EVALUATION_PLANNING_UTILIZATION = 0.85
EVALUATION_INPUT_PLANNING_UTILIZATION = 0.85
MIN_CREATIVE_OUTPUT_TOKENS = 1_536
MIN_EVALUATION_OUTPUT_TOKENS = 2_048
MIN_INFERRED_EVALUATION_OUTPUT_TOKENS = 4_096
MIN_EVALUATION_INPUT_TOKEN_BUDGET = 4_096
DEFAULT_EVALUATION_INPUT_TOKEN_BUDGET = 12_000
EVALUATION_REQUEST_BASE_INPUT_TOKENS = 1_800


def creative_item_output_tokens(duration_seconds: int) -> int:
    """Estimate one structured shot plan without imposing a text-length rule."""

    return min(
        1_350 + MAX_PROMPT_DURATION_SECONDS * 30,
        1_350 + duration_seconds * 30,
    )


def creative_output_token_budget(tasks: Sequence[CreativeTask]) -> int:
    estimated_tokens = max(
        MIN_CREATIVE_OUTPUT_TOKENS,
        sum(creative_item_output_tokens(task.target_duration_seconds) for task in tasks),
    )
    return math.ceil(estimated_tokens / OUTPUT_PLANNING_UTILIZATION)


def creative_shard_size(
    duration_seconds: int,
    *,
    configured_max_size: int,
    max_output_tokens: int,
) -> int:
    """Choose a shard size that agrees with the provider's real token cap."""

    conservative_duration_size = 4
    safe_tokens = max(1, math.floor(max_output_tokens * OUTPUT_PLANNING_UTILIZATION))
    token_size = max(1, safe_tokens // creative_item_output_tokens(duration_seconds))
    return max(1, min(configured_max_size, conservative_duration_size, token_size, 5))


def evaluation_item_output_tokens(candidate: CreativeCandidate) -> int:
    """Estimate evaluation output using the amount of evidence the model must inspect."""

    dimensions = candidate.dimensions
    source_characters = sum(
        len(value)
        for value in (
            candidate.creative_core,
            candidate.content,
            dimensions.narrative,
            dimensions.scene,
            dimensions.persona,
            dimensions.product_relation,
            dimensions.camera,
            dimensions.emotion,
        )
    )
    # Reserve short execution findings as well as scores/fact support. Actual
    # diagnostics may be empty; this is a transport allowance, not a length rule.
    return 1_600 + min(300, max(0, source_characters - 1_200) // 8)


def evaluation_item_input_tokens(candidate: CreativeCandidate) -> int:
    """Conservatively estimate the compact evaluation input for one candidate."""

    dimensions = candidate.dimensions
    source_characters = sum(
        len(value)
        for value in (
            candidate.creative_core,
            candidate.content,
            dimensions.narrative,
            dimensions.scene,
            dimensions.persona,
            dimensions.product_relation,
            dimensions.camera,
            dimensions.emotion,
        )
    )
    # Chinese copy is close to one token per visible character for planning
    # purposes. Fact records and visual policies are sent once per shard, but
    # charging each candidate a small allowance safely overestimates overlap.
    return (
        450
        + math.ceil(source_characters * 1.15)
        + len(set(candidate.declared_fact_ids)) * 180
    )


def evaluation_duration_max_size(duration_seconds: int) -> int:
    """Bound cognitive load without imposing any content-length gate."""

    del duration_seconds
    return 4


def evaluation_chunk_input_tokens(candidates: Sequence[CreativeCandidate]) -> int:
    return EVALUATION_REQUEST_BASE_INPUT_TOKENS + sum(
        evaluation_item_input_tokens(item) for item in candidates
    )


def evaluation_output_token_budget(
    candidates: Sequence[CreativeCandidate],
    *,
    infer_creative_structure: bool,
) -> int:
    minimum = (
        MIN_INFERRED_EVALUATION_OUTPUT_TOKENS
        if infer_creative_structure
        else MIN_EVALUATION_OUTPUT_TOKENS
    )
    estimated_tokens = sum(evaluation_item_output_tokens(item) for item in candidates)
    return max(
        minimum,
        math.ceil(estimated_tokens / EVALUATION_PLANNING_UTILIZATION),
    )


def evaluation_chunks(
    candidates: Sequence[CreativeCandidate],
    *,
    configured_max_size: int,
    max_output_tokens: int,
    target_durations: Mapping[str, int] | None = None,
    max_input_tokens: int = DEFAULT_EVALUATION_INPUT_TOKEN_BUDGET,
) -> list[list[CreativeCandidate]]:
    """Pack candidates against input, output, duration and count budgets."""

    safe_output_tokens = max(
        1, math.floor(max_output_tokens * EVALUATION_PLANNING_UTILIZATION)
    )
    safe_input_tokens = max(
        1, math.floor(max_input_tokens * EVALUATION_INPUT_PLANNING_UTILIZATION)
    )
    chunks: list[list[CreativeCandidate]] = []
    current: list[CreativeCandidate] = []
    current_output_tokens = 0
    current_input_tokens = EVALUATION_REQUEST_BASE_INPUT_TOKENS
    for candidate in candidates:
        output_estimate = evaluation_item_output_tokens(candidate)
        input_estimate = evaluation_item_input_tokens(candidate)
        candidate_duration = (
            target_durations.get(candidate.slot_id, 5)
            if target_durations is not None
            else 5
        )
        combined_durations = [
            *(
                target_durations.get(item.slot_id, 5) for item in current
                if target_durations is not None
            ),
            candidate_duration,
        ]
        duration_max_size = min(
            evaluation_duration_max_size(duration) for duration in combined_durations
        )
        would_overflow = bool(current) and (
            current_output_tokens + output_estimate > safe_output_tokens
            or current_input_tokens + input_estimate > safe_input_tokens
            or len(current) >= duration_max_size
        )
        if would_overflow or len(current) >= max(1, configured_max_size):
            chunks.append(current)
            current = []
            current_output_tokens = 0
            current_input_tokens = EVALUATION_REQUEST_BASE_INPUT_TOKENS
        current.append(candidate)
        current_output_tokens += output_estimate
        current_input_tokens += input_estimate
    if current:
        chunks.append(current)
    return chunks


def validate_output_limits(
    *,
    candidate_max_output_tokens: int,
    evaluation_max_output_tokens: int,
    evaluation_input_token_budget: int = DEFAULT_EVALUATION_INPUT_TOKEN_BUDGET,
) -> None:
    minimum_candidate_limit = math.ceil(
        creative_item_output_tokens(MAX_PROMPT_DURATION_SECONDS)
        / OUTPUT_PLANNING_UTILIZATION
    )
    if candidate_max_output_tokens < minimum_candidate_limit:
        raise ValueError(
            "ARK_PROMPT_CANDIDATE_MAX_OUTPUT_TOKENS must allow one 15-second "
            "creative with response headroom"
        )
    if evaluation_max_output_tokens < MIN_INFERRED_EVALUATION_OUTPUT_TOKENS:
        raise ValueError(
            "ARK_PROMPT_EVALUATION_MAX_OUTPUT_TOKENS must allow one inferred item evaluation"
        )
    if evaluation_input_token_budget < MIN_EVALUATION_INPUT_TOKEN_BUDGET:
        raise ValueError(
            "PROMPT_EVALUATION_INPUT_TOKEN_BUDGET must allow one compact evaluation request"
        )
