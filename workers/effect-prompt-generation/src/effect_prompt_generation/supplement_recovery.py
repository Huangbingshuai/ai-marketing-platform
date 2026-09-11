"""Field projections and ID-only recovery for supplementary planning."""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from typing import Any

from .creative_directions import validate_diversity_supplement_directions
from .models import (
    CreativeDirection,
    CreativeDirectionResponse,
    CreativeDiversityLandscape,
    CreativeExecutionRoute,
    FactVisualStrategy,
    InsightApplicationMap,
)


def route_summary(route: CreativeExecutionRoute) -> dict[str, str | None]:
    """Project AI-authored event fields verbatim; no text/semantic inference."""
    return {
        "routeId": route.route_id,
        "eventOutline": route.event_outline,
        "visualEvent": route.visual_event,
        "sceneRelation": route.scene_relation,
        "productAction": route.product_action,
        "endingState": route.ending_state,
    }


def direction_summary(direction: CreativeDirection) -> dict[str, Any]:
    # Keep every AI-authored route relationship; omit repeated fact explanations.
    return {
        "directionId": direction.direction_id,
        "territoryId": direction.territory_id,
        "primaryActionId": direction.primary_action_id,
        "proposedAction": direction.proposed_action.model_dump(mode="json", by_alias=True) if direction.proposed_action else None,
        "creativeDirection": direction.creative_direction,
        "semanticProfile": direction.semantic_profile.model_dump(
            mode="json", by_alias=True
        ),
        "visualEvents": [
            {
                "event": r.visual_event,
                "eventOutline": r.event_outline,
                "sceneRelation": r.scene_relation,
                "productAction": r.product_action,
                "endingState": r.ending_state,
            }
            for r in direction.execution_routes
        ],
    }


def retain_valid_supplements(
    response: CreativeDirectionResponse,
    *,
    pending_ids: Sequence[str],
    retained: dict[str, CreativeDirection],
    application: InsightApplicationMap,
    strategy: FactVisualStrategy,
    landscape: CreativeDiversityLandscape,
    existing: Sequence[CreativeDirection],
    route_count: int | None,
) -> dict[str, str]:
    """Keep valid slots; never change a fact, territory, action or creative text."""
    counts = Counter(d.direction_id for d in response.directions)
    errors = {key: "MISSING_DIRECTION" for key in pending_ids}
    for direction in response.directions:
        key = direction.direction_id
        if key not in pending_ids:
            continue  # unrequested output cannot overwrite a retained direction
        if counts[key] != 1:
            errors[key] = "DUPLICATE_DIRECTION_ID"
            continue
        if not direction.execution_routes:
            errors[key] = "MISSING_EVENT_ROUTES"
            continue
        try:
            validate_diversity_supplement_directions(
                CreativeDirectionResponse(directions=[direction]),
                application,
                strategy,
                landscape=landscape,
                existing_directions=[*existing, *retained.values()],
                expected_direction_count=1,
                expected_execution_route_count=route_count,
            )
        except ValueError as exc:
            # Validator messages are fixed source/shape diagnostics, never model text.
            errors[key] = str(exc)
        else:
            retained[key] = direction
            errors.pop(key, None)
    return errors
