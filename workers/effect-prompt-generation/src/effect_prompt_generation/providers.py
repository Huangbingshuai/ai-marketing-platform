from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace
from enum import StrEnum
from itertools import combinations
from typing import Any, Generic, Protocol, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .models import (
    BlueprintShardPlan,
    CompactMarketingRelationshipBundle,
    CompactStrategyPlan,
    DimensionPools,
    DimensionCoordinate,
    EvidenceMode,
    FragmentFactAllocation,
    FragmentDimensionCoordinatePlan,
    FragmentMarketingBundle,
    FragmentMarketingPlan,
    FragmentRelationshipBundle,
    FragmentRelationshipModelResponse,
    FragmentRelationshipPlan,
    FragmentStrategyPool,
    FragmentType,
    GeneratedBlueprint,
    GeneratedBlueprintBatch,
    GeneratedPromptText,
    GeneratedPromptTextBatch,
    InsightApplicationMap,
    InsightFact,
    InsightField,
    MarketingRelationshipBundle,
    NodeId,
    PlannedCombination,
    SharedPrompt,
    SellingPointEvidence,
    StrategyPlan,
)
from .prompt_loader import load_prompt, load_prompt_version, render_prompt
from .strategy_planning import validate_fragment_marketing_plan
from .v10_blueprints import (
    coordinate_variant_targets,
    normalize_coordinate_plan,
    normalize_coordinate_signature,
    normalize_generated_blueprints,
    relationship_hash,
    validate_coordinate_plan,
    validate_generated_blueprints,
    validate_relationship_plan,
)

TModel = TypeVar("TModel", bound=BaseModel)
LOGGER = logging.getLogger(__name__)
STRATEGY_PROMPT = "strategy_planning.prompt.txt"
FRAGMENT_STRATEGY_VERSION = "effect-prompt-fragment-strategy-v1"
FRAGMENT_STRATEGY_BASE_PROMPT = "fragment_strategy_base.system.prompt.txt"
FRAGMENT_STRATEGY_TASK_PROMPT = "fragment_strategy_task.user.prompt.txt"
FRAGMENT_STRATEGY_SYSTEM_PROMPTS: dict[FragmentType, str] = {
    FragmentType.HOOK: "fragment_strategy_hook.system.prompt.txt",
    FragmentType.PAIN: "fragment_strategy_pain.system.prompt.txt",
    FragmentType.PRODUCT_DISPLAY: "fragment_strategy_product_display.system.prompt.txt",
    FragmentType.SELLING_POINT_EXPLANATION: "fragment_strategy_selling_point.system.prompt.txt",
    FragmentType.CTA: "fragment_strategy_cta.system.prompt.txt",
    FragmentType.OUTRO: "fragment_strategy_outro.system.prompt.txt",
}
FRAGMENT_STRATEGY_STAGE_BY_TYPE: dict[FragmentType, str] = {
    FragmentType.HOOK: NodeId.PLAN_HOOK_STRATEGY.value,
    FragmentType.PAIN: NodeId.PLAN_PAIN_STRATEGY.value,
    FragmentType.PRODUCT_DISPLAY: NodeId.PLAN_PRODUCT_DISPLAY_STRATEGY.value,
    FragmentType.SELLING_POINT_EXPLANATION: (
        NodeId.PLAN_SELLING_POINT_EXPLANATION_STRATEGY.value
    ),
    FragmentType.CTA: NodeId.PLAN_CTA_STRATEGY.value,
    FragmentType.OUTRO: NodeId.PLAN_OUTRO_STRATEGY.value,
}
CANDIDATE_BASE_SYSTEM_PROMPT = "candidate_base.system.prompt.txt"
CANDIDATE_TASK_PROMPT = "candidate_task.user.prompt.txt"
CANDIDATE_SYSTEM_PROMPTS: dict[FragmentType, str] = {
    FragmentType.HOOK: "candidate_hook.system.prompt.txt",
    FragmentType.PAIN: "candidate_pain.system.prompt.txt",
    FragmentType.PRODUCT_DISPLAY: "candidate_product_display.system.prompt.txt",
    FragmentType.SELLING_POINT_EXPLANATION: "candidate_selling_point.system.prompt.txt",
    FragmentType.CTA: "candidate_cta.system.prompt.txt",
    FragmentType.OUTRO: "candidate_outro.system.prompt.txt",
}
CANDIDATE_STAGE_BY_TYPE: dict[FragmentType, str] = {
    FragmentType.HOOK: NodeId.GENERATE_HOOK.value,
    FragmentType.PAIN: NodeId.GENERATE_PAIN.value,
    FragmentType.PRODUCT_DISPLAY: NodeId.GENERATE_PRODUCT_DISPLAY.value,
    FragmentType.SELLING_POINT_EXPLANATION: NodeId.GENERATE_SELLING_POINT_EXPLANATION.value,
    FragmentType.CTA: NodeId.GENERATE_CTA.value,
    FragmentType.OUTRO: NodeId.GENERATE_OUTRO.value,
}
V10_RELATIONSHIP_VERSION = "effect-prompt-v10-relationship-v2"
V10_COORDINATE_VERSION = "effect-prompt-v10-coordinate-v8"
V10_RELATIONSHIP_BASE_PROMPT = "v10_relationship_base.system.prompt.txt"
V10_RELATIONSHIP_TASK_PROMPT = "v10_relationship_task.user.prompt.txt"
V10_COORDINATE_BASE_PROMPT = "v10_coordinate_base.system.prompt.txt"
V10_COORDINATE_TASK_PROMPT = "v10_coordinate_task.user.prompt.txt"
V10_BLUEPRINT_BASE_PROMPT = "v10_blueprint_base.system.prompt.txt"
V10_BLUEPRINT_TASK_PROMPT = "v10_blueprint_task.user.prompt.txt"

RELATIONSHIP_STAGE_BY_TYPE: dict[FragmentType, str] = {
    FragmentType.HOOK: NodeId.PLAN_HOOK_RELATIONSHIPS.value,
    FragmentType.PAIN: NodeId.PLAN_PAIN_RELATIONSHIPS.value,
    FragmentType.PRODUCT_DISPLAY: NodeId.PLAN_PRODUCT_DISPLAY_RELATIONSHIPS.value,
    FragmentType.SELLING_POINT_EXPLANATION: NodeId.PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS.value,
    FragmentType.CTA: NodeId.PLAN_CTA_RELATIONSHIPS.value,
    FragmentType.OUTRO: NodeId.PLAN_OUTRO_RELATIONSHIPS.value,
}
COORDINATE_STAGE_BY_TYPE: dict[FragmentType, str] = {
    FragmentType.HOOK: NodeId.PLAN_HOOK_COORDINATES.value,
    FragmentType.PAIN: NodeId.PLAN_PAIN_COORDINATES.value,
    FragmentType.PRODUCT_DISPLAY: NodeId.PLAN_PRODUCT_DISPLAY_COORDINATES.value,
    FragmentType.SELLING_POINT_EXPLANATION: NodeId.PLAN_SELLING_POINT_EXPLANATION_COORDINATES.value,
    FragmentType.CTA: NodeId.PLAN_CTA_COORDINATES.value,
    FragmentType.OUTRO: NodeId.PLAN_OUTRO_COORDINATES.value,
}
BLUEPRINT_STAGE_BY_TYPE: dict[FragmentType, str] = {
    FragmentType.HOOK: NodeId.GENERATE_HOOK_BLUEPRINTS.value,
    FragmentType.PAIN: NodeId.GENERATE_PAIN_BLUEPRINTS.value,
    FragmentType.PRODUCT_DISPLAY: NodeId.GENERATE_PRODUCT_DISPLAY_BLUEPRINTS.value,
    FragmentType.SELLING_POINT_EXPLANATION: NodeId.GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS.value,
    FragmentType.CTA: NodeId.GENERATE_CTA_BLUEPRINTS.value,
    FragmentType.OUTRO: NodeId.GENERATE_OUTRO_BLUEPRINTS.value,
}


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
    prompt_version: str
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


class AiProvider(Protocol):
    async def plan_strategy(
        self, application: InsightApplicationMap, *, target_count: int
    ) -> AiCallResult[StrategyPlan]: ...

    async def plan_fragment_strategy(
        self,
        allocation: FragmentFactAllocation,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
    ) -> AiCallResult[FragmentMarketingPlan]: ...

    async def plan_fragment_relationships(
        self,
        allocation: FragmentFactAllocation,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
    ) -> AiCallResult[FragmentRelationshipPlan]: ...

    async def plan_dimension_coordinates(
        self,
        relationships: FragmentRelationshipPlan,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        target_count: int,
    ) -> AiCallResult[FragmentDimensionCoordinatePlan]: ...

    async def generate_blueprints(
        self,
        shard: BlueprintShardPlan,
        *,
        relationships: FragmentRelationshipPlan,
        coordinate_plan: FragmentDimensionCoordinatePlan,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        avoid_signatures: list[list[str]] | None = None,
    ) -> AiCallResult[GeneratedBlueprintBatch]: ...

    async def generate_candidates(
        self,
        combinations: list[PlannedCombination],
        *,
        insight: Mapping[str, Any],
        shared_prompt: SharedPrompt,
        regeneration_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[GeneratedPromptTextBatch]: ...


class MockAiProvider:
    async def plan_strategy(
        self, application: InsightApplicationMap, *, target_count: int
    ) -> AiCallResult[StrategyPlan]:
        plan = _deterministic_strategy_plan(application)
        return _mock_result(
            plan,
            "STRATEGY_PLANNING",
            STRATEGY_PROMPT,
            model_relationship_bundle_count=len(plan.relationship_bundles),
            worker_completed_relationship_bundle_count=0,
        )

    async def plan_fragment_strategy(
        self,
        allocation: FragmentFactAllocation,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
    ) -> AiCallResult[FragmentMarketingPlan]:
        plan = _mock_fragment_marketing_plan(allocation, application)
        return _mock_result(
            plan,
            FRAGMENT_STRATEGY_STAGE_BY_TYPE[allocation.fragment_type],
            FRAGMENT_STRATEGY_SYSTEM_PROMPTS[allocation.fragment_type],
        )

    async def plan_fragment_relationships(
        self,
        allocation: FragmentFactAllocation,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
    ) -> AiCallResult[FragmentRelationshipPlan]:
        selected_by_bundle: list[list[str]] = [
            [] for _ in range(allocation.bundle_target)
        ]
        for index, fact_id in enumerate(allocation.mandatory_fact_ids):
            selected_by_bundle[index % allocation.bundle_target].append(fact_id)
        for index, selected in enumerate(selected_by_bundle):
            candidate = allocation.candidate_fact_ids[index % len(allocation.candidate_fact_ids)]
            if candidate not in selected:
                selected.append(candidate)
        bundles = []
        for index, selected in enumerate(selected_by_bundle):
            primary = selected[0]
            bundles.append(
                FragmentRelationshipBundle(
                    bundle_id=f"{allocation.fragment_type.value}-R{index + 1}",
                    fragment_type=allocation.fragment_type,
                    primary_fact_id=primary,
                    fact_ids=selected,
                    creative_intent=f"以第 {index + 1} 组已确认事实完成当前片段职责",
                )
            )
        plan = FragmentRelationshipPlan(
            fragment_type=allocation.fragment_type,
            bundles=bundles,
            allocation_hash=allocation.allocation_hash,
            prompt_version=V10_RELATIONSHIP_VERSION,
        )
        return _mock_result(
            plan,
            RELATIONSHIP_STAGE_BY_TYPE[allocation.fragment_type],
            V10_RELATIONSHIP_BASE_PROMPT,
        )

    async def plan_dimension_coordinates(
        self,
        relationships: FragmentRelationshipPlan,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        target_count: int,
    ) -> AiCallResult[FragmentDimensionCoordinatePlan]:
        plan = _mock_coordinate_plan(relationships, application, target_count)
        return _mock_result(
            plan,
            COORDINATE_STAGE_BY_TYPE[relationships.fragment_type],
            V10_COORDINATE_BASE_PROMPT,
        )

    async def generate_blueprints(
        self,
        shard: BlueprintShardPlan,
        *,
        relationships: FragmentRelationshipPlan,
        coordinate_plan: FragmentDimensionCoordinatePlan,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        avoid_signatures: list[list[str]] | None = None,
    ) -> AiCallResult[GeneratedBlueprintBatch]:
        del relationships, application, shared_prompt, avoid_signatures
        items = _mock_blueprints(shard, coordinate_plan)
        return _mock_result(
            GeneratedBlueprintBatch(items=items),
            BLUEPRINT_STAGE_BY_TYPE[shard.fragment_type],
            V10_BLUEPRINT_BASE_PROMPT,
        )

    async def generate_candidates(
        self,
        combinations: list[PlannedCombination],
        *,
        insight: Mapping[str, Any],
        shared_prompt: SharedPrompt,
        regeneration_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[GeneratedPromptTextBatch]:
        fragment_type = _homogeneous_fragment_type(combinations)
        product_name = _first_text(insight, "productName", "product_name") or "产品"
        items = []
        for combo in combinations:
            items.append(
                _mock_prompt_text(
                    combo,
                    product_name=product_name,
                )
            )
        return _mock_result(
            GeneratedPromptTextBatch(items=items),
            CANDIDATE_STAGE_BY_TYPE[fragment_type],
            CANDIDATE_SYSTEM_PROMPTS[fragment_type],
        )


class ArkResponsesProvider:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        strategy_model: str,
        candidate_model: str,
        fragment_strategy_model: str | None = None,
        blueprint_model: str | None = None,
        strategy_max_output_tokens: int = 8192,
        candidate_max_output_tokens: int = 4096,
        fragment_strategy_max_output_tokens: int = 3072,
        reasoning_effort: str = "minimal",
        strategy_timeout: float = 180.0,
        candidate_timeout: float = 120.0,
        fragment_strategy_timeout: float = 120.0,
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
        self._strategy_max_output_tokens = strategy_max_output_tokens
        self._candidate_max_output_tokens = candidate_max_output_tokens
        self._fragment_strategy_max_output_tokens = fragment_strategy_max_output_tokens
        self._reasoning_effort = reasoning_effort
        self._strategy_timeout = strategy_timeout
        self._candidate_timeout = candidate_timeout
        self._fragment_strategy_timeout = fragment_strategy_timeout
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

    async def plan_strategy(
        self, application: InsightApplicationMap, *, target_count: int
    ) -> AiCallResult[StrategyPlan]:
        allowed = [
            fact.value
            for fact in application.usable
            if fact.field
            in {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT}
        ]
        if not allowed:
            raise ProviderError(
                "产品素材制作信息卡缺少已确认卖点",
                retryable=False,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        prompt = render_prompt(
            STRATEGY_PROMPT,
            target_count=str(target_count),
            insight_json=json.dumps(
                _strategy_context(application),
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            CompactStrategyPlan,
            schema_name="effect_prompt_compact_strategy_plan_v8",
            stage="STRATEGY_PLANNING",
            prompt_file=STRATEGY_PROMPT,
            model=self._strategy_model,
            max_output_tokens=self._strategy_max_output_tokens,
            request_timeout=self._strategy_timeout,
        )
        model_bundles = _materialize_compact_relationship_bundles(
            call.value.relationship_bundles,
            application,
        )
        protected_bundles = _complete_relationship_bundles(model_bundles, application)
        strategy = _deterministic_strategy_plan(
            application,
            relationship_bundles=protected_bundles,
        )
        return AiCallResult(
            value=strategy,
            metadata=replace(
                call.metadata,
                model_relationship_bundle_count=len(model_bundles),
                worker_completed_relationship_bundle_count=max(
                    0, len(protected_bundles) - len(model_bundles)
                ),
            ),
        )

    async def plan_fragment_strategy(
        self,
        allocation: FragmentFactAllocation,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
    ) -> AiCallResult[FragmentMarketingPlan]:
        candidate_facts = [
            application.by_id[fact_id].model_dump(
                mode="json",
                by_alias=True,
                exclude={"eligible_fragment_types", "exclusion_reason"},
            )
            for fact_id in allocation.candidate_fact_ids
        ]
        prompt = render_prompt(
            FRAGMENT_STRATEGY_TASK_PROMPT,
            fragment_type=allocation.fragment_type.value,
            target_count=str(allocation.target_count),
            bundle_target=str(allocation.bundle_target),
            mandatory_fact_ids_json=json.dumps(
                allocation.mandatory_fact_ids, ensure_ascii=False
            ),
            candidate_facts_json=json.dumps(
                candidate_facts, ensure_ascii=False, sort_keys=True
            ),
            shared_prompt=shared_prompt.compiled_content or "未设置",
            allocation_hash=allocation.allocation_hash,
        )
        call = await self._structured(
            prompt,
            FragmentMarketingPlan,
            schema_name=(
                f"effect_prompt_{allocation.fragment_type.value.lower()}_strategy_v1"
            ),
            stage=FRAGMENT_STRATEGY_STAGE_BY_TYPE[allocation.fragment_type],
            prompt_file=FRAGMENT_STRATEGY_SYSTEM_PROMPTS[allocation.fragment_type],
            model=self._fragment_strategy_model,
            max_output_tokens=self._fragment_strategy_max_output_tokens,
            request_timeout=self._fragment_strategy_timeout,
            instructions=(
                load_prompt(FRAGMENT_STRATEGY_BASE_PROMPT)
                + "\n\n"
                + load_prompt(
                    FRAGMENT_STRATEGY_SYSTEM_PROMPTS[allocation.fragment_type]
                )
            ),
        )
        try:
            if call.value.prompt_version != FRAGMENT_STRATEGY_VERSION:
                raise ValueError("fragment strategy prompt version mismatch")
            validate_fragment_marketing_plan(call.value, allocation, application)
        except ValueError as exc:
            raise ProviderError(
                "AI fragment strategy response violated its allocation",
                retryable=True,
                error_type=ProviderErrorType.RESPONSE_INVALID,
                attempts=call.metadata.attempts,
                elapsed_ms=call.metadata.latency_ms,
            ) from exc
        return call

    async def plan_fragment_relationships(
        self,
        allocation: FragmentFactAllocation,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
    ) -> AiCallResult[FragmentRelationshipPlan]:
        candidate_facts = [
            application.by_id[fact_id].model_dump(
                mode="json", by_alias=True, exclude={"eligible_fragment_types", "exclusion_reason"}
            )
            for fact_id in allocation.candidate_fact_ids
        ]
        prompt = render_prompt(
            V10_RELATIONSHIP_TASK_PROMPT,
            fragment_type=allocation.fragment_type.value,
            target_count=str(allocation.target_count),
            bundle_target=str(allocation.bundle_target),
            mandatory_fact_ids_json=json.dumps(allocation.mandatory_fact_ids, ensure_ascii=False),
            candidate_facts_json=json.dumps(candidate_facts, ensure_ascii=False, sort_keys=True),
            shared_prompt=shared_prompt.compiled_content or "未设置",
            allocation_hash=allocation.allocation_hash,
        )
        call = await self._structured(
            prompt,
            FragmentRelationshipModelResponse,
            schema_name=f"effect_prompt_{allocation.fragment_type.value.lower()}_relationships_v10",
            stage=RELATIONSHIP_STAGE_BY_TYPE[allocation.fragment_type],
            prompt_file=V10_RELATIONSHIP_BASE_PROMPT,
            model=self._strategy_model,
            max_output_tokens=min(self._strategy_max_output_tokens, 3072),
            request_timeout=self._strategy_timeout,
            instructions=load_prompt(V10_RELATIONSHIP_BASE_PROMPT),
        )
        try:
            plan = _normalize_relationship_model_response(
                call.value, allocation, application
            )
            validate_relationship_plan(plan, allocation, application)
        except ValueError as exc:
            raise ProviderError(
                "AI relationship response violated its fact allocation",
                retryable=True,
                error_type=ProviderErrorType.RESPONSE_INVALID,
                attempts=call.metadata.attempts,
                elapsed_ms=call.metadata.latency_ms,
            ) from exc
        return AiCallResult(value=plan, metadata=call.metadata)

    async def plan_dimension_coordinates(
        self,
        relationships: FragmentRelationshipPlan,
        *,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        target_count: int,
    ) -> AiCallResult[FragmentDimensionCoordinatePlan]:
        facts = [
            application.by_id[fact_id].model_dump(mode="json", by_alias=True)
            for fact_id in dict.fromkeys(
                fact_id for bundle in relationships.bundles for fact_id in bundle.fact_ids
            )
        ]
        plan_hash = relationship_hash(relationships)
        variant_targets = coordinate_variant_targets(
            relationships, target_count
        )
        shared_variant_count = min(5, max(variant_targets.values()) + 2)
        prompt = render_prompt(
            V10_COORDINATE_TASK_PROMPT,
            fragment_type=relationships.fragment_type.value,
            target_count=str(target_count),
            facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
            relationships_json=json.dumps(
                relationships.model_dump(mode="json", by_alias=True), ensure_ascii=False, sort_keys=True
            ),
            fragment_rules=_fragment_rule(relationships.fragment_type),
            shared_prompt=shared_prompt.compiled_content or "未设置",
            relationship_hash=plan_hash,
            quota_json=json.dumps(
                variant_targets, ensure_ascii=False, sort_keys=True
            ),
            bundle_ids_json=json.dumps(
                list(variant_targets), ensure_ascii=False
            ),
            shared_variant_count=str(shared_variant_count),
        )
        call = await self._structured(
            prompt,
            FragmentDimensionCoordinatePlan,
            schema_name=f"effect_prompt_{relationships.fragment_type.value.lower()}_coordinates_v10",
            stage=COORDINATE_STAGE_BY_TYPE[relationships.fragment_type],
            prompt_file=V10_COORDINATE_BASE_PROMPT,
            model=self._blueprint_model,
            max_output_tokens=min(self._strategy_max_output_tokens, 6144),
            request_timeout=self._strategy_timeout,
            instructions=load_prompt(V10_COORDINATE_BASE_PROMPT),
        )
        try:
            normalized_plan = normalize_coordinate_plan(
                call.value, relationships
            ).model_copy(
                update={
                    "fragment_type": relationships.fragment_type,
                    "relationship_allocation_hash": plan_hash,
                    "prompt_version": V10_COORDINATE_VERSION,
                }
            )
            validate_coordinate_plan(
                normalized_plan,
                relationships,
                application,
            )
        except ValueError as exc:
            raise ProviderError(
                "AI coordinate plan violated its relationship allocation",
                retryable=True,
                error_type=ProviderErrorType.RESPONSE_INVALID,
                attempts=call.metadata.attempts,
                elapsed_ms=call.metadata.latency_ms,
            ) from exc
        return AiCallResult(value=normalized_plan, metadata=call.metadata)

    async def generate_blueprints(
        self,
        shard: BlueprintShardPlan,
        *,
        relationships: FragmentRelationshipPlan,
        coordinate_plan: FragmentDimensionCoordinatePlan,
        application: InsightApplicationMap,
        shared_prompt: SharedPrompt,
        avoid_signatures: list[list[str]] | None = None,
    ) -> AiCallResult[GeneratedBlueprintBatch]:
        facts = [
            application.by_id[fact_id].model_dump(mode="json", by_alias=True)
            for fact_id in dict.fromkeys(fact_id for task in shard.tasks for fact_id in task.fact_ids)
        ]
        prompt = render_prompt(
            V10_BLUEPRINT_TASK_PROMPT,
            facts_json=json.dumps(facts, ensure_ascii=False, sort_keys=True),
            relationships_json=json.dumps(
                relationships.model_dump(mode="json", by_alias=True), ensure_ascii=False, sort_keys=True
            ),
            coordinate_plan_json=json.dumps(
                coordinate_plan.model_dump(mode="json", by_alias=True), ensure_ascii=False, sort_keys=True
            ),
            tasks_json=json.dumps(
                [item.model_dump(mode="json", by_alias=True) for item in shard.tasks],
                ensure_ascii=False,
                sort_keys=True,
            ),
            shared_prompt=shared_prompt.compiled_content or "未设置",
            avoid_signatures_json=json.dumps(avoid_signatures or [], ensure_ascii=False),
        )
        call = await self._structured(
            prompt,
            GeneratedBlueprintBatch,
            schema_name=f"effect_prompt_{shard.fragment_type.value.lower()}_blueprints_v10",
            stage=BLUEPRINT_STAGE_BY_TYPE[shard.fragment_type],
            prompt_file=V10_BLUEPRINT_BASE_PROMPT,
            model=self._blueprint_model,
            max_output_tokens=min(self._strategy_max_output_tokens, max(1536, len(shard.tasks) * 640)),
            request_timeout=self._strategy_timeout,
            instructions=load_prompt(V10_BLUEPRINT_BASE_PROMPT),
        )
        try:
            normalized_items = normalize_generated_blueprints(call.value.items, shard.tasks)
            validate_generated_blueprints(normalized_items, shard.tasks, coordinate_plan)
        except ValueError as exc:
            raise ProviderError(
                "AI blueprint response changed locked coordinates or facts",
                retryable=True,
                error_type=ProviderErrorType.RESPONSE_INVALID,
                attempts=call.metadata.attempts,
                elapsed_ms=call.metadata.latency_ms,
            ) from exc
        return AiCallResult(
            value=GeneratedBlueprintBatch(items=normalized_items),
            metadata=call.metadata,
        )

    async def generate_candidates(
        self,
        combinations: list[PlannedCombination],
        *,
        insight: Mapping[str, Any],
        shared_prompt: SharedPrompt,
        regeneration_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[GeneratedPromptTextBatch]:
        fragment_type = _homogeneous_fragment_type(combinations)
        product_context = _candidate_product_context(insight)
        prompt = render_prompt(
            CANDIDATE_TASK_PROMPT,
            delivery_channels=_first_text(
                insight, "deliveryChannels", "delivery_channels"
            )
            or "以信息卡为准",
            visual_style=_first_text(
                insight, "visualStyleBaseline", "visual_style_baseline"
            )
            or "以信息卡为准",
            shared_prompt_json=json.dumps(
                shared_prompt.model_dump(mode="json", by_alias=True),
                ensure_ascii=False,
                sort_keys=True,
            ),
            product_context_json=json.dumps(
                product_context, ensure_ascii=False, sort_keys=True
            ),
            combinations_json=json.dumps(
                [item.model_dump(mode="json", by_alias=True) for item in combinations],
                ensure_ascii=False,
                sort_keys=True,
            ),
            regeneration_context_json=json.dumps(
                regeneration_context or {}, ensure_ascii=False, sort_keys=True
            ),
        )
        call = await self._structured(
            prompt,
            GeneratedPromptTextBatch,
            schema_name=f"effect_prompt_{fragment_type.value.lower()}_batch",
            stage=CANDIDATE_STAGE_BY_TYPE[fragment_type],
            prompt_file=CANDIDATE_SYSTEM_PROMPTS[fragment_type],
            model=self._candidate_model,
            max_output_tokens=min(
                self._candidate_max_output_tokens,
                max(768, len(combinations) * 360),
            ),
            request_timeout=self._candidate_timeout,
            instructions=(
                load_prompt(CANDIDATE_BASE_SYSTEM_PROMPT)
                + "\n\n"
                + load_prompt(CANDIDATE_SYSTEM_PROMPTS[fragment_type])
            ),
        )
        expected = {item.slot_id for item in combinations}
        actual = [item.slot_id for item in call.value.items]
        if len(actual) != len(set(actual)) or set(actual) != expected:
            raise ProviderError(
                "AI structured response has missing, duplicate, or unknown slotId",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
                attempts=call.metadata.attempts,
                elapsed_ms=call.metadata.latency_ms,
            )
        combinations_by_slot = {item.slot_id: item for item in combinations}
        normalized_items = []
        normalized_binding_count = 0
        for item in call.value.items:
            expected_fact_ids = [
                binding.fact_id
                for binding in combinations_by_slot[item.slot_id].insight_bindings
            ]
            if item.used_fact_ids != expected_fact_ids:
                normalized_binding_count += 1
            normalized_items.append(
                item.model_copy(update={"used_fact_ids": expected_fact_ids})
            )
        if normalized_binding_count:
            LOGGER.warning(
                "Ark candidate fact bindings normalized stage=%s item_count=%s",
                CANDIDATE_STAGE_BY_TYPE[fragment_type],
                normalized_binding_count,
            )
        return AiCallResult(
            value=call.value.model_copy(update={"items": normalized_items}),
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
                                and incomplete_reason == "max_output_tokens"
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
                                value = model_type.model_validate_json(
                                    _output_text(response_payload)
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
                                        prompt_version=load_prompt_version(prompt_file),
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
            prompt_version=load_prompt_version(prompt_file),
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


def _normalize_relationship_model_response(
    response: FragmentRelationshipModelResponse,
    allocation: FragmentFactAllocation,
    application: InsightApplicationMap,
) -> FragmentRelationshipPlan:
    """Select an exact, safe bundle set while freezing worker-owned metadata.

    Ark's structured output guarantees field shapes but may not enforce array-size
    annotations consistently. Extra bundles are alternatives, not a reason to repeat every
    paid branch. The worker never invents facts or relationships here.
    """

    candidate_ids = set(allocation.candidate_fact_ids)
    known_ids = set(application.by_id)
    valid: list[FragmentRelationshipBundle] = []
    seen_signatures: set[tuple[str, tuple[str, ...]]] = set()
    for bundle in response.bundles:
        fact_ids = list(dict.fromkeys(bundle.fact_ids))
        if (
            not fact_ids
            or bundle.primary_fact_id not in fact_ids
            or any(
                fact_id not in candidate_ids or fact_id not in known_ids
                for fact_id in fact_ids
            )
        ):
            continue
        signature = (bundle.primary_fact_id, tuple(fact_ids))
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        valid.append(
            bundle.model_copy(
                update={
                    "fragment_type": allocation.fragment_type,
                    "fact_ids": fact_ids,
                }
            )
        )

    mandatory = set(allocation.mandatory_fact_ids)
    exact_sets = [
        rows
        for rows in combinations(enumerate(valid), allocation.bundle_target)
        if mandatory.issubset(
            fact_id for _, bundle in rows for fact_id in bundle.fact_ids
        )
    ]
    if not exact_sets:
        raise ValueError("relationship model response cannot satisfy the exact allocation")
    chosen = max(
        exact_sets,
        key=lambda rows: (
            len({fact_id for _, bundle in rows for fact_id in bundle.fact_ids}),
            sum(len(bundle.fact_ids) for _, bundle in rows),
            tuple(-index for index, _ in rows),
        ),
    )
    selected = [bundle for _, bundle in chosen]

    frozen = [
        bundle.model_copy(
            update={
                "bundle_id": f"{allocation.fragment_type.value}-R{index + 1}",
                "fragment_type": allocation.fragment_type,
            }
        )
        for index, bundle in enumerate(selected)
    ]
    return FragmentRelationshipPlan(
        fragment_type=allocation.fragment_type,
        bundles=frozen,
        allocation_hash=allocation.allocation_hash,
        prompt_version=V10_RELATIONSHIP_VERSION,
    )


def _candidate_product_context(insight: Mapping[str, Any]) -> dict[str, object]:
    aliases: tuple[tuple[str, tuple[str, ...]], ...] = (
        ("productName", ("productName", "product_name")),
        ("productCategory", ("productCategory", "product_category")),
        ("coreSpecification", ("coreSpecification", "core_specification")),
        ("visualFeatures", ("visualFeatures", "visual_features")),
        ("coreSellingPoints", ("coreSellingPoints", "core_selling_points")),
        (
            "secondarySellingPoints",
            ("secondarySellingPoints", "secondary_selling_points"),
        ),
        ("targetAudience", ("targetAudience", "target_audience")),
        ("corePainPoints", ("corePainPoints", "core_pain_points")),
        ("decisionDrivers", ("decisionDrivers", "decision_drivers")),
        ("marketingGoal", ("marketingGoal", "marketing_goal")),
        ("usageScenarios", ("usageScenarios", "usage_scenarios")),
        ("purchaseScenarios", ("purchaseScenarios", "purchase_scenarios")),
        ("emotionalScenarios", ("emotionalScenarios", "emotional_scenarios")),
        ("deliveryChannels", ("deliveryChannels", "delivery_channels")),
        ("visualStyleBaseline", ("visualStyleBaseline", "visual_style_baseline")),
    )
    result: dict[str, object] = {}
    for output_key, input_keys in aliases:
        value = next((insight[key] for key in input_keys if key in insight), None)
        if isinstance(value, (str, int, float, bool)) or value is None:
            result[output_key] = value
        elif isinstance(value, list):
            result[output_key] = [
                item for item in value if isinstance(item, (str, int, float, bool))
            ]
    return result


def _homogeneous_fragment_type(combinations: list[PlannedCombination]) -> FragmentType:
    if not combinations:
        raise ProviderError(
            "candidate shard cannot be empty",
            retryable=False,
            error_type=ProviderErrorType.REQUEST_REJECTED,
        )
    fragment_types = {item.fragment_type for item in combinations}
    if len(fragment_types) != 1:
        raise ProviderError(
            "candidate shard must contain one fragment type",
            retryable=False,
            error_type=ProviderErrorType.REQUEST_REJECTED,
        )
    return next(iter(fragment_types))


def _mock_prompt_text(
    combination: PlannedCombination,
    *,
    product_name: str,
) -> GeneratedPromptText:
    dims = combination.dimensions
    maximum_length = (
        150
        if combination.target_duration_seconds <= 5
        else 200
        if combination.target_duration_seconds <= 8
        else 260
    )
    budgets = (
        (18, 20, 18, 25, 18, 12, 22)
        if maximum_length == 150
        else (25, 28, 25, 38, 28, 18, 30)
        if maximum_length == 200
        else (32, 36, 32, 50, 36, 24, 40)
    )
    if combination.fragment_type == FragmentType.SELLING_POINT_EXPLANATION:
        budgets = (
            (16, 18, 15, 22, 16, 10, 18)
            if maximum_length == 150
            else (22, 24, 20, 30, 22, 15, 25)
            if maximum_length == 200
            else (28, 32, 28, 42, 30, 20, 34)
        )
    scene = _prompt_clause(dims.scene, budgets[0])
    persona = _prompt_clause(dims.persona, budgets[1])
    opening = _prompt_clause(combination.opening_state, budgets[2])
    action = _prompt_clause(
        combination.visible_action.replace("产品", product_name).replace("·", "，"),
        budgets[3],
    )
    camera = _prompt_clause(dims.camera, budgets[4])
    ending = _prompt_clause(combination.ending_state, budgets[6])
    emotion = _prompt_clause(dims.emotion, budgets[5])
    abstract_selling_point = combination.evidence_mode in {
        EvidenceMode.TEXT_ONLY,
        EvidenceMode.PROCESS_ONLY,
    }
    role_text = {
        FragmentType.HOOK: (
            f"{scene}，{persona}。{opening}；{action}。{camera}，自然光下{emotion}。{ending}。"
        ),
        FragmentType.PAIN: (
            f"{scene.replace('使用', '生活')}，{persona.replace('完成', '执行')}。"
            f"{opening}；{action}。{camera}，自然光下{emotion}。{ending}。"
        ),
        FragmentType.PRODUCT_DISPLAY: (
            f"{scene}，{product_name}首帧清楚，{persona}。"
            f"{opening}；{action}。{camera}，自然光下{emotion}。{ending}。"
        ),
        FragmentType.SELLING_POINT_EXPLANATION: (
            f"{scene}，{product_name}首帧对准操作部位，{persona}。"
            f"{opening}；{action}。{camera}，自然光下{emotion}，"
            + (
                f"真实外观和接触位置清楚。{ending}。"
                if abstract_selling_point
                else {
                    EvidenceMode.VISIBLE_ATTRIBUTE: f"真实表面细节清楚。{ending}。",
                    EvidenceMode.USAGE_ACTION: f"操作部位和动作关系清楚。{ending}。",
                    EvidenceMode.VISIBLE_RESULT: f"停在完成状态且结果可见。{ending}。",
                }[combination.evidence_mode]
            )
        ),
        FragmentType.CTA: (
            f"{scene}，{product_name}首帧清楚，{persona}。"
            f"{opening}；{action}。{camera}，自然光下{emotion}。{ending}。"
        ),
        FragmentType.OUTRO: (
            f"{scene}，{product_name}首帧稳定，{persona}。"
            f"{opening}；{action}。{camera}，自然光下{emotion}。{ending}。"
        ),
    }[combination.fragment_type]
    prompt = role_text
    if len(prompt) > maximum_length:
        prompt = prompt[: maximum_length - 1].rstrip("，；。 ") + "。"
    return GeneratedPromptText(
        slot_id=combination.slot_id,
        prompt_text=prompt,
        used_fact_ids=[binding.fact_id for binding in combination.insight_bindings],
    )


def _prompt_clause(value: str, limit: int) -> str:
    cleaned = " ".join(value.replace("·", "，").split()).strip("，。； ")
    return cleaned[:limit].rstrip("，。； ")


def _deterministic_strategy_plan(
    application: InsightApplicationMap,
    *,
    relationship_bundles: list[MarketingRelationshipBundle] | None = None,
) -> StrategyPlan:
    selling_points = _unique_texts(
        fact.value
        for fact in application.usable
        if fact.field
        in {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT}
    )
    if not selling_points:
        raise ProviderError(
            "产品素材制作信息卡缺少已确认卖点",
            retryable=False,
            error_type=ProviderErrorType.REQUEST_REJECTED,
        )
    scenario_values = _unique_texts(
        fact.value
        for fact in application.usable
        if fact.field
        in {
            InsightField.USAGE_SCENARIO,
            InsightField.PURCHASE_SCENARIO,
            InsightField.EMOTIONAL_SCENARIO,
        }
    )
    scenes = _unique_texts(_mock_concrete_scene(item) for item in scenario_values)
    if not scenes:
        scenes = ["真实生活场景中的简洁桌面"]
    audience_values = _unique_texts(
        fact.value
        for fact in application.usable
        if fact.field == InsightField.TARGET_AUDIENCE
    )
    personas = _unique_texts(
        [
            *(_mock_persona(item) for item in audience_values),
            "一双成年人的手，人物不露脸",
            "无人出镜，产品独立放在桌面中央",
        ]
    )
    return StrategyPlan(
        dimension_pools=DimensionPools(
            scenes=scenes[:24],
            personas=personas[:24],
            selling_points=selling_points,
            evidence_plans=[_mock_evidence_plan(item) for item in selling_points],
        ),
        fragment_strategy_pools=_default_fragment_strategy_pools(),
        relationship_bundles=relationship_bundles
        if relationship_bundles is not None
        else _mock_relationship_bundles(application),
    )


def merge_fragment_marketing_plans(
    application: InsightApplicationMap,
    plans: list[FragmentMarketingPlan],
    *,
    required_fragment_types: set[FragmentType] | None = None,
) -> StrategyPlan:
    expected = required_fragment_types or set(FragmentType)
    by_type = {plan.fragment_type: plan for plan in plans}
    if len(by_type) != len(plans) or set(by_type) != expected:
        raise ValueError("fragment strategy merge is missing or duplicates a required type")
    covered: set[str] = set()
    relationships: list[MarketingRelationshipBundle] = []
    for fragment_type in FragmentType:
        if fragment_type not in expected:
            continue
        for bundle in by_type[fragment_type].bundles:
            facts = [application.by_id[fact_id] for fact_id in bundle.fact_ids]
            covered.update(bundle.fact_ids)
            selling_fact = next(
                (
                    fact
                    for fact in facts
                    if fact.field
                    in {
                        InsightField.CORE_SELLING_POINT,
                        InsightField.SECONDARY_SELLING_POINT,
                    }
                ),
                None,
            )
            primary = application.by_id[bundle.primary_fact_id]
            selling_point = (
                selling_fact.value
                if selling_fact
                else "产品身份与真实外观"
                if fragment_type in {FragmentType.PRODUCT_DISPLAY, FragmentType.CTA}
                else primary.value
                if fragment_type
                in {
                    FragmentType.SELLING_POINT_EXPLANATION,
                }
                else "按当前片段职责表达已绑定事实"
            )
            evidence = _mock_evidence_plan(selling_point)
            if evidence.evidence_mode in {
                EvidenceMode.TEXT_ONLY,
                EvidenceMode.PROCESS_ONLY,
            } and any(
                token in bundle.action_arc
                for token in ("证明", "验证", "检测", "对比证实", "功效")
            ):
                raise ValueError("fragment strategy conflicts with safe evidence mode")
            relationships.append(
                MarketingRelationshipBundle(
                    bundle_id=bundle.bundle_id,
                    fact_ids=bundle.fact_ids,
                    eligible_fragment_types=[fragment_type],
                    scene=bundle.scene,
                    persona=_safe_relationship_persona(bundle.persona),
                    selling_point=selling_point,
                    primary_fact_id=bundle.primary_fact_id,
                    creative_intent=bundle.creative_intent,
                    opening_state=bundle.opening_state,
                    action_arc=bundle.action_arc,
                    camera=bundle.camera,
                    emotion=bundle.emotion,
                    ending_state=bundle.ending_state,
                )
            )
    required_ids = (
        {fact.fact_id for fact in application.required}
        if expected == set(FragmentType)
        else set()
    )
    if not required_ids.issubset(covered):
        raise ValueError("fragment strategy merge missed required facts")
    return _deterministic_strategy_plan(
        application,
        relationship_bundles=relationships,
    )


def _mock_fragment_marketing_plan(
    allocation: FragmentFactAllocation,
    application: InsightApplicationMap,
) -> FragmentMarketingPlan:
    facts = application.by_id
    candidates = allocation.candidate_fact_ids
    fact_sets: list[list[str]] = [[] for _ in range(allocation.bundle_target)]
    for index, fact_id in enumerate(allocation.mandatory_fact_ids):
        fact_sets[index % allocation.bundle_target].append(fact_id)
    signatures: set[tuple[str, ...]] = set()
    pool = _fragment_strategy_pool_for_mock(allocation.fragment_type)
    bundles: list[FragmentMarketingBundle] = []
    for index, selected in enumerate(fact_sets):
        for offset in range(len(candidates)):
            fact_id = candidates[(index + offset) % len(candidates)]
            if fact_id not in selected:
                selected.append(fact_id)
            signature = tuple(sorted(selected))
            if signature not in signatures:
                break
        signature = tuple(sorted(selected))
        if signature in signatures:
            raise ValueError("not enough distinct facts for mock fragment strategies")
        signatures.add(signature)
        primary_id = selected[0]
        selected_facts = [facts[fact_id] for fact_id in selected]
        scene_fact = next(
            (
                fact
                for fact in selected_facts
                if fact.field
                in {
                    InsightField.USAGE_SCENARIO,
                    InsightField.PURCHASE_SCENARIO,
                    InsightField.EMOTIONAL_SCENARIO,
                }
            ),
            None,
        )
        audience_fact = next(
            (
                fact
                for fact in selected_facts
                if fact.field == InsightField.TARGET_AUDIENCE
            ),
            None,
        )
        bundles.append(
            FragmentMarketingBundle(
                bundle_id=f"{allocation.fragment_type.value.lower()}-{index + 1}",
                primary_fact_id=primary_id,
                fact_ids=selected,
                creative_intent=f"围绕{facts[primary_id].value}形成单一片段创意",
                scene=(
                    _mock_concrete_scene(scene_fact.value)
                    if scene_fact
                    else (
                        "自然光厨房操作台"
                        if index % 4 == 0
                        else "餐桌边的简洁备餐区"
                        if index % 4 == 1
                        else "窗边木质展示台"
                        if index % 4 == 2
                        else "整洁货架前的产品展示区"
                    )
                ),
                persona=(
                    _mock_persona(audience_fact.value)
                    if audience_fact
                    else (
                        "一双成年人的手，人物不露脸"
                        if index % 3 == 0
                        else "无人出镜，产品独立置于画面中央"
                        if index % 3 == 1
                        else "一位成年家庭烹饪者，仅露出上半身与双手"
                    )
                ),
                opening_state=pool.opening_states[index % len(pool.opening_states)],
                action_arc=pool.action_arcs[index % len(pool.action_arcs)],
                camera=pool.cameras[index % len(pool.cameras)],
                emotion=pool.emotions[index % len(pool.emotions)],
                ending_state=pool.ending_states[index % len(pool.ending_states)],
            )
        )
    return FragmentMarketingPlan(
        fragment_type=allocation.fragment_type,
        bundles=bundles,
        allocation_hash=allocation.allocation_hash,
        prompt_version=FRAGMENT_STRATEGY_VERSION,
    )


def _fragment_strategy_pool_for_mock(
    fragment_type: FragmentType,
) -> FragmentStrategyPool:
    return next(
        pool
        for pool in _default_fragment_strategy_pools()
        if pool.fragment_type == fragment_type
    )


def _materialize_compact_relationship_bundles(
    bundles: list[CompactMarketingRelationshipBundle],
    application: InsightApplicationMap,
) -> list[MarketingRelationshipBundle]:
    known = application.by_id
    result: list[MarketingRelationshipBundle] = []
    for index, bundle in enumerate(bundles, 1):
        if len(bundle.fact_ids) != len(set(bundle.fact_ids)):
            continue
        facts = [known.get(fact_id) for fact_id in bundle.fact_ids]
        if any(fact is None for fact in facts):
            continue
        confirmed = [fact for fact in facts if fact is not None]
        if not all(
            bundle.fragment_type in fact.eligible_fragment_types for fact in confirmed
        ):
            continue
        scene_fact = _first_fact(
            confirmed,
            {
                InsightField.USAGE_SCENARIO,
                InsightField.PURCHASE_SCENARIO,
                InsightField.EMOTIONAL_SCENARIO,
            },
        ) or _first_eligible_fact(
            application,
            bundle.fragment_type,
            {
                InsightField.USAGE_SCENARIO,
                InsightField.PURCHASE_SCENARIO,
                InsightField.EMOTIONAL_SCENARIO,
            },
        )
        audience_fact = _first_fact(
            confirmed, {InsightField.TARGET_AUDIENCE}
        ) or _first_eligible_fact(
            application,
            bundle.fragment_type,
            {InsightField.TARGET_AUDIENCE},
        )
        selling_point_fact = _first_fact(
            confirmed,
            {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT},
        ) or _first_eligible_fact(
            application,
            bundle.fragment_type,
            {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT},
        )
        result.append(
            MarketingRelationshipBundle(
                bundle_id=f"model-{index}-{bundle.bundle_id}"[:120],
                fact_ids=bundle.fact_ids,
                eligible_fragment_types=[bundle.fragment_type],
                scene=_mock_concrete_scene(scene_fact.value)
                if scene_fact
                else "真实生活场景中的简洁桌面",
                persona=_safe_relationship_persona(
                    _mock_persona(audience_fact.value)
                    if audience_fact
                    else "无人出镜，只展示产品与成年人的手"
                ),
                selling_point=selling_point_fact.value
                if selling_point_fact
                else (
                    "不提前展示产品解决方案"
                    if bundle.fragment_type in {FragmentType.HOOK, FragmentType.PAIN}
                    else "产品身份与真实外观"
                ),
            )
        )
    return result


def _first_fact(
    facts: list[InsightFact], fields: set[InsightField]
) -> InsightFact | None:
    return next((fact for fact in facts if fact.field in fields), None)


def _first_eligible_fact(
    application: InsightApplicationMap,
    fragment_type: FragmentType,
    fields: set[InsightField],
) -> InsightFact | None:
    return next(
        (
            fact
            for fact in application.usable
            if fact.field in fields and fragment_type in fact.eligible_fragment_types
        ),
        None,
    )


def _unique_texts(values: Iterable[object]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, str) or not (value := " ".join(raw.split())):
            continue
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result


def _default_fragment_strategy_pools() -> list[FragmentStrategyPool]:
    values: dict[
        FragmentType,
        tuple[list[str], list[str], list[str], list[str], list[str]],
    ] = {
        FragmentType.HOOK: (
            [
                "首帧只露出一个反常局部，答案仍在画外",
                "首帧停在主体即将接触道具的瞬间",
                "首帧由前景遮挡显露一个尚未解释的细节",
            ],
            [
                "主体伸向目标位置，在接触前突然停住",
                "局部物件开始移动，在关键细节完全露出前停住",
                "主体缓慢伸向异常细节，刚要确认时停止动作",
            ],
            [
                "低机位近景快速靠近主体后停止",
                "微距固定机位持续观察局部变化",
                "肩后中近景稳定跟随主体动作",
            ],
            [
                "高对比侧光与短促停顿",
                "冷暖反差与快速停住",
                "局部亮部和紧张停顿",
            ],
            [
                "结束时答案仍未揭晓，动作停在临界位置",
                "结束画面保留被遮挡的关键信息",
                "结束时主体保持迟疑，悬念没有被解释",
            ],
        ),
        FragmentType.PAIN: (
            [
                "首帧直接呈现操作空间不足的受阻状态",
                "首帧呈现主体反复寻找落点但仍无法继续",
                "首帧让凌乱、遮挡或不便关系清楚可见",
            ],
            [
                "主体尝试完成一个动作，遇到阻碍后停下",
                "主体调整一次手部位置，仍无法继续并保持原状",
                "主体把道具移向目标位置，因空间冲突而停止",
            ],
            [
                "俯拍近景固定观察问题关系",
                "胸前中近景稳定跟随受阻动作",
                "侧面近景固定呈现主体与障碍的位置关系",
            ],
            [
                "冷色自然光与迟滞节奏",
                "低饱和侧光与克制停顿",
                "阴天柔光与受阻停顿",
            ],
            [
                "结束时问题仍清楚存在，动作没有完成",
                "结束画面保持受阻状态，不出现解决动作",
                "结束时主体停下，空间或道具关系没有改善",
            ],
        ),
        FragmentType.PRODUCT_DISPLAY: (
            [
                "首帧产品完整清楚地位于主体位置",
                "首帧产品正面与真实使用道具同时可辨",
                "首帧以简洁背景建立产品轮廓和比例",
            ],
            [
                "一只手将产品扶正到正面朝向并退出画面",
                "主体拿起产品缓慢转动一个角度后停住",
                "主体把产品从侧边平稳摆到画面中央后松手",
            ],
            [
                "正面近景轻微横移展示产品轮廓",
                "桌面高度近景缓慢靠近产品后停止",
                "肩高近景固定观察产品转动动作",
            ],
            [
                "柔和窗光与平稳节奏",
                "中性侧光与清晰节奏",
                "轮廓光与从容停顿",
            ],
            [
                "结束时产品正面清楚且轮廓完整",
                "结束画面停在产品三分之二角度的英雄构图",
                "结束时产品稳定居中，手部已经退出画面",
            ],
        ),
        FragmentType.SELLING_POINT_EXPLANATION: (
            [
                "首帧建立产品、操作部位和道具的真实关系",
                "首帧聚焦已确认的产品表面或结构细节",
                "首帧让允许呈现的使用状态清楚可见",
            ],
            [
                "主体只触碰一次已确认部位，完成后保持当前状态",
                "主体沿一个真实外观细节缓慢移动手指后停住",
                "主体把允许观察的产品细节转向镜头并保持稳定",
            ],
            [
                "肩后中近景固定观察操作位置",
                "微距近景缓慢靠近允许呈现的真实细节",
                "桌面高度近景轻微横移观察材质受光变化",
            ],
            [
                "清晰侧光与克制节奏",
                "中性光线与专注停顿",
                "柔和近光与缓慢观察",
            ],
            [
                "结束时允许证据仍清楚可观察，画面一侧保持干净",
                "结束画面停在动作结果与产品关系清楚的位置",
                "结束时真实细节保持稳定，不增加推断性结果",
            ],
        ),
        FragmentType.CTA: (
            [
                "首帧产品位于主体近侧，背景留有自然空白",
                "首帧产品与人物手部形成清楚的收束关系",
                "首帧以简洁环境建立产品和安全留白区",
            ],
            [
                "主体把产品平稳放到主位置后手部退出",
                "主体托住产品转向镜头并在正面位置停住",
                "主体将产品轻缓递近到前景后保持不动",
            ],
            [
                "正面中近景缓慢靠近产品后停止",
                "半身近景固定保持产品与留白关系",
                "桌面高度近景轻微横移到稳定收束构图",
            ],
            [
                "明亮轮廓光与平稳收束",
                "暖色侧光与舒缓停顿",
                "自然逆光与从容静止",
            ],
            [
                "结束时产品清楚，右侧保留完整干净空间",
                "结束画面在产品下方保留无遮挡安全区",
                "结束时产品稳定朝向镜头，背景留白自然连续",
            ],
        ),
        FragmentType.OUTRO: (
            [
                "首帧产品已处于稳定静物构图中心",
                "首帧产品轮廓清楚，背景运动接近静止",
                "首帧以简洁台面和稳定光线建立产品身份",
            ],
            [
                "一只手轻微扶正产品后离开，产品保持不动",
                "背景光线轻微变化后恢复稳定，产品始终静止",
                "焦点从产品边缘缓慢落到正面后保持稳定",
            ],
            [
                "固定近景保持产品居中",
                "正面中近景固定观察背景逐渐安静",
                "固定近景只进行一次缓慢收焦",
            ],
            [
                "柔和轮廓光与安静节奏",
                "稳定中性光与缓慢停顿",
                "暖色侧光与静止氛围",
            ],
            [
                "结束时产品稳定定格，上方保留干净空间",
                "结束画面保持至少一秒的清楚静物构图",
                "结束时背景完全安静，不出现新动作或新信息",
            ],
        ),
    }
    return [
        FragmentStrategyPool(
            fragment_type=fragment_type,
            opening_states=opening_states,
            action_arcs=action_arcs,
            cameras=cameras,
            emotions=emotions,
            ending_states=ending_states,
        )
        for fragment_type, (
            opening_states,
            action_arcs,
            cameras,
            emotions,
            ending_states,
        ) in values.items()
    ]


def _mock_evidence_plan(selling_point: str) -> SellingPointEvidence:
    normalized = selling_point.casefold()
    if any(
        token in normalized
        for token in (
            "工艺",
            "配方",
            "技术",
            "理念",
            "品质",
            "匠心",
            "专业",
            "配比",
            "比例",
            "口感",
            "香味",
            "酒香",
            "回甘",
            "无淀粉",
            "纯猪肉",
            "锁鲜",
        )
    ):
        mode = EvidenceMode.TEXT_ONLY
        allowed = "只生成与该卖点相符的真实产品细节素材，卖点原文保留在结构化元数据中"
    elif any(
        token in normalized
        for token in (
            "开",
            "关",
            "按",
            "操作",
            "使用",
            "清洗",
            "切割",
            "烹饪",
            "适配",
            "便于",
        )
    ):
        mode = EvidenceMode.USAGE_ACTION
        allowed = f"一次可见、连续且不增加结论的{selling_point}使用动作"
    elif any(
        token in normalized
        for token in ("外观", "颜色", "轻量", "便携", "尺寸", "设计")
    ):
        mode = EvidenceMode.VISIBLE_ATTRIBUTE
        allowed = f"产品在人物手部或真实场景中的{selling_point}可见属性"
    else:
        mode = EvidenceMode.TEXT_ONLY
        allowed = "只生成与该卖点相符的真实产品细节素材，卖点原文保留在结构化元数据中"
    return SellingPointEvidence(
        selling_point=selling_point,
        evidence_mode=mode,
        allowed_visual_evidence=allowed,
        forbidden_inference=f"不得把{selling_point}扩展为未确认功效、数据、认证或绝对化结论",
    )


def _mock_relationship_bundles(
    application: InsightApplicationMap,
) -> list[MarketingRelationshipBundle]:
    bundles: list[MarketingRelationshipBundle] = []
    for fragment_type in FragmentType:
        eligible = [
            fact
            for fact in application.usable
            if fragment_type in fact.eligible_fragment_types
        ]
        by_field: dict[InsightField, list[InsightFact]] = {}
        for fact in eligible:
            by_field.setdefault(fact.field, []).append(fact)
        row_count = max((len(items) for items in by_field.values()), default=1)
        for index in range(row_count):
            selected = [items[index % len(items)] for items in by_field.values()]
            fact_ids = list(dict.fromkeys(fact.fact_id for fact in selected))[:12]
            selling_point = next(
                (
                    fact.value
                    for fact in selected
                    if fact.field
                    in {
                        InsightField.CORE_SELLING_POINT,
                        InsightField.SECONDARY_SELLING_POINT,
                    }
                ),
                "不提前展示产品解决方案"
                if fragment_type in {FragmentType.HOOK, FragmentType.PAIN}
                else "产品身份与真实外观",
            )
            scene = next(
                (
                    fact.value
                    for fact in selected
                    if fact.field
                    in {
                        InsightField.USAGE_SCENARIO,
                        InsightField.PURCHASE_SCENARIO,
                        InsightField.EMOTIONAL_SCENARIO,
                    }
                ),
                "真实生活场景中的简洁桌面",
            )
            audience = next(
                (
                    fact.value
                    for fact in selected
                    if fact.field == InsightField.TARGET_AUDIENCE
                ),
                "无人出镜，只展示产品与成年人的手",
            )
            bundles.append(
                MarketingRelationshipBundle(
                    bundle_id=f"{fragment_type.value.lower()}-{index + 1}",
                    fact_ids=fact_ids,
                    eligible_fragment_types=[fragment_type],
                    scene=_mock_concrete_scene(scene),
                    persona=_mock_persona(audience),
                    selling_point=selling_point,
                )
            )
    _validate_relationship_bundles(bundles, application)
    return bundles


def _validate_relationship_bundles(
    bundles: list[MarketingRelationshipBundle],
    application: InsightApplicationMap,
    *,
    require_complete: bool = True,
) -> None:
    known = application.by_id
    planned: set[str] = set()
    covered_fragment_types: set[FragmentType] = set()
    for bundle in bundles:
        if len(bundle.fact_ids) != len(set(bundle.fact_ids)):
            raise ProviderError(
                "AI relationship bundle contains duplicate factId",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        for fact_id in bundle.fact_ids:
            fact = known.get(fact_id)
            if not fact:
                raise ProviderError(
                    "AI relationship bundle references an unknown factId",
                    retryable=False,
                    error_type=ProviderErrorType.RESPONSE_INVALID,
                )
            if not all(
                fragment_type in fact.eligible_fragment_types
                for fragment_type in bundle.eligible_fragment_types
            ):
                raise ProviderError(
                    "AI relationship bundle assigns an insight fact to an incompatible fragment type",
                    retryable=False,
                    error_type=ProviderErrorType.RESPONSE_INVALID,
                )
            planned.add(fact_id)
        covered_fragment_types.update(bundle.eligible_fragment_types)
    missing = {fact.fact_id for fact in application.required} - planned
    if require_complete and (missing or covered_fragment_types != set(FragmentType)):
        raise ProviderError(
            "AI relationship plan does not cover every required fact and fragment type",
            retryable=False,
            error_type=ProviderErrorType.RESPONSE_INVALID,
        )


def _complete_relationship_bundles(
    bundles: list[MarketingRelationshipBundle],
    application: InsightApplicationMap,
) -> list[MarketingRelationshipBundle]:
    # Reject each invalid model bundle independently. Coverage is then repaired only from the
    # deterministic fact map, so unknown references and responsibility conflicts never survive.
    completed: list[MarketingRelationshipBundle] = []
    for bundle in bundles:
        try:
            _validate_relationship_bundles(
                [bundle], application, require_complete=False
            )
        except ProviderError:
            continue
        completed.append(
            bundle.model_copy(
                update={"persona": _safe_relationship_persona(bundle.persona)}
            )
        )
    planned = {fact_id for bundle in completed for fact_id in bundle.fact_ids}
    covered_types = {
        fragment_type
        for bundle in completed
        for fragment_type in bundle.eligible_fragment_types
    }
    missing = {fact.fact_id for fact in application.required} - planned
    missing_types = set(FragmentType) - covered_types
    fallbacks = _mock_relationship_bundles(application)
    fallback_index = 0
    while missing or missing_types:
        candidate = max(
            fallbacks,
            key=lambda item: (
                len(missing.intersection(item.fact_ids))
                + len(missing_types.intersection(item.eligible_fragment_types))
            ),
        )
        score = len(missing.intersection(candidate.fact_ids)) + len(
            missing_types.intersection(candidate.eligible_fragment_types)
        )
        if score == 0 or len(completed) >= 48:
            raise ProviderError(
                "Worker could not complete relationship coverage from confirmed facts",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
            )
        fallback_index += 1
        completed.append(
            candidate.model_copy(
                update={
                    "bundle_id": f"worker-coverage-{fallback_index}-{candidate.bundle_id}"
                }
            )
        )
        missing.difference_update(candidate.fact_ids)
        missing_types.difference_update(candidate.eligible_fragment_types)
        fallbacks.remove(candidate)
    _validate_relationship_bundles(completed, application)
    return completed


def _mock_concrete_scene(value: str) -> str:
    if any(
        token in value for token in ("烹饪", "蒸制", "炒制", "切配", "佐餐", "食材准备")
    ):
        return f"家庭厨房的{value}操作台"
    return f"{value}场景中的暖色木质桌面"


def _mock_persona(value: str) -> str:
    if value.startswith("无人出镜"):
        return value
    if any(token in value for token in ("家庭", "厨房", "家宴")):
        return "一位35岁左右、穿米色围裙的家庭烹饪者"
    if any(token in value for token in ("通勤", "职场", "办公")):
        return "一位30岁左右、穿深蓝通勤外套的上班族"
    if any(token in value for token in ("美食", "烹饪", "厨")):
        return "一位35岁左右、穿纯色围裙的成年家庭烹饪者"
    return "一位30至40岁、穿简洁生活装的成年使用者"


def _safe_relationship_persona(value: str) -> str:
    audience_markers = (
        "目标受众",
        "消费者",
        "人群",
        "爱好者",
        "家庭厨房决策者",
        "年货送礼",
        "全国",
        "用户群体",
    )
    if value.startswith(("一位", "一名", "一双", "无人出镜")) and not any(
        marker in value for marker in audience_markers
    ):
        return value
    return _mock_persona(value)


def _fragment_rule(fragment_type: FragmentType) -> str:
    return {
        FragmentType.HOOK: "首秒建立未解决的视觉悬念，不出现解决方案或转化",
        FragmentType.PAIN: "只呈现一个真实受阻动作，结束时问题仍存在",
        FragmentType.PRODUCT_DISPLAY: "产品首帧清楚，只完成一次展示动作",
        FragmentType.SELLING_POINT_EXPLANATION: "围绕一个确认事实生成可见细节或安全使用动作",
        FragmentType.CTA: "一次收束动作形成稳定构图并预留后期文案安全区",
        FragmentType.OUTRO: "动作极少，形成可持续停留的产品或品牌定格",
    }[fragment_type]


def _mock_coordinate_plan(
    relationships: FragmentRelationshipPlan,
    application: InsightApplicationMap,
    target_count: int,
) -> FragmentDimensionCoordinatePlan:
    fragment = relationships.fragment_type
    bundle_ids = [item.bundle_id for item in relationships.bundles]
    facts = [
        application.by_id[fact_id]
        for fact_id in dict.fromkeys(
            fact_id for bundle in relationships.bundles for fact_id in bundle.fact_ids
        )
    ]
    anchor_values = [fact.value for fact in facts] or [fragment.value]
    size = min(12, max(4, target_count))
    detail_sets = {
        "N": [
            "局部先露", "动作前停", "环境先行", "结果倒叙", "遮挡待解", "关系对照",
            "材质先见", "位置悬念", "状态先行", "边缘揭示", "距离变化", "静态蓄势",
        ],
        "S": [
            "晨间窗边", "傍晚玄关", "午后书桌", "夜间厨房", "门店侧台", "户外长椅",
            "客厅矮柜", "办公茶水间", "餐桌一角", "卧室收纳区", "通勤入口", "简洁展示台",
        ],
        "P": [
            "深色袖口双手", "浅色袖口双手", "成年女性侧身", "成年男性侧身", "无人仅产品", "单手持物",
            "双手轻扶", "成年使用者背影", "仅指尖入画", "成年人物半身", "手腕局部", "无人道具陪衬",
        ],
        "C": [
            "正面固定近景", "桌面低位近景", "侧前方固定中景", "固定俯拍近景", "微距固定观察", "中近景固定观察",
            "肩后固定观察", "平视固定近景", "侧面固定特写", "高位固定中景", "低位固定中景", "正上方固定俯拍",
        ],
        "E": [
            "暖色柔光", "冷中性光", "清晨自然光", "傍晚侧逆光", "柔和顶光", "明亮散射光",
            "克制低饱和", "清透高明度", "温和侧光", "安静暗背景", "轻快自然光", "专业硬朗侧光",
        ],
    }
    role_markers = {
        FragmentType.HOOK: {"N": "未揭晓悬念", "C": "局部悬念观察", "E": "疑问张力"},
        FragmentType.PAIN: {"N": "真实受阻状态", "C": "障碍关系观察", "E": "克制焦虑"},
        FragmentType.PRODUCT_DISPLAY: {"N": "产品主体展示", "C": "产品轮廓观察", "E": "清晰明亮"},
        FragmentType.SELLING_POINT_EXPLANATION: {"N": "产品细节观察", "C": "细节证据观察", "E": "专业专注"},
        FragmentType.CTA: {"N": "稳定收束构图", "C": "安全留白构图", "E": "从容确认"},
        FragmentType.OUTRO: {"N": "安静稳定定格", "C": "固定品牌构图", "E": "沉静结束"},
    }[fragment]

    def coordinates(prefix: str, templates: list[str]) -> list[DimensionCoordinate]:
        rows: list[DimensionCoordinate] = []
        for index in range(size):
            anchor = anchor_values[index % len(anchor_values)]
            marker = role_markers.get(prefix, "")
            detail = detail_sets[prefix][index % len(detail_sets[prefix])]
            value = (
                (f"{marker}，" if marker else "")
                + templates[index % len(templates)].format(
                    anchor=anchor,
                    detail=detail,
                    index=index + 1,
                )
            )[:240]
            rows.append(
                DimensionCoordinate(
                    coordinate_id=f"{fragment.value}-{prefix}{index + 1:02d}",
                    value=value,
                    compatible_bundle_ids=bundle_ids,
                    source_fact_ids=[facts[index % len(facts)].fact_id] if facts else [],
                    normalized_signature=normalize_coordinate_signature(value),
                )
            )
        return rows

    neutral_selling_point = {
        FragmentType.HOOK: "不提前展示产品解决方案",
        FragmentType.PAIN: "不提前展示产品解决方案",
        FragmentType.PRODUCT_DISPLAY: "产品身份与真实外观",
        FragmentType.CTA: "产品身份与真实外观",
        FragmentType.OUTRO: "产品身份与真实外观",
    }.get(fragment)
    selling_rows_by_signature: dict[str, DimensionCoordinate] = {}
    for index, bundle in enumerate(relationships.bundles):
        value = neutral_selling_point or application.by_id[bundle.primary_fact_id].value
        signature = normalize_coordinate_signature(value)
        existing = selling_rows_by_signature.get(signature)
        if existing:
            selling_rows_by_signature[signature] = existing.model_copy(
                update={
                    "compatible_bundle_ids": [
                        *existing.compatible_bundle_ids,
                        bundle.bundle_id,
                    ]
                }
            )
        else:
            selling_rows_by_signature[signature] = DimensionCoordinate(
                coordinate_id=f"{fragment.value}-SP{index + 1:02d}",
                value=value,
                compatible_bundle_ids=[bundle.bundle_id],
                source_fact_ids=[bundle.primary_fact_id],
                normalized_signature=signature,
            )
    camera_templates = (
        [
            "固定机位近景观察主体稳定状态{index}",
            "固定机位中近景保持产品居中{index}",
            "固定机位微距让焦点稳定落在主体{index}",
            "固定机位正面近景保持背景安静{index}",
        ]
        if fragment == FragmentType.OUTRO
        else [
            "{detail}持续观察单一动作",
            "{detail}记录真实细节",
            "{detail}记录主体一次动作",
            "{detail}记录主体状态",
        ]
    )
    return FragmentDimensionCoordinatePlan(
        fragment_type=fragment,
        relationship_allocation_hash=relationship_hash(relationships),
        narratives=coordinates(
            "N",
            [
                "从局部状态建立信息路径{index}",
                "通过连续动作推进观察路径{index}",
                "以环境关系建立代入路径{index}",
                "从稳定结果反向建立注意路径{index}",
            ],
        ),
        scenes=coordinates(
            "S",
            [
                "{detail}的真实使用环境",
                "{detail}，保留少量生活道具",
                "{detail}，背景层次简洁",
                "{detail}，主体周围无遮挡",
            ],
        ),
        personas=coordinates(
            "P",
            [
                "{detail}完成一次真实动作",
                "{detail}，只承担一个动作",
                "{detail}，主体与道具清楚",
                "{detail}，不引入第二人物",
            ],
        ),
        selling_points=list(selling_rows_by_signature.values()),
        cameras=coordinates("C", camera_templates),
        emotions=coordinates(
            "E",
            [
                "{detail}突出真实质感",
                "{detail}形成生活氛围",
                "{detail}保持专业克制",
                "{detail}形成轻快节奏",
            ],
        ),
        prompt_version=V10_COORDINATE_VERSION,
    )


def _mock_blueprints(
    shard: BlueprintShardPlan,
    plan: FragmentDimensionCoordinatePlan,
) -> list[GeneratedBlueprint]:
    selling_by_bundle = {
        bundle_id: coordinate
        for coordinate in plan.selling_points
        for bundle_id in coordinate.compatible_bundle_ids
    }
    items: list[GeneratedBlueprint] = []
    bundle_occurrences: dict[str, int] = {}
    for task in shard.tasks:
        # The explicit mock uses the stable global ordinal so a type split over
        # multiple shards cannot repeat the first tuple of a previous shard.
        index = task.ordinal - 1
        narrative = plan.narratives[index % len(plan.narratives)]
        scene = plan.scenes[index % len(plan.scenes)]
        persona = plan.personas[index % len(plan.personas)]
        camera = plan.cameras[index % len(plan.cameras)]
        emotion = plan.emotions[index % len(plan.emotions)]
        selling = selling_by_bundle[task.bundle_id]
        bundle_occurrence = bundle_occurrences.get(task.bundle_id, 0)
        bundle_occurrences[task.bundle_id] = bundle_occurrence + 1
        auxiliary_fact_ids = [
            fact_id for fact_id in task.fact_ids if fact_id != task.primary_fact_id
        ]
        selected_auxiliary = [
            auxiliary_fact_ids[(bundle_occurrence + offset) % len(auxiliary_fact_ids)]
            for offset in range(min(2, len(auxiliary_fact_ids)))
        ]
        used_fact_ids = list(dict.fromkeys([task.primary_fact_id, *selected_auxiliary]))
        opening, action, ending = {
            FragmentType.HOOK: (
                "首帧让主体局部被真实道具遮挡，关键信息尚未揭晓",
                "成年人伸手缓慢移开一小部分遮挡物，在完全显露前停住",
                "遮挡仍保留，动作停在即将揭晓的位置",
            ),
            FragmentType.PAIN: (
                "首帧直接呈现主体与障碍物之间的受阻关系",
                "成年人伸手尝试调整主体与障碍物的距离，受阻后停下",
                "问题仍清楚存在，主体保持在障碍物外侧",
            ),
            FragmentType.PRODUCT_DISPLAY: (
                "首帧产品完整清楚地位于简洁背景中央",
                "成年人将产品缓慢扶正到正面朝向后松手",
                "产品正面清楚且轮廓完整，手部退出画面",
            ),
            FragmentType.SELLING_POINT_EXPLANATION: (
                "首帧建立产品与真实操作部位的清楚关系",
                "成年人沿产品一个真实外观细节缓慢移动手指后停住",
                "焦点稳定停留在真实外观和接触位置",
            ),
            FragmentType.CTA: (
                "首帧产品位于画面左侧，右侧保持干净留白",
                "成年人把产品平稳放到左侧主位置后手部退出",
                "产品稳定清楚，右侧安全留白保持干净",
            ),
            FragmentType.OUTRO: (
                "首帧产品已经稳定放在简洁背景中央",
                "产品只发生一次轻微自然反光变化后保持不动",
                "背景和产品保持安静，形成可持续停留的稳定画面",
            ),
        }[task.fragment_type]
        items.append(
            GeneratedBlueprint(
                slot_id=task.slot_id,
                fragment_type=task.fragment_type,
                bundle_id=task.bundle_id,
                primary_fact_id=task.primary_fact_id,
                used_fact_ids=used_fact_ids,
                narrative_coordinate_id=narrative.coordinate_id,
                scene_coordinate_id=scene.coordinate_id,
                persona_coordinate_id=persona.coordinate_id,
                selling_point_coordinate_id=selling.coordinate_id,
                camera_coordinate_id=camera.coordinate_id,
                emotion_coordinate_id=emotion.coordinate_id,
                opening_state=opening,
                action_arc=action,
                ending_state=ending,
            )
        )
    return items


def _strategy_context(application: InsightApplicationMap) -> dict[str, object]:
    return {
        "facts": [
            {
                "factId": fact.fact_id,
                "field": fact.field.value,
                "value": fact.value,
                "eligibleFragmentTypes": [
                    fragment_type.value
                    for fragment_type in fact.eligible_fragment_types
                ],
            }
            for fact in application.usable
        ],
        "constraints": [
            {"field": fact.field.value, "value": fact.value}
            for fact in application.constraints
        ],
    }


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
