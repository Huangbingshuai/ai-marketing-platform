from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from collections.abc import Iterable, Sequence

from .insight_mapping import mandatory_business_facts
from .models import (
    CreativeDirection,
    CreativeDirectionAudit,
    CreativeDirectionAuditResponse,
    CreativeDirectionPlan,
    CreativeDirectionResponse,
    CreativeDiversityLandscape,
    CreativeDiversityLandscapeResponse,
    CreativeCandidate,
    CreativeEvaluation,
    CreativeSemanticProfile,
    FactVisualStrategy,
    InsightApplicationMap,
)


OTHER_FAMILY = "OTHER"


def creative_direction_target_count(target_count: int) -> int:
    """Scale creative spaces with batch size instead of paraphrasing eight."""

    return min(16, max(8, math.ceil(max(1, target_count) / 4)))


def creative_direction_source_hash(
    *,
    insight_content_hash: str,
    visual_strategy_hash: str,
    shared_prompt_hash: str,
    target_count: int,
    template_hash: str,
) -> str:
    return _hash(
        {
            "insightContentHash": insight_content_hash,
            "visualStrategyHash": visual_strategy_hash,
            "sharedPromptHash": shared_prompt_hash,
            "targetCount": target_count,
            "templateHash": template_hash,
        }
    )


def creative_landscape_revision_context(
    response: CreativeDiversityLandscapeResponse,
    application: InsightApplicationMap,
    *,
    validation_error: str,
) -> dict[str, object]:
    business_ids = [fact.fact_id for fact in mandatory_business_facts(application)]
    assigned_ids = [
        fact_id
        for territory in response.territories
        for fact_id in territory.required_fact_ids
    ]
    counts = Counter(assigned_ids)
    return {
        "validationError": validation_error,
        "missingRequiredFactIds": [
            fact_id for fact_id in business_ids if counts[fact_id] == 0
        ],
        "duplicatedRequiredFactIds": [
            fact_id for fact_id, count in counts.items() if count > 1
        ],
        "previousTerritories": [
            territory.model_dump(mode="json", by_alias=True)
            for territory in response.territories
        ],
        "revisionInstruction": (
            "重新规划完整创意版图，让每个必用事实恰好由一个语义相容空间主承载；"
            "不得由系统替你分配事实。"
        ),
    }


def validate_creative_diversity_landscape(
    response: CreativeDiversityLandscapeResponse,
    application: InsightApplicationMap,
    *,
    source_hash: str,
    template_hash: str,
    expected_direction_count: int,
) -> CreativeDiversityLandscape:
    usable_ids = {fact.fact_id for fact in application.usable}
    territory_ids = [item.territory_id for item in response.territories]
    if len(set(territory_ids)) != len(territory_ids):
        raise ValueError("creative landscape repeats a territory id")
    action_ids = [
        action.action_id
        for territory in response.territories
        for action in territory.actions
    ]
    if len(set(action_ids)) != len(action_ids):
        raise ValueError("creative landscape action ids must be globally unique")
    if (
        sum(item.target_slots for item in response.territories)
        != expected_direction_count
    ):
        raise ValueError("creative landscape target slots do not match direction count")
    if any(item.target_slots < 1 for item in response.territories):
        raise ValueError("creative landscape territory target slots must be positive")
    if any(
        fact_id not in usable_ids
        for territory in response.territories
        for fact_id in territory.compatible_fact_ids
    ):
        raise ValueError("creative landscape referenced an unavailable fact")
    for territory in response.territories:
        if territory.fact_compatibilities is None:
            raise ValueError("creative landscape omitted fact compatibility guidance")
        guided_ids = [item.fact_id for item in territory.fact_compatibilities]
        if len(guided_ids) != len(set(guided_ids)):
            raise ValueError("creative landscape repeated fact compatibility guidance")
        if set(guided_ids) != set(territory.compatible_fact_ids):
            raise ValueError(
                "creative landscape fact guidance must match compatible facts"
            )
    business_ids = {fact.fact_id for fact in mandatory_business_facts(application)}
    required_ids = [
        fact_id
        for territory in response.territories
        for fact_id in territory.required_fact_ids
    ]
    if len(required_ids) != len(set(required_ids)):
        raise ValueError("creative landscape repeats a required fact assignment")
    if any(fact_id not in usable_ids for fact_id in required_ids):
        raise ValueError("creative landscape assigned an unavailable required fact")
    if not business_ids.issubset(required_ids):
        raise ValueError("creative landscape did not assign every business fact")
    if any(
        fact_id not in territory.compatible_fact_ids
        for territory in response.territories
        for fact_id in territory.required_fact_ids
    ):
        raise ValueError("creative landscape required fact lacks compatibility guidance")
    territories = [
        territory.model_copy(
            update={
                "required_fact_ids": [
                    fact_id
                    for fact_id in territory.required_fact_ids
                    if fact_id in business_ids
                ],
            }
        )
        for territory in response.territories
    ]
    if any(
        len(territory.required_fact_ids) > territory.target_slots * 4
        for territory in territories
    ):
        raise ValueError("creative landscape required facts exceed territory capacity")
    landscape_ids = {
        fact_id
        for territory in territories
        for fact_id in territory.compatible_fact_ids
    }
    if not business_ids.issubset(landscape_ids):
        raise ValueError("creative landscape did not cover all usable business facts")
    payload = [item.model_dump(mode="json", by_alias=True) for item in territories]
    return CreativeDiversityLandscape(
        territories=territories,
        source_hash=source_hash,
        landscape_hash=_hash(payload),
        template_hash=template_hash,
    )


def validate_creative_direction_plan(
    response: CreativeDirectionResponse,
    application: InsightApplicationMap,
    fact_visual_strategy: FactVisualStrategy,
    *,
    source_hash: str,
    template_hash: str,
    expected_direction_count: int | None = None,
    landscape: CreativeDiversityLandscape | None = None,
) -> CreativeDirectionPlan:
    if (
        expected_direction_count is not None
        and len(response.directions) != expected_direction_count
    ):
        raise ValueError("creative direction count does not match the batch target")
    usable_ids = {fact.fact_id for fact in application.usable}
    strategy_ids = set(fact_visual_strategy.by_id)
    directions: list[CreativeDirection] = []
    direction_ids: set[str] = set()
    for direction in response.directions:
        if direction.direction_id in direction_ids:
            raise ValueError("creative directions repeat the same direction id")
        direction_ids.add(direction.direction_id)
        fact_ids = direction.fact_ids
        if not fact_ids or any(
            fact_id not in usable_ids or fact_id not in strategy_ids
            for fact_id in fact_ids
        ):
            raise ValueError("creative direction referenced an unavailable fact")
        if landscape is not None:
            territory = landscape.by_id.get(direction.territory_id)
            if territory is None:
                raise ValueError("creative direction referenced an unknown territory")
            allowed_actions = {item.action_id for item in territory.actions}
            if direction.primary_action_id not in allowed_actions:
                raise ValueError(
                    "creative direction referenced an unknown territory action"
                )
            if any(
                fact_id not in territory.compatible_fact_ids
                for fact_id in direction.fact_ids
            ):
                raise ValueError("creative direction used a fact outside its territory")
        directions.append(direction)
    business_ids = {fact.fact_id for fact in mandatory_business_facts(application)}
    minimum_business_facts = min(2, len(business_ids))
    if business_ids and any(
        len(business_ids.intersection(direction.fact_ids)) < minimum_business_facts
        for direction in directions
    ):
        raise ValueError("each creative direction must apply multiple business facts")
    planned_ids = {
        fact_id for direction in directions for fact_id in direction.fact_ids
    }
    if not business_ids.issubset(planned_ids):
        raise ValueError("creative directions did not cover all usable business facts")
    if landscape is not None:
        actual_slots = Counter(item.territory_id for item in directions)
        expected_slots = {
            item.territory_id: item.target_slots for item in landscape.territories
        }
        if dict(actual_slots) != expected_slots:
            raise ValueError("creative directions do not follow landscape target slots")
        for territory in landscape.territories:
            realized_ids = {
                fact_id
                for direction in directions
                if direction.territory_id == territory.territory_id
                for fact_id in direction.fact_ids
            }
            if not set(territory.required_fact_ids).issubset(realized_ids):
                raise ValueError(
                    "creative directions did not cover territory required facts"
                )
    plan_payload = [item.model_dump(mode="json", by_alias=True) for item in directions]
    return CreativeDirectionPlan(
        directions=directions,
        source_hash=source_hash,
        plan_hash=_hash(plan_payload),
        template_hash=template_hash,
        landscape=landscape,
    )


def validate_creative_direction_audit(
    response: CreativeDirectionAuditResponse,
    plan: CreativeDirectionPlan,
    landscape: CreativeDiversityLandscape,
) -> CreativeDirectionAudit:
    direction_ids = {item.direction_id for item in plan.directions}
    audit_ids = [item.direction_id for item in response.items]
    if len(audit_ids) != len(set(audit_ids)) or set(audit_ids) != direction_ids:
        raise ValueError(
            "creative direction audit must cover every direction exactly once"
        )
    plan_by_id = {item.direction_id: item for item in plan.directions}
    revision_required_ids: set[str] = set()
    for item in response.items:
        territory = landscape.by_id.get(item.realized_territory_id)
        if territory is None:
            raise ValueError("creative direction audit used an unknown territory")
        if item.realized_action_id not in {
            action.action_id for action in territory.actions
        }:
            raise ValueError("creative direction audit used an unknown action")
        direction = plan_by_id[item.direction_id]
        if item.fact_reviews is None:
            raise ValueError("creative direction audit omitted fact reviews")
        reviewed_fact_ids = [review.fact_id for review in item.fact_reviews]
        if (
            len(reviewed_fact_ids) != len(set(reviewed_fact_ids))
            or set(reviewed_fact_ids) != set(direction.fact_ids)
        ):
            raise ValueError(
                "creative direction audit must review every applied fact exactly once"
            )
        has_fact_issue = any(
            review.verdict != "NATURAL" for review in item.fact_reviews
        )
        if has_fact_issue or not item.aligned:
            revision_required_ids.add(item.direction_id)
    if any(item not in direction_ids for item in response.revision_direction_ids):
        raise ValueError("creative direction audit used an unknown revision id")
    if revision_required_ids:
        if not response.requires_revision:
            raise ValueError("creative direction audit ignored a semantic issue")
        if not revision_required_ids.issubset(response.revision_direction_ids):
            raise ValueError("creative direction audit omitted a revision direction")
    elif response.requires_revision:
        raise ValueError("creative direction audit requested an unsupported revision")
    payload = response.model_dump(mode="json", by_alias=True)
    return CreativeDirectionAudit(
        **response.model_dump(mode="python"),
        audit_hash=_hash(payload),
    )


def creative_direction_audit_revision_context(
    plan: CreativeDirectionPlan,
    audit: CreativeDirectionAudit,
) -> dict[str, object]:
    return {
        "semanticAudit": audit.model_dump(mode="json", by_alias=True),
        "previousDirections": [
            item.model_dump(mode="json", by_alias=True) for item in plan.directions
        ],
        "revisionInstruction": (
            "依据独立语义复核重新规划完整批次，只修改被点名的事实关系、"
            "同义改名、版图错位、多主场景或多主动作问题。事实必须转移到"
            "自然相容的版图与方向，不能为了覆盖率硬塞，也不得由系统替换事实。"
        ),
    }


def merge_creative_direction_revision(
    previous: CreativeDirectionResponse,
    revised: CreativeDirectionResponse,
    revision_direction_ids: Sequence[str],
) -> CreativeDirectionResponse:
    """Mechanically keep unflagged directions; semantic choices stay model-owned."""

    previous_by_id = {item.direction_id: item for item in previous.directions}
    revised_by_id = {item.direction_id: item for item in revised.directions}
    if set(previous_by_id) != set(revised_by_id):
        raise ValueError("creative direction revision changed the direction id set")
    revision_ids = set(revision_direction_ids)
    if not revision_ids or not revision_ids.issubset(previous_by_id):
        raise ValueError("creative direction revision used an unknown revision id")
    return CreativeDirectionResponse(
        directions=[
            revised_by_id[item.direction_id]
            if item.direction_id in revision_ids
            else item
            for item in previous.directions
        ]
    )


def creative_direction_revision_context(
    response: CreativeDirectionResponse,
    application: InsightApplicationMap,
    *,
    validation_error: str,
) -> dict[str, object]:
    """Prepare a model-owned revision brief without changing any direction."""

    business_ids = [fact.fact_id for fact in mandatory_business_facts(application)]
    planned_ids = {
        fact_id for direction in response.directions for fact_id in direction.fact_ids
    }
    return {
        "validationError": validation_error,
        "missingBusinessFactIds": [
            fact_id for fact_id in business_ids if fact_id not in planned_ids
        ],
        "previousDirections": [
            direction.model_dump(mode="json", by_alias=True)
            for direction in response.directions
        ],
        "revisionInstruction": (
            "重新规划完整批次，让缺失事实自然进入合适方向；"
            "不得只追加事实ID或由系统替换事实组合。"
        ),
    }


def allocate_creative_directions(
    plan: CreativeDirectionPlan,
    *,
    count: int,
    ordinal_start: int,
    preferred_direction_ids: Sequence[str] = (),
    avoid_scene_families: Iterable[str] = (),
    avoid_action_families: Iterable[str] = (),
) -> list[CreativeDirection]:
    if count <= 0:
        return []
    preferred = set(preferred_direction_ids)
    avoided_scenes = set(avoid_scene_families)
    avoided_actions = set(avoid_action_families)
    directions = [
        item
        for item in plan.directions
        if not preferred or item.direction_id in preferred
    ] or list(plan.directions)
    alternatives = [
        item
        for item in directions
        if item.semantic_profile.scene_family not in avoided_scenes
        and item.semantic_profile.product_action_family not in avoided_actions
    ]
    if alternatives:
        directions = alternatives
    # AI owns the product-specific territory and action semantics. Worker only
    # balances their stable IDs and never interprets direction text.
    grouped: dict[tuple[str, str], list[CreativeDirection]] = {}
    for direction in directions:
        grouped.setdefault(direction_allocation_bucket(direction), []).append(direction)
    buckets = list(grouped)
    bucket_start = max(0, ordinal_start - 1) % len(buckets)
    buckets = [*buckets[bucket_start:], *buckets[:bucket_start]]
    direction_cap = math.ceil(count / len(directions))
    direction_counts: Counter[str] = Counter()
    bucket_counts: Counter[tuple[str, str]] = Counter()
    bucket_offsets: Counter[tuple[str, str]] = Counter()
    cursor = 0
    allocated: list[CreativeDirection] = []
    for _ in range(count):
        eligible_buckets = [
            bucket
            for bucket in buckets
            if any(
                direction_counts[row.direction_id] < direction_cap
                for row in grouped[bucket]
            )
        ]
        if not eligible_buckets:
            raise ValueError("creative direction allocation capacity was exhausted")
        minimum_bucket_load = min(bucket_counts[bucket] for bucket in eligible_buckets)
        equally_loaded = {
            bucket
            for bucket in eligible_buckets
            if bucket_counts[bucket] == minimum_bucket_load
        }
        bucket = next(
            candidate
            for offset in range(len(buckets))
            if (candidate := buckets[(cursor + offset) % len(buckets)])
            in equally_loaded
        )
        cursor = (buckets.index(bucket) + 1) % len(buckets)
        rows = grouped[bucket]
        eligible_rows = [
            row for row in rows if direction_counts[row.direction_id] < direction_cap
        ]
        minimum_direction_load = min(
            direction_counts[row.direction_id] for row in eligible_rows
        )
        equally_loaded_rows = [
            row
            for row in eligible_rows
            if direction_counts[row.direction_id] == minimum_direction_load
        ]
        direction = equally_loaded_rows[
            bucket_offsets[bucket] % len(equally_loaded_rows)
        ]
        bucket_offsets[bucket] += 1
        bucket_counts[bucket] += 1
        direction_counts[direction.direction_id] += 1
        allocated.append(direction)
        if len(allocated) % len(directions) == 0:
            # Do not repeat the exact same direction order every pass. Fact
            # allocation also uses the absolute ordinal, so a fixed N-item
            # cycle can repeatedly pair one direction with the same fact when
            # both cycles share a divisor. Rotating the next pass keeps the
            # direction counts balanced while varying the fact combination.
            cursor = (cursor + 1) % len(buckets)
    return allocated


def validate_semantic_profile(
    evaluation: CreativeEvaluation,
    plan: CreativeDirectionPlan,
) -> None:
    profile = evaluation.semantic_profile
    if profile is None:
        raise ValueError("creative evaluation omitted semanticProfile")
    vocabulary = plan.vocabulary
    for field_name, allowed in vocabulary.items():
        value = getattr(profile, field_name)
        if value != OTHER_FAMILY and value not in allowed:
            raise ValueError(f"creative evaluation used unknown {field_name} value")


def complete_semantic_profile(
    evaluation: CreativeEvaluation,
    candidate: CreativeCandidate,
    plan: CreativeDirectionPlan,
) -> CreativeEvaluation:
    """Normalize evaluator output without guessing semantics from characters.

    The evaluation model is the semantic classifier. A missing or unknown value
    becomes OTHER; substring overlap, edit distance and Chinese n-grams must not
    invent a classification for a different product domain.
    """

    del candidate
    existing = evaluation.semantic_profile
    completed: dict[str, str] = {}
    for field_name, allowed in plan.vocabulary.items():
        current = getattr(existing, field_name) if existing is not None else None
        completed[field_name] = current if current in allowed else OTHER_FAMILY
    repaired = evaluation.model_copy(
        update={"semantic_profile": CreativeSemanticProfile(**completed)}
    )
    validate_semantic_profile(repaired, plan)
    return repaired


def semantic_profile_signature(profile: CreativeSemanticProfile) -> tuple[str, ...]:
    return (
        profile.narrative_family.casefold(),
        profile.scene_family.casefold(),
        profile.persona_family.casefold(),
        profile.product_action_family.casefold(),
        profile.camera_family.casefold(),
        profile.emotion_family.casefold(),
    )


def semantic_cluster_novelty(
    left: CreativeSemanticProfile | None,
    right: CreativeSemanticProfile | None,
) -> float:
    """Compare AI-owned category IDs by equality; never infer their meaning."""

    if left is None or right is None:
        return 100.0
    left_signature = semantic_profile_signature(left)
    right_signature = semantic_profile_signature(right)
    weights = (0.10, 0.25, 0.10, 0.25, 0.15, 0.15)
    repeated_weight = sum(
        weight
        for left_value, right_value, weight in zip(
            left_signature,
            right_signature,
            weights,
            strict=True,
        )
        if left_value == right_value
    )
    return round(100.0 * (1.0 - repeated_weight), 4)


def direction_allocation_bucket(direction: CreativeDirection) -> tuple[str, str]:
    return direction.territory_id, direction.primary_action_id


def semantic_profile_distribution(
    evaluations: Iterable[CreativeEvaluation],
) -> dict[str, list[dict[str, str | int]]]:
    rows = [item.semantic_profile for item in evaluations if item.semantic_profile]

    def summarize(field: str) -> list[dict[str, str | int]]:
        counts = Counter(getattr(item, field) for item in rows)
        return [
            {"label": label, "count": count}
            for label, count in sorted(
                counts.items(), key=lambda item: (-item[1], item[0])
            )[:5]
        ]

    return {
        "sceneFamilies": summarize("scene_family"),
        "productActionFamilies": summarize("product_action_family"),
        "narrativeFamilies": summarize("narrative_family"),
    }


def max_cluster_share(
    evaluations: Iterable[CreativeEvaluation],
    field: str,
) -> float:
    rows = [item.semantic_profile for item in evaluations if item.semantic_profile]
    if not rows:
        return 0.0
    counts = Counter(
        label for item in rows if (label := getattr(item, field)) != OTHER_FAMILY
    )
    return round(max(counts.values(), default=0) / len(rows), 4)


def dominant_families(
    evaluations: Iterable[CreativeEvaluation],
    field: str,
    *,
    threshold: float = 0.40,
) -> list[str]:
    rows = [item.semantic_profile for item in evaluations if item.semantic_profile]
    if not rows:
        return []
    counts = Counter(
        label for item in rows if (label := getattr(item, field)) != OTHER_FAMILY
    )
    return [label for label, count in counts.items() if count / len(rows) > threshold]


def _family_key(value: str) -> str:
    """Normalize a model-owned category label without inferring its meaning."""

    return " ".join(value.split()).casefold() or OTHER_FAMILY.casefold()


def _hash(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
