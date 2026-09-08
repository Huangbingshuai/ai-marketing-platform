"""Structural sizing and identity checks only; AI owns all semantic review."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from typing import Any

from .models import (
    CreativeDirection,
    CreativeDiversityLandscape,
    FactVisualStrategy,
    InsightApplicationMap,
)


def review_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()


def review_input_size(
    directions: Sequence[CreativeDirection],
    application: InsightApplicationMap,
    strategy: FactVisualStrategy,
    landscape: CreativeDiversityLandscape,
) -> int:
    territory_ids = {direction.territory_id for direction in directions}
    territories = [t for t in landscape.territories if t.territory_id in territory_ids]
    fact_ids = {fact_id for d in directions for fact_id in d.fact_ids}
    fact_ids.update(fact_id for t in territories for fact_id in t.compatible_fact_ids)
    rows = [
        *directions,
        *territories,
        *(fact for fact in application.usable if fact.fact_id in fact_ids),
        *(policy for policy in strategy.policies if policy.fact_id in fact_ids),
    ]
    # Conservative character-based capacity estimate, NOT semantic analysis or
    # a provider tokenizer. Include a fixed allowance for instructions/schema.
    return 2500 + len(
        json.dumps(
            [row.model_dump(mode="json", by_alias=True) for row in rows],
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


def review_batches(
    directions: Sequence[CreativeDirection],
    application: InsightApplicationMap,
    strategy: FactVisualStrategy,
    landscape: CreativeDiversityLandscape,
    *,
    max_size: int = 6,
    input_budget: int = 12000,
) -> list[list[CreativeDirection]]:
    batches: list[list[CreativeDirection]] = []
    current: list[CreativeDirection] = []
    for direction in directions:
        proposed = [*current, direction]
        if current and (
            len(proposed) > max_size
            or review_input_size(proposed, application, strategy, landscape)
            > input_budget
        ):
            batches.append(current)
            current = []
        current.append(direction)
    if current:
        batches.append(current)
    return batches
