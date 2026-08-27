from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence

from .insight_mapping import bindings_for_fact_ids
from .models import (
    BlueprintBundleQuota,
    BlueprintShardPlan,
    BlueprintTask,
    DimensionCoordinate,
    EvidenceMode,
    FragmentDimensionCoordinatePlan,
    FragmentFactAllocation,
    FragmentRelationshipPlan,
    FragmentType,
    GeneratedBlueprint,
    InsightApplicationMap,
    InsightField,
    PlannedCombination,
    PromptDimensions,
)


_MATERIAL_TAGS: dict[FragmentType, list[str]] = {
    FragmentType.HOOK: ["钩子", "悬念"],
    FragmentType.PAIN: ["痛点", "受阻"],
    FragmentType.PRODUCT_DISPLAY: ["产品", "展示"],
    FragmentType.SELLING_POINT_EXPLANATION: ["卖点", "细节"],
    FragmentType.CTA: ["转化", "留白"],
    FragmentType.OUTRO: ["片尾", "品牌定格"],
}


def normalize_coordinate_signature(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    normalized = re.sub(r"[\s\W_]+", "", normalized)
    return normalized[:240] or "empty"


def normalize_coordinate_plan(
    plan: FragmentDimensionCoordinatePlan,
) -> FragmentDimensionCoordinatePlan:
    """Replace untrusted model signatures with the worker's canonical form."""
    updates = {
        field_name: [
            item.model_copy(
                update={"normalized_signature": normalize_coordinate_signature(item.value)}
            )
            for item in values
        ]
        for field_name, values in (
            ("narratives", plan.narratives),
            ("scenes", plan.scenes),
            ("personas", plan.personas),
            ("selling_points", plan.selling_points),
            ("cameras", plan.cameras),
            ("emotions", plan.emotions),
        )
    }
    return plan.model_copy(update=updates)


def blueprint_signature(
    item: GeneratedBlueprint,
    coordinate_plan: FragmentDimensionCoordinatePlan,
) -> list[str]:
    coordinates = {
        coordinate.coordinate_id: coordinate.normalized_signature
        for values in _coordinate_groups(coordinate_plan).values()
        for coordinate in values
    }
    return [coordinates[coordinate_id] for coordinate_id in _blueprint_coordinate_ids(item)]


def validate_relationship_plan(
    plan: FragmentRelationshipPlan,
    allocation: FragmentFactAllocation,
    application: InsightApplicationMap,
) -> None:
    if plan.fragment_type != allocation.fragment_type:
        raise ValueError("relationship plan changed fragmentType")
    if plan.allocation_hash != allocation.allocation_hash:
        raise ValueError("relationship plan allocation hash mismatch")
    if len(plan.bundles) != allocation.bundle_target:
        raise ValueError("relationship plan bundle count mismatch")
    known = application.by_id
    candidates = set(allocation.candidate_fact_ids)
    covered: set[str] = set()
    seen_ids: set[str] = set()
    for bundle in plan.bundles:
        if bundle.fragment_type != allocation.fragment_type:
            raise ValueError("relationship bundle changed fragmentType")
        if bundle.bundle_id in seen_ids:
            raise ValueError("relationship plan contains duplicate bundleId")
        seen_ids.add(bundle.bundle_id)
        if bundle.primary_fact_id not in bundle.fact_ids:
            raise ValueError("primaryFactId must be included in factIds")
        if len(bundle.fact_ids) != len(set(bundle.fact_ids)):
            raise ValueError("relationship bundle contains duplicate factId")
        if any(fact_id not in candidates or fact_id not in known for fact_id in bundle.fact_ids):
            raise ValueError("relationship plan referenced an unallocated fact")
        covered.update(bundle.fact_ids)
    if not set(allocation.mandatory_fact_ids).issubset(covered):
        raise ValueError("relationship plan missed mandatory facts")


def validate_coordinate_plan(
    plan: FragmentDimensionCoordinatePlan,
    relationships: FragmentRelationshipPlan,
    application: InsightApplicationMap,
) -> None:
    if plan.fragment_type != relationships.fragment_type:
        raise ValueError("coordinate plan changed fragmentType")
    if plan.relationship_allocation_hash != relationship_hash(relationships):
        raise ValueError("coordinate plan relationship hash mismatch")
    bundles = {item.bundle_id: item for item in relationships.bundles}
    known_facts = application.by_id
    for dimension_name, values in _coordinate_groups(plan).items():
        seen_ids: set[str] = set()
        seen_signatures: set[str] = set()
        covered_bundles: set[str] = set()
        for value in values:
            if value.coordinate_id in seen_ids:
                raise ValueError(f"{dimension_name} contains duplicate coordinateId")
            seen_ids.add(value.coordinate_id)
            expected_signature = normalize_coordinate_signature(value.value)
            if value.normalized_signature != expected_signature:
                raise ValueError(f"{dimension_name} contains an invalid normalizedSignature")
            if expected_signature in seen_signatures:
                raise ValueError(f"{dimension_name} repeats the same semantic coordinate")
            seen_signatures.add(expected_signature)
            if any(bundle_id not in bundles for bundle_id in value.compatible_bundle_ids):
                raise ValueError(f"{dimension_name} references an unknown bundle")
            if any(fact_id not in known_facts for fact_id in value.source_fact_ids):
                raise ValueError(f"{dimension_name} references an unknown fact")
            covered_bundles.update(value.compatible_bundle_ids)
        if covered_bundles != set(bundles):
            raise ValueError(f"{dimension_name} does not cover every relationship bundle")


def allocate_blueprint_quotas(
    relationships: Sequence[FragmentRelationshipPlan],
    targets: Mapping[FragmentType, int],
    *,
    round_number: int = 0,
    deficits: Mapping[str, int] | None = None,
    priority_fact_ids: set[str] | None = None,
) -> list[BlueprintBundleQuota]:
    quotas: list[BlueprintBundleQuota] = []
    deficit_map = dict(deficits or {})
    for plan in sorted(relationships, key=lambda item: list(FragmentType).index(item.fragment_type)):
        bundles = list(plan.bundles)
        if round_number == 0:
            target = targets[plan.fragment_type]
            base, remainder = divmod(target, len(bundles))
            priority = priority_fact_ids or set()
            ranked_indexes = sorted(
                range(len(bundles)),
                key=lambda index: (
                    not bool(priority.intersection(bundles[index].fact_ids)),
                    index,
                ),
            )
            extra_indexes = set(ranked_indexes[:remainder])
            counts = [
                base + (1 if index in extra_indexes else 0)
                for index in range(len(bundles))
            ]
        else:
            counts = [max(0, deficit_map.get(bundle.bundle_id, 0)) for bundle in bundles]
        for bundle, target_count in zip(bundles, counts, strict=True):
            if target_count <= 0:
                continue
            candidate_count = (
                target_count if round_number == 0 else max(2, (target_count * 5 + 3) // 4)
            )
            quotas.append(
                BlueprintBundleQuota(
                    fragment_type=plan.fragment_type,
                    bundle_id=bundle.bundle_id,
                    primary_fact_id=bundle.primary_fact_id,
                    target_count=target_count,
                    candidate_count=candidate_count,
                )
            )
    return quotas


def make_blueprint_tasks(
    relationships: Sequence[FragmentRelationshipPlan],
    quotas: Sequence[BlueprintBundleQuota],
    durations: Mapping[FragmentType, int],
    *,
    round_number: int,
    ordinal_start: int,
) -> list[BlueprintTask]:
    bundle_by_id = {
        bundle.bundle_id: bundle for plan in relationships for bundle in plan.bundles
    }
    tasks: list[BlueprintTask] = []
    ordinal = ordinal_start
    for quota in quotas:
        bundle = bundle_by_id[quota.bundle_id]
        for _ in range(quota.candidate_count):
            tasks.append(
                BlueprintTask(
                    slot_id=f"r{round_number}-b{ordinal:04d}",
                    ordinal=ordinal,
                    round=round_number,
                    fragment_type=quota.fragment_type,
                    bundle_id=quota.bundle_id,
                    primary_fact_id=quota.primary_fact_id,
                    fact_ids=bundle.fact_ids,
                    target_duration_seconds=durations[quota.fragment_type],
                    material_tags=_MATERIAL_TAGS[quota.fragment_type],
                )
            )
            ordinal += 1
    return tasks


def make_blueprint_shards(
    tasks: Sequence[BlueprintTask], *, round_number: int, shard_size: int
) -> list[BlueprintShardPlan]:
    if not 1 <= shard_size <= 8:
        raise ValueError("shard_size must be between 1 and 8")
    shards: list[BlueprintShardPlan] = []
    index = 0
    for fragment_type in FragmentType:
        grouped = [item for item in tasks if item.fragment_type == fragment_type]
        for start in range(0, len(grouped), shard_size):
            shards.append(
                BlueprintShardPlan(
                    round=round_number,
                    shard_index=index,
                    tasks=grouped[start : start + shard_size],
                )
            )
            index += 1
    return shards


def validate_generated_blueprints(
    items: Sequence[GeneratedBlueprint],
    tasks: Sequence[BlueprintTask],
    plan: FragmentDimensionCoordinatePlan,
) -> None:
    task_by_slot = {item.slot_id: item for item in tasks}
    if len(items) != len(task_by_slot) or {item.slot_id for item in items} != set(task_by_slot):
        raise ValueError("blueprint response has missing, duplicate, or unknown slotId")
    coordinate_by_id = {
        item.coordinate_id: item
        for values in _coordinate_groups(plan).values()
        for item in values
    }
    for item in items:
        task = task_by_slot[item.slot_id]
        if (
            item.fragment_type != task.fragment_type
            or item.bundle_id != task.bundle_id
            or item.primary_fact_id != task.primary_fact_id
        ):
            raise ValueError("blueprint changed locked task identity")
        if item.primary_fact_id not in item.used_fact_ids:
            raise ValueError("blueprint omitted its primary fact")
        if any(fact_id not in task.fact_ids for fact_id in item.used_fact_ids):
            raise ValueError("blueprint used a fact outside its relationship bundle")
        for coordinate_id in _blueprint_coordinate_ids(item):
            coordinate = coordinate_by_id.get(coordinate_id)
            if coordinate is None or task.bundle_id not in coordinate.compatible_bundle_ids:
                raise ValueError("blueprint selected an unknown or incompatible coordinate")


def select_orthogonal_blueprints(
    blueprints: Sequence[GeneratedBlueprint],
    quotas: Sequence[BlueprintBundleQuota],
    coordinate_plans: Sequence[FragmentDimensionCoordinatePlan],
) -> tuple[list[GeneratedBlueprint], dict[str, int], int]:
    quota_by_bundle = {item.bundle_id: item.target_count for item in quotas}
    selected: list[GeneratedBlueprint] = []
    counts: Counter[str] = Counter()
    rejected = 0
    remaining = sorted(blueprints, key=lambda item: item.slot_id)
    while remaining:
        eligible = [
            item
            for item in remaining
            if counts[item.bundle_id] < quota_by_bundle.get(item.bundle_id, 0)
            and all(
                blueprint_distance(item, accepted, coordinate_plans) >= 3
                for accepted in selected
            )
        ]
        if not eligible:
            break
        candidate = max(
            eligible,
            key=lambda item: (
                min(
                    (
                        blueprint_distance(item, accepted, coordinate_plans)
                        for accepted in selected
                    ),
                    default=6,
                ),
                -counts[item.bundle_id],
                item.slot_id,
            ),
        )
        selected.append(candidate)
        counts[candidate.bundle_id] += 1
        remaining.remove(candidate)
    rejected = len(blueprints) - len(selected)
    deficits = {
        bundle_id: target - counts[bundle_id]
        for bundle_id, target in quota_by_bundle.items()
        if counts[bundle_id] < target
    }
    return selected, deficits, rejected


def blueprint_distance(
    left: GeneratedBlueprint,
    right: GeneratedBlueprint,
    coordinate_plans: Sequence[FragmentDimensionCoordinatePlan] | None = None,
) -> int:
    if coordinate_plans is None:
        left_values = _blueprint_coordinate_ids(left)
        right_values = _blueprint_coordinate_ids(right)
    else:
        coordinates = {
            item.coordinate_id: item.normalized_signature
            for plan in coordinate_plans
            for values in _coordinate_groups(plan).values()
            for item in values
        }
        left_values = tuple(coordinates[item] for item in _blueprint_coordinate_ids(left))
        right_values = tuple(coordinates[item] for item in _blueprint_coordinate_ids(right))
    return sum(
        a != b
        for a, b in zip(
            left_values, right_values, strict=True
        )
    )


def materialize_blueprint(
    blueprint: GeneratedBlueprint,
    task: BlueprintTask,
    coordinate_plan: FragmentDimensionCoordinatePlan,
    application: InsightApplicationMap,
) -> PlannedCombination:
    coordinates = {
        item.coordinate_id: item
        for values in _coordinate_groups(coordinate_plan).values()
        for item in values
    }
    fact = application.by_id[blueprint.primary_fact_id]
    evidence_mode = _evidence_mode(fact.field, fact.value)
    bindings = bindings_for_fact_ids(
        application, blueprint.used_fact_ids, blueprint.fragment_type
    )
    return PlannedCombination(
        slot_id=task.slot_id,
        ordinal=task.ordinal,
        fragment_type=task.fragment_type,
        material_tags=task.material_tags,
        target_duration_seconds=task.target_duration_seconds,
        planning_version="v10-coordinate-blueprint",
        opening_state=blueprint.opening_state,
        visible_action=blueprint.action_arc,
        ending_state=blueprint.ending_state,
        evidence_mode=evidence_mode,
        allowed_visual_evidence=(
            "仅呈现信息卡确认的真实产品外观、使用动作或可观察状态"
            if evidence_mode not in {EvidenceMode.TEXT_ONLY, EvidenceMode.PROCESS_ONLY}
            else "只生成真实产品细节素材，抽象信息保留在结构化元数据中"
        ),
        forbidden_inference="不得虚构工厂、实验室、功效、认证、数据、价格或促销承诺",
        relationship_bundle_id=task.bundle_id,
        insight_bindings=bindings,
        dimensions=PromptDimensions(
            narrative=coordinates[blueprint.narrative_coordinate_id].value,
            scene=coordinates[blueprint.scene_coordinate_id].value,
            persona=coordinates[blueprint.persona_coordinate_id].value,
            selling_point=coordinates[blueprint.selling_point_coordinate_id].value,
            camera=coordinates[blueprint.camera_coordinate_id].value,
            emotion=coordinates[blueprint.emotion_coordinate_id].value,
        ),
    )


def relationship_hash(plan: FragmentRelationshipPlan) -> str:
    payload = "|".join(
        f"{item.bundle_id}:{item.primary_fact_id}:{','.join(item.fact_ids)}"
        for item in plan.bundles
    )
    return hashlib.sha256(
        f"{plan.fragment_type.value}:{plan.allocation_hash}:{payload}".encode("utf-8")
    ).hexdigest()


def _coordinate_groups(
    plan: FragmentDimensionCoordinatePlan,
) -> dict[str, list[DimensionCoordinate]]:
    return {
        "narratives": plan.narratives,
        "scenes": plan.scenes,
        "personas": plan.personas,
        "sellingPoints": plan.selling_points,
        "cameras": plan.cameras,
        "emotions": plan.emotions,
    }


def _blueprint_coordinate_ids(item: GeneratedBlueprint) -> tuple[str, ...]:
    return (
        item.narrative_coordinate_id,
        item.scene_coordinate_id,
        item.persona_coordinate_id,
        item.selling_point_coordinate_id,
        item.camera_coordinate_id,
        item.emotion_coordinate_id,
    )


def _evidence_mode(field: InsightField, value: str) -> EvidenceMode:
    if field in {
        InsightField.PRODUCT_NAME,
        InsightField.VISUAL_FEATURES,
        InsightField.CORE_SPECIFICATION,
    }:
        return EvidenceMode.VISIBLE_ATTRIBUTE
    if field == InsightField.USAGE_SCENARIO:
        return EvidenceMode.USAGE_ACTION
    if any(token in value for token in ("工艺", "配方", "技术", "品质", "匠心", "理念")):
        return EvidenceMode.TEXT_ONLY
    return EvidenceMode.TEXT_ONLY
