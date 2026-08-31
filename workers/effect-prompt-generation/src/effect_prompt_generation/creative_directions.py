from __future__ import annotations

import hashlib
import json
import math
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

# The evaluator's product-action family is intentionally a reusable, high-level
# business label.  It cannot distinguish two candidates that both say
# "serving interaction" while repeating the same underlying "slice then pick
# up" action.  These deterministic motifs stay internal to selection and are
# derived from the actual candidate rather than trusted model metadata.
_ACTION_MOTIF_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("CUT", re.compile(r"切(?:开|下|成|出|片|段|块|丁|丝|薄片|厚片|制)|下刀|刀刃")),
    ("PICK_UP", re.compile(r"夹起|夹取|筷子夹|拿起|拾起|提起")),
    ("PLATE", re.compile(r"摆盘|装盘|码放|摆放到.{0,6}(?:盘|碟|碗)")),
    ("UNPACK", re.compile(r"拆(?:开)?包装|撕开|开袋|取出包装|从.{0,6}(?:袋|盒)中取出")),
    ("STEAM", re.compile(r"蒸制|上锅蒸|放入蒸笼|揭开锅盖|打开蒸笼")),
    ("FRY", re.compile(r"煎制|下锅煎|翻煎")),
    ("STIR_FRY", re.compile(r"翻炒|下锅炒|炒制")),
    ("BOIL", re.compile(r"水煮|煮制|放入汤中|下锅煮")),
    ("ROAST", re.compile(r"烘烤|烤制|放入烤箱")),
    ("ADD_TO_DISH", re.compile(r"加入|放入|铺在|盖在|拌入")),
    ("SERVE", re.compile(r"端上|端到|递到|递给|递赠|递送|赠送|交到|送到餐桌")),
    ("SHARE", re.compile(r"分享|分给|共同夹取|家人.{0,8}(?:夹|取|尝)")),
    ("TASTE", re.compile(r"品尝|尝一口|入口|咬下|送入口中|放入口中")),
    ("SMELL", re.compile(r"闻香|凑近闻|闻一闻")),
    ("INSPECT", re.compile(r"观察|查看|端详|对准.{0,8}(?:切面|表面|包装)")),
    ("TURN", re.compile(r"翻面|转动|旋转")),
    ("PRESS", re.compile(r"按压|轻压|捏动")),
)

_ACTION_MOTIF_GUIDANCE = {
    "CUT": "切开或切片",
    "PICK_UP": "夹取或拿起",
    "PLATE": "摆盘或码放",
    "UNPACK": "拆袋或取出包装",
    "STEAM": "蒸制或揭盖",
    "FRY": "煎制",
    "STIR_FRY": "翻炒",
    "BOIL": "水煮",
    "ROAST": "烘烤",
    "ADD_TO_DISH": "加入或铺入菜品",
    "SERVE": "端上或递送",
    "SHARE": "分享或共同夹取",
    "TASTE": "品尝或入口",
    "SMELL": "闻香",
    "INSPECT": "观察外观",
    "TURN": "翻面或转动",
    "PRESS": "按压或捏动",
}

_SCENE_ATOM_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "KITCHEN_PREP",
        re.compile(
            r"厨房|灶台|厨台|备餐|备菜|砧板|案板|料理台|砂锅台面|锅边|蒸笼旁|蒸锅旁|岭南厨房"
        ),
    ),
    ("DINING_MEAL", re.compile(r"餐桌|饭桌|家宴|聚餐|用餐区|围桌|团圆饭")),
    ("RETAIL_PURCHASE", re.compile(r"超市|商超|货架|门店|卖场|选购|收银台")),
    ("GIFT_HANDOFF", re.compile(r"送礼|递礼|拜访|年货|伴手礼|礼赠|登门")),
    ("HOME_LIVING", re.compile(r"客厅|居家|家中|玄关|阳台")),
    ("OUTDOOR_MEAL", re.compile(r"户外|露营|野餐|庭院|烧烤架")),
    ("FOOD_STALL", re.compile(r"市集|摊位|档口|熟食店|餐饮店")),
    ("PRODUCT_STILL_LIFE", re.compile(r"纯色背景|静物台|展示台|棚拍|产品台")),
)

_SCENE_ATOM_GUIDANCE = {
    "KITCHEN_PREP": "家庭厨房、灶台、砧板或备餐台",
    "DINING_MEAL": "餐桌、家宴或围桌用餐",
    "RETAIL_PURCHASE": "商超、门店、货架或收银",
    "GIFT_HANDOFF": "送礼、拜访或年货递送",
    "HOME_LIVING": "客厅或普通居家空间",
    "OUTDOOR_MEAL": "户外、露营或野餐",
    "FOOD_STALL": "市集、摊位或餐饮档口",
    "PRODUCT_STILL_LIFE": "纯色背景、展示台或棚拍静物",
}


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
) -> CreativeDirectionPlan:
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


def allocate_creative_directions(
    plan: CreativeDirectionPlan,
    *,
    count: int,
    ordinal_start: int,
    preferred_direction_ids: Sequence[str] = (),
    avoid_scene_families: Iterable[str] = (),
    avoid_scene_atoms: Iterable[str] = (),
    avoid_action_families: Iterable[str] = (),
) -> list[CreativeDirection]:
    if count <= 0:
        return []
    preferred = set(preferred_direction_ids)
    avoided_scenes = set(avoid_scene_families)
    avoided_scene_atoms = set(avoid_scene_atoms)
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
        and scene_atom_for_direction(item) not in avoided_scene_atoms
        and item.semantic_profile.product_action_family not in avoided_actions
    ]
    if alternatives:
        directions = alternatives
    # Balance concrete scene-action combinations while also capping every
    # individual direction. Balancing only by a coarse scene atom caused a
    # single dining direction to receive 23/70 tasks when five kitchen
    # directions were collapsed into one atom.
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
            # Avoid repeating the same direction/fact ordinal cycle.
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
            if isinstance(value, str) and value.strip() and value != OTHER_FAMILY
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
    *,
    left_action_motifs: Sequence[str] = (),
    right_action_motifs: Sequence[str] = (),
    left_scene_atom: str | None = None,
    right_scene_atom: str | None = None,
) -> float:
    if left is None or right is None:
        return 100.0
    left_signature = semantic_profile_signature(left)
    right_signature = semantic_profile_signature(right)
    same = sum(
        left_value == right_value
        for left_value, right_value in zip(left_signature, right_signature, strict=True)
    )
    axis_novelty = 100.0 * (1.0 - same / len(left_signature))
    left_motifs = set(left_action_motifs)
    right_motifs = set(right_action_motifs)
    # Reusing even one concrete production action is meaningful repetition.
    # A Jaccard score hid this whenever two prompts surrounded the same CUT
    # action with different secondary gestures, so shared motifs now receive
    # no motif novelty at all.
    motif_novelty = 0.0 if left_motifs & right_motifs else 100.0
    scene_atom_novelty = (
        0.0
        if left_scene_atom
        and right_scene_atom
        and left_scene_atom == right_scene_atom
        else 100.0
    )
    # Keep the six official axes in the score, but make the two known sources of
    # label fragmentation (concrete action and concrete scene) independently
    # visible to MMR.
    weighted = [(0.30, axis_novelty)]
    if left_motifs or right_motifs:
        weighted.append((0.40, motif_novelty))
    if left_scene_atom and right_scene_atom:
        weighted.append((0.30, scene_atom_novelty))
    weight_sum = sum(weight for weight, _ in weighted)
    return round(sum(weight * value for weight, value in weighted) / weight_sum, 4)


def action_motif_signature(candidate: CreativeCandidate) -> tuple[str, ...]:
    corpus = "|".join(
        (
            candidate.creative_core,
            candidate.dimensions.narrative,
            candidate.dimensions.product_relation,
            candidate.content,
        )
    )
    return tuple(
        label for label, pattern in _ACTION_MOTIF_PATTERNS if pattern.search(corpus)
    )


def dominant_action_motifs(
    candidates: Iterable[CreativeCandidate],
    *,
    threshold: float = 0.40,
) -> list[str]:
    rows = list(candidates)
    if not rows:
        return []
    counts = Counter(
        motif for candidate in rows for motif in set(action_motif_signature(candidate))
    )
    return [motif for motif, count in counts.items() if count / len(rows) > threshold]


def action_motif_guidance(motifs: Iterable[str]) -> list[str]:
    return [
        _ACTION_MOTIF_GUIDANCE[motif]
        for motif in motifs
        if motif in _ACTION_MOTIF_GUIDANCE
    ]


def scene_atom_from_text(value: str) -> str:
    for atom, pattern in _SCENE_ATOM_PATTERNS:
        if pattern.search(value):
            return atom
    return "OTHER"


def scene_atom_for_direction(direction: CreativeDirection) -> str:
    primary = scene_atom_from_text(direction.semantic_profile.scene_family)
    return (
        primary
        if primary != "OTHER"
        else scene_atom_from_text(direction.creative_direction)
    )


def direction_allocation_bucket(direction: CreativeDirection) -> tuple[str, str]:
    action_corpus = "|".join(
        (
            direction.semantic_profile.product_action_family,
            direction.creative_direction,
        )
    )
    motifs = tuple(
        label for label, pattern in _ACTION_MOTIF_PATTERNS if pattern.search(action_corpus)
    )
    action_key = "+".join(motifs) or re.sub(
        r"\s+",
        "",
        direction.semantic_profile.product_action_family,
    ).casefold()
    return scene_atom_for_direction(direction), action_key


def scene_atom_signature(candidate: CreativeCandidate) -> str:
    primary = scene_atom_from_text(candidate.dimensions.scene)
    return (
        primary
        if primary != "OTHER"
        else scene_atom_from_text(
            "|".join((candidate.creative_core, candidate.content))
        )
    )


def scene_atom_guidance(atoms: Iterable[str]) -> list[str]:
    return [_SCENE_ATOM_GUIDANCE[atom] for atom in atoms if atom in _SCENE_ATOM_GUIDANCE]


def dominant_scene_atoms(
    candidates: Iterable[CreativeCandidate],
    *,
    threshold: float = 0.40,
) -> list[str]:
    rows = list(candidates)
    if not rows:
        return []
    counts = Counter(scene_atom_signature(candidate) for candidate in rows)
    return [
        atom
        for atom, count in counts.items()
        if atom != "OTHER" and count / len(rows) > threshold
    ]


def max_scene_atom_share(candidates: Iterable[CreativeCandidate]) -> float:
    rows = list(candidates)
    if not rows:
        return 0.0
    counts = Counter(scene_atom_signature(candidate) for candidate in rows)
    return round(max(counts.values(), default=0) / len(rows), 4)


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
    return [label for label, count in counts.items() if count / len(rows) > threshold]


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
            (
                _family_match_score(normalized_label, source)
                for source in normalized_sources
            ),
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
