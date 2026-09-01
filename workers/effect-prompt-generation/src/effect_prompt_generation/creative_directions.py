from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from collections.abc import Iterable, Sequence

from .models import (
    CreativeDirection,
    CreativeDirectionPlan,
    CreativeDirectionResponse,
    CreativeCandidate,
    CreativeEvaluation,
    CreativeSemanticProfile,
    FactVisualStrategy,
    InsightApplicationMap,
    InsightFactPolicy,
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


def validate_creative_direction_plan(
    response: CreativeDirectionResponse,
    application: InsightApplicationMap,
    fact_visual_strategy: FactVisualStrategy,
    *,
    source_hash: str,
    template_hash: str,
    expected_direction_count: int | None = None,
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
    semantic_signatures: set[tuple[str, ...]] = set()
    for direction in response.directions:
        if direction.direction_id in direction_ids:
            raise ValueError("creative directions repeat the same direction id")
        direction_ids.add(direction.direction_id)
        fact_ids = list(dict.fromkeys(direction.compatible_fact_ids))
        if not fact_ids or any(
            fact_id not in usable_ids or fact_id not in strategy_ids
            for fact_id in fact_ids
        ):
            raise ValueError("creative direction referenced an unavailable fact")
        signature = semantic_profile_signature(direction.semantic_profile)
        if signature in semantic_signatures:
            raise ValueError("creative directions repeat the same semantic profile")
        semantic_signatures.add(signature)
        directions.append(
            direction.model_copy(update={"compatible_fact_ids": fact_ids})
        )
    directions = _distribute_unassigned_facts(
        directions,
        application=application,
        fact_visual_strategy=fact_visual_strategy,
    )
    required_ids = {fact.fact_id for fact in application.required}
    planned_ids = {
        fact_id for direction in directions for fact_id in direction.compatible_fact_ids
    }
    if not required_ids.issubset(planned_ids):
        raise ValueError("creative directions did not cover all required facts")
    allocation_buckets = Counter(
        direction_allocation_bucket(direction) for direction in directions
    )
    minimum_bucket_count = min(5, len(directions))
    if len(allocation_buckets) < minimum_bucket_count:
        raise ValueError("creative directions do not cover enough scene-action combinations")
    if allocation_buckets and max(allocation_buckets.values()) > 2:
        raise ValueError("creative directions repeat one scene-action combination")
    plan_payload = [item.model_dump(mode="json", by_alias=True) for item in directions]
    return CreativeDirectionPlan(
        directions=directions,
        source_hash=source_hash,
        plan_hash=_hash(plan_payload),
        template_hash=template_hash,
    )


def allocate_direction_fact_focus_ids(
    directions: Sequence[CreativeDirection],
    application: InsightApplicationMap,
    *,
    priority_fact_ids: Sequence[str] = (),
    minimum_priority_uses: int = 2,
) -> list[str]:
    """Choose one business fact per task while covering the whole insight map.

    Directions remain the creative boundary. Within that boundary this scheduler
    prefers facts that have been used least, so product name and packaging cannot
    crowd out pains, audiences, decision drivers, scenarios, or selling points.
    """

    if not directions:
        return []
    fact_by_id = application.by_id
    priority = [
        fact_id
        for fact_id in dict.fromkeys(priority_fact_ids)
        if fact_id in fact_by_id
    ]
    priority_rank = {fact_id: index for index, fact_id in enumerate(priority)}
    source_rank = {
        fact.fact_id: index for index, fact in enumerate(application.usable)
    }
    usage: Counter[str] = Counter()
    selected: list[str] = []
    minimum_priority_uses = max(1, minimum_priority_uses)
    for direction in directions:
        candidates = [
            fact_id
            for fact_id in direction.compatible_fact_ids
            if fact_id in fact_by_id
        ]
        if not candidates:
            raise ValueError("creative direction has no usable fact for allocation")
        priority_candidates = [
            fact_id for fact_id in candidates if fact_id in priority_rank
        ]
        under_target = [
            fact_id
            for fact_id in priority_candidates
            if usage[fact_id] < minimum_priority_uses
        ]
        # Product identity remains a separate anchor. Whenever a direction can
        # carry a mandatory business fact, keep the task focused on that fact
        # instead of letting an unused product name/specification win merely
        # because its usage counter is lower.
        selection_pool = under_target or priority_candidates or candidates
        chosen = min(
            selection_pool,
            key=lambda fact_id: (
                usage[fact_id],
                0 if fact_id in priority_rank else 1,
                0
                if fact_by_id[fact_id].policy == InsightFactPolicy.REQUIRED
                else 1,
                priority_rank.get(fact_id, len(priority_rank)),
                source_rank.get(fact_id, len(source_rank)),
            ),
        )
        usage[chosen] += 1
        selected.append(chosen)
    return selected


def _distribute_unassigned_facts(
    directions: Sequence[CreativeDirection],
    *,
    application: InsightApplicationMap,
    fact_visual_strategy: FactVisualStrategy,
) -> list[CreativeDirection]:
    """Fill planning omissions without inventing a second creative plan.

    The model still decides all creative directions. The Worker only attaches
    confirmed facts that the model omitted, preferring directions already linked
    by the visual strategy and otherwise the least-loaded direction.
    """

    result = list(directions)
    planned = {
        fact_id for direction in result for fact_id in direction.compatible_fact_ids
    }
    policy_by_id = fact_visual_strategy.by_id
    for fact in application.usable:
        if fact.fact_id in planned:
            continue
        policy = policy_by_id[fact.fact_id]

        def direction_score(index: int) -> tuple[int, int, int]:
            direction = result[index]
            existing = set(direction.compatible_fact_ids)
            related = bool(existing.intersection(policy.compatible_fact_ids)) or any(
                fact.fact_id in policy_by_id[item].compatible_fact_ids
                for item in existing
                if item in policy_by_id
            )
            return (0 if related else 1, len(existing), index)

        target_index = min(range(len(result)), key=direction_score)
        target = result[target_index]
        result[target_index] = target.model_copy(
            update={
                "compatible_fact_ids": [
                    *target.compatible_fact_ids,
                    fact.fact_id,
                ]
            }
        )
        planned.add(fact.fact_id)
    return result


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
    # The planner owns the batch-specific semantic vocabulary. Balance its
    # verified scene/action families without re-interpreting them through a
    # product-specific keyword dictionary.
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
            row
            for row in rows
            if direction_counts[row.direction_id] < direction_cap
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
    profile = direction.semantic_profile
    return (
        _family_key(profile.scene_family),
        _family_key(profile.product_action_family),
    )


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
        label
        for item in rows
        if (label := getattr(item, field)) != OTHER_FAMILY
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
        label
        for item in rows
        if (label := getattr(item, field)) != OTHER_FAMILY
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
