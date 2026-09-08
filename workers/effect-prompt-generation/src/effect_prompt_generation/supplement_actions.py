"""Prepare an ephemeral AI review context; never infer action semantics."""

from __future__ import annotations

from collections.abc import Sequence

from .models import (
    CreativeDirection,
    CreativeDiversityLandscape,
    CreativeTerritoryAction,
)


def supplement_review_landscape(
    landscape: CreativeDiversityLandscape,
    directions: Sequence[CreativeDirection],
) -> CreativeDiversityLandscape:
    additions: dict[str, dict[str, CreativeTerritoryAction]] = {}
    existing_ids = {
        action.action_id
        for territory in landscape.territories
        for action in territory.actions
    }
    new_owners: dict[str, str] = {}
    for direction in directions:
        action = direction.proposed_action
        if action is None:
            continue
        territory = landscape.by_id.get(direction.territory_id)
        if territory is None or direction.primary_action_id != action.action_id:
            raise ValueError("proposed action has unknown territory or mismatched id")
        if action.action_id in existing_ids:
            raise ValueError("proposed action cannot overwrite an existing action")
        if (
            action.action_id in new_owners
            and new_owners[action.action_id] != direction.territory_id
        ):
            raise ValueError("proposed action id has multiple territories")
        new_owners[action.action_id] = direction.territory_id
        owned = additions.setdefault(territory.territory_id, {})
        if action.action_id in owned and owned[action.action_id] != action:
            raise ValueError("conflicting proposed action definitions")
        owned[action.action_id] = action
    # Temporary expanded context for AI/ID validation only. The persisted base
    # landscape, its hash, facts and slot allocations stay unchanged.
    return landscape.model_copy(
        update={
            "territories": [
                territory.model_copy(
                    update={
                        "actions": [
                            *territory.actions,
                            *additions.get(territory.territory_id, {}).values(),
                        ]
                    }
                )
                for territory in landscape.territories
            ]
        }
    )
