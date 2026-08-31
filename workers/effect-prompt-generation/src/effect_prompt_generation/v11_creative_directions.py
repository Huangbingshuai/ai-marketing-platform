from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from difflib import SequenceMatcher

from .models import (
    CreativeDirection,
    CreativeDirectionPlan,
    CreativeDirectionResponse,
    CreativeCandidate,
    CreativeEvaluation,
    CreativeSemanticProfile,
    FactVisualStrategy,
    InsightApplicationMap,
)


OTHER_FAMILY = "OTHER"


def creative_direction_source_hash(
    *,
    insight_content_hash: str,
    visual_strategy_hash: str,
    shared_prompt_hash: str,
    target_count: int,
    prompt_version: str,
) -> str:
    return _hash(
        {
            "insightContentHash": insight_content_hash,
            "visualStrategyHash": visual_strategy_hash,
            "sharedPromptHash": shared_prompt_hash,
            "targetCount": target_count,
            "promptVersion": prompt_version,
        }
    )


def validate_creative_direction_plan(
    response: CreativeDirectionResponse,
    application: InsightApplicationMap,
    fact_visual_strategy: FactVisualStrategy,
    *,
    source_hash: str,
    prompt_version: str,
) -> CreativeDirectionPlan:
    usable_ids = {fact.fact_id for fact in application.usable}
    strategy_ids = set(fact_visual_strategy.by_id)
    directions: list[CreativeDirection] = []
    semantic_signatures: set[tuple[str, ...]] = set()
    for direction in response.directions:
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
    plan_payload = [
        item.model_dump(mode="json", by_alias=True) for item in directions
    ]
    return CreativeDirectionPlan(
        directions=directions,
        source_hash=source_hash,
        plan_hash=_hash(plan_payload),
        prompt_version=prompt_version,
    )


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
    # A stable round-robin gives every available direction equal opportunity before
    # any one direction receives a second task. The model still owns the actual idea.
    start = max(0, ordinal_start - 1) % len(directions)
    rotated = [*directions[start:], *directions[:start]]
    return [rotated[index % len(rotated)] for index in range(count)]


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
            raise ValueError(
                f"creative evaluation used unknown {field_name} value"
            )


def complete_semantic_profile(
    evaluation: CreativeEvaluation,
    candidate: CreativeCandidate,
    plan: CreativeDirectionPlan,
) -> CreativeEvaluation:
    """Deterministically complete a missing/partial evaluator classification.

    This is deliberately a classifier, not a quality fallback: it never changes
    scores, evidence or hard issues. Values are selected only from the current
    batch vocabulary; ambiguous input becomes OTHER and is then strictly checked.
    """

    existing = evaluation.semantic_profile
    source_by_field = {
        "narrative_family": (
            candidate.dimensions.narrative,
            candidate.creative_core,
            candidate.content,
        ),
        "scene_family": (candidate.dimensions.scene, candidate.content),
        "persona_family": (candidate.dimensions.persona, candidate.content),
        "product_action_family": (
            candidate.dimensions.product_relation,
            candidate.content,
        ),
        "camera_family": (candidate.dimensions.camera, candidate.content),
        "emotion_family": (
            candidate.dimensions.emotion,
            candidate.creative_core,
            candidate.content,
        ),
    }
    completed: dict[str, str] = {}
    for field_name, allowed in plan.vocabulary.items():
        current = getattr(existing, field_name) if existing is not None else None
        if current in allowed:
            completed[field_name] = current
            continue
        sources = tuple(
            value
            for value in (current, *source_by_field[field_name])
            if isinstance(value, str)
            and value.strip()
            and value != OTHER_FAMILY
        )
        completed[field_name] = _match_dynamic_family(sources, allowed)
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
    same = sum(
        left_value == right_value
        for left_value, right_value in zip(
            left_signature, right_signature, strict=True
        )
    )
    return round(100.0 * (1.0 - same / len(left_signature)), 4)


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
    counts = Counter(getattr(item, field) for item in rows)
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
    counts = Counter(getattr(item, field) for item in rows)
    return [
        label
        for label, count in counts.items()
        if count / len(rows) > threshold
    ]


def _match_dynamic_family(sources: Sequence[str], allowed: set[str]) -> str:
    if not sources or not allowed:
        return OTHER_FAMILY
    ranked: list[tuple[float, str]] = []
    normalized_sources = [_normalize_match_text(item) for item in sources]
    for label in allowed:
        normalized_label = _normalize_match_text(label)
        if not normalized_label:
            continue
        score = max(
            (_family_match_score(normalized_label, source) for source in normalized_sources),
            default=0.0,
        )
        ranked.append((score, label))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    if not ranked:
        return OTHER_FAMILY
    best_score, best_label = ranked[0]
    second_score = ranked[1][0] if len(ranked) > 1 else 0.0
    if best_score >= 0.72 and best_score - second_score >= 0.10:
        return best_label
    return OTHER_FAMILY


def _family_match_score(label: str, source: str) -> float:
    if not label or not source:
        return 0.0
    if label in source or (len(source) >= 2 and source in label):
        return 1.0
    sequence_score = SequenceMatcher(None, label, source).ratio()
    if len(label) == 1:
        return sequence_score
    label_bigrams = {label[index : index + 2] for index in range(len(label) - 1)}
    source_bigrams = {
        source[index : index + 2] for index in range(max(0, len(source) - 1))
    }
    containment = (
        len(label_bigrams & source_bigrams) / len(label_bigrams)
        if label_bigrams
        else 0.0
    )
    return max(sequence_score, containment)


def _normalize_match_text(value: str) -> str:
    return "".join(re.findall(r"[\w\u4e00-\u9fff]+", value.casefold()))


def _hash(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
