from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import re
import time
from collections.abc import Mapping, Sequence
from collections import Counter
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Generic, Protocol, TypeVar

import httpx
from pydantic import BaseModel, Field, ValidationError

from .creative_directions import (
    creative_direction_fact_density_instruction,
    creative_execution_route_target_count,
    creative_direction_target_count,
    creative_territory_target_range,
)
from .insight_mapping import mandatory_business_facts
from .execution_refinement import (
    ExecutionEditBatch, apply_execution_edits, editable_execution_paths, execution_edit_schema,
)
from .product_images import PreparedProductImage
from .supplement_recovery import direction_summary, route_summary
from .models import (
    MaterialBrief,
    MaterialPlanResponse,
    MAX_PROMPT_DURATION_SECONDS,
    MIN_PROMPT_DURATION_SECONDS,
    CreativeCandidate,
    CreativeCandidateBatch,
    CreativeCandidateDraft,
    CreativeCandidateDraftBatch,
    CreativeDirectionAuditItem,
    CreativeDirectionFactAudit,
    CreativeDirectionAuditResponse,
    CreativeDirectionCanonicalProfile,
    CreativeDirectionDiversityAuditResponse,
    CreativeDirection,
    CreativeExecutionRoute,
    CreativeDirectionFactApplication,
    CreativeDirectionPlan,
    CreativeDirectionResponse,
    CreativeDiversityLandscape,
    CreativeDiversityLandscapeResponse,
    CreativeLandscapeAuditResponse,
    CreativeTerritory,
    CreativeTerritoryDraft,
    CreativeTerritoryAuditResponse,
    CreativeTerritoryAction,
    CreativeTerritoryFactCompatibility,
    CreativeDimensionKey,
    CreativeDimensions,
    CreativeEvaluation,
    CreativeEvaluationBatch,
    CreativeEvaluationDraft,
    CreativeEvaluationDraftBatch,
    ExecutionFinding,
    ExecutionRepairDraft,
    CreativeFactTerritoryAssignment,
    CreativeFactTerritoryAssignmentResponse,
    CreativeFactAssignment,
    CreativeScores,
    CreativeSemanticProfile,
    CreativeShardPlan,
    CreativeTask,
    FactEvidence,
    FactVisualPolicyDraft,
    FactVisualStrategy,
    FactVisualStrategyResponse,
    FactVisualUsage,
    FragmentType,
    InsightApplicationMap,
    InsightField,
    NodeId,
    SharedPrompt,
    MaterialShotBeat,
    MaterialShotOverview,
    MaterialShotPlan,
    MaterialShotScene,
)
from .reliability import (
    creative_output_token_budget as _creative_output_token_budget,
    evaluation_output_token_budget,
)
from .prompt_loader import load_prompt, load_prompt_hash, render_prompt
from .shot_plan import ShotPlanCompilationError, compile_material_shot_plan

TModel = TypeVar("TModel", bound=BaseModel)
LOGGER = logging.getLogger(__name__)
CREATIVE_BASE_PROMPT = "creative_base.system.prompt.txt"
CREATIVE_EXECUTION_PROMPT = "creative_execution.system.prompt.txt"
CREATIVE_TASK_PROMPT = "creative_task.user.prompt.txt"
EXECUTION_REPAIR_PROMPT = "execution_repair.system.prompt.txt"
EVALUATION_BASE_PROMPT = "evaluation_base.system.prompt.txt"
EVALUATION_TASK_PROMPT = "evaluation_task.user.prompt.txt"
FACT_VISUAL_STRATEGY_BASE_PROMPT = "fact_visual_strategy.system.prompt.txt"
FACT_VISUAL_STRATEGY_TASK_PROMPT = "fact_visual_strategy.user.prompt.txt"
CREATIVE_DIRECTION_BASE_PROMPT = "creative_direction.system.prompt.txt"
CREATIVE_DIRECTION_TASK_PROMPT = "creative_direction.user.prompt.txt"
CREATIVE_LANDSCAPE_BASE_PROMPT = "creative_landscape.system.prompt.txt"
CREATIVE_LANDSCAPE_TASK_PROMPT = "creative_landscape.user.prompt.txt"
CREATIVE_LANDSCAPE_AUDIT_BASE_PROMPT = "creative_landscape_audit.system.prompt.txt"
CREATIVE_LANDSCAPE_AUDIT_TASK_PROMPT = "creative_landscape_audit.user.prompt.txt"
CREATIVE_LANDSCAPE_BATCH_AUDIT_BASE_PROMPT = (
    "creative_landscape_batch_audit.system.prompt.txt"
)
CREATIVE_LANDSCAPE_BATCH_AUDIT_TASK_PROMPT = (
    "creative_landscape_batch_audit.user.prompt.txt"
)
CREATIVE_FACT_TERRITORY_ASSIGNMENT_BASE_PROMPT = (
    "creative_fact_territory_assignment.system.prompt.txt"
)
CREATIVE_FACT_TERRITORY_ASSIGNMENT_TASK_PROMPT = (
    "creative_fact_territory_assignment.user.prompt.txt"
)
CREATIVE_DIRECTION_AUDIT_BASE_PROMPT = "creative_direction_audit.system.prompt.txt"
CREATIVE_DIRECTION_AUDIT_TASK_PROMPT = "creative_direction_audit.user.prompt.txt"
CREATIVE_DIRECTION_DIVERSITY_AUDIT_BASE_PROMPT = (
    "creative_direction_diversity_audit.system.prompt.txt"
)
CREATIVE_DIRECTION_DIVERSITY_AUDIT_TASK_PROMPT = (
    "creative_direction_diversity_audit.user.prompt.txt"
)
CREATIVE_DIRECTION_SUPPLEMENT_BASE_PROMPT = (
    "creative_direction_supplement.system.prompt.txt"
)
CREATIVE_DIRECTION_SUPPLEMENT_TASK_PROMPT = (
    "creative_direction_supplement.user.prompt.txt"
)
FACT_VISUAL_STRATEGY_TEMPLATE_HASH = hashlib.sha256(
    (
        load_prompt(FACT_VISUAL_STRATEGY_BASE_PROMPT)
        + "\n"
        + load_prompt(FACT_VISUAL_STRATEGY_TASK_PROMPT)
    ).encode("utf-8")
).hexdigest()
CREATIVE_DIRECTION_TEMPLATE_HASH = hashlib.sha256(
    (
        load_prompt(CREATIVE_LANDSCAPE_BASE_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_LANDSCAPE_TASK_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_LANDSCAPE_AUDIT_BASE_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_LANDSCAPE_AUDIT_TASK_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_LANDSCAPE_BATCH_AUDIT_BASE_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_LANDSCAPE_BATCH_AUDIT_TASK_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_FACT_TERRITORY_ASSIGNMENT_BASE_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_FACT_TERRITORY_ASSIGNMENT_TASK_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_DIRECTION_BASE_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_DIRECTION_TASK_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_DIRECTION_AUDIT_BASE_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_DIRECTION_AUDIT_TASK_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_DIRECTION_DIVERSITY_AUDIT_BASE_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_DIRECTION_DIVERSITY_AUDIT_TASK_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_DIRECTION_SUPPLEMENT_BASE_PROMPT)
        + "\n"
        + load_prompt(CREATIVE_DIRECTION_SUPPLEMENT_TASK_PROMPT)
    ).encode("utf-8")
).hexdigest()


class CreativeDraftEnvelope(BaseModel):
    """Wire envelope only; every row still passes CreativeCandidateDraft."""

    model_config = {"extra": "forbid"}
    items: list[Any] = Field(min_length=1, max_length=5)


class ProviderErrorType(StrEnum):
    TIMEOUT = "AI_TIMEOUT"
    NETWORK = "AI_NETWORK"
    RATE_LIMIT = "AI_RATE_LIMIT"
    SERVICE = "AI_SERVICE"
    OUTPUT_TRUNCATED = "AI_OUTPUT_TRUNCATED"
    RESPONSE_INCOMPLETE = "AI_RESPONSE_INCOMPLETE"
    RESPONSE_INVALID = "AI_RESPONSE_INVALID"
    REQUEST_REJECTED = "AI_REQUEST_REJECTED"
    UNKNOWN = "AI_UNKNOWN"


class ProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool,
        error_type: ProviderErrorType = ProviderErrorType.UNKNOWN,
        attempts: int = 1,
        elapsed_ms: int = 0,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.error_type = error_type
        self.attempts = max(1, attempts)
        self.elapsed_ms = max(0, elapsed_ms)


@dataclass(frozen=True, slots=True)
class AiCallMetadata:
    stage: str
    template_hash: str
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    latency_ms: int
    attempts: int
    model_relationship_bundle_count: int | None = None
    worker_completed_relationship_bundle_count: int | None = None


@dataclass(frozen=True, slots=True)
class AiCallResult(Generic[TModel]):
    value: TModel
    metadata: AiCallMetadata


def _fact_alias_maps(
    application: InsightApplicationMap,
) -> tuple[dict[str, str], dict[str, str]]:
    aliases = {
        fact.fact_id: f"F{index + 1}" for index, fact in enumerate(application.usable)
    }
    return aliases, {alias: fact_id for fact_id, alias in aliases.items()}


def _remap_fact_references(value: Any, mapping: Mapping[str, str]) -> Any:
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [_remap_fact_references(item, mapping) for item in value]
    if isinstance(value, dict):
        return {
            key: _remap_fact_references(item, mapping) for key, item in value.items()
        }
    return value


def _visual_style_baseline_section(style_instruction: str) -> str:
    """Render fixed-style guidance without adding constraints in auto mode."""
    normalized = style_instruction.strip()
    if not normalized:
        return ""
    return (
        "视觉风格基调（只影响光线、色彩、材质和镜头质感，"
        "不是固定场景模板）：\n"
        + json.dumps(normalized, ensure_ascii=False)
    )


class AiProvider(Protocol):
    async def plan_materials(
        self, application: InsightApplicationMap, *, task_ids: Sequence[str],
        fact_visual_strategy: FactVisualStrategy, shared_prompt: SharedPrompt,
        remaining_fact_ids: Sequence[str], existing_tasks: Sequence[MaterialBrief] = (),
        settings: Mapping[str, Any] | None = None,
        repair_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[MaterialPlanResponse]: ...

    execution_mode: str

    async def compile_fact_visual_strategy(
        self,
        application: InsightApplicationMap,
        *,
        product_images: Sequence[PreparedProductImage] = (),
        target_fact_ids: Sequence[str] = (),
    ) -> AiCallResult[FactVisualStrategyResponse]: ...

    async def plan_creative_landscape(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        target_count: int,
        style_instruction: str,
        delivery_channel: str,
        revision_context: Mapping[str, Any] | None = None,
        revision_territory_ids: Sequence[str] = (),
    ) -> AiCallResult[CreativeDiversityLandscapeResponse]: ...

    async def plan_creative_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        landscape: CreativeDiversityLandscape,
        target_count: int,
        style_instruction: str,
        delivery_channel: str,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionResponse]: ...

    async def assign_creative_landscape_facts(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscapeResponse,
        target_count: int,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeFactTerritoryAssignmentResponse]: ...

    async def audit_creative_territory(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        territory: CreativeTerritory,
    ) -> AiCallResult[CreativeTerritoryAuditResponse]: ...

    async def audit_creative_landscape(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscape,
    ) -> AiCallResult[CreativeLandscapeAuditResponse]: ...

    async def audit_creative_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscape,
        directions: CreativeDirectionResponse,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionAuditResponse]: ...

    async def audit_creative_direction_diversity(
        self,
        *,
        landscape: CreativeDiversityLandscape,
        directions: CreativeDirectionResponse,
        proposed_direction_ids: Sequence[str] = (),
    ) -> AiCallResult[CreativeDirectionDiversityAuditResponse]: ...

    async def plan_diversity_supplement_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        landscape: CreativeDiversityLandscape,
        existing_directions: CreativeDirectionResponse,
        requested_direction_count: int,
        execution_route_count: int,
        crowded_scene_families: Sequence[str],
        crowded_action_families: Sequence[str],
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionResponse]: ...

    async def generate_creatives(
        self,
        shard: CreativeShardPlan,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        fact_visual_strategy: FactVisualStrategy | None = None,
        regeneration_context: Mapping[str, Any] | None = None,
        product_images: Sequence[PreparedProductImage] = (),
    ) -> AiCallResult[CreativeCandidateBatch]: ...

    async def repair_creative_execution(
        self, candidate: CreativeCandidate, *, task: CreativeTask,
        findings: Sequence[ExecutionFinding], application: InsightApplicationMap,
        shared_prompt: SharedPrompt, fact_visual_strategy: FactVisualStrategy,
    ) -> AiCallResult[ExecutionRepairDraft]: ...

    async def refine_creative_execution(
        self, candidates: list[CreativeCandidate], *, shard: CreativeShardPlan,
        application: InsightApplicationMap, shared_prompt: SharedPrompt,
        fact_visual_strategy: FactVisualStrategy | None = None,
        product_images: Sequence[PreparedProductImage] = (),
    ) -> AiCallResult[CreativeCandidateBatch]: ...

    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        target_durations: Mapping[str, int],
        application: InsightApplicationMap,
        assigned_context_fact_ids: Mapping[str, Sequence[str]] | None = None,
        fact_visual_strategy: FactVisualStrategy | None = None,
        direction_plan: CreativeDirectionPlan | None = None,
        infer_creative_structure: bool = False,
    ) -> AiCallResult[CreativeEvaluationBatch]: ...


class MockAiProvider:
    async def plan_materials(
        self, application: InsightApplicationMap, *, task_ids: Sequence[str],
        fact_visual_strategy: FactVisualStrategy, shared_prompt: SharedPrompt,
        remaining_fact_ids: Sequence[str], existing_tasks: Sequence[MaterialBrief] = (),
        settings: Mapping[str, Any] | None = None,
        repair_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[MaterialPlanResponse]:
        del fact_visual_strategy, shared_prompt, settings, repair_context
        facts = list(remaining_fact_ids) or [fact.fact_id for fact in mandatory_business_facts(application)]
        facts = facts or [fact.fact_id for fact in application.usable]
        if not facts:
            raise ProviderError("no confirmed facts", retryable=False)
        return _mock_result(MaterialPlanResponse(tasks=[
            MaterialBrief(task_id=task_id,
                fact_ids=facts[index::len(task_ids)] or [facts[(index + len(existing_tasks)) % len(facts)]],
                visual_event=f"测试素材事件{len(existing_tasks) + index + 1}：展示已确认的使用价值",
                difference=f"测试独立观看变化{len(existing_tasks) + index + 1}",
                priority_dimensions=[])
            for index, task_id in enumerate(task_ids)
        ]), "COHERENT_CREATIVE_GENERATION", "material_planning.system.prompt.txt")

    execution_mode = "MOCK"

    async def refine_creative_execution(
        self, candidates: list[CreativeCandidate], *, shard: CreativeShardPlan,
        application: InsightApplicationMap, shared_prompt: SharedPrompt,
        fact_visual_strategy: FactVisualStrategy | None = None,
        product_images: Sequence[PreparedProductImage] = (),
    ) -> AiCallResult[CreativeCandidateBatch]:
        # Explicit test identity fixture, not a semantic implementation.
        return _mock_result(CreativeCandidateBatch(items=candidates),
                            "COHERENT_CREATIVE_GENERATION", CREATIVE_EXECUTION_PROMPT)

    async def repair_creative_execution(
        self, candidate: CreativeCandidate, *, task: CreativeTask,
        findings: Sequence[ExecutionFinding], application: InsightApplicationMap,
        shared_prompt: SharedPrompt, fact_visual_strategy: FactVisualStrategy,
    ) -> AiCallResult[ExecutionRepairDraft]:
        # Explicit fixture-only no-op; never manufacture a production repair.
        if candidate.shot_plan is None:
            raise ValueError("mock repair requires shot plan")
        return _mock_result(ExecutionRepairDraft(
            slot_id=candidate.slot_id,
            shot_plan=candidate.shot_plan,
        ), "CREATIVE_EVALUATION_CLASSIFICATION", EXECUTION_REPAIR_PROMPT)

    async def compile_fact_visual_strategy(
        self,
        application: InsightApplicationMap,
        *,
        product_images: Sequence[PreparedProductImage] = (),
        target_fact_ids: Sequence[str] = (),
    ) -> AiCallResult[FactVisualStrategyResponse]:
        del product_images
        response = _mock_fact_visual_strategy(application)
        if target_fact_ids:
            response = response.model_copy(update={"policies": [
                policy for policy in response.policies if policy.fact_id in target_fact_ids
            ]})
        return _mock_result(
            response,
            NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value,
            FACT_VISUAL_STRATEGY_BASE_PROMPT,
        )

    async def plan_creative_landscape(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        target_count: int,
        style_instruction: str,
        delivery_channel: str,
        revision_context: Mapping[str, Any] | None = None,
        revision_territory_ids: Sequence[str] = (),
    ) -> AiCallResult[CreativeDiversityLandscapeResponse]:
        del (
            fact_visual_strategy,
            shared_prompt,
            style_instruction,
            delivery_channel,
        )
        response = _mock_creative_landscape_response(
            application,
            direction_count=creative_direction_target_count(
                target_count,
                len(mandatory_business_facts(application)),
            ),
        )
        if revision_territory_ids:
            requested = set(revision_territory_ids)
            response = CreativeDiversityLandscapeResponse(
                territories=[
                    item
                    for item in response.territories
                    if item.territory_id in requested
                ]
            )
        del revision_context
        return _mock_result(
            response,
            NodeId.COHERENT_CREATIVE_GENERATION.value,
            CREATIVE_LANDSCAPE_BASE_PROMPT,
        )

    async def plan_creative_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        landscape: CreativeDiversityLandscape,
        target_count: int,
        style_instruction: str,
        delivery_channel: str,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionResponse]:
        del fact_visual_strategy, shared_prompt, style_instruction, delivery_channel
        response = _mock_creative_direction_response(
            application,
            landscape=landscape,
            execution_route_count=creative_execution_route_target_count(
                (target_count * 14 + 9) // 10,
                sum(item.target_slots for item in landscape.territories),
            ),
        )
        required_slots = (
            revision_context.get("requiredDirectionSlots", [])
            if revision_context is not None
            else []
        )
        revision_direction_ids = (
            revision_context.get("revisionDirectionIds", [])
            if revision_context is not None
            else []
        )
        if isinstance(required_slots, list) and required_slots:
            directions_by_slot = {
                (direction.territory_id, direction.primary_action_id): direction
                for direction in response.directions
            }
            unused_directions = iter(response.directions)
            slot_directions: list[CreativeDirection] = []
            for slot in required_slots:
                if not isinstance(slot, dict):
                    continue
                territory_id = slot.get("territoryId")
                primary_action_id = slot.get("primaryActionId")
                matched = (
                    directions_by_slot.get((territory_id, primary_action_id))
                    if isinstance(territory_id, str)
                    and isinstance(primary_action_id, str)
                    else None
                )
                if matched is None:
                    matched = next(unused_directions, None)
                if matched is not None:
                    slot_directions.append(matched)
            response = CreativeDirectionResponse(directions=slot_directions)
        elif (
            isinstance(revision_direction_ids, list)
            and revision_direction_ids
            and all(isinstance(item, str) for item in revision_direction_ids)
        ):
            directions_by_id = {
                direction.direction_id: direction for direction in response.directions
            }
            response = CreativeDirectionResponse(
                directions=[
                    directions_by_id[direction_id]
                    for direction_id in revision_direction_ids
                    if direction_id in directions_by_id
                ]
            )
        if isinstance(required_slots, list) and len(required_slots) == len(
            response.directions
        ):
            response = CreativeDirectionResponse(
                directions=[
                    direction.model_copy(
                        update={
                            "direction_id": slot.get(
                                "directionId", direction.direction_id
                            ),
                            # The mock builds directions from the scoped territory and
                            # therefore restarts its local wording for every bounded
                            # transport batch. Preserve production's global-slot
                            # semantics in tests by making that synthetic wording
                            # stable per assigned direction id as well.
                            "creative_direction": (
                                f"{direction.creative_direction} · "
                                f"{slot.get('directionId', direction.direction_id)}"
                            ),
                            "territory_id": slot.get(
                                "territoryId", direction.territory_id
                            ),
                            "primary_action_id": slot.get(
                                "primaryActionId", direction.primary_action_id
                            ),
                            # Direction planning is transported in bounded batches.
                            # Keep the mock's semantic families tied to the global
                            # direction id so every batch does not restart at the
                            # first synthetic family and accidentally look duplicate.
                            "semantic_profile": _mock_semantic_profile_for_direction(
                                slot.get("directionId", direction.direction_id),
                                fallback_index=index,
                            ),
                        }
                    )
                    for index, (direction, slot) in enumerate(
                        zip(
                            response.directions,
                            required_slots,
                            strict=True,
                        )
                    )
                    if isinstance(slot, dict)
                ]
            )
        return _mock_result(
            response,
            NodeId.COHERENT_CREATIVE_GENERATION.value,
            CREATIVE_DIRECTION_BASE_PROMPT,
        )

    async def assign_creative_landscape_facts(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscapeResponse,
        target_count: int,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeFactTerritoryAssignmentResponse]:
        del fact_visual_strategy, target_count, revision_context
        territory_ids = [item.territory_id for item in landscape.territories]
        assignments = [
            CreativeFactTerritoryAssignment(
                fact_id=fact.fact_id,
                territory_id=territory_ids[index % len(territory_ids)],
                natural_usage=f"让该事实直接决定{landscape.territories[index % len(territory_ids)].label}的商业表达",
                unsupported_conditions=[],
            )
            for index, fact in enumerate(mandatory_business_facts(application))
        ]
        return _mock_result(
            CreativeFactTerritoryAssignmentResponse(assignments=assignments),
            NodeId.COHERENT_CREATIVE_GENERATION.value,
            CREATIVE_FACT_TERRITORY_ASSIGNMENT_BASE_PROMPT,
        )

    async def audit_creative_territory(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        territory: CreativeTerritory,
    ) -> AiCallResult[CreativeTerritoryAuditResponse]:
        del application, fact_visual_strategy
        return _mock_result(
            _mock_creative_territory_audit(territory),
            NodeId.COHERENT_CREATIVE_GENERATION.value,
            CREATIVE_LANDSCAPE_AUDIT_BASE_PROMPT,
        )

    async def audit_creative_landscape(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscape,
    ) -> AiCallResult[CreativeLandscapeAuditResponse]:
        del application, fact_visual_strategy
        return _mock_result(
            _mock_creative_landscape_audit(landscape),
            NodeId.COHERENT_CREATIVE_GENERATION.value,
            CREATIVE_LANDSCAPE_BATCH_AUDIT_BASE_PROMPT,
        )

    async def audit_creative_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscape,
        directions: CreativeDirectionResponse,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionAuditResponse]:
        del application, fact_visual_strategy, revision_context
        return _mock_result(
            _mock_creative_direction_audit(landscape, directions),
            NodeId.COHERENT_CREATIVE_GENERATION.value,
            CREATIVE_DIRECTION_AUDIT_BASE_PROMPT,
        )

    async def audit_creative_direction_diversity(
        self,
        *,
        landscape: CreativeDiversityLandscape,
        directions: CreativeDirectionResponse,
        proposed_direction_ids: Sequence[str] = (),
    ) -> AiCallResult[CreativeDirectionDiversityAuditResponse]:
        del landscape, proposed_direction_ids
        return _mock_result(
            CreativeDirectionDiversityAuditResponse(
                groups=[],
                requires_revision=False,
                revision_direction_ids=[],
                canonical_profiles=[
                    CreativeDirectionCanonicalProfile(
                        direction_id=direction.direction_id,
                        semantic_profile=direction.semantic_profile,
                    )
                    for direction in directions.directions
                ],
                summary="全批创意方向未发现实质视觉重叠",
            ),
            NodeId.COHERENT_CREATIVE_GENERATION.value,
            CREATIVE_DIRECTION_DIVERSITY_AUDIT_BASE_PROMPT,
        )

    async def plan_diversity_supplement_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        landscape: CreativeDiversityLandscape,
        existing_directions: CreativeDirectionResponse,
        requested_direction_count: int,
        execution_route_count: int,
        crowded_scene_families: Sequence[str],
        crowded_action_families: Sequence[str],
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionResponse]:
        del (
            application,
            fact_visual_strategy,
            shared_prompt,
            landscape,
            crowded_scene_families,
            crowded_action_families,
        )
        requested_ids = (revision_context or {}).get("requiredDirectionIds", [])
        rows = []
        for index in range(requested_direction_count):
            direction_id = requested_ids[index] if requested_ids else f"DIVERSITY_SUPPLEMENT_{index + 1}"
            base = existing_directions.directions[
                index % len(existing_directions.directions)
            ]
            rows.append(
                base.model_copy(
                    update={
                        "direction_id": direction_id,
                        "creative_direction": (
                            f"补充差异方向 {direction_id}：{base.creative_direction}"
                        ),
                        "semantic_profile": base.semantic_profile.model_copy(
                            update={
                                "scene_family": (f"SUPPLEMENT_SCENE_{index + 1}"),
                                "product_action_family": (
                                    f"SUPPLEMENT_ACTION_{index + 1}"
                                ),
                            }
                        ),
                        "execution_routes": [
                            CreativeExecutionRoute(
                                route_id=f"ROUTE_{route_index + 1}",
                                visual_event=(
                                    f"补充方向 {index + 1} 的主视觉事件"
                                    f"路线 {route_index + 1}"
                                ),
                                scene_relation=(
                                    f"补充场景关系 {index + 1}-{route_index + 1}"
                                ),
                                product_action=(
                                    f"补充产品动作 {index + 1}-{route_index + 1}"
                                ),
                                ending_state=(
                                    f"补充结束状态 {index + 1}-{route_index + 1}"
                                ),
                            )
                            for route_index in range(execution_route_count)
                        ],
                    }
                )
            )
        return _mock_result(
            CreativeDirectionResponse(directions=rows),
            NodeId.COHERENT_CREATIVE_GENERATION.value,
            CREATIVE_DIRECTION_SUPPLEMENT_BASE_PROMPT,
        )

    async def generate_creatives(
        self,
        shard: CreativeShardPlan,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        fact_visual_strategy: FactVisualStrategy | None = None,
        regeneration_context: Mapping[str, Any] | None = None,
        product_images: Sequence[PreparedProductImage] = (),
    ) -> AiCallResult[CreativeCandidateBatch]:
        del shared_prompt, regeneration_context
        items = [
            _mock_creative_candidate(task, application, fact_visual_strategy)
            for task in shard.tasks
        ]
        return _mock_result(
            CreativeCandidateBatch(items=items),
            "COHERENT_CREATIVE_GENERATION",
            CREATIVE_BASE_PROMPT,
        )

    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        target_durations: Mapping[str, int],
        application: InsightApplicationMap,
        assigned_context_fact_ids: Mapping[str, Sequence[str]] | None = None,
        fact_visual_strategy: FactVisualStrategy | None = None,
        direction_plan: CreativeDirectionPlan | None = None,
        infer_creative_structure: bool = False,
    ) -> AiCallResult[CreativeEvaluationBatch]:
        del target_durations
        context_by_slot = assigned_context_fact_ids or {}
        return _mock_result(
            CreativeEvaluationBatch(
                items=[
                    _mock_creative_evaluation(
                        item,
                        application,
                        direction_plan,
                        context_fact_ids=context_by_slot.get(item.slot_id, ()),
                        infer_creative_structure=infer_creative_structure,
                    )
                    for item in candidates
                ]
            ),
            "CREATIVE_EVALUATION_CLASSIFICATION",
            EVALUATION_BASE_PROMPT,
        )


class ArkResponsesProvider:
    async def plan_materials(
        self, application: InsightApplicationMap, *, task_ids: Sequence[str],
        fact_visual_strategy: FactVisualStrategy, shared_prompt: SharedPrompt,
        remaining_fact_ids: Sequence[str], existing_tasks: Sequence[MaterialBrief] = (),
        settings: Mapping[str, Any] | None = None,
        repair_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[MaterialPlanResponse]:
        aliases, originals = _fact_alias_maps(application)
        payload = {
            "taskIds": list(task_ids), "settings": dict(settings or {}),
            "facts": [{"factId": fact.fact_id, "field": fact.field.value, "value": fact.value}
                      for fact in application.usable],
            "visualPolicies": [row.model_dump(mode="json", by_alias=True)
                               for row in fact_visual_strategy.policies],
            "remainingFactIds": list(remaining_fact_ids),
            "existingTasks": [row.model_dump(mode="json", by_alias=True) for row in existing_tasks],
            "repairContext": dict(repair_context or {}),
            "sharedPrompt": shared_prompt.compiled_content,
        }
        schema = MaterialPlanResponse.model_json_schema(by_alias=True)
        schema["properties"]["tasks"].update(minItems=len(task_ids), maxItems=len(task_ids))
        schema["$defs"]["MaterialBrief"]["properties"]["taskId"]["enum"] = list(task_ids)
        call = await self._structured(
            json.dumps(_remap_fact_references(payload, aliases), ensure_ascii=False),
            MaterialPlanResponse, schema_name="effect_prompt_material_tasks",
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file="material_planning.system.prompt.txt", model=self._fragment_strategy_model,
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._fragment_strategy_timeout,
            instructions=load_prompt("material_planning.system.prompt.txt"), response_schema=schema,
        )
        return AiCallResult(value=MaterialPlanResponse(tasks=[
            row.model_copy(update={"fact_ids": [originals.get(key, key) for key in row.fact_ids]})
            for row in call.value.tasks
        ]), metadata=call.metadata)

    execution_mode = "ARK"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        strategy_model: str,
        candidate_model: str,
        visual_strategy_model: str | None = None,
        visual_strategy_image_detail: str = "high",
        fragment_strategy_model: str | None = None,
        blueprint_model: str | None = None,
        evaluation_model: str | None = None,
        strategy_max_output_tokens: int = 8192,
        candidate_max_output_tokens: int = 8192,
        fragment_strategy_max_output_tokens: int = 3072,
        evaluation_max_output_tokens: int = 6144,
        reasoning_effort: str = "minimal",
        strategy_timeout: float = 180.0,
        candidate_timeout: float = 120.0,
        fragment_strategy_timeout: float = 120.0,
        evaluation_timeout: float = 120.0,
        direction_review_timeout: float = 180.0,
        max_attempts: int = 1,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not strategy_model.strip() or not candidate_model.strip():
            raise ValueError("Ark prompt models cannot be empty")
        self._strategy_model = strategy_model.strip()
        self._candidate_model = candidate_model.strip()
        self._visual_strategy_model = (
            visual_strategy_model or candidate_model
        ).strip()
        if visual_strategy_image_detail not in {"low", "high"}:
            raise ValueError("Ark visual strategy image detail must be low or high")
        self._visual_strategy_image_detail = visual_strategy_image_detail
        self._fragment_strategy_model = (
            fragment_strategy_model or candidate_model
        ).strip()
        self._blueprint_model = (blueprint_model or strategy_model).strip()
        self._evaluation_model = (evaluation_model or candidate_model).strip()
        self._strategy_max_output_tokens = strategy_max_output_tokens
        self._candidate_max_output_tokens = candidate_max_output_tokens
        self._fragment_strategy_max_output_tokens = fragment_strategy_max_output_tokens
        self._evaluation_max_output_tokens = evaluation_max_output_tokens
        self._reasoning_effort = reasoning_effort
        self._strategy_timeout = strategy_timeout
        self._candidate_timeout = candidate_timeout
        self._fragment_strategy_timeout = fragment_strategy_timeout
        self._evaluation_timeout = evaluation_timeout
        self._direction_review_timeout = direction_review_timeout
        self._max_attempts = max(1, max_attempts)
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=candidate_timeout,
            transport=transport,
            headers={
                "authorization": f"Bearer {api_key}",
                "content-type": "application/json",
            },
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def compile_fact_visual_strategy(
        self,
        application: InsightApplicationMap,
        *,
        product_images: Sequence[PreparedProductImage] = (),
        target_fact_ids: Sequence[str] = (),
    ) -> AiCallResult[FactVisualStrategyResponse]:
        fact_aliases, fact_ids_by_alias = _fact_alias_maps(application)
        facts = []
        for fact in application.usable:
            payload = fact.model_dump(
                mode="json",
                by_alias=True,
                exclude={
                    "eligible_fragment_types",
                    "preferred_role",
                    "exclusion_reason",
                    "value_hash",
                },
            )
            payload["factId"] = fact_aliases[fact.fact_id]
            facts.append(payload)
        if not facts:
            raise ProviderError(
                "fact visual strategy requires confirmed insight facts",
                retryable=False,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        prompt = render_prompt(
            FACT_VISUAL_STRATEGY_TASK_PROMPT,
            facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
        )
        if target_fact_ids:
            prompt += "\n本次只为以下事实输出策略，每个恰好一次；其余事实仅供理解上下文与兼容关系：\n" + json.dumps(
                [fact_aliases[fact_id] for fact_id in target_fact_ids], ensure_ascii=False
            )
        input_content: list[dict[str, Any]] = [
            {"type": "input_text", "text": prompt}
        ]
        for index, image in enumerate(product_images, start=1):
            input_content.extend(
                [
                    {
                        "type": "input_text",
                        "text": f"商品参考图 {index}",
                    },
                    {
                        "type": "input_image",
                        "image_url": image.data_uri,
                        "detail": self._visual_strategy_image_detail,
                    },
                ]
            )
        call = await self._structured(
            prompt,
            FactVisualStrategyResponse,
            schema_name="effect_prompt_fact_visual_strategy",
            stage=NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value,
            prompt_file=FACT_VISUAL_STRATEGY_BASE_PROMPT,
            model=self._visual_strategy_model,
            max_output_tokens=min(
                self._strategy_max_output_tokens,
                max(4096, len(target_fact_ids or facts) * 320),
            ),
            request_timeout=self._strategy_timeout,
            instructions=load_prompt(FACT_VISUAL_STRATEGY_BASE_PROMPT),
            input_content=input_content,
        )
        return AiCallResult(
            value=FactVisualStrategyResponse(
                policies=[
                    policy.model_copy(
                        update={
                            "fact_id": fact_ids_by_alias.get(
                                policy.fact_id, policy.fact_id
                            ),
                            "compatible_fact_ids": [
                                fact_ids_by_alias.get(fact_id, fact_id)
                                for fact_id in policy.compatible_fact_ids
                            ],
                        }
                    )
                    for policy in call.value.policies
                ]
            ),
            metadata=call.metadata,
        )

    async def plan_creative_landscape(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        target_count: int,
        style_instruction: str,
        delivery_channel: str,
        revision_context: Mapping[str, Any] | None = None,
        revision_territory_ids: Sequence[str] = (),
    ) -> AiCallResult[CreativeDiversityLandscapeResponse]:
        fact_aliases, fact_ids_by_alias = _fact_alias_maps(application)
        facts = [
            {
                "factId": fact_aliases[fact.fact_id],
                "field": fact.field.value,
                "value": fact.value,
                "policy": fact.policy.value,
            }
            for fact in application.usable
        ]
        visual_policies = [
            {
                "factId": fact_aliases[policy.fact_id],
                "visualUsage": policy.visual_usage.value,
                "visualInstruction": policy.visual_instruction,
                "contextInstruction": policy.context_instruction,
                "compatibleFactIds": [
                    fact_aliases[fact_id]
                    for fact_id in policy.compatible_fact_ids
                    if fact_id in fact_aliases
                ],
                "forbiddenInferences": policy.forbidden_inferences,
            }
            for policy in fact_visual_strategy.policies
        ]
        business_fact_count = len(mandatory_business_facts(application))
        target_direction_count = creative_direction_target_count(
            target_count,
            business_fact_count,
        )
        territory_count_range = creative_territory_target_range(target_direction_count)
        prompt = render_prompt(
            CREATIVE_LANDSCAPE_TASK_PROMPT,
            target_direction_count=str(target_direction_count),
            territory_count_range=(
                f"{territory_count_range[0]}～{territory_count_range[1]}"
            ),
            required_fact_ids_json=json.dumps(
                [
                    fact_aliases[fact.fact_id]
                    for fact in mandatory_business_facts(application)
                ],
                ensure_ascii=False,
            ),
            facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
            fact_visual_strategy_json=json.dumps(
                visual_policies, ensure_ascii=False, sort_keys=True
            ),
            shared_prompt_json=json.dumps(
                shared_prompt.compiled_content, ensure_ascii=False
            ),
            visual_style_baseline_section=_visual_style_baseline_section(
                style_instruction
            ),
            delivery_channel_json=json.dumps(delivery_channel, ensure_ascii=False),
            output_scope_instruction=(
                "本次是局部修订。只输出以下 territoryId，且每个恰好一次："
                + json.dumps(list(revision_territory_ids), ensure_ascii=False)
                + "。不要输出任何未被点名的空间；系统会按稳定 ID 与已通过空间合并。"
                if revision_territory_ids
                else "本次是首次规划，输出完整创意版图。"
            ),
            revision_context_json=json.dumps(
                _remap_fact_references(revision_context or {}, fact_aliases),
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            CreativeDiversityLandscapeResponse,
            schema_name="effect_prompt_creative_landscape",
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_LANDSCAPE_BASE_PROMPT,
            model=self._fragment_strategy_model,
            # Ark counts hidden reasoning and the JSON answer against the same
            # limit. The landscape is compact, but a rich information card can
            # still exhaust 4096 tokens before the structured answer closes.
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._strategy_timeout,
            instructions=load_prompt(CREATIVE_LANDSCAPE_BASE_PROMPT),
        )
        return AiCallResult(
            value=CreativeDiversityLandscapeResponse(
                territories=[
                    territory.model_copy(
                        update={
                            "compatible_fact_ids": [
                                fact_ids_by_alias.get(fact_id, fact_id)
                                for fact_id in territory.compatible_fact_ids
                            ],
                            "fact_compatibilities": [
                                compatibility.model_copy(
                                    update={
                                        "fact_id": fact_ids_by_alias.get(
                                            compatibility.fact_id,
                                            compatibility.fact_id,
                                        )
                                    }
                                )
                                for compatibility in territory.fact_compatibilities
                            ],
                            "required_fact_ids": [
                                fact_ids_by_alias.get(fact_id, fact_id)
                                for fact_id in territory.required_fact_ids
                            ],
                        }
                    )
                    for territory in call.value.territories
                ]
            ),
            metadata=call.metadata,
        )

    async def assign_creative_landscape_facts(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscapeResponse,
        target_count: int,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeFactTerritoryAssignmentResponse]:
        fact_aliases, fact_ids_by_alias = _fact_alias_maps(application)
        business_facts = mandatory_business_facts(application)
        if not business_facts:
            return AiCallResult(
                value=CreativeFactTerritoryAssignmentResponse(assignments=[]),
                metadata=AiCallMetadata(
                    stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
                    template_hash=load_prompt_hash(CREATIVE_FACT_TERRITORY_ASSIGNMENT_BASE_PROMPT),
                    input_tokens=0, output_tokens=0, total_tokens=0,
                    latency_ms=0, attempts=0,
                ),
            )
        policies_by_id = fact_visual_strategy.by_id
        facts = [
            {
                "factId": fact_aliases[fact.fact_id],
                "field": fact.field.value,
                "value": fact.value,
            }
            for fact in business_facts
        ]
        visual_policies = [
            {
                "factId": fact_aliases[fact.fact_id],
                "visualUsage": policies_by_id[fact.fact_id].visual_usage.value,
                "visualInstruction": policies_by_id[fact.fact_id].visual_instruction,
                "contextInstruction": policies_by_id[fact.fact_id].context_instruction,
                "compatibleFactIds": [
                    fact_aliases[fact_id]
                    for fact_id in policies_by_id[fact.fact_id].compatible_fact_ids
                ],
                "forbiddenInferences": policies_by_id[
                    fact.fact_id
                ].forbidden_inferences,
            }
            for fact in business_facts
        ]
        territories = [
            {
                "territoryId": territory.territory_id,
                "label": territory.label,
                "sceneBoundary": territory.scene_boundary,
                "actions": [
                    action.model_dump(mode="json", by_alias=True)
                    for action in territory.actions
                ],
                "differentiationGoal": territory.differentiation_goal,
                "preliminaryFactIds": [
                    fact_aliases[fact_id]
                    for fact_id in territory.compatible_fact_ids
                    if fact_id in fact_aliases
                ],
            }
            for territory in landscape.territories
        ]
        prompt = render_prompt(
            CREATIVE_FACT_TERRITORY_ASSIGNMENT_TASK_PROMPT,
            target_direction_count=str(
                creative_direction_target_count(
                    target_count,
                    len(business_facts),
                )
            ),
            required_facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
            supporting_facts_json=json.dumps(
                [
                    {
                        "factId": fact_aliases[fact.fact_id],
                        "field": fact.field.value,
                        "value": fact.value,
                    }
                    for fact in application.usable
                    if fact not in business_facts
                ],
                ensure_ascii=False,
                sort_keys=True,
            ),
            fact_visual_strategy_json=json.dumps(
                visual_policies, ensure_ascii=False, sort_keys=True
            ),
            territories_json=json.dumps(
                territories, ensure_ascii=False, sort_keys=True
            ),
            revision_context_json=json.dumps(
                _remap_fact_references(revision_context or {}, fact_aliases),
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            CreativeFactTerritoryAssignmentResponse,
            schema_name="effect_prompt_creative_fact_territory_assignment",
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_FACT_TERRITORY_ASSIGNMENT_BASE_PROMPT,
            model=self._fragment_strategy_model,
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._strategy_timeout,
            instructions=load_prompt(CREATIVE_FACT_TERRITORY_ASSIGNMENT_BASE_PROMPT),
        )
        return AiCallResult(
            value=CreativeFactTerritoryAssignmentResponse(
                assignments=[
                    item.model_copy(
                        update={
                            "fact_id": fact_ids_by_alias.get(item.fact_id, item.fact_id)
                        }
                    )
                    for item in call.value.assignments
                ]
            ),
            metadata=call.metadata,
        )

    async def audit_creative_territory(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        territory: CreativeTerritory,
    ) -> AiCallResult[CreativeTerritoryAuditResponse]:
        fact_aliases, fact_ids_by_alias = _fact_alias_maps(application)
        facts = [
            {
                "factId": fact_aliases[fact.fact_id],
                "field": fact.field.value,
                "value": fact.value,
                "policy": fact.policy.value,
            }
            for fact in application.usable
        ]
        visual_policies = [
            {
                "factId": fact_aliases[policy.fact_id],
                "visualUsage": policy.visual_usage.value,
                "visualInstruction": policy.visual_instruction,
                "contextInstruction": policy.context_instruction,
                "compatibleFactIds": [
                    fact_aliases[fact_id] for fact_id in policy.compatible_fact_ids
                ],
                "forbiddenInferences": policy.forbidden_inferences,
            }
            for policy in fact_visual_strategy.policies
        ]
        prompt = render_prompt(
            CREATIVE_LANDSCAPE_AUDIT_TASK_PROMPT,
            facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
            fact_visual_strategy_json=json.dumps(
                visual_policies,
                ensure_ascii=False,
                sort_keys=True,
            ),
            creative_territory_json=json.dumps(
                _remap_fact_references(
                    territory.model_dump(mode="json", by_alias=True),
                    fact_aliases,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            CreativeTerritoryAuditResponse,
            schema_name="effect_prompt_creative_territory_audit",
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_LANDSCAPE_AUDIT_BASE_PROMPT,
            model=self._evaluation_model,
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._evaluation_timeout,
            instructions=load_prompt(CREATIVE_LANDSCAPE_AUDIT_BASE_PROMPT),
        )
        return AiCallResult(
            value=CreativeTerritoryAuditResponse(
                territory_id=call.value.territory_id,
                fact_issues=[
                    issue.model_copy(
                        update={
                            "fact_id": fact_ids_by_alias.get(
                                issue.fact_id,
                                issue.fact_id,
                            )
                        }
                    )
                    for issue in call.value.fact_issues
                ],
                summary=call.value.summary,
            ),
            metadata=call.metadata,
        )

    async def audit_creative_landscape(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscape,
    ) -> AiCallResult[CreativeLandscapeAuditResponse]:
        fact_aliases, fact_ids_by_alias = _fact_alias_maps(application)
        scoped_fact_ids = {
            fact_id
            for territory in landscape.territories
            for fact_id in territory.compatible_fact_ids
        }
        facts = [
            {
                "factId": fact_aliases[fact.fact_id],
                "field": fact.field.value,
                "value": fact.value,
                "policy": fact.policy.value,
            }
            for fact in application.usable
            if fact.fact_id in scoped_fact_ids
        ]
        visual_policies = [
            {
                "factId": fact_aliases[policy.fact_id],
                "visualUsage": policy.visual_usage.value,
                "visualInstruction": policy.visual_instruction,
                "contextInstruction": policy.context_instruction,
                "compatibleFactIds": [
                    fact_aliases[fact_id]
                    for fact_id in policy.compatible_fact_ids
                    if fact_id in fact_aliases
                ],
                "forbiddenInferences": policy.forbidden_inferences,
            }
            for policy in fact_visual_strategy.policies
            if policy.fact_id in scoped_fact_ids
        ]
        prompt = render_prompt(
            CREATIVE_LANDSCAPE_BATCH_AUDIT_TASK_PROMPT,
            facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
            fact_visual_strategy_json=json.dumps(
                visual_policies,
                ensure_ascii=False,
                sort_keys=True,
            ),
            creative_landscape_json=json.dumps(
                _remap_fact_references(
                    [
                        territory.model_dump(mode="json", by_alias=True)
                        for territory in landscape.territories
                    ],
                    fact_aliases,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            CreativeLandscapeAuditResponse,
            schema_name="effect_prompt_creative_landscape_batch_audit",
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_LANDSCAPE_BATCH_AUDIT_BASE_PROMPT,
            model=self._evaluation_model,
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._evaluation_timeout,
            instructions=load_prompt(CREATIVE_LANDSCAPE_BATCH_AUDIT_BASE_PROMPT),
        )
        return AiCallResult(
            value=CreativeLandscapeAuditResponse(
                reviewed_territory_ids=call.value.reviewed_territory_ids,
                fact_issues=[
                    issue.model_copy(
                        update={
                            "fact_id": fact_ids_by_alias.get(
                                issue.fact_id,
                                issue.fact_id,
                            )
                        }
                    )
                    for issue in call.value.fact_issues
                ],
                requires_revision=call.value.requires_revision,
                revision_territory_ids=call.value.revision_territory_ids,
                summary=call.value.summary,
            ),
            metadata=call.metadata,
        )

    async def plan_creative_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        landscape: CreativeDiversityLandscape,
        target_count: int,
        style_instruction: str,
        delivery_channel: str,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionResponse]:
        fact_aliases, fact_ids_by_alias = _fact_alias_maps(application)
        scoped_fact_ids = {
            fact_id
            for territory in landscape.territories
            for fact_id in territory.compatible_fact_ids
        }
        facts = [
            {
                "factId": fact_aliases[fact.fact_id],
                "field": fact.field.value,
                "value": fact.value,
                "policy": fact.policy.value,
            }
            for fact in application.usable
            if fact.fact_id in scoped_fact_ids
        ]
        visual_policies = [
            {
                "factId": fact_aliases[policy.fact_id],
                "visualUsage": policy.visual_usage.value,
                "visualInstruction": policy.visual_instruction,
                "contextInstruction": policy.context_instruction,
                "forbiddenInferences": policy.forbidden_inferences,
            }
            for policy in fact_visual_strategy.policies
            if policy.fact_id in scoped_fact_ids
        ]
        business_fact_count = len(
            {
                fact.fact_id
                for fact in mandatory_business_facts(application)
                if fact.fact_id in scoped_fact_ids
            }
        )
        global_business_fact_count = len(mandatory_business_facts(application))
        global_direction_count = creative_direction_target_count(
            target_count,
            global_business_fact_count,
        )
        execution_route_count = creative_execution_route_target_count(
            (target_count * 14 + 9) // 10,
            global_direction_count,
        )
        # The validated landscape owns the exact slot allocation. Its slot
        # total supports territory-scoped planning without changing the final
        # number of directions in the merged batch.
        target_direction_count = sum(
            territory.target_slots for territory in landscape.territories
        )
        revision_direction_ids = (
            revision_context.get("revisionDirectionIds", [])
            if revision_context is not None
            else []
        )
        output_direction_count = target_direction_count
        density_business_fact_count = business_fact_count
        if (
            isinstance(revision_direction_ids, list)
            and revision_direction_ids
            and all(isinstance(item, str) for item in revision_direction_ids)
        ):
            output_direction_count = len(revision_direction_ids)
            revision_required_fact_ids = (
                revision_context.get("revisionRequiredBusinessFactIds", [])
                if revision_context is not None
                else []
            )
            if isinstance(revision_required_fact_ids, list):
                density_business_fact_count = len(
                    {
                        fact_id
                        for fact_id in revision_required_fact_ids
                        if isinstance(fact_id, str)
                    }
                )
        required_direction_slots = (
            revision_context.get("requiredDirectionSlots", [])
            if revision_context is not None
            else []
        )
        required_business_fact_ids = (
            revision_context.get("requiredBusinessFactIds", [])
            if revision_context is not None
            else []
        )
        if (
            not revision_direction_ids
            and isinstance(required_direction_slots, list)
            and required_direction_slots
            and all(isinstance(item, dict) for item in required_direction_slots)
        ):
            output_direction_count = len(required_direction_slots)
            if isinstance(required_business_fact_ids, list):
                density_business_fact_count = len(
                    {
                        fact_id
                        for fact_id in required_business_fact_ids
                        if isinstance(fact_id, str)
                    }
                )
        coverage_fact_ids = (
            revision_required_fact_ids
            if revision_direction_ids
            else required_business_fact_ids
        )
        coverage_fact_count = (
            len({item for item in coverage_fact_ids if isinstance(item, str)})
            if isinstance(coverage_fact_ids, list)
            else 0
        )
        fact_density_instruction = creative_direction_fact_density_instruction(
            density_business_fact_count, output_direction_count,
        )
        if coverage_fact_count:
            fact_density_instruction += (
                f"本分片有 {coverage_fact_count} 条优先覆盖事实，由你选择自然的承载方向。"
                "不得为了逐项覆盖而虚构事实关系、塞入多项任务或复制相同创意。"
            )
        if (
            isinstance(revision_direction_ids, list)
            and revision_direction_ids
            and all(isinstance(item, str) for item in revision_direction_ids)
        ):
            if (
                isinstance(required_direction_slots, list)
                and required_direction_slots
                and all(isinstance(item, dict) for item in required_direction_slots)
            ):
                direction_output_instruction = (
                    "这是局部修订。directions 数组只输出以下指定槽位，"
                    "directionId、territoryId 与 primaryActionId 都必须原样保留，"
                    "不得交换、重复或改用其他动作："
                    + json.dumps(required_direction_slots, ensure_ascii=False)
                    + "。只修订创意关系、事实组合和六维表达；不要输出未点名方向，"
                    "系统会按稳定 ID 与上一版机械合并。"
                )
            else:
                direction_output_instruction = (
                    "这是局部修订。directions 数组只输出 revisionDirectionIds 中的 "
                    f"{len(revision_direction_ids)} 个方向，directionId 必须逐一对应："
                    + json.dumps(revision_direction_ids, ensure_ascii=False)
                    + "。不要输出未点名方向，系统会按稳定 ID 与上一版机械合并。"
                    "每个方向必须保留 revision_context 中"
                    " preservedBusinessFactIdsByDirection 为该 directionId 点名的全部"
                    "合法业务事实；这些事实不能因补足密度或覆盖其他事实而被替换。"
                )
        elif (
            isinstance(required_direction_slots, list)
            and required_direction_slots
            and all(isinstance(item, dict) for item in required_direction_slots)
        ):
            direction_output_instruction = (
                "这是首次批量规划。directions 数组必须逐项对应以下方向槽位，"
                "directionId、territoryId 与 primaryActionId 必须原样使用，"
                "不得交换、重复或自选："
                + json.dumps(required_direction_slots, ensure_ascii=False)
                + "。本分片必须共同覆盖 requiredBusinessFactIds："
                + json.dumps(
                    _remap_fact_references(required_business_fact_ids, fact_aliases),
                    ensure_ascii=False,
                )
                + "；你需要根据每个主动作的自然关系，自主决定事实进入哪个方向，"
                "不得遗漏，也不得为凑覆盖建立牵强关系。每个槽位的创意关系、"
                "事实组合和六维表达仍由你自主规划。"
            )
        else:
            direction_output_instruction = (
                f"这是首次规划。directions 数组必须恰好输出 {target_direction_count} "
                "个方向。"
            )
        prompt = render_prompt(
            CREATIVE_DIRECTION_TASK_PROMPT,
            target_count=str(target_count),
            target_direction_count=str(output_direction_count),
            execution_route_count=str(execution_route_count),
            direction_output_instruction=direction_output_instruction,
            fact_density_instruction=fact_density_instruction,
            facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
            fact_visual_strategy_json=json.dumps(
                visual_policies,
                ensure_ascii=False,
                sort_keys=True,
            ),
            shared_prompt_json=json.dumps(
                shared_prompt.compiled_content,
                ensure_ascii=False,
            ),
            visual_style_baseline_section=_visual_style_baseline_section(
                style_instruction
            ),
            delivery_channel_json=json.dumps(delivery_channel, ensure_ascii=False),
            creative_landscape_json=json.dumps(
                _remap_fact_references(
                    [
                        item.model_dump(mode="json", by_alias=True)
                        for item in landscape.territories
                    ],
                    fact_aliases,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
            revision_context_json=json.dumps(
                _remap_fact_references(revision_context or {}, fact_aliases),
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            CreativeDirectionResponse,
            schema_name="effect_prompt_creative_direction_plan",
            response_schema=_direction_event_capacity_schema(),
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_DIRECTION_BASE_PROMPT,
            model=self._fragment_strategy_model,
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._strategy_timeout,
            instructions=load_prompt(CREATIVE_DIRECTION_BASE_PROMPT),
        )
        _validate_direction_event_capacity(call.value)
        return AiCallResult(
            value=CreativeDirectionResponse(
                directions=[
                    direction.model_copy(
                        update={
                            "fact_applications": [
                                application.model_copy(
                                    update={
                                        "fact_id": fact_ids_by_alias.get(
                                            application.fact_id,
                                            application.fact_id,
                                        )
                                    }
                                )
                                for application in direction.fact_applications
                            ]
                        }
                    )
                    for direction in call.value.directions
                ]
            ),
            metadata=call.metadata,
        )

    async def audit_creative_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscape,
        directions: CreativeDirectionResponse,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionAuditResponse]:
        fact_aliases, fact_ids_by_alias = _fact_alias_maps(application)
        scoped_territory_ids = {
            item.territory_id for item in directions.directions
        }
        scoped_territories = [
            item
            for item in landscape.territories
            if item.territory_id in scoped_territory_ids
        ]
        scoped_fact_ids = {
            fact_id
            for direction in directions.directions
            for fact_id in direction.fact_ids
        }
        scoped_fact_ids.update(
            fact_id
            for territory in scoped_territories
            for fact_id in territory.compatible_fact_ids
        )
        facts = [
            {
                "factId": fact_aliases[fact.fact_id],
                "field": fact.field.value,
                "value": fact.value,
                "policy": fact.policy.value,
            }
            for fact in application.usable
            if fact.fact_id in scoped_fact_ids
        ]
        visual_policies = [
            {
                "factId": fact_aliases[policy.fact_id],
                "visualUsage": policy.visual_usage.value,
                "visualInstruction": policy.visual_instruction,
                "contextInstruction": policy.context_instruction,
                "compatibleFactIds": [
                    fact_aliases[fact_id] for fact_id in policy.compatible_fact_ids
                ],
                "forbiddenInferences": policy.forbidden_inferences,
            }
            for policy in fact_visual_strategy.policies
            if policy.fact_id in scoped_fact_ids
        ]
        prompt = render_prompt(
            CREATIVE_DIRECTION_AUDIT_TASK_PROMPT,
            facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
            fact_visual_strategy_json=json.dumps(
                visual_policies,
                ensure_ascii=False,
                sort_keys=True,
            ),
            creative_landscape_json=json.dumps(
                _remap_fact_references(
                    [
                        item.model_dump(mode="json", by_alias=True)
                        for item in scoped_territories
                    ],
                    fact_aliases,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
            creative_directions_json=json.dumps(
                _remap_fact_references(
                    [
                        item.model_dump(mode="json", by_alias=True)
                        for item in directions.directions
                    ],
                    fact_aliases,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
            revision_context_json=json.dumps(
                revision_context or {},
                ensure_ascii=False,
                sort_keys=True,
            ),
        )

        call = await self._structured(
            prompt,
            CreativeDirectionAuditResponse,
            schema_name="effect_prompt_creative_direction_audit",
            item_count=len(directions.directions),
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_DIRECTION_AUDIT_BASE_PROMPT,
            model=self._evaluation_model,
            # This is a batch strategy audit rather than per-item scoring. Use
            # the strategy budget so a territory-scoped structured response
            # cannot be truncated
            # by the smaller candidate-evaluation budget.
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._direction_review_timeout,
            instructions=load_prompt(CREATIVE_DIRECTION_AUDIT_BASE_PROMPT),
        )
        return AiCallResult(
            value=CreativeDirectionAuditResponse(
                items=[
                    item.model_copy(
                        update={
                            "fact_reviews": (
                                [
                                    review.model_copy(
                                        update={
                                            "fact_id": fact_ids_by_alias.get(
                                                review.fact_id,
                                                review.fact_id,
                                            )
                                        }
                                    )
                                    for review in item.fact_reviews
                                ]
                                if item.fact_reviews is not None
                                else None
                            )
                        }
                    )
                    for item in call.value.items
                ],
                requires_revision=call.value.requires_revision,
                revision_direction_ids=call.value.revision_direction_ids,
                summary=call.value.summary,
            ),
            metadata=call.metadata,
        )

    async def audit_creative_direction_diversity(
        self,
        *,
        landscape: CreativeDiversityLandscape,
        directions: CreativeDirectionResponse,
        proposed_direction_ids: Sequence[str] = (),
    ) -> AiCallResult[CreativeDirectionDiversityAuditResponse]:
        prompt = render_prompt(
            CREATIVE_DIRECTION_DIVERSITY_AUDIT_TASK_PROMPT,
            creative_landscape_json=json.dumps(
                [
                    {
                        "territoryId": territory.territory_id,
                        "label": territory.label,
                        "sceneBoundary": territory.scene_boundary,
                        "actions": [
                            action.model_dump(mode="json", by_alias=True)
                            for action in territory.actions
                        ],
                    }
                    for territory in landscape.territories
                ],
                ensure_ascii=False,
                sort_keys=True,
            ),
            creative_directions_json=json.dumps(
                [
                    {
                        "directionId": direction.direction_id,
                        "territoryId": direction.territory_id,
                        "primaryActionId": direction.primary_action_id,
                        "creativeDirection": direction.creative_direction,
                        "priorityDimensions": [
                            item.value for item in direction.priority_dimensions
                        ],
                        "semanticProfile": direction.semantic_profile.model_dump(
                            mode="json", by_alias=True
                        ),
                        "executionRoutes": [
                            route_summary(route)
                            for route in direction.execution_routes
                        ],
                    }
                    for direction in directions.directions
                ],
                ensure_ascii=False,
                sort_keys=True,
            ),
            proposed_direction_ids_json=json.dumps(
                list(proposed_direction_ids), ensure_ascii=False
            ),
        )
        return await self._structured(
            prompt,
            CreativeDirectionDiversityAuditResponse,
            schema_name="effect_prompt_creative_direction_diversity_audit",
            item_count=len(directions.directions),
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_DIRECTION_DIVERSITY_AUDIT_BASE_PROMPT,
            model=self._evaluation_model,
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._direction_review_timeout,
            instructions=load_prompt(CREATIVE_DIRECTION_DIVERSITY_AUDIT_BASE_PROMPT),
        )

    async def plan_diversity_supplement_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        landscape: CreativeDiversityLandscape,
        existing_directions: CreativeDirectionResponse,
        requested_direction_count: int,
        execution_route_count: int,
        crowded_scene_families: Sequence[str],
        crowded_action_families: Sequence[str],
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionResponse]:
        fact_aliases, fact_ids_by_alias = _fact_alias_maps(application)
        compact_revision = dict(revision_context or {})
        audit = compact_revision.get("diversityAudit")
        if isinstance(audit, dict):
            compact_revision["diversityAudit"] = {
                key: audit[key] for key in ("groups", "revisionDirectionIds", "summary")
                if key in audit
            }
        response_schema = CreativeDirectionResponse.model_json_schema(by_alias=True)
        response_schema["properties"]["directions"].update(
            minItems=requested_direction_count, maxItems=requested_direction_count,
        )
        direction_schema = response_schema["$defs"]["CreativeDirection"]["properties"]
        required_ids = compact_revision.get("requiredDirectionIds", [])
        if required_ids:
            direction_schema["directionId"]["enum"] = required_ids
        direction_schema["territoryId"]["enum"] = list(landscape.by_id)
        direction_schema["executionRoutes"].update(minItems=1, maxItems=5)
        prompt = render_prompt(
            CREATIVE_DIRECTION_SUPPLEMENT_TASK_PROMPT,
            requested_direction_count=str(requested_direction_count),
            execution_route_count=str(execution_route_count),
            facts_json=json.dumps(
                [
                    {
                        "factId": fact_aliases[fact.fact_id],
                        "field": fact.field.value,
                        "value": fact.value,
                        "policy": fact.policy.value,
                    }
                    for fact in application.usable
                ],
                ensure_ascii=False,
                sort_keys=True,
            ),
            fact_visual_strategy_json=json.dumps(
                _remap_fact_references(
                    [
                        policy.model_dump(mode="json", by_alias=True)
                        for policy in fact_visual_strategy.policies
                    ],
                    fact_aliases,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
            shared_prompt_json=json.dumps(
                shared_prompt.compiled_content, ensure_ascii=False
            ),
            creative_landscape_json=json.dumps(
                _remap_fact_references(
                    [
                        territory.model_dump(mode="json", by_alias=True)
                        for territory in landscape.territories
                    ],
                    fact_aliases,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
            allowed_combinations_json=json.dumps(
                _remap_fact_references(
                    [
                        {
                            "territoryId": territory.territory_id,
                            "compatibleFactIds": territory.compatible_fact_ids,
                            "primaryActionIds": [
                                action.action_id for action in territory.actions
                            ],
                        }
                        for territory in landscape.territories
                    ],
                    fact_aliases,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
            existing_directions_json=json.dumps(
                _remap_fact_references(
                    [
                        direction_summary(direction)
                        for direction in existing_directions.directions
                    ],
                    fact_aliases,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
            crowded_scene_families_json=json.dumps(
                list(crowded_scene_families), ensure_ascii=False
            ),
            crowded_action_families_json=json.dumps(
                list(crowded_action_families), ensure_ascii=False
            ),
            revision_context_json=json.dumps(
                _remap_fact_references(compact_revision, fact_aliases),
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            CreativeDirectionResponse,
            schema_name="effect_prompt_creative_direction_supplement",
            response_schema=response_schema,
            item_count=requested_direction_count,
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_DIRECTION_SUPPLEMENT_BASE_PROMPT,
            model=self._fragment_strategy_model,
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._strategy_timeout,
            instructions=load_prompt(CREATIVE_DIRECTION_SUPPLEMENT_BASE_PROMPT),
        )
        return AiCallResult(
            value=CreativeDirectionResponse(
                directions=[
                    direction.model_copy(
                        update={
                            "fact_applications": [
                                fact_application.model_copy(
                                    update={
                                        "fact_id": fact_ids_by_alias.get(
                                            fact_application.fact_id,
                                            fact_application.fact_id,
                                        )
                                    }
                                )
                                for fact_application in direction.fact_applications
                            ]
                        }
                    )
                    for direction in call.value.directions
                ]
            ),
            metadata=call.metadata,
        )

    async def generate_creatives(
        self,
        shard: CreativeShardPlan,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        fact_visual_strategy: FactVisualStrategy | None = None,
        regeneration_context: Mapping[str, Any] | None = None,
        product_images: Sequence[PreparedProductImage] = (),
    ) -> AiCallResult[CreativeCandidateBatch]:
        assignments = {
            task.slot_id: _creative_fact_assignment(task, application)
            for task in shard.tasks
        }
        fact_aliases_by_slot = {
            task.slot_id: _creative_fact_aliases(assignments[task.slot_id])
            for task in shard.tasks
        }
        task_briefs = [
            _creative_task_brief(
                task,
                assignment=assignments[task.slot_id],
                application=application,
                fact_visual_strategy=fact_visual_strategy,
                fact_aliases=fact_aliases_by_slot[task.slot_id],
            )
            for task in shard.tasks
        ]
        creative_task_prompt = (
            "material_creative.user.prompt.txt"
            if all(task.material_brief is not None for task in shard.tasks)
            else CREATIVE_TASK_PROMPT
        )
        creative_base_prompt = CREATIVE_BASE_PROMPT
        prompt = render_prompt(
            creative_task_prompt,
            task_briefs_json=json.dumps(
                task_briefs,
                ensure_ascii=False,
                sort_keys=True,
            ),
            shared_prompt_content_json=json.dumps(
                shared_prompt.compiled_content,
                ensure_ascii=False,
            ),
            avoid_semantic_json=json.dumps(
                shard.avoid_semantic_signatures, ensure_ascii=False
            ),
            avoid_visual_json=json.dumps(
                shard.avoid_visual_signatures, ensure_ascii=False
            ),
            rejection_reasons_json=json.dumps(
                shard.rejection_reasons, ensure_ascii=False
            ),
            regeneration_context_json=json.dumps(
                regeneration_context or {}, ensure_ascii=False, sort_keys=True
            ),
        )
        call = await self._structured(
            prompt,
            CreativeDraftEnvelope,
            schema_name="effect_prompt_coherent_creative_batch",
            stage="COHERENT_CREATIVE_GENERATION",
            prompt_file=creative_base_prompt,
            model=self._candidate_model,
            max_output_tokens=min(
                self._candidate_max_output_tokens,
                max(4096, _creative_output_token_budget(shard.tasks)),
            ),
            request_timeout=self._candidate_timeout,
            instructions=load_prompt(creative_base_prompt),
            response_schema=_creative_shot_response_schema(shard.tasks),
            input_content=[{"type": "input_text", "text": prompt}, *[
                {"type": "input_image", "image_url": image.data_uri,
                 "detail": self._visual_strategy_image_detail}
                for image in product_images
            ]],
        )
        task_by_slot = {item.slot_id: item for item in shard.tasks}
        # Keep the provider's strict response schema; validate each returned row
        # independently so a broken sibling cannot destroy a valid draft.
        identities = Counter(row.get("slotId") for row in call.value.items
                             if isinstance(row, dict) and isinstance(row.get("slotId"), str))
        normalized: list[CreativeCandidate] = []
        rejections: Counter[str] = Counter()
        for row in call.value.items:
            try:
                item = CreativeCandidateDraft.model_validate(row)
            except ValidationError as exc:
                for error in exc.errors(include_input=False, include_url=False):
                    rejections[f"SCHEMA_{error['type']}"] += 1
                continue
            if item.slot_id not in task_by_slot or identities[item.slot_id] != 1:
                rejections["UNKNOWN_OR_DUPLICATE_SLOT"] += 1
                continue
            task = task_by_slot[item.slot_id]
            assignment = assignments[item.slot_id]
            aliases = fact_aliases_by_slot[item.slot_id]
            fact_ids_by_alias = {alias: fact_id for fact_id, alias in aliases.items()}
            fact_ids = list(
                dict.fromkeys(
                    fact_ids_by_alias.get(fact_id, fact_id)
                    for fact_id in item.declared_fact_ids
                )
            )
            unassigned = [
                fact_id for fact_id in fact_ids if fact_id not in assignment.fact_ids
            ]
            if unassigned or set(fact_ids) != set(assignment.fact_ids):
                rejections["ASSIGNED_FACT_IDS_MISMATCH"] += 1
                continue
            try:
                content = compile_material_shot_plan(
                    item.shot_plan,
                    target_duration_seconds=task.target_duration_seconds,
                )
            except ShotPlanCompilationError:
                rejections["SHOT_PLAN_STRUCTURE_INVALID"] += 1
                continue
            normalized.append(
                CreativeCandidate(
                    slot_id=item.slot_id,
                    ordinal=task.ordinal,
                    round=task.round,
                    creative_core=item.creative_core,
                    declared_fact_ids=list(dict.fromkeys(fact_ids)),
                    dimensions=item.dimensions,
                    content=content,
                    shot_plan=item.shot_plan,
                )
            )
        missing_count = len(task_by_slot) - len(normalized)
        if missing_count:
            LOGGER.warning("creative candidate structure recovery needed accepted=%s missing=%s reasons=%s",
                           len(normalized), missing_count, dict(rejections))
        if not normalized:
            raise ProviderError(
                "AI coherent creative response contained no valid candidate",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
                attempts=call.metadata.attempts,
                elapsed_ms=call.metadata.latency_ms,
            )
        return AiCallResult(
            value=CreativeCandidateBatch(items=normalized),
            metadata=call.metadata,
        )

    async def refine_creative_execution(
        self, candidates: list[CreativeCandidate], *, shard: CreativeShardPlan,
        application: InsightApplicationMap, shared_prompt: SharedPrompt,
        fact_visual_strategy: FactVisualStrategy | None = None,
        product_images: Sequence[PreparedProductImage] = (),
    ) -> AiCallResult[CreativeCandidateBatch]:
        tasks = {task.slot_id: task for task in shard.tasks}
        originals = {item.slot_id: item for item in candidates}
        briefs = []
        for candidate in candidates:
            task = tasks[candidate.slot_id]
            assignment = _creative_fact_assignment(task, application)
            aliases = _creative_fact_aliases(assignment)
            draft = candidate.model_dump(mode="json", by_alias=True,
                                         exclude={"content", "generated_at"})
            draft["declaredFactIds"] = [aliases[key] for key in candidate.declared_fact_ids]
            briefs.append({
                "task": _execution_fact_brief(
                    task, assignment=assignment, application=application,
                    fact_visual_strategy=fact_visual_strategy, fact_aliases=aliases),
                "draft": draft,
                "editablePaths": editable_execution_paths(candidate),
            })
        prompt = json.dumps({"items": briefs, "sharedPrompt": shared_prompt.compiled_content},
                            ensure_ascii=False)
        call = await self._structured(
            prompt,
            ExecutionEditBatch,
            schema_name="effect_prompt_creative_execution",
            stage="COHERENT_CREATIVE_GENERATION",
            prompt_file=CREATIVE_EXECUTION_PROMPT,
            model=self._candidate_model,
            max_output_tokens=min(self._candidate_max_output_tokens,
                                  max(4096, _creative_output_token_budget([tasks[key] for key in originals]))),
            request_timeout=self._candidate_timeout,
            instructions=load_prompt(CREATIVE_EXECUTION_PROMPT),
            response_schema=execution_edit_schema(candidates),
            input_content=[{"type": "input_text", "text": prompt}, *[
                {"type": "input_image", "image_url": image.data_uri,
                 "detail": self._visual_strategy_image_detail}
                for image in product_images
            ]],
        )
        actual = [item.slot_id for item in call.value.items]
        if len(actual) != len(set(actual)) or set(actual) != set(originals):
            raise ProviderError("execution refinement changed candidate identity/count",
                                error_type=ProviderErrorType.RESPONSE_INVALID, retryable=False)
        decisions = {item.slot_id: item for item in call.value.items}
        try:
            revised = [apply_execution_edits(
                original, decisions[original.slot_id],
                duration_seconds=tasks[original.slot_id].target_duration_seconds,
            ) for original in candidates]
        except ValueError as exc:
            raise ProviderError("invalid execution edit structure",
                                error_type=ProviderErrorType.RESPONSE_INVALID, retryable=False) from exc
        return AiCallResult(value=CreativeCandidateBatch(items=revised), metadata=call.metadata)

    async def repair_creative_execution(
        self, candidate: CreativeCandidate, *, task: CreativeTask,
        findings: Sequence[ExecutionFinding], application: InsightApplicationMap,
        shared_prompt: SharedPrompt, fact_visual_strategy: FactVisualStrategy,
    ) -> AiCallResult[ExecutionRepairDraft]:
        assignment = _creative_fact_assignment(task, application)
        prompt = json.dumps({
            "task": _creative_task_brief(
                task, assignment=assignment, application=application,
                fact_visual_strategy=fact_visual_strategy,
            ),
            "original": candidate.model_dump(mode="json", by_alias=True, exclude={"content", "generated_at"}),
            "findings": [item.model_dump(mode="json", by_alias=True) for item in findings],
            "sharedPrompt": shared_prompt.compiled_content,
        }, ensure_ascii=False, sort_keys=True)
        return await self._structured(
            prompt, ExecutionRepairDraft, schema_name="effect_prompt_execution_repair",
            stage=NodeId.CREATIVE_EVALUATION_CLASSIFICATION.value,
            prompt_file=EXECUTION_REPAIR_PROMPT, model=self._candidate_model,
            max_output_tokens=min(self._candidate_max_output_tokens, 6144),
            request_timeout=self._candidate_timeout,
            instructions=load_prompt(EXECUTION_REPAIR_PROMPT),
        )

    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        target_durations: Mapping[str, int],
        application: InsightApplicationMap,
        assigned_context_fact_ids: Mapping[str, Sequence[str]] | None = None,
        fact_visual_strategy: FactVisualStrategy | None = None,
        direction_plan: CreativeDirectionPlan | None = None,
        infer_creative_structure: bool = False,
    ) -> AiCallResult[CreativeEvaluationBatch]:
        if not candidates or len(candidates) > 10:
            raise ProviderError(
                "creative evaluation batch must contain between one and ten items",
                retryable=False,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        expected = {item.slot_id for item in candidates}
        if set(target_durations) != expected or any(
            not MIN_PROMPT_DURATION_SECONDS
            <= duration
            <= MAX_PROMPT_DURATION_SECONDS
            for duration in target_durations.values()
        ):
            raise ProviderError(
                "creative evaluation requires one valid target duration per candidate",
                retryable=False,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        context_by_slot = {
            slot_id: list(dict.fromkeys(fact_ids))
            for slot_id, fact_ids in (assigned_context_fact_ids or {}).items()
        }
        if any(slot_id not in expected for slot_id in context_by_slot) or any(
            fact_id not in application.by_id
            for fact_ids in context_by_slot.values()
            for fact_id in fact_ids
        ):
            raise ProviderError(
                "creative evaluation received an unknown assigned context fact",
                retryable=False,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        # Planned sources are guidance, not the universe of legitimate evidence.
        referenced = {fact.fact_id for fact in application.usable}
        facts = [
            application.by_id[fact_id].model_dump(
                mode="json",
                by_alias=True,
                exclude={"eligible_fragment_types", "exclusion_reason"},
            )
            for fact_id in referenced
            if fact_id in application.by_id
        ]
        prompt = render_prompt(
            EVALUATION_TASK_PROMPT,
            facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
            fact_visual_strategy_json=json.dumps(
                _evaluation_strategy_payload(
                    referenced,
                    fact_visual_strategy,
                ),
                ensure_ascii=False,
                sort_keys=True,
            ),
            candidates_json=json.dumps(
                [
                    {
                        "candidate": {
                            "slotId": item.slot_id,
                            "creativeCore": item.creative_core,
                            "declaredFactIds": item.declared_fact_ids,
                            "dimensions": item.dimensions.model_dump(
                                mode="json",
                                by_alias=True,
                            ),
                            "content": item.content,
                            "beatSequences": [beat.sequence for beat in item.shot_plan.beats] if item.shot_plan else [],
                        },
                        "targetDurationSeconds": target_durations[item.slot_id],
                        "assignedContextFactIds": context_by_slot.get(
                            item.slot_id,
                            [],
                        ),
                        "inferCreativeStructure": infer_creative_structure,
                    }
                    for item in candidates
                ],
                ensure_ascii=False,
                sort_keys=True,
            ),
            semantic_vocabulary_json=json.dumps(
                {
                    key: sorted([*values, "OTHER"])
                    for key, values in direction_plan.vocabulary.items()
                }
                if direction_plan is not None
                else {},
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            CreativeEvaluationDraftBatch,
            schema_name="effect_prompt_creative_evaluation_draft_batch",
            stage="CREATIVE_EVALUATION_CLASSIFICATION",
            prompt_file=EVALUATION_BASE_PROMPT,
            model=self._evaluation_model,
            max_output_tokens=min(
                self._evaluation_max_output_tokens,
                evaluation_output_token_budget(
                    candidates,
                    infer_creative_structure=infer_creative_structure,
                ),
            ),
            request_timeout=self._evaluation_timeout,
            instructions=load_prompt(EVALUATION_BASE_PROMPT),
        )
        actual = [item.slot_id for item in call.value.items]
        if len(actual) != len(set(actual)) or set(actual) != expected:
            raise ProviderError(
                "AI creative evaluation has missing, duplicate, or unknown slotId",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
                attempts=call.metadata.attempts,
                elapsed_ms=call.metadata.latency_ms,
            )
        candidates_by_id = {item.slot_id: item for item in candidates}
        return AiCallResult(
            value=CreativeEvaluationBatch(
                items=[
                    _compile_creative_evaluation(
                        candidates_by_id[item.slot_id],
                        item,
                    )
                    for item in call.value.items
                ]
            ),
            metadata=call.metadata,
        )

    async def _structured(
        self,
        prompt: str,
        model_type: type[TModel],
        *,
        schema_name: str,
        stage: str,
        prompt_file: str,
        model: str,
        max_output_tokens: int,
        request_timeout: float,
        instructions: str | None = None,
        item_count: int | None = None,
        response_schema: dict[str, Any] | None = None,
        input_content: list[dict[str, Any]] | None = None,
    ) -> AiCallResult[TModel]:
        if model_type is CreativeDirectionResponse:
            response_schema = response_schema or model_type.model_json_schema(by_alias=True)
            route_schema = response_schema["$defs"]["CreativeExecutionRoute"]
            route_schema["required"] = list(dict.fromkeys([*route_schema["required"], "eventOutline"]))
        payload = {
            "model": model,
            "input": [
                {
                    "role": "user",
                    "content": input_content
                    if input_content is not None
                    else [{"type": "input_text", "text": prompt}],
                }
            ],
            "store": False,
            "max_output_tokens": max_output_tokens,
            "reasoning": {"effort": self._reasoning_effort},
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": schema_name,
                    "schema": response_schema or model_type.model_json_schema(by_alias=True),
                    "strict": True,
                }
            },
        }
        if instructions:
            payload["instructions"] = instructions
        started_at = time.perf_counter()
        last_error: Exception | None = None
        error_type = ProviderErrorType.UNKNOWN
        retryable = False
        attempts = 0
        for attempt in range(1, self._max_attempts + 1):
            attempts = attempt
            LOGGER.info(
                "Ark call started stage=%s step=%s batch_size=%s input_chars=%s timeout_seconds=%s attempt=%s",
                stage, schema_name, item_count, len(prompt), request_timeout, attempt,
            )
            try:
                response = await self._client.post(
                    "responses", json=payload, timeout=request_timeout
                )
            except httpx.TimeoutException as exc:
                last_error, error_type, retryable = exc, ProviderErrorType.TIMEOUT, True
            except httpx.TransportError as exc:
                last_error, error_type, retryable = exc, ProviderErrorType.NETWORK, True
            else:
                if not response.is_error:
                    try:
                        response_payload = response.json()
                    except (ValueError, TypeError) as exc:
                        last_error, error_type = exc, ProviderErrorType.RESPONSE_INVALID
                        retryable = attempt == 1
                    else:
                        usage = _usage(response_payload)
                        response_status = _response_status(response_payload)
                        incomplete_reason = _incomplete_reason(response_payload)
                        elapsed = max(
                            0, round((time.perf_counter() - started_at) * 1000)
                        )
                        if response_status != "completed":
                            LOGGER.warning(
                                "Ark call incomplete stage=%s status=%s reason=%s input_tokens=%s output_tokens=%s total_tokens=%s latency_ms=%s attempts=%s",
                                stage,
                                response_status,
                                incomplete_reason,
                                usage["inputTokens"],
                                usage["outputTokens"],
                                usage["totalTokens"],
                                elapsed,
                                attempt,
                            )
                            last_error = RuntimeError(
                                f"response status={response_status} reason={incomplete_reason}"
                            )
                            if (
                                response_status == "incomplete"
                                and incomplete_reason in {"max_output_tokens", "length"}
                            ):
                                error_type = ProviderErrorType.OUTPUT_TRUNCATED
                                retryable = False
                            elif response_status == "incomplete":
                                error_type = ProviderErrorType.RESPONSE_INCOMPLETE
                                retryable = False
                            else:
                                error_type = ProviderErrorType.SERVICE
                                retryable = True
                        else:
                            try:
                                value, recovered_trailing_artifact = (
                                    _validate_structured_output(
                                        model_type,
                                        _output_text(response_payload),
                                    )
                                )
                            except (
                                ValueError,
                                ValidationError,
                                KeyError,
                                TypeError,
                            ) as exc:
                                LOGGER.warning(
                                    "Ark structured response invalid stage=%s status=%s input_tokens=%s output_tokens=%s total_tokens=%s latency_ms=%s attempts=%s schema_errors=%s",
                                    stage,
                                    response_status,
                                    usage["inputTokens"],
                                    usage["outputTokens"],
                                    usage["totalTokens"],
                                    elapsed,
                                    attempt,
                                    _safe_schema_errors(exc, model_type),
                                )
                                last_error = exc
                                error_type = ProviderErrorType.RESPONSE_INVALID
                                retryable = attempt == 1
                            else:
                                if recovered_trailing_artifact:
                                    LOGGER.info(
                                        "Ark structured response normalized trailing artifact stage=%s status=%s input_tokens=%s output_tokens=%s total_tokens=%s latency_ms=%s attempts=%s",
                                        stage,
                                        response_status,
                                        usage["inputTokens"],
                                        usage["outputTokens"],
                                        usage["totalTokens"],
                                        elapsed,
                                        attempt,
                                    )
                                LOGGER.info(
                                    "Ark call succeeded stage=%s step=%s batch_size=%s input_tokens=%s output_tokens=%s total_tokens=%s latency_ms=%s attempts=%s",
                                    stage,
                                    schema_name,
                                    item_count,
                                    usage["inputTokens"],
                                    usage["outputTokens"],
                                    usage["totalTokens"],
                                    elapsed,
                                    attempt,
                                )
                                return AiCallResult(
                                    value=value,
                                    metadata=AiCallMetadata(
                                        stage=stage,
                                        template_hash=load_prompt_hash(prompt_file),
                                        input_tokens=usage["inputTokens"],
                                        output_tokens=usage["outputTokens"],
                                        total_tokens=usage["totalTokens"],
                                        latency_ms=elapsed,
                                        attempts=attempt,
                                    ),
                                )
                elif response.status_code == 429:
                    last_error, error_type, retryable = (
                        RuntimeError("rate limited"),
                        ProviderErrorType.RATE_LIMIT,
                        True,
                    )
                elif response.status_code >= 500:
                    last_error, error_type, retryable = (
                        RuntimeError("service unavailable"),
                        ProviderErrorType.SERVICE,
                        True,
                    )
                else:
                    last_error, error_type, retryable = (
                        RuntimeError("request rejected"),
                        ProviderErrorType.REQUEST_REJECTED,
                        False,
                    )
            if not retryable or attempt >= self._max_attempts:
                break
            await asyncio.sleep(
                min(4.0, 0.4 * (2 ** (attempt - 1))) + random.uniform(0, 0.15)
            )
        elapsed = max(0, round((time.perf_counter() - started_at) * 1000))
        LOGGER.warning(
            "Ark call failed stage=%s step=%s batch_size=%s input_chars=%s timeout_seconds=%s latency_ms=%s attempts=%s error_type=%s exception_type=%s",
            stage, schema_name, item_count, len(prompt), request_timeout, elapsed,
            attempts, error_type.value, type(last_error).__name__,
        )
        raise ProviderError(
            _safe_provider_message(error_type),
            retryable=retryable,
            error_type=error_type,
            attempts=attempts,
            elapsed_ms=elapsed,
        ) from last_error


def _mock_result(
    value: TModel,
    stage: str,
    prompt_file: str,
    *,
    model_relationship_bundle_count: int | None = None,
    worker_completed_relationship_bundle_count: int | None = None,
) -> AiCallResult[TModel]:
    return AiCallResult(
        value=value,
        metadata=AiCallMetadata(
            stage=stage,
            template_hash=load_prompt_hash(prompt_file),
            input_tokens=None,
            output_tokens=None,
            total_tokens=None,
            latency_ms=0,
            attempts=1,
            model_relationship_bundle_count=model_relationship_bundle_count,
            worker_completed_relationship_bundle_count=(
                worker_completed_relationship_bundle_count
            ),
        ),
    )


def _mock_fact_visual_strategy(
    application: InsightApplicationMap,
) -> FactVisualStrategyResponse:
    policies: list[FactVisualPolicyDraft] = []
    visible_ids = [
        fact.fact_id
        for fact in application.usable
        if fact.field
        in {
            InsightField.PRODUCT_NAME,
            InsightField.PRODUCT_CATEGORY,
            InsightField.CORE_SPECIFICATION,
            InsightField.VISUAL_FEATURES,
            InsightField.USAGE_SCENARIO,
            InsightField.PURCHASE_SCENARIO,
        }
    ]
    for fact in application.usable:
        if fact.field in {InsightField.PRODUCT_NAME, InsightField.PRODUCT_CATEGORY}:
            usage = FactVisualUsage.IDENTITY_ANCHOR
            visual_instruction = "让当前产品或品类成为明确的主要画面主体"
            context_instruction = ""
        elif fact.field in {
            InsightField.CORE_SPECIFICATION,
            InsightField.VISUAL_FEATURES,
        }:
            usage = FactVisualUsage.DIRECTLY_VISIBLE
            visual_instruction = "只呈现该事实中能够直接观察的外观或包装信息"
            context_instruction = ""
        elif fact.field in {
            InsightField.SELLING_POINT,
            InsightField.USAGE_SCENARIO,
            InsightField.PURCHASE_SCENARIO,
        }:
            usage = FactVisualUsage.ACTION_DEMONSTRABLE
            visual_instruction = "通过一个连续、真实的使用或购买动作表达该场景"
            context_instruction = ""
        elif fact.field in {
            InsightField.CORE_SELLING_POINT,
            InsightField.TRUST_BACKING,
        }:
            usage = FactVisualUsage.FORBIDDEN_VISUAL_PROOF
            visual_instruction = ""
            context_instruction = "只作为商业方向，不要求画面证明该结论"
        else:
            usage = FactVisualUsage.CONTEXT_ONLY
            visual_instruction = ""
            context_instruction = "用于选择合理的场景、人物或叙事动机"
        policies.append(
            FactVisualPolicyDraft(
                fact_id=fact.fact_id,
                visual_usage=usage,
                visual_instruction=visual_instruction,
                context_instruction=context_instruction,
                compatible_fact_ids=[
                    fact_id for fact_id in visible_ids if fact_id != fact.fact_id
                ][:3],
                forbidden_inferences=(
                    ["不得用成品外观、纹理、光泽或人物反应证明该事实"]
                    if usage == FactVisualUsage.FORBIDDEN_VISUAL_PROOF
                    else []
                ),
            )
        )
    return FactVisualStrategyResponse(policies=policies)


_MOCK_DIRECTION_ROWS = (
    ("场景代入", "家庭备餐", "独自备餐", "取放产品", "稳定跟拍", "生活真实"),
    ("分享体验", "家庭餐桌", "家庭成员", "端菜分享", "中景观察", "温馨团聚"),
    ("产品观察", "食品展示台", "仅手部", "转动展示", "微距环绕", "清晰克制"),
    ("使用演示", "早餐准备区", "通勤成年人", "快速装盘", "俯拍跟随", "活力明快"),
    ("消费场景", "年货准备区", "送礼双方", "递送接收", "侧向跟拍", "节庆期待"),
    ("细节发现", "家宴餐桌", "聚餐成员", "夹取观察", "近景轻推", "食欲吸引"),
    ("选择过程", "家庭储物区", "家庭采购者", "取出确认", "主观视角", "安心从容"),
    ("结果呈现", "餐后分享区", "朋友群体", "分食互动", "固定全景", "轻松愉悦"),
)


def _mock_semantic_profile_for_direction(
    direction_id: object,
    *,
    fallback_index: int,
) -> CreativeSemanticProfile:
    try:
        global_index = max(0, int(str(direction_id).rsplit("-", 1)[-1]) - 1)
    except ValueError:
        global_index = fallback_index
    row = _MOCK_DIRECTION_ROWS[global_index % len(_MOCK_DIRECTION_ROWS)]
    return CreativeSemanticProfile(
        narrative_family=row[0],
        scene_family=row[1],
        persona_family=row[2],
        product_action_family=row[3],
        camera_family=row[4],
        emotion_family=row[5],
    )


def _mock_creative_landscape_response(
    application: InsightApplicationMap,
    *,
    direction_count: int,
) -> CreativeDiversityLandscapeResponse:
    business_facts = mandatory_business_facts(application) or application.usable
    required_pool = list({fact.fact_id: fact for fact in application.usable}.values())
    fact_ids = [item.fact_id for item in application.usable]
    minimum_territory_count, _ = creative_territory_target_range(direction_count)
    territory_count = min(
        len(_MOCK_DIRECTION_ROWS),
        direction_count,
        max(minimum_territory_count, len(required_pool)),
    )
    base_action_count, extra_action_count = divmod(
        direction_count,
        territory_count,
    )
    required_by_territory = [
        [fact.fact_id for fact in business_facts[index::territory_count]]
        for index in range(territory_count)
    ]
    facts_by_id = application.by_id
    business_fact_ids = [fact.fact_id for fact in business_facts]
    compatible_by_territory = []
    for index, required_ids in enumerate(required_by_territory):
        rotated_business_ids = business_fact_ids[index:] + business_fact_ids[:index]
        rotated_ids = [*rotated_business_ids, *fact_ids]
        supporting_ids = [
            fact_id for fact_id in rotated_ids if fact_id not in required_ids
        ][:2]
        compatible_by_territory.append(
            list(dict.fromkeys([*required_ids, *supporting_ids]))[:64]
        )
    return CreativeDiversityLandscapeResponse(
        territories=[
            CreativeTerritoryDraft(
                territory_id=f"TERRITORY_{index + 1:02d}",
                label=row[1],
                compatible_fact_ids=compatible_by_territory[index],
                fact_compatibilities=[
                    CreativeTerritoryFactCompatibility(
                        fact_id=fact_id,
                        natural_usage=(
                            f"让“{facts_by_id[fact_id].value}”自然进入{row[1]}的人物、需求、"
                            "动作或产品表达"
                        ),
                        unsupported_conditions=["不得依赖资料未确认的画面条件"],
                    )
                    for fact_id in compatible_by_territory[index]
                ],
                required_fact_ids=required_by_territory[index],
                scene_boundary=f"只在{row[1]}内形成一个主要场景",
                actions=[
                    CreativeTerritoryAction(
                        action_id=f"ACTION_{index + 1:02d}_{action_index + 1:02d}",
                        label=f"{row[3]}阶段{action_index + 1}",
                        boundary=(
                            f"只以{row[3]}的第{action_index + 1}个可拍阶段作为连续主动作"
                        ),
                    )
                    for action_index in range(
                        max(
                            8,
                            base_action_count + int(index < extra_action_count),
                        )
                    )
                ],
                differentiation_goal=f"通过{row[0]}区别于其他创意空间",
            )
            for index, row in enumerate(_MOCK_DIRECTION_ROWS[:territory_count])
        ]
    )


def _mock_creative_direction_response(
    application: InsightApplicationMap,
    *,
    landscape: CreativeDiversityLandscape | None = None,
    direction_count: int = 8,
    execution_route_count: int = 4,
) -> CreativeDirectionResponse:
    business_facts = mandatory_business_facts(application) or application.usable
    if landscape is None:
        draft = _mock_creative_landscape_response(
            application,
            direction_count=direction_count,
        )
        base_slots, extra_slots = divmod(
            direction_count,
            len(draft.territories),
        )
        landscape = CreativeDiversityLandscape(
            territories=[
                CreativeTerritory(
                    **territory.model_dump(mode="python"),
                    target_slots=base_slots + int(index < extra_slots),
                )
                for index, territory in enumerate(draft.territories)
            ],
            source_hash="0" * 64,
            landscape_hash="0" * 64,
            template_hash="0" * 64,
        )
    dimension_pairs = (
        (CreativeDimensionKey.SCENE, CreativeDimensionKey.PRODUCT_RELATION),
        (CreativeDimensionKey.PERSONA, CreativeDimensionKey.EMOTION),
        (CreativeDimensionKey.CAMERA, CreativeDimensionKey.PRODUCT_RELATION),
        (CreativeDimensionKey.NARRATIVE, CreativeDimensionKey.CAMERA),
        (CreativeDimensionKey.SCENE, CreativeDimensionKey.PERSONA),
        (CreativeDimensionKey.PRODUCT_RELATION, CreativeDimensionKey.CAMERA),
        (CreativeDimensionKey.NARRATIVE, CreativeDimensionKey.PERSONA),
        (CreativeDimensionKey.EMOTION, CreativeDimensionKey.SCENE),
        (CreativeDimensionKey.CAMERA, CreativeDimensionKey.SCENE),
        (CreativeDimensionKey.PRODUCT_RELATION, CreativeDimensionKey.NARRATIVE),
        (CreativeDimensionKey.PERSONA, CreativeDimensionKey.CAMERA),
        (CreativeDimensionKey.SCENE, CreativeDimensionKey.EMOTION),
        (CreativeDimensionKey.NARRATIVE, CreativeDimensionKey.PRODUCT_RELATION),
        (CreativeDimensionKey.CAMERA, CreativeDimensionKey.EMOTION),
        (CreativeDimensionKey.PERSONA, CreativeDimensionKey.PRODUCT_RELATION),
        (CreativeDimensionKey.NARRATIVE, CreativeDimensionKey.SCENE),
    )
    total_direction_count = sum(item.target_slots for item in landscape.territories)
    bundle_size = min(
        4,
        max(
            1,
            (len(business_facts) + total_direction_count - 1) // total_direction_count,
        ),
    )
    direction_rows = [
        (
            territory,
            local_index,
            _MOCK_DIRECTION_ROWS[index % len(_MOCK_DIRECTION_ROWS)],
        )
        for index, territory in enumerate(landscape.territories)
        for local_index in range(territory.target_slots)
    ]

    def assigned_facts(
        territory: CreativeTerritory,
        local_index: int,
        global_index: int,
    ) -> list[Any]:
        required = [
            fact
            for fact in business_facts
            if fact.fact_id
            in territory.required_fact_ids[local_index :: territory.target_slots]
        ]
        if len(business_facts) >= total_direction_count * 2:
            minimum_business_count = 2
        elif len(business_facts) >= total_direction_count:
            minimum_business_count = 1
        else:
            minimum_business_count = int(global_index < len(business_facts))
        rotated = (
            business_facts[(global_index * bundle_size) % len(business_facts) :]
            + business_facts[: (global_index * bundle_size) % len(business_facts)]
        )
        selected = list(
            {
                fact.fact_id: fact
                for fact in [*required, *rotated]
                if fact.fact_id in territory.compatible_fact_ids
            }.values()
        )[: max(minimum_business_count, min(4, len(required)))]
        if len(selected) < minimum_business_count:
            selected.extend(
                fact
                for fact in rotated
                if fact.fact_id not in {item.fact_id for item in selected}
                and fact.fact_id in territory.compatible_fact_ids
            )
            selected = selected[:minimum_business_count]
        if not selected:
            compatible_ids = set(territory.compatible_fact_ids)
            selected = [
                fact for fact in application.usable if fact.fact_id in compatible_ids
            ][:1]
        return selected[:4]

    return CreativeDirectionResponse(
        directions=[
            CreativeDirection(
                direction_id=f"direction-{index + 1:02d}",
                territory_id=territory.territory_id,
                primary_action_id=territory.actions[local_index].action_id,
                fact_applications=[
                    CreativeDirectionFactApplication(
                        fact_id=fact.fact_id,
                        creative_usage=(
                            f"让“{fact.value}”自然决定本方向的人物、场景或产品表达"
                        ),
                    )
                    for fact in assigned_facts(territory, local_index, index)
                ],
                creative_direction=(
                    f"在{territory.label}中围绕{row[1]}里的{row[3]}"
                    f"建立第{index + 1}个连续产品画面"
                ),
                priority_dimensions=list(dimension_pairs[index % len(dimension_pairs)]),
                semantic_profile=CreativeSemanticProfile(
                    narrative_family=row[0],
                    scene_family=row[1],
                    persona_family=row[2],
                    product_action_family=row[3],
                    camera_family=row[4],
                    emotion_family=row[5],
                ),
                avoid_families=["重复厨房切制"],
                execution_routes=[
                    CreativeExecutionRoute(
                        route_id=f"ROUTE_{route_index + 1}",
                        visual_event=(
                            f"{row[3]}的第 {route_index + 1} 种主视觉事件"
                        ),
                        scene_relation=(
                            f"{row[1]}中的第 {route_index + 1} 种场景关系"
                        ),
                        product_action=(
                            f"{row[3]}的第 {route_index + 1} 种产品动作"
                        ),
                        ending_state=(
                            f"{row[0]}的第 {route_index + 1} 种结束状态"
                        ),
                    )
                    for route_index in range(execution_route_count)
                ],
            )
            for index, (territory, local_index, row) in enumerate(direction_rows)
        ]
    )


def _mock_creative_direction_audit(
    landscape: CreativeDiversityLandscape,
    directions: CreativeDirectionResponse,
) -> CreativeDirectionAuditResponse:
    del landscape
    return CreativeDirectionAuditResponse(
        items=[
            CreativeDirectionAuditItem(
                direction_id=item.direction_id,
                realized_territory_id=item.territory_id,
                realized_action_id=item.primary_action_id,
                aligned=True,
                fact_reviews=[
                    CreativeDirectionFactAudit(
                        fact_id=application.fact_id,
                        verdict="NATURAL",
                        reason="事实按版图适配依据自然进入当前方向",
                    )
                    for application in item.fact_applications
                ],
                issues=[],
            )
            for item in directions.directions
        ],
        requires_revision=False,
        revision_direction_ids=[],
        summary="全部方向与模型规划的创意版图一致",
    )


def _mock_creative_landscape_audit(
    landscape: CreativeDiversityLandscape,
) -> CreativeLandscapeAuditResponse:
    return CreativeLandscapeAuditResponse(
        reviewed_territory_ids=[
            territory.territory_id for territory in landscape.territories
        ],
        fact_issues=[],
        requires_revision=False,
        revision_territory_ids=[],
        summary="全部事实与产品专属创意空间自然相容",
    )


def _mock_creative_territory_audit(
    territory: CreativeTerritory,
) -> CreativeTerritoryAuditResponse:
    return CreativeTerritoryAuditResponse(
        territory_id=territory.territory_id,
        fact_issues=[],
        summary="当前空间的事实关系自然相容",
    )


def _mock_creative_candidate(
    task: CreativeTask,
    application: InsightApplicationMap,
    fact_visual_strategy: FactVisualStrategy | None = None,
) -> CreativeCandidate:
    assignment = _creative_fact_assignment(task, application)
    assigned_facts = [application.by_id[fact_id] for fact_id in assignment.fact_ids]
    anchor = assigned_facts[0]
    product_fact = next(
        (
            fact
            for fact in application.usable
            if fact.field == InsightField.PRODUCT_NAME
        ),
        next(
            (
                fact
                for fact in application.usable
                if fact.field == InsightField.PRODUCT_CATEGORY
            ),
            anchor,
        ),
    )
    product = product_fact.value
    scenes = ["家庭厨房料理台", "节日家宴餐桌", "明亮食品展示台", "居家备餐区"]
    cameras = ["近景缓慢横移", "微距轻推", "中近景固定观察", "俯拍平稳跟随"]
    direction = task.creative_direction
    scene = (
        direction.semantic_profile.scene_family
        if direction is not None
        else scenes[(task.ordinal - 1) % len(scenes)]
    )
    camera = (
        direction.semantic_profile.camera_family
        if direction is not None
        else cameras[((task.ordinal - 1) // len(scenes)) % len(cameras)]
    )
    composition_details = [
        "主体从画面左侧进入",
        "主体从画面右侧进入",
        "前景保留一件生活道具",
        "背景保持大面积留白",
    ]
    composition = composition_details[(task.ordinal - 1) % len(composition_details)]
    camera = f"{camera}，{composition}"
    actions = [
        "被切开并整齐摆盘",
        "由筷子夹起后停在切面细节",
        "从蒸笼中取出并放到白瓷盘",
        "包装旁的成品被缓慢转动展示",
    ]
    action = (
        direction.semantic_profile.product_action_family
        if direction is not None
        else actions[
            ((task.ordinal - 1) // (len(scenes) * len(cameras))) % len(actions)
        ]
    )
    shot_plan = MaterialShotPlan(
        overview=MaterialShotOverview(
            visual_intent=f"用一个连续产品动作自然承载{'、'.join(fact.value for fact in assigned_facts)}",
            visual_style="真实生活化产品素材",
        ),
        scene=MaterialShotScene(
            environment=scene,
            lighting="自然暖光清楚照亮主体与产品",
            initial_state=f"{product}与必要道具已经位于画面中央，主体准备完成一个连续动作",
        ),
        beats=[
            MaterialShotBeat(
                sequence=1,
                duration_weight=2,
                framing="中近景观察主体与产品关系",
                action=f"主体稳定完成{action}",
                camera=camera,
                visible_result="主要动作完成，产品状态清晰可见",
                sound="保留与动作同步的自然现场声",
            ),
            MaterialShotBeat(
                sequence=2,
                duration_weight=1,
                framing="产品近景",
                action="主体收住动作并让产品稳定停留",
                camera="镜头随动作轻微调整后固定对焦产品",
                visible_result="产品与动作形成的结果同时留在画面中",
            ),
        ],
        final_frame="主体动作结束，产品稳定停留在清楚可辨的位置，镜头完成收束",
    )
    content = compile_material_shot_plan(
        shot_plan,
        target_duration_seconds=task.target_duration_seconds,
    )
    audience_fact = next(
        (fact for fact in assigned_facts if fact.field == InsightField.TARGET_AUDIENCE),
        None,
    )
    persona = (
        audience_fact.value
        if audience_fact is not None
        else direction.semantic_profile.persona_family
        if direction is not None
        else "仅一双成年人的手参与动作"
    )
    scene_fact = next(
        (
            fact
            for fact in assigned_facts
            if fact.field
            in {
                InsightField.USAGE_SCENARIO,
                InsightField.PURCHASE_SCENARIO,
                InsightField.EMOTIONAL_SCENARIO,
            }
        ),
        None,
    )
    scene_dimension = scene_fact.value if scene_fact is not None else scene
    product_relation = "；".join(fact.value for fact in assigned_facts)
    return CreativeCandidate(
        slot_id=task.slot_id,
        ordinal=task.ordinal,
        round=task.round,
        creative_core=(
            direction.creative_direction
            if direction is not None
            else f"用{scene}中的连续动作自然结合多个已确认事实"
        ),
        declared_fact_ids=assignment.fact_ids,
        dimensions=CreativeDimensions(
            narrative=(
                direction.semantic_profile.narrative_family
                if direction is not None
                else "从准备动作自然推进到产品细节停留"
            ),
            scene=scene_dimension,
            persona=persona,
            product_relation=product_relation,
            camera=camera,
            emotion=(
                direction.semantic_profile.emotion_family
                if direction is not None
                else "温暖真实且具有食欲吸引力"
            ),
        ),
        content=content,
        shot_plan=shot_plan,
    )


def _creative_fact_assignment(
    task: CreativeTask,
    application: InsightApplicationMap,
) -> CreativeFactAssignment:
    if task.fact_assignment is not None:
        assignment = task.fact_assignment
    else:
        # Compatibility for earlier shard plans persisted before fact assignments.
        from .fact_allocation import allocate_creative_facts

        assignment = allocate_creative_facts(
            application,
            count=1,
            ordinal_start=task.ordinal,
            preferred_fact_ids=task.preferred_fact_ids,
        )[0]
    missing = [
        fact_id for fact_id in assignment.fact_ids if fact_id not in application.by_id
    ]
    if missing:
        raise ProviderError(
            "creative fact assignment contains an unavailable fact",
            retryable=False,
            error_type=ProviderErrorType.RESPONSE_INVALID,
        )
    return assignment


_SIBLING_VARIATION_DIMENSION_PAIRS: tuple[tuple[str, str], ...] = (
    ("NARRATIVE", "SCENE"),
    ("PERSONA", "PRODUCT_RELATION"),
    ("CAMERA", "EMOTION"),
    ("NARRATIVE", "CAMERA"),
    ("SCENE", "PERSONA"),
    ("PRODUCT_RELATION", "EMOTION"),
    ("NARRATIVE", "PERSONA"),
    ("SCENE", "PRODUCT_RELATION"),
    ("CAMERA", "PRODUCT_RELATION"),
    ("PERSONA", "EMOTION"),
    ("NARRATIVE", "PRODUCT_RELATION"),
    ("SCENE", "CAMERA"),
    ("NARRATIVE", "EMOTION"),
    ("PERSONA", "CAMERA"),
    ("SCENE", "EMOTION"),
)


def _sibling_variation_dimensions(index: int) -> list[str]:
    """Assign only structural axes; the model still owns product semantics."""

    pair = _SIBLING_VARIATION_DIMENSION_PAIRS[
        (max(1, index) - 1) % len(_SIBLING_VARIATION_DIMENSION_PAIRS)
    ]
    return list(pair)


def _creative_task_brief(
    task: CreativeTask,
    *,
    assignment: CreativeFactAssignment,
    application: InsightApplicationMap,
    fact_visual_strategy: FactVisualStrategy | None,
    fact_aliases: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    def fact_payload(fact_id: str) -> dict[str, str]:
        fact = application.by_id[fact_id]
        return {
            "factId": (fact_aliases or {}).get(fact.fact_id, fact.fact_id),
            "field": fact.field.value,
            "value": fact.value,
        }

    direction_payload = (
        {
            "directionId": task.creative_direction.direction_id,
            "creativeDirection": task.creative_direction.creative_direction,
            "priorityDimensions": [
                item.value for item in task.creative_direction.priority_dimensions
            ],
            "targetSemanticProfile": task.creative_direction.semantic_profile.model_dump(
                mode="json", by_alias=True
            ),
            "avoidFamilies": task.creative_direction.avoid_families,
        }
        if task.creative_direction is not None
        else None
    )
    temporal_intent = _temporal_intent_for_duration(task.target_duration_seconds)
    direction_usage = (
        {
            item.fact_id: item.creative_usage
            for item in task.creative_direction.fact_applications
        }
        if task.creative_direction is not None
        else {}
    )

    def fact_application_payload(fact_id: str) -> dict[str, Any]:
        policy = (
            fact_visual_strategy.by_id[fact_id]
            if fact_visual_strategy is not None
            else None
        )
        instruction = (
            policy.visual_instruction
            if policy is not None
            and policy.visual_usage
            in {
                FactVisualUsage.DIRECTLY_VISIBLE,
                FactVisualUsage.ACTION_DEMONSTRABLE,
                FactVisualUsage.IDENTITY_ANCHOR,
            }
            else policy.context_instruction
            if policy is not None
            else "自然融入同一创意，不得补造输入中没有的信息"
        )
        creative_usage = direction_usage.get(
            fact_id,
            "结合当前条目的既有事实关系自然融入同一画面",
        )
        if policy is not None and policy.visual_usage == FactVisualUsage.TEXT_ONLY:
            creative_usage = (
                "仅作为后续成片文案依据；当前无口播素材无需复述、配字幕或视觉证明"
            )
        return {
            **fact_payload(fact_id),
            "creativeUsage": creative_usage,
            "instruction": instruction,
            "visualUsage": (
                policy.visual_usage.value if policy is not None else "UNSPECIFIED"
            ),
            "forbiddenInferences": (
                list(dict.fromkeys(policy.forbidden_inferences))
                if policy is not None
                else []
            ),
        }

    return {
        "slotId": task.slot_id,
        "ordinal": task.ordinal,
        "round": task.round,
        "targetDurationSeconds": task.target_duration_seconds,
        "temporalIntent": temporal_intent,
        "siblingVariation": {
            "index": task.sibling_variant_index,
            "total": task.sibling_variant_total,
            "focusDimensions": _sibling_variation_dimensions(
                task.sibling_variant_index
            ),
            "routeComparisons": [
                route_summary(route)
                for route in task.creative_direction.execution_routes
            ] if task.creative_direction is not None else [],
        },
        "executionRoute": (
            task.execution_route.model_dump(mode="json", by_alias=True)
            if task.execution_route is not None
            else None
        ),
        "regenerationVariantRole": task.regeneration_variant_role,
        "factApplications": [
            fact_application_payload(fact_id) for fact_id in assignment.fact_ids
        ],
        # Copyable task-source metadata, not a model judgment that all facts
        # have been visibly realized. The independent evaluator decides that.
        "declaredFactIds": [(fact_aliases or {}).get(fact_id, fact_id)
                            for fact_id in assignment.fact_ids],
        "coverageFocusFactIds": [
            (fact_aliases or {}).get(fact_id, fact_id)
            for fact_id in task.coverage_focus_fact_ids
        ],
        "productSnapshot": _product_snapshot(application),
        "forbiddenInferences": (
            list(
                dict.fromkeys(
                    inference
                    for fact_id in assignment.fact_ids
                    if fact_visual_strategy is not None
                    for inference in fact_visual_strategy.by_id[
                        fact_id
                    ].forbidden_inferences
                )
            )
        ),
        "creativeDirection": direction_payload,
        "materialTask": (
            {"visualEvent": task.material_brief.visual_event,
             "difference": task.material_brief.difference,
             "priorityDimensions": [key.value for key in task.material_brief.priority_dimensions]}
            if task.material_brief is not None else None
        ),
    }


def _execution_fact_brief(
    task: CreativeTask, *, assignment: CreativeFactAssignment,
    application: InsightApplicationMap, fact_visual_strategy: FactVisualStrategy | None,
    fact_aliases: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Give the edit model facts, not the upstream filming advice it must repair."""
    brief = _creative_task_brief(task, assignment=assignment, application=application,
                                 fact_visual_strategy=fact_visual_strategy, fact_aliases=fact_aliases)
    return {
        "targetDurationSeconds": task.target_duration_seconds,
        "productSnapshot": brief["productSnapshot"],
        "factApplications": [
            {key: value for key, value in fact.items() if key not in {"creativeUsage", "instruction"}}
            for fact in brief["factApplications"]
        ],
        "forbiddenInferences": brief["forbiddenInferences"],
    }


def _product_snapshot(application: InsightApplicationMap) -> dict[str, Any]:
    values_by_field = {
        field: [fact.value for fact in application.usable if fact.field == field]
        for field in {
            InsightField.PRODUCT_NAME,
            InsightField.PRODUCT_CATEGORY,
            InsightField.CORE_SPECIFICATION,
            InsightField.VISUAL_FEATURES,
        }
    }
    return {
        "productName": next(iter(values_by_field[InsightField.PRODUCT_NAME]), ""),
        "productCategory": next(
            iter(values_by_field[InsightField.PRODUCT_CATEGORY]),
            "",
        ),
        "coreSpecifications": values_by_field[InsightField.CORE_SPECIFICATION],
        "visualFeatures": values_by_field[InsightField.VISUAL_FEATURES],
    }


def _creative_fact_aliases(
    assignment: CreativeFactAssignment,
) -> dict[str, str]:
    """Give every slot its own compact fact namespace.

    Multiple tasks share one model request. Reusing global fact identifiers in
    that request lets the model accidentally borrow another slot's identifier.
    Slot-local aliases keep the briefs isolated; generated aliases are mapped
    back to authoritative fact ids before any candidate is persisted.
    """

    return {
        fact_id: f"F{index}"
        for index, fact_id in enumerate(assignment.fact_ids, start=1)
    }


def _temporal_intent_for_duration(duration_seconds: int) -> dict[str, str]:
    if not MIN_PROMPT_DURATION_SECONDS <= duration_seconds <= MAX_PROMPT_DURATION_SECONDS:
        raise ValueError("target duration must be between 4 and 15 seconds")
    if duration_seconds <= 8:
        lower_chars = 65 + (duration_seconds - 4) * 10
        upper_chars = 100 + (duration_seconds - 4) * 15
        return {
            "band": "SHORT_FOCUS",
            "guidance": (
                "只围绕一个可立即看懂的视觉事件。主体、商品和关键道具在首帧就位，直接完成"
                "一个主要产品动作并停在该动作形成的清晰结果上；不要先走入、寻找或拿取后再"
                "开始另一项使用动作，也不要切换到第二阶段。"
            ),
            "detailGuidance": (
                f"本次为 {duration_seconds} 秒，软参考约 {lower_chars}～{upper_chars} 个汉字："
                "写清首帧、一个具体主动作、镜头如何看见变化和结束状态；"
                "依靠画面而不是台词完成表达，声音只描述环境声或动作声。"
            ),
        }
    lower_chars = 120 + (duration_seconds - 9) * 7
    upper_chars = 180 + (duration_seconds - 9) * 16
    beat_guidance = "1～2 个"
    return {
        "band": "COMPLETE_ACTION",
        "guidance": (
            f"在同一主场景和同一目标下，通常用 {beat_guidance}连续动作节拍完成一个英雄事件。"
            "主体、商品与必要工具在首帧就位；过程与结果自然衔接，结果停留并入最后一个"
            "动作节拍，不另拆一拍，不为填满时长加入第二项任务。节拍数是软建议。"
        ),
        "detailGuidance": (
            f"本次为 {duration_seconds} 秒，软参考约 {lower_chars}～{upper_chars} 个汉字："
            f"首帧和结束状态完整，{beat_guidance}节拍均写清主体、对象、可见变化和镜头配合；"
            "片段静音时也必须能看懂，声音只描述环境声或动作声。"
        ),
    }


def _evaluation_strategy_payload(
    referenced_fact_ids: set[str],
    strategy: FactVisualStrategy | None,
) -> list[dict[str, Any]]:
    if strategy is None:
        return []
    return [
        policy.model_dump(mode="json", by_alias=True)
        for policy in strategy.policies
        if policy.fact_id in referenced_fact_ids
    ]


def _direction_event_capacity_schema() -> dict[str, Any]:
    """New model output needs at least one event; old checkpoints stay readable."""
    schema = CreativeDirectionResponse.model_json_schema(by_alias=True)
    schema["$defs"]["CreativeDirection"]["properties"]["executionRoutes"].update(
        minItems=1, maxItems=5,
    )
    return schema


def _validate_direction_event_capacity(response: CreativeDirectionResponse) -> None:
    # Provider output only; do not invalidate historical route-less checkpoints.
    if any(not direction.execution_routes for direction in response.directions):
        raise ProviderError("creative direction omitted event routes",
                            error_type=ProviderErrorType.RESPONSE_INVALID, retryable=False)


def _creative_shot_response_schema(tasks: Sequence[CreativeTask] = ()) -> dict[str, Any]:
    schema = CreativeCandidateDraftBatch.model_json_schema(by_alias=True)
    if tasks:
        schema["properties"]["items"].update(minItems=len(tasks), maxItems=len(tasks))
        draft = schema["$defs"]["CreativeCandidateDraft"]["properties"]
        draft["slotId"]["enum"] = [task.slot_id for task in tasks]
        draft["ordinal"]["enum"] = sorted({task.ordinal for task in tasks})
        draft["round"]["enum"] = sorted({task.round for task in tasks})
    beat = schema["$defs"]["MaterialShotBeat"]
    beat["required"] = list(dict.fromkeys([*beat["required"], "focus", "motionSource"]))
    return schema


def _compile_creative_evaluation(
    candidate: CreativeCandidate,
    draft: CreativeEvaluationDraft,
) -> CreativeEvaluation:
    """Add only deterministic fields omitted from the paid model response."""

    supported_fact_ids = list(
        dict.fromkeys(
            item.fact_id
            for item in draft.fact_evidence
            if item.support_level in {"EXACT", "SEMANTIC_FULL"}
        )
    )
    primary_and_compatible = list(
        dict.fromkeys([draft.primary_purpose, *draft.compatible_purposes])
    )
    return CreativeEvaluation(
        slot_id=draft.slot_id,
        primary_purpose=draft.primary_purpose,
        compatible_purposes=primary_and_compatible,
        fact_evidence=draft.fact_evidence,
        realized_fact_ids=supported_fact_ids,
        scores=draft.scores,
        semantic_signature=_normalized_text(candidate.creative_core)[:240] or "empty",
        visual_signature=(
            _normalized_text(
                "|".join(
                    (
                        candidate.dimensions.scene,
                        candidate.dimensions.persona,
                        candidate.dimensions.product_relation,
                        candidate.dimensions.camera,
                    )
                )
            )[:240]
            or "empty"
        ),
        semantic_profile=draft.semantic_profile,
        abstract_visual_proof_findings=draft.abstract_visual_proof_findings,
        hard_issues=draft.hard_issues,
        warnings=draft.warnings,
        execution_findings=draft.execution_findings,
        inferred_creative_core=draft.inferred_creative_core,
        inferred_dimensions=draft.inferred_dimensions,
    )


def _mock_creative_evaluation(
    candidate: CreativeCandidate,
    application: InsightApplicationMap,
    direction_plan: CreativeDirectionPlan | None = None,
    *,
    context_fact_ids: Sequence[str] = (),
    infer_creative_structure: bool = False,
) -> CreativeEvaluation:
    evidence = [
        FactEvidence(
            fact_id=fact_id,
            support_level="SEMANTIC_FULL",
        )
        for fact_id in dict.fromkeys([*candidate.declared_fact_ids, *context_fact_ids])
        if fact_id in application.by_id
    ]
    purposes = list(FragmentType)
    primary = purposes[(candidate.ordinal - 1) % len(purposes)]
    compatible = [primary]
    if primary != FragmentType.PRODUCT_DISPLAY:
        compatible.append(FragmentType.PRODUCT_DISPLAY)
    direction = (
        direction_plan.directions[
            (candidate.ordinal - 1) % len(direction_plan.directions)
        ]
        if direction_plan is not None
        else None
    )
    return CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=primary,
        compatible_purposes=compatible,
        fact_evidence=evidence,
        realized_fact_ids=[item.fact_id for item in evidence],
        scores=CreativeScores(
            product_relevance=92 if evidence else 20,
            creative_coherence=88,
            visual_executability=90,
            commercial_usefulness=85,
            visual_clarity=90,
        ),
        semantic_signature=_normalized_text(candidate.creative_core),
        visual_signature=_normalized_text(
            "|".join(
                [
                    candidate.dimensions.scene,
                    candidate.dimensions.persona,
                    candidate.dimensions.product_relation,
                    candidate.dimensions.camera,
                ]
            )
        ),
        semantic_profile=(direction.semantic_profile if direction else None),
        hard_issues=[] if evidence else ["PRODUCT_UNRELATED"],
        warnings=[],
        inferred_creative_core=(
            f"围绕用户正文呈现{candidate.dimensions.product_relation}"
            if infer_creative_structure
            else None
        ),
        inferred_dimensions=(
            CreativeDimensions(
                narrative="用户自定义片段",
                scene="正文中的单一主要场景",
                persona="正文中的出镜主体",
                product_relation="正文表达的产品关联点",
                camera="正文描述的镜头语言",
                emotion="正文呈现的情绪基调",
            )
            if infer_creative_structure
            else None
        ),
    )


def _selling_points(insight: Mapping[str, Any]) -> list[str]:
    return _text_list(
        insight,
        "coreSellingPoints",
        "core_selling_points",
        "secondarySellingPoints",
        "secondary_selling_points",
    )


def _normalized_text(value: str) -> str:
    return " ".join(value.split()).casefold()


def _text_list(payload: Mapping[str, Any], *keys: str) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for key in keys:
        raw = payload.get(key)
        values = raw if isinstance(raw, list) else [raw] if isinstance(raw, str) else []
        for item in values:
            if isinstance(item, str) and (value := " ".join(item.split())):
                folded = value.casefold()
                if folded not in seen:
                    seen.add(folded)
                    result.append(value)
    return result


def _first_text(payload: Mapping[str, Any], *keys: str) -> str | None:
    values = _text_list(payload, *keys)
    return values[0] if values else None


def _safe_provider_message(error_type: ProviderErrorType) -> str:
    return {
        ProviderErrorType.TIMEOUT: "AI request timed out",
        ProviderErrorType.NETWORK: "AI network request failed",
        ProviderErrorType.RATE_LIMIT: "AI service rate limit exceeded",
        ProviderErrorType.SERVICE: "AI service request failed",
        ProviderErrorType.OUTPUT_TRUNCATED: "AI strategy output exceeded the safe length",
        ProviderErrorType.RESPONSE_INCOMPLETE: "AI response was not completed",
        ProviderErrorType.RESPONSE_INVALID: "AI structured response is invalid",
        ProviderErrorType.REQUEST_REJECTED: "AI request was rejected",
        ProviderErrorType.UNKNOWN: "AI structured-output request failed",
    }[error_type]


def _token(value: Any) -> int | None:
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0
        else None
    )


def _usage(payload: Any) -> dict[str, int | None]:
    usage = payload.get("usage") if isinstance(payload, Mapping) else None
    if not isinstance(usage, Mapping):
        usage = {}
    return {
        "inputTokens": _token(usage.get("input_tokens", usage.get("inputTokens"))),
        "outputTokens": _token(usage.get("output_tokens", usage.get("outputTokens"))),
        "totalTokens": _token(usage.get("total_tokens", usage.get("totalTokens"))),
    }


def _response_status(payload: Any) -> str:
    if isinstance(payload, Mapping) and isinstance(payload.get("status"), str):
        return str(payload["status"]).strip().casefold()
    return "unknown"


def _incomplete_reason(payload: Any) -> str | None:
    details = (
        payload.get("incomplete_details") if isinstance(payload, Mapping) else None
    )
    if not isinstance(details, Mapping):
        return None
    reason = details.get("reason")
    return (
        reason.strip().casefold()
        if isinstance(reason, str) and reason.strip()
        else None
    )


def _output_text(payload: Any) -> str:
    if isinstance(payload, Mapping):
        direct = payload.get("output_text")
        if isinstance(direct, str) and direct.strip():
            return direct
        output = payload.get("output")
        if isinstance(output, list):
            for item in output:
                if not isinstance(item, Mapping) or item.get("type") != "message":
                    continue
                content = item.get("content")
                if isinstance(content, list):
                    for part in content:
                        if (
                            isinstance(part, Mapping)
                            and part.get("type") == "output_text"
                        ):
                            text = part.get("text")
                            if isinstance(text, str) and text.strip():
                                return text
    raise ValueError("Ark response does not contain output_text")


_SAFE_STRUCTURED_TRAILING_ARTIFACT = re.compile(
    r"(?:\s|[\]\}]|```|</[A-Za-z][A-Za-z0-9:_.-]*>)*\Z"
)


def _safe_schema_errors(exc: Exception, model_type: type[BaseModel]) -> list[dict[str, str]]:
    """Log schema-owned paths/codes only, never values, messages or unknown keys."""
    if not isinstance(exc, ValidationError):
        return [{"path": "$", "code": "invalid_json"}]
    fields: set[str] = set()

    def collect(node: Any) -> None:
        if isinstance(node, dict):
            properties = node.get("properties", {})
            fields.update(properties)
            for value in node.values():
                collect(value)
        elif isinstance(node, list):
            for value in node:
                collect(value)

    collect(model_type.model_json_schema(by_alias=True))
    collect(model_type.model_json_schema(by_alias=False))
    diagnostics = []
    for error in exc.errors(include_input=False, include_context=False, include_url=False)[:8]:
        path = ".".join(
            "[]" if isinstance(part, int) else part if part in fields else "?"
            for part in error["loc"]
        )
        code = str(error["type"])
        diagnostics.append({
            "path": path or "$",
            "code": code if re.fullmatch(r"[a-z_]+", code) else "validation_error",
        })
    return diagnostics


def _validate_structured_output(
    model_type: type[TModel], output_text: str
) -> tuple[TModel, bool]:
    """Validate Ark JSON and recover only harmless transport/model tail artifacts.

    Ark occasionally returns a complete schema-valid JSON value followed by
    duplicated closing brackets, a Markdown fence, or internal closing tags. We
    may ignore those tokens because they cannot alter the decoded value. Any
    prose, second JSON value, opening tag, or semantic schema error stays invalid.
    """

    try:
        return model_type.model_validate_json(output_text), False
    except (ValueError, ValidationError) as original_error:
        candidate = output_text.lstrip("\ufeff \t\r\n")
        if candidate.startswith("```"):
            first_line, separator, remainder = candidate.partition("\n")
            if not separator or first_line.strip().casefold() not in {
                "```",
                "```json",
            }:
                raise original_error
            candidate = remainder

        try:
            decoded, end_index = json.JSONDecoder().raw_decode(candidate)
        except (TypeError, json.JSONDecodeError):
            raise original_error

        trailing = candidate[end_index:]
        if not _SAFE_STRUCTURED_TRAILING_ARTIFACT.fullmatch(trailing):
            raise original_error

        try:
            return model_type.model_validate(decoded), True
        except (ValueError, ValidationError, TypeError):
            raise original_error
