from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Generic, Protocol, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .creative_directions import (
    creative_direction_fact_density_instruction,
    creative_direction_target_count,
)
from .insight_mapping import mandatory_business_facts
from .models import (
    CreativeCandidate,
    CreativeCandidateBatch,
    CreativeDirectionAuditItem,
    CreativeDirectionFactAudit,
    CreativeDirectionAuditResponse,
    CreativeDirectionDiversityAuditResponse,
    CreativeDirection,
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
)
from .prompt_loader import load_prompt, load_prompt_hash, render_prompt

TModel = TypeVar("TModel", bound=BaseModel)
LOGGER = logging.getLogger(__name__)
CREATIVE_BASE_PROMPT = "creative_base.system.prompt.txt"
CREATIVE_TASK_PROMPT = "creative_task.user.prompt.txt"
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
    load_prompt(FACT_VISUAL_STRATEGY_BASE_PROMPT).encode("utf-8")
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


class AiProvider(Protocol):
    execution_mode: str

    async def compile_fact_visual_strategy(
        self,
        application: InsightApplicationMap,
    ) -> AiCallResult[FactVisualStrategyResponse]: ...

    async def plan_creative_landscape(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        target_count: int,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDiversityLandscapeResponse]: ...

    async def plan_creative_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        landscape: CreativeDiversityLandscape,
        target_count: int,
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

    async def audit_creative_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscape,
        directions: CreativeDirectionResponse,
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
    ) -> AiCallResult[CreativeEvaluationBatch]: ...


class MockAiProvider:
    execution_mode = "MOCK"

    async def compile_fact_visual_strategy(
        self,
        application: InsightApplicationMap,
    ) -> AiCallResult[FactVisualStrategyResponse]:
        return _mock_result(
            _mock_fact_visual_strategy(application),
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
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDiversityLandscapeResponse]:
        del fact_visual_strategy, shared_prompt, revision_context
        return _mock_result(
            _mock_creative_landscape_response(
                application,
                direction_count=creative_direction_target_count(
                    target_count,
                    len(mandatory_business_facts(application)),
                ),
            ),
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
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionResponse]:
        del fact_visual_strategy, shared_prompt, revision_context
        return _mock_result(
            _mock_creative_direction_response(
                application,
                landscape=landscape,
            ),
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

    async def audit_creative_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        landscape: CreativeDiversityLandscape,
        directions: CreativeDirectionResponse,
    ) -> AiCallResult[CreativeDirectionAuditResponse]:
        del application, fact_visual_strategy
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
        del landscape, directions, proposed_direction_ids
        return _mock_result(
            CreativeDirectionDiversityAuditResponse(
                groups=[],
                requires_revision=False,
                revision_direction_ids=[],
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
            revision_context,
        )
        rows = []
        for index in range(requested_direction_count):
            base = existing_directions.directions[index % len(existing_directions.directions)]
            rows.append(
                base.model_copy(
                    update={
                        "direction_id": f"DIVERSITY_SUPPLEMENT_{index + 1}",
                        "creative_direction": (
                            f"补充差异方向 {index + 1}：{base.creative_direction}"
                        ),
                        "semantic_profile": base.semantic_profile.model_copy(
                            update={
                                "scene_family": (
                                    f"SUPPLEMENT_SCENE_{index + 1}"
                                ),
                                "product_action_family": (
                                    f"SUPPLEMENT_ACTION_{index + 1}"
                                ),
                            }
                        ),
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
                    )
                    for item in candidates
                ]
            ),
            "CREATIVE_EVALUATION_CLASSIFICATION",
            EVALUATION_BASE_PROMPT,
        )


class ArkResponsesProvider:
    execution_mode = "ARK"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        strategy_model: str,
        candidate_model: str,
        fragment_strategy_model: str | None = None,
        blueprint_model: str | None = None,
        evaluation_model: str | None = None,
        strategy_max_output_tokens: int = 8192,
        candidate_max_output_tokens: int = 4096,
        fragment_strategy_max_output_tokens: int = 3072,
        evaluation_max_output_tokens: int = 4096,
        reasoning_effort: str = "minimal",
        strategy_timeout: float = 180.0,
        candidate_timeout: float = 120.0,
        fragment_strategy_timeout: float = 120.0,
        evaluation_timeout: float = 120.0,
        max_attempts: int = 1,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not strategy_model.strip() or not candidate_model.strip():
            raise ValueError("Ark prompt models cannot be empty")
        self._strategy_model = strategy_model.strip()
        self._candidate_model = candidate_model.strip()
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
        call = await self._structured(
            prompt,
            FactVisualStrategyResponse,
            schema_name="effect_prompt_fact_visual_strategy",
            stage=NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value,
            prompt_file=FACT_VISUAL_STRATEGY_BASE_PROMPT,
            model=self._candidate_model,
            max_output_tokens=min(
                self._strategy_max_output_tokens,
                max(4096, len(facts) * 320),
            ),
            request_timeout=self._strategy_timeout,
            instructions=load_prompt(FACT_VISUAL_STRATEGY_BASE_PROMPT),
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
        revision_context: Mapping[str, Any] | None = None,
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
                    fact_aliases[fact_id] for fact_id in policy.compatible_fact_ids
                ],
                "forbiddenInferences": policy.forbidden_inferences,
            }
            for policy in fact_visual_strategy.policies
        ]
        visual_style_baseline = next(
            (
                fact.value
                for fact in application.constraints
                if fact.field == InsightField.VISUAL_STYLE_BASELINE
            ),
            "",
        )
        business_fact_count = len(mandatory_business_facts(application))
        target_direction_count = creative_direction_target_count(
            target_count,
            business_fact_count,
        )
        prompt = render_prompt(
            CREATIVE_LANDSCAPE_TASK_PROMPT,
            target_direction_count=str(target_direction_count),
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
            visual_style_baseline_json=json.dumps(
                visual_style_baseline or "未设置", ensure_ascii=False
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

    async def plan_creative_directions(
        self,
        application: InsightApplicationMap,
        *,
        fact_visual_strategy: FactVisualStrategy,
        shared_prompt: SharedPrompt,
        landscape: CreativeDiversityLandscape,
        target_count: int,
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionResponse]:
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
                "forbiddenInferences": policy.forbidden_inferences,
            }
            for policy in fact_visual_strategy.policies
        ]
        visual_style_baseline = next(
            (
                fact.value
                for fact in application.constraints
                if fact.field == InsightField.VISUAL_STYLE_BASELINE
            ),
            "",
        )
        business_fact_count = len(mandatory_business_facts(application))
        target_direction_count = creative_direction_target_count(
            target_count,
            business_fact_count,
        )
        revision_direction_ids = (
            revision_context.get("revisionDirectionIds", [])
            if revision_context is not None
            else []
        )
        if (
            isinstance(revision_direction_ids, list)
            and revision_direction_ids
            and all(isinstance(item, str) for item in revision_direction_ids)
        ):
            direction_output_instruction = (
                "这是局部修订。directions 数组只输出 revisionDirectionIds 中的 "
                f"{len(revision_direction_ids)} 个方向，directionId 必须逐一对应："
                + json.dumps(revision_direction_ids, ensure_ascii=False)
                + "。不要输出未点名方向，系统会按稳定 ID 与上一版机械合并。"
            )
        else:
            direction_output_instruction = (
                f"这是首次规划。directions 数组必须恰好输出 {target_direction_count} "
                "个方向。"
            )
        prompt = render_prompt(
            CREATIVE_DIRECTION_TASK_PROMPT,
            target_count=str(target_count),
            target_direction_count=str(target_direction_count),
            direction_output_instruction=direction_output_instruction,
            fact_density_instruction=(
                creative_direction_fact_density_instruction(
                    business_fact_count,
                    target_direction_count,
                )
            ),
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
            visual_style_baseline_json=json.dumps(
                visual_style_baseline or "未设置",
                ensure_ascii=False,
            ),
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
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_DIRECTION_BASE_PROMPT,
            model=self._fragment_strategy_model,
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._strategy_timeout,
            instructions=load_prompt(CREATIVE_DIRECTION_BASE_PROMPT),
        )
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
    ) -> AiCallResult[CreativeDirectionAuditResponse]:
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
                        for item in landscape.territories
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
        )

        call = await self._structured(
            prompt,
            CreativeDirectionAuditResponse,
            schema_name="effect_prompt_creative_direction_audit",
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_DIRECTION_AUDIT_BASE_PROMPT,
            model=self._evaluation_model,
            # This is a batch strategy audit rather than per-item scoring. Use
            # the strategy budget so 8-24 structured rows cannot be truncated
            # by the smaller candidate-evaluation budget.
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._evaluation_timeout,
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
            stage=NodeId.COHERENT_CREATIVE_GENERATION.value,
            prompt_file=CREATIVE_DIRECTION_DIVERSITY_AUDIT_BASE_PROMPT,
            model=self._evaluation_model,
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._evaluation_timeout,
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
        crowded_scene_families: Sequence[str],
        crowded_action_families: Sequence[str],
        revision_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[CreativeDirectionResponse]:
        fact_aliases, fact_ids_by_alias = _fact_alias_maps(application)
        prompt = render_prompt(
            CREATIVE_DIRECTION_SUPPLEMENT_TASK_PROMPT,
            requested_direction_count=str(requested_direction_count),
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
            existing_directions_json=json.dumps(
                _remap_fact_references(
                    [
                        direction.model_dump(mode="json", by_alias=True)
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
                _remap_fact_references(revision_context or {}, fact_aliases),
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            CreativeDirectionResponse,
            schema_name="effect_prompt_creative_direction_supplement",
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
        creative_task_prompt = CREATIVE_TASK_PROMPT
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
            CreativeCandidateBatch,
            schema_name="effect_prompt_coherent_creative_batch",
            stage="COHERENT_CREATIVE_GENERATION",
            prompt_file=creative_base_prompt,
            model=self._candidate_model,
            max_output_tokens=min(
                self._candidate_max_output_tokens,
                max(1536, len(shard.tasks) * 900),
            ),
            request_timeout=self._candidate_timeout,
            instructions=load_prompt(creative_base_prompt),
        )
        task_by_slot = {item.slot_id: item for item in shard.tasks}
        actual = [item.slot_id for item in call.value.items]
        if len(actual) != len(set(actual)) or set(actual) != set(task_by_slot):
            raise ProviderError(
                "AI coherent creative response has missing, duplicate, or unknown slotId",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
                attempts=call.metadata.attempts,
                elapsed_ms=call.metadata.latency_ms,
            )
        normalized: list[CreativeCandidate] = []
        rejected_item_count = 0
        for item in call.value.items:
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
                rejected_item_count += 1
                continue
            normalized.append(
                item.model_copy(
                    update={
                        "ordinal": task.ordinal,
                        "round": task.round,
                        "declared_fact_ids": list(dict.fromkeys(fact_ids)),
                    }
                )
            )
        if not normalized:
            raise ProviderError(
                "AI coherent creative response contained no valid candidate",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
                attempts=call.metadata.attempts,
                elapsed_ms=call.metadata.latency_ms,
            )
        if rejected_item_count:
            LOGGER.warning(
                "discarded invalid creative candidates stage=%s rejected=%s accepted=%s",
                NodeId.COHERENT_CREATIVE_GENERATION.value,
                rejected_item_count,
                len(normalized),
            )
        return AiCallResult(
            value=call.value.model_copy(update={"items": normalized}),
            metadata=call.metadata,
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
    ) -> AiCallResult[CreativeEvaluationBatch]:
        if not candidates or len(candidates) > 10:
            raise ProviderError(
                "creative evaluation batch must contain between one and ten items",
                retryable=False,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        expected = {item.slot_id for item in candidates}
        if set(target_durations) != expected or any(
            not 4 <= duration <= 30 for duration in target_durations.values()
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
        referenced = {
            fact_id for item in candidates for fact_id in item.declared_fact_ids
        }
        referenced.update(
            fact_id for fact_ids in context_by_slot.values() for fact_id in fact_ids
        )
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
                        "candidate": item.model_dump(mode="json", by_alias=True),
                        "targetDurationSeconds": target_durations[item.slot_id],
                        "assignedContextFactIds": context_by_slot.get(
                            item.slot_id,
                            [],
                        ),
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
            CreativeEvaluationBatch,
            schema_name="effect_prompt_creative_evaluation_batch",
            stage="CREATIVE_EVALUATION_CLASSIFICATION",
            prompt_file=EVALUATION_BASE_PROMPT,
            model=self._evaluation_model,
            max_output_tokens=min(
                self._evaluation_max_output_tokens,
                # Ark counts both the structured answer and reasoning tokens.
                # Real three-item shards reached the former 2,160-token limit,
                # so reserve enough room per candidate instead of truncating JSON.
                max(2048, len(candidates) * 1000),
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
        return call

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
    ) -> AiCallResult[TModel]:
        payload = {
            "model": model,
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": prompt}]}
            ],
            "store": False,
            "max_output_tokens": max_output_tokens,
            "reasoning": {"effort": self._reasoning_effort},
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": schema_name,
                    "schema": model_type.model_json_schema(by_alias=True),
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
            try:
                response = await self._client.post(
                    "responses", json=payload, timeout=request_timeout
                )
            except httpx.TimeoutException as exc:
                last_error, error_type, retryable = exc, ProviderErrorType.TIMEOUT, True
            except httpx.NetworkError as exc:
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
                                    "Ark structured response invalid stage=%s status=%s input_tokens=%s output_tokens=%s total_tokens=%s latency_ms=%s attempts=%s",
                                    stage,
                                    response_status,
                                    usage["inputTokens"],
                                    usage["outputTokens"],
                                    usage["totalTokens"],
                                    elapsed,
                                    attempt,
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
                                    "Ark call succeeded stage=%s input_tokens=%s output_tokens=%s total_tokens=%s latency_ms=%s attempts=%s",
                                    stage,
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


def _mock_creative_landscape_response(
    application: InsightApplicationMap,
    *,
    direction_count: int,
) -> CreativeDiversityLandscapeResponse:
    business_facts = mandatory_business_facts(application)
    if not business_facts:
        raise ProviderError(
            "creative landscape planning requires confirmed business facts",
            retryable=False,
            error_type=ProviderErrorType.REQUEST_REJECTED,
        )
    required_pool = list({fact.fact_id: fact for fact in application.usable}.values())
    fact_ids = [item.fact_id for item in application.usable]
    territory_count = min(
        len(_MOCK_DIRECTION_ROWS),
        direction_count,
        max(1, len(required_pool)),
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
                        action_id=f"ACTION_{index + 1:02d}",
                        label=row[3],
                        boundary=f"只以{row[3]}作为连续主动作",
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
) -> CreativeDirectionResponse:
    business_facts = mandatory_business_facts(application)
    if not business_facts:
        raise ProviderError(
            "creative direction planning requires confirmed insight facts",
            retryable=False,
            error_type=ProviderErrorType.REQUEST_REJECTED,
        )
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
                primary_action_id=territory.actions[0].action_id,
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
                    f"围绕{row[1]}中的{row[3]}建立第{index + 1}个连续产品画面"
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
    content = (
        f"{scene}内，{product}{action}，画面自然结合"
        f"{'、'.join(fact.value for fact in assigned_facts)}。"
        f"{camera}记录一个连续动作，暖色自然光突出真实质感，动作结束后主体稳定停留在画面中央。"
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
        return {
            **fact_payload(fact_id),
            "creativeUsage": direction_usage.get(
                fact_id,
                "结合当前条目的既有事实关系自然融入同一画面",
            ),
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
        },
        "factApplications": [
            fact_application_payload(fact_id) for fact_id in assignment.fact_ids
        ],
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
    if not 4 <= duration_seconds <= 30:
        raise ValueError("target duration must be between 4 and 30 seconds")
    if duration_seconds <= 8:
        return {
            "band": "SHORT_FOCUS",
            "guidance": (
                "只围绕一个可立即看懂的视觉事件，直接进入一个主动作，并在该动作形成的清晰结果上停留。"
                "不要在主动作后继续切换到烹饪、摆盘、品尝、递送或开箱等第二阶段。"
            ),
        }
    if duration_seconds <= 15:
        return {
            "band": "COMPLETE_ACTION",
            "guidance": (
                "在同一主场景和同一目标下安排 2～3 个连续动作节拍，让开端、发展与结束状态"
                "彼此衔接；不得加入第二种完整使用方法。"
            ),
        }
    if duration_seconds <= 22:
        return {
            "band": "GRADUAL_PROCESS",
            "guidance": (
                "围绕同一商品、同一主场景和同一目标安排 3 个连续动作节拍，可自然改变构图"
                "或观察角度，但不得拆成多个独立地点或完整做法。"
            ),
        }
    return {
        "band": "CONNECTED_PHASES",
        "guidance": (
            "围绕同一商品、同一主场景和同一目标安排 3～4 个连续动作节拍，形成一条可实时"
            "拍完的过程；不得用慢动作、无意义停留、分屏、时间跳跃或多种完整做法填满素材。"
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


def _mock_creative_evaluation(
    candidate: CreativeCandidate,
    application: InsightApplicationMap,
    direction_plan: CreativeDirectionPlan | None = None,
    *,
    context_fact_ids: Sequence[str] = (),
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
