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
    CreativeLandscapeAudit,
    CreativeLandscapeAuditResponse,
    CreativeTerritory,
    CreativeCandidate,
    CreativeEvaluation,
    CreativeFactTerritoryAssignment,
    CreativeFactTerritoryAssignmentResponse,
    CreativeSemanticProfile,
    CreativeTerritoryFactCompatibility,
    FactVisualStrategy,
    InsightApplicationMap,
)


OTHER_FAMILY = "OTHER"
MIN_CREATIVE_DIRECTION_COUNT = 8
MAX_CREATIVE_DIRECTION_COUNT = 16
MAX_BUSINESS_FACTS_PER_DIRECTION = 4


def creative_direction_target_count(
    target_count: int,
    mandatory_fact_count: int | None = None,
) -> int:
    """Scale directions for both output volume and required fact density.

    The optional fact count keeps isolated historical callers readable, while
    current batch generation always supplies the real mandatory business fact
    count and therefore receives capacity validation before any AI call.
    """

    volume_target = min(
        MAX_CREATIVE_DIRECTION_COUNT,
        max(MIN_CREATIVE_DIRECTION_COUNT, math.ceil(max(1, target_count) / 4)),
    )
    if mandatory_fact_count is None:
        return volume_target
    if mandatory_fact_count <= 0:
        raise ValueError(
            "提炼信息中没有可分配的卖点、痛点、受众、动机、营销目标或场景，"
            "请先完善并提交信息提炼结果"
        )
    prompt_capacity = max(1, target_count) * MAX_BUSINESS_FACTS_PER_DIRECTION
    if mandatory_fact_count > prompt_capacity:
        minimum_prompt_count = math.ceil(
            mandatory_fact_count / MAX_BUSINESS_FACTS_PER_DIRECTION
        )
        raise ValueError(
            f"当前 {target_count} 条 Prompt 最多承载 {prompt_capacity} 条业务事实，"
            f"现有 {mandatory_fact_count} 条；请将 Prompt 总数至少调整为 "
            f"{minimum_prompt_count} 条"
        )
    direction_capacity = (
        MAX_CREATIVE_DIRECTION_COUNT * MAX_BUSINESS_FACTS_PER_DIRECTION
    )
    if mandatory_fact_count > direction_capacity:
        raise ValueError(
            f"当前创意规划最多承载 {direction_capacity} 条业务事实，现有 "
            f"{mandatory_fact_count} 条；请先精简或合并提炼信息"
        )
    # Four facts is the structural ceiling, not the creative planning target.
    # Keeping the average near 2.5 gives the AI room to build one coherent
    # relationship instead of squeezing every available slot. Worker only
    # calculates capacity; it never assigns facts to directions.
    coverage_target = min(
        MAX_CREATIVE_DIRECTION_COUNT,
        max(1, target_count),
        math.ceil(mandatory_fact_count * 2 / 5),
    )
    return max(volume_target, coverage_target)


def creative_direction_fact_density_instruction(
    mandatory_fact_count: int,
    direction_count: int,
) -> str:
    """Describe the current batch's fact-density rule to the AI planner."""

    if mandatory_fact_count >= direction_count * 2:
        return (
            f"当前有 {mandatory_fact_count} 条必须覆盖的业务事实和 {direction_count} "
            "个创意方向。每个方向必须自然使用 2～4 条业务事实；整批必须覆盖"
            "全部业务事实。"
        )
    if mandatory_fact_count >= direction_count:
        return (
            f"当前有 {mandatory_fact_count} 条必须覆盖的业务事实和 {direction_count} "
            "个创意方向。每个方向至少自然使用 1 条业务事实，可在关系自然时使用"
            "至多 4 条；整批必须覆盖全部业务事实。"
        )
    return (
        f"当前只有 {mandatory_fact_count} 条必须覆盖的业务事实，但需要规划 "
        f"{direction_count} 个创意方向。至少让 {mandatory_fact_count} 个不同方向"
        "各自然承载业务事实，并保证整批完整覆盖；其余方向可以引用已确认的产品"
        "名称、品类、规格或视觉特征形成产品相关创意，不得虚构新的营销事实，也"
        "不得机械重复同一业务事实凑数。"
    )


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


def creative_fact_assignment_revision_context(
    response: CreativeFactTerritoryAssignmentResponse,
    application: InsightApplicationMap,
    landscape: CreativeDiversityLandscapeResponse,
    *,
    validation_error: str,
    expected_direction_count: int,
) -> dict[str, object]:
    business_ids = [fact.fact_id for fact in mandatory_business_facts(application)]
    territory_ids = {item.territory_id for item in landscape.territories}
    assigned_ids = [item.fact_id for item in response.assignments]
    counts = Counter(assigned_ids)
    load = Counter(
        item.territory_id
        for item in response.assignments
        if item.territory_id in territory_ids
    )
    minimum_slots = {
        territory_id: max(1, math.ceil(load.get(territory_id, 0) / 4))
        for territory_id in territory_ids
    }
    return {
        "validationError": validation_error,
        "missingFactIds": [item for item in business_ids if item not in counts],
        "duplicatedFactIds": [item for item, count in counts.items() if count > 1],
        "unknownFactIds": [item for item in counts if item not in business_ids],
        "unknownTerritoryIds": sorted(
            {
                item.territory_id
                for item in response.assignments
                if item.territory_id not in territory_ids
            }
        ),
        "factLoadByTerritory": dict(load),
        "minimumSlotsByTerritory": minimum_slots,
        "minimumSlotTotal": sum(minimum_slots.values()),
        "targetDirectionCount": expected_direction_count,
        "previousAssignments": [
            item.model_dump(mode="json", by_alias=True)
            for item in response.assignments
        ],
        "revisionInstruction": (
            "重新输出全部业务事实的完整唯一分配；修正缺失、重复、未知引用和"
            "容量问题，不修改创意空间，不删除事实。"
        ),
    }


def compile_creative_landscape_assignments(
    landscape: CreativeDiversityLandscapeResponse,
    assignments: CreativeFactTerritoryAssignmentResponse,
    application: InsightApplicationMap,
    *,
    source_hash: str,
    template_hash: str,
    expected_direction_count: int,
) -> CreativeDiversityLandscape:
    """Mechanically merge AI-owned fact assignments into AI-owned territories."""

    business_ids = [fact.fact_id for fact in mandatory_business_facts(application)]
    business_id_set = set(business_ids)
    assigned_ids = [item.fact_id for item in assignments.assignments]
    if len(assigned_ids) != len(set(assigned_ids)):
        raise ValueError("creative fact assignment repeated a fact")
    if set(assigned_ids) != business_id_set:
        raise ValueError("creative fact assignment must cover every business fact once")
    territory_ids = {item.territory_id for item in landscape.territories}
    if any(item.territory_id not in territory_ids for item in assignments.assignments):
        raise ValueError("creative fact assignment used an unknown territory")

    assigned_by_territory: dict[str, list[CreativeFactTerritoryAssignment]] = {
        territory_id: [] for territory_id in territory_ids
    }
    for item in assignments.assignments:
        assigned_by_territory[item.territory_id].append(item)

    compiled_territories = []
    for territory in landscape.territories:
        assigned = assigned_by_territory[territory.territory_id]
        if len(assigned) > 64:
            raise ValueError("creative fact assignment exceeded territory fact capacity")
        assigned_fact_ids = [item.fact_id for item in assigned]
        supporting_fact_ids = [
            fact_id
            for fact_id in territory.compatible_fact_ids
            if fact_id not in assigned_fact_ids
        ][: max(0, 64 - len(assigned_fact_ids))]
        guidance_by_id = {
            item.fact_id: item for item in territory.fact_compatibilities
        }
        compiled_guidance = [
            CreativeTerritoryFactCompatibility(
                fact_id=item.fact_id,
                natural_usage=item.natural_usage,
                unsupported_conditions=item.unsupported_conditions,
            )
            for item in assigned
        ]
        compiled_guidance.extend(
            guidance_by_id[fact_id]
            for fact_id in supporting_fact_ids
            if fact_id in guidance_by_id
        )
        supporting_fact_ids = [
            item.fact_id for item in compiled_guidance[len(assigned) :]
        ]
        compiled_territories.append(
            territory.model_copy(
                update={
                    "required_fact_ids": assigned_fact_ids,
                    "compatible_fact_ids": [
                        *assigned_fact_ids,
                        *supporting_fact_ids,
                    ],
                    "fact_compatibilities": compiled_guidance,
                }
            )
        )
    return validate_creative_diversity_landscape(
        CreativeDiversityLandscapeResponse(territories=compiled_territories),
        application,
        source_hash=source_hash,
        template_hash=template_hash,
        expected_direction_count=expected_direction_count,
    )
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
    if len(response.territories) > expected_direction_count:
        raise ValueError("creative landscape has more territories than directions")
    if any(
        fact_id not in usable_ids
        for territory in response.territories
        for fact_id in territory.compatible_fact_ids
    ):
        raise ValueError("creative landscape referenced an unavailable fact")
    for territory in response.territories:
        if not territory.fact_compatibilities:
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
    if any(
        fact_id not in territory.compatible_fact_ids
        for territory in response.territories
        for fact_id in territory.required_fact_ids
    ):
        raise ValueError("creative landscape required fact lacks compatibility guidance")
    if not business_ids.issubset(set(required_ids)):
        raise ValueError("creative landscape did not assign every business fact once")
    normalized_required_ids = [
        [
            fact_id
            for fact_id in territory.required_fact_ids
            if fact_id in business_ids
        ]
        for territory in response.territories
    ]
    target_slots = [
        max(1, math.ceil(len(required_fact_ids) / 4))
        for required_fact_ids in normalized_required_ids
    ]
    if sum(target_slots) > expected_direction_count:
        raise ValueError("creative landscape required facts exceed direction capacity")
    allocation_order = sorted(
        range(len(response.territories)),
        key=lambda index: (
            -len(normalized_required_ids[index]),
            -len(response.territories[index].compatible_fact_ids),
            response.territories[index].territory_id,
        ),
    )
    for offset in range(expected_direction_count - sum(target_slots)):
        target_slots[allocation_order[offset % len(allocation_order)]] += 1
    territories = [
        CreativeTerritory(
            **territory.model_dump(
                mode="python",
                exclude={"required_fact_ids"},
            ),
            required_fact_ids=normalized_required_ids[index],
            target_slots=target_slots[index],
        )
        for index, territory in enumerate(response.territories)
    ]
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


def validate_creative_landscape_audit(
    response: CreativeLandscapeAuditResponse,
    landscape: CreativeDiversityLandscape,
) -> CreativeLandscapeAudit:
    """Validate audit bookkeeping without making semantic decisions in Worker."""

    territory_ids = {item.territory_id for item in landscape.territories}
    audit_ids = response.reviewed_territory_ids
    if len(audit_ids) != len(set(audit_ids)) or set(audit_ids) != territory_ids:
        raise ValueError("creative landscape audit must cover every territory once")
    landscape_by_id = landscape.by_id
    issue_territory_ids: set[str] = set()
    issue_keys = [
        (issue.territory_id, issue.fact_id) for issue in response.fact_issues
    ]
    if len(issue_keys) != len(set(issue_keys)):
        raise ValueError("creative landscape audit repeated a fact issue")
    for issue in response.fact_issues:
        territory = landscape_by_id.get(issue.territory_id)
        if territory is None:
            raise ValueError("creative landscape audit used an unknown territory")
        if issue.fact_id not in territory.compatible_fact_ids:
            raise ValueError("creative landscape audit used an unrelated fact id")
        issue_territory_ids.add(issue.territory_id)
    if any(
        territory_id not in territory_ids
        for territory_id in response.revision_territory_ids
    ):
        raise ValueError("creative landscape audit used an unknown revision id")
    if issue_territory_ids:
        if not response.requires_revision:
            raise ValueError("creative landscape audit ignored a semantic issue")
        if not issue_territory_ids.issubset(response.revision_territory_ids):
            raise ValueError("creative landscape audit omitted a revision territory")
    elif response.requires_revision:
        raise ValueError("creative landscape audit requested an unsupported revision")
    payload = response.model_dump(mode="json", by_alias=True)
    return CreativeLandscapeAudit(
        **response.model_dump(mode="python"),
        audit_hash=_hash(payload),
    )


def creative_landscape_audit_revision_context(
    landscape: CreativeDiversityLandscape,
    audit: CreativeLandscapeAudit,
) -> dict[str, object]:
    return {
        "semanticAudit": audit.model_dump(mode="json", by_alias=True),
        "previousTerritories": [
            item.model_dump(mode="json", by_alias=True)
            for item in landscape.territories
        ],
        "revisionInstruction": (
            "依据独立语义复核重新规划完整创意版图。把不自然或缺少画面条件的"
            "事实移出原空间，放入真正能自然承载它的空间；必要时同步调整相关空间。"
            "多选项事实可以由同一空间内多个方向分别承载，不得强迫单条短片同时完成"
            "多种动作。保持未被指出的空间稳定，不得由系统替你判断事实语义。"
        ),
    }


def apply_creative_landscape_audit(
    landscape: CreativeDiversityLandscape,
    audit: CreativeLandscapeAudit,
    application: InsightApplicationMap,
) -> CreativeDiversityLandscape | None:
    """Apply AI semantic findings without asking Worker to interpret semantics.

    AI owns the WEAK/UNSUPPORTED verdict. Worker only removes the exact optional
    relationship named by AI. If that mechanical removal would lose a required
    assignment or mandatory batch fact, the caller must ask AI to replan.
    """

    if not audit.requires_revision:
        return landscape.model_copy(update={"semantic_audit": audit})
    issue_keys = {
        (issue.territory_id, issue.fact_id) for issue in audit.fact_issues
    }
    territories: list[CreativeTerritory] = []
    for territory in landscape.territories:
        removed_ids = {
            fact_id
            for territory_id, fact_id in issue_keys
            if territory_id == territory.territory_id
        }
        if removed_ids.intersection(territory.required_fact_ids):
            return None
        compatible_fact_ids = [
            fact_id
            for fact_id in territory.compatible_fact_ids
            if fact_id not in removed_ids
        ]
        if not compatible_fact_ids:
            return None
        territories.append(
            territory.model_copy(
                update={
                    "compatible_fact_ids": compatible_fact_ids,
                    "fact_compatibilities": [
                        item
                        for item in territory.fact_compatibilities
                        if item.fact_id not in removed_ids
                    ],
                }
            )
        )
    remaining_fact_ids = {
        fact_id
        for territory in territories
        for fact_id in territory.compatible_fact_ids
    }
    mandatory_fact_ids = {
        fact.fact_id for fact in mandatory_business_facts(application)
    }
    if not mandatory_fact_ids.issubset(remaining_fact_ids):
        return None
    clean_response = CreativeLandscapeAuditResponse(
        reviewed_territory_ids=[item.territory_id for item in territories],
        fact_issues=[],
        requires_revision=False,
        revision_territory_ids=[],
        summary=(
            f"独立复核指出的 {len(issue_keys)} 项不自然辅助事实关系已移除"
        ),
    )
    clean_audit = validate_creative_landscape_audit(
        clean_response,
        landscape.model_copy(update={"territories": territories}),
    )
    payload = [
        item.model_dump(mode="json", by_alias=True) for item in territories
    ]
    return landscape.model_copy(
        update={
            "territories": territories,
            "landscape_hash": _hash(payload),
            "semantic_audit": clean_audit,
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
    business_fact_counts = [
        len(business_ids.intersection(direction.fact_ids)) for direction in directions
    ]
    if len(business_ids) >= len(directions) * 2:
        if any(count < 2 for count in business_fact_counts):
            raise ValueError(
                "fact-rich batches require at least two business facts per direction"
            )
    elif len(business_ids) >= len(directions):
        if any(count < 1 for count in business_fact_counts):
            raise ValueError(
                "this batch requires at least one business fact per direction"
            )
    elif sum(count > 0 for count in business_fact_counts) < len(business_ids):
        raise ValueError(
            "sparse business facts must be distributed across distinct directions"
        )
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
        # ``issues`` is part of the AI auditor's structured verdict.  Treating
        # only ``aligned`` and fact reviews as authoritative made a perfectly
        # valid response self-contradictory whenever the auditor reported a
        # direction-level issue while keeping the coarse alignment flag true.
        # This is structural reconciliation only; Worker does not infer the
        # business meaning of the issue text.
        if has_fact_issue or not item.aligned or bool(item.issues):
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
    landscape: CreativeDiversityLandscape | None = None,
) -> dict[str, object]:
    """Prepare a model-owned revision brief without changing any direction."""

    business_ids = [fact.fact_id for fact in mandatory_business_facts(application)]
    planned_ids = {
        fact_id for direction in response.directions for fact_id in direction.fact_ids
    }
    invalid_fact_references = []
    invalid_direction_ids: list[str] = []
    allowed_facts_by_territory: dict[str, list[str]] = {}
    if landscape is not None:
        allowed_facts_by_territory = {
            territory.territory_id: list(territory.compatible_fact_ids)
            for territory in landscape.territories
        }
        invalid_fact_references = [
            {
                "directionId": direction.direction_id,
                "territoryId": direction.territory_id,
                "invalidFactIds": [
                    fact_id
                    for fact_id in direction.fact_ids
                    if fact_id
                    not in allowed_facts_by_territory.get(
                        direction.territory_id,
                        [],
                    )
                ],
            }
            for direction in response.directions
            if any(
                fact_id
                not in allowed_facts_by_territory.get(direction.territory_id, [])
                for fact_id in direction.fact_ids
            )
        ]
        invalid_direction_ids = [
            direction.direction_id
            for direction in response.directions
            if any(
                fact_id
                not in allowed_facts_by_territory.get(direction.territory_id, [])
                for fact_id in direction.fact_ids
            )
        ]
    missing_business_fact_ids = [
        fact_id for fact_id in business_ids if fact_id not in planned_ids
    ]
    revision_direction_ids: list[str] = []
    if landscape is not None:
        missing_territory_ids = {
            territory_id
            for territory_id, allowed_fact_ids in allowed_facts_by_territory.items()
            if any(
                fact_id in allowed_fact_ids
                for fact_id in missing_business_fact_ids
            )
        }
        revision_direction_ids = list(
            dict.fromkeys(
                [
                    direction.direction_id
                    for direction in response.directions
                    if direction.territory_id in missing_territory_ids
                ]
                + invalid_direction_ids
            )
        )
    return {
        "validationError": validation_error,
        "missingBusinessFactIds": missing_business_fact_ids,
        "previousDirections": [
            direction.model_dump(mode="json", by_alias=True)
            for direction in response.directions
        ],
        "allowedFactIdsByTerritory": allowed_facts_by_territory,
        "invalidDirectionFactReferences": invalid_fact_references,
        "revisionDirectionIds": revision_direction_ids,
        "revisionInstruction": (
            "重新规划完整批次，让缺失事实自然进入合适方向；"
            "每个方向的 factApplications 只能引用其 territoryId 对应的"
            " allowedFactIdsByTerritory，逐项修复 invalidDirectionFactReferences；"
            "revisionDirectionIds 是本轮允许调整的方向，其他方向必须原样返回；"
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
