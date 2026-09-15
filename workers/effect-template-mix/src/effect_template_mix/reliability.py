import math
from collections.abc import Sequence

from .models import Material


OUTPUT_PLANNING_UTILIZATION = 0.85
INPUT_PLANNING_UTILIZATION = 0.85
REQUEST_BASE_INPUT_TOKENS = 1_200
CLASSIFICATION_ITEM_OUTPUT_TOKENS = 700
MIN_CLASSIFICATION_OUTPUT_TOKENS = 1_024
CLASSIFICATION_COGNITIVE_MAX_SIZE = 4


def classification_item_input_tokens(material: Material) -> int:
    return 250 + math.ceil(len(material.prompt) * 1.15)


def classification_output_token_budget(materials: Sequence[Material]) -> int:
    estimate = max(
        MIN_CLASSIFICATION_OUTPUT_TOKENS,
        len(materials) * CLASSIFICATION_ITEM_OUTPUT_TOKENS,
    )
    return math.ceil(estimate / OUTPUT_PLANNING_UTILIZATION)


def classification_chunks(
    materials: Sequence[Material],
    *,
    configured_max_size: int,
    max_output_tokens: int,
    max_input_tokens: int,
) -> list[list[Material]]:
    safe_output_tokens = max(
        1,
        math.floor(max_output_tokens * OUTPUT_PLANNING_UTILIZATION),
    )
    safe_input_tokens = max(
        1,
        math.floor(max_input_tokens * INPUT_PLANNING_UTILIZATION),
    )
    chunks: list[list[Material]] = []
    current: list[Material] = []
    current_input_tokens = REQUEST_BASE_INPUT_TOKENS
    current_output_tokens = 0
    for material in materials:
        input_tokens = classification_item_input_tokens(material)
        output_tokens = CLASSIFICATION_ITEM_OUTPUT_TOKENS
        would_overflow = bool(current) and (
            len(current) >= configured_max_size
            or len(current) >= CLASSIFICATION_COGNITIVE_MAX_SIZE
            or current_input_tokens + input_tokens > safe_input_tokens
            or current_output_tokens + output_tokens > safe_output_tokens
        )
        if would_overflow:
            chunks.append(current)
            current = []
            current_input_tokens = REQUEST_BASE_INPUT_TOKENS
            current_output_tokens = 0
        current.append(material)
        current_input_tokens += input_tokens
        current_output_tokens += output_tokens
    if current:
        chunks.append(current)
    return chunks
