from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Generic, Protocol, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .models import (
    CreativeCandidate,
    CreativeCandidateBatch,
    CreativeDimensions,
    CreativeEvaluation,
    CreativeEvaluationBatch,
    CreativeFactAssignment,
    CreativeScores,
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
CREATIVE_FALLBACK_BASE_PROMPT = "creative_fallback_base.system.prompt.txt"
CREATIVE_FALLBACK_TASK_PROMPT = "creative_fallback_task.user.prompt.txt"
EVALUATION_BASE_PROMPT = "evaluation_base.system.prompt.txt"
EVALUATION_TASK_PROMPT = "evaluation_task.user.prompt.txt"
FACT_VISUAL_STRATEGY_BASE_PROMPT = "fact_visual_strategy.system.prompt.txt"
FACT_VISUAL_STRATEGY_TASK_PROMPT = "fact_visual_strategy.user.prompt.txt"
FACT_VISUAL_STRATEGY_TEMPLATE_HASH = hashlib.sha256(
    load_prompt(FACT_VISUAL_STRATEGY_BASE_PROMPT).encode("utf-8")
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


class AiProvider(Protocol):
    execution_mode: str

    async def compile_fact_visual_strategy(
        self,
        application: InsightApplicationMap,
    ) -> AiCallResult[FactVisualStrategyResponse]: ...

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
        application: InsightApplicationMap,
        fact_visual_strategy: FactVisualStrategy | None = None,
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
            (
                CREATIVE_BASE_PROMPT
                if fact_visual_strategy is not None
                else CREATIVE_FALLBACK_BASE_PROMPT
            ),
        )

    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        application: InsightApplicationMap,
        fact_visual_strategy: FactVisualStrategy | None = None,
    ) -> AiCallResult[CreativeEvaluationBatch]:
        return _mock_result(
            CreativeEvaluationBatch(
                items=[
                    _mock_creative_evaluation(item, application)
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
        facts = [
            fact.model_dump(
                mode="json",
                by_alias=True,
                exclude={
                    "eligible_fragment_types",
                    "preferred_role",
                    "exclusion_reason",
                    "value_hash",
                },
            )
            for fact in application.usable
        ]
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
        return await self._structured(
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
        task_briefs = [
            _creative_task_brief(
                task,
                assignment=assignments[task.slot_id],
                application=application,
                fact_visual_strategy=fact_visual_strategy,
            )
            for task in shard.tasks
        ]
        creative_task_prompt = (
            CREATIVE_TASK_PROMPT
            if fact_visual_strategy is not None
            else CREATIVE_FALLBACK_TASK_PROMPT
        )
        creative_base_prompt = (
            CREATIVE_BASE_PROMPT
            if fact_visual_strategy is not None
            else CREATIVE_FALLBACK_BASE_PROMPT
        )
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
            avoid_semantic_json=json.dumps(shard.avoid_semantic_signatures, ensure_ascii=False),
            avoid_visual_json=json.dumps(shard.avoid_visual_signatures, ensure_ascii=False),
            rejection_reasons_json=json.dumps(shard.rejection_reasons, ensure_ascii=False),
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
        for item in call.value.items:
            task = task_by_slot[item.slot_id]
            assignment = assignments[item.slot_id]
            fact_ids = list(dict.fromkeys(item.declared_fact_ids))
            unassigned = [
                fact_id
                for fact_id in fact_ids
                if fact_id not in assignment.allowed_fact_ids
            ]
            if unassigned:
                raise ProviderError(
                    "AI coherent creative response referenced a fact outside its assigned brief",
                    retryable=False,
                    error_type=ProviderErrorType.RESPONSE_INVALID,
                    attempts=call.metadata.attempts,
                    elapsed_ms=call.metadata.latency_ms,
                )
            visual_fact_id = assignment.visual_task_fact_id or assignment.primary_fact_id
            if visual_fact_id not in fact_ids:
                raise ProviderError(
                    (
                        "AI coherent creative response did not use its assigned visual task fact"
                        if fact_visual_strategy is not None
                        else "AI coherent creative response did not use its assigned primary fact"
                    ),
                    retryable=False,
                    error_type=ProviderErrorType.RESPONSE_INVALID,
                    attempts=call.metadata.attempts,
                    elapsed_ms=call.metadata.latency_ms,
                )
            if not set(fact_ids).intersection(assignment.product_anchor_fact_ids):
                raise ProviderError(
                    "AI coherent creative response did not use an assigned product anchor",
                    retryable=False,
                    error_type=ProviderErrorType.RESPONSE_INVALID,
                    attempts=call.metadata.attempts,
                    elapsed_ms=call.metadata.latency_ms,
                )
            normalized.append(
                item.model_copy(
                    update={
                        "ordinal": task.ordinal,
                        "round": task.round,
                        "declared_fact_ids": list(dict.fromkeys(fact_ids)),
                    }
                )
            )
        return AiCallResult(
            value=call.value.model_copy(update={"items": normalized}),
            metadata=call.metadata,
        )

    async def evaluate_creatives(
        self,
        candidates: list[CreativeCandidate],
        *,
        application: InsightApplicationMap,
        fact_visual_strategy: FactVisualStrategy | None = None,
    ) -> AiCallResult[CreativeEvaluationBatch]:
        if not candidates or len(candidates) > 10:
            raise ProviderError(
                "creative evaluation batch must contain between one and ten items",
                retryable=False,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        referenced = {
            fact_id for item in candidates for fact_id in item.declared_fact_ids
        }
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
                [item.model_dump(mode="json", by_alias=True) for item in candidates],
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
                # Ark counts the structured answer and reasoning tokens against
                # the same limit. Five detailed evaluations repeatedly reached
                # the former 2,600-token ceiling during the paid 50-item run.
                max(1536, len(candidates) * 720),
            ),
            request_timeout=self._evaluation_timeout,
            instructions=load_prompt(EVALUATION_BASE_PROMPT),
        )
        expected = {item.slot_id for item in candidates}
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
                                and incomplete_reason
                                in {"max_output_tokens", "length"}
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
        elif fact.field in {InsightField.CORE_SPECIFICATION, InsightField.VISUAL_FEATURES}:
            usage = FactVisualUsage.DIRECTLY_VISIBLE
            visual_instruction = "只呈现该事实中能够直接观察的外观或包装信息"
            context_instruction = ""
        elif fact.field in {InsightField.USAGE_SCENARIO, InsightField.PURCHASE_SCENARIO}:
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


def _mock_creative_candidate(
    task: CreativeTask,
    application: InsightApplicationMap,
    fact_visual_strategy: FactVisualStrategy | None = None,
) -> CreativeCandidate:
    assignment = _creative_fact_assignment(task, application)
    visual_fact_id = assignment.visual_task_fact_id or assignment.primary_fact_id
    primary = application.by_id[visual_fact_id]
    anchor = application.by_id[assignment.product_anchor_fact_ids[0]]
    declared_fact_ids = list(
        dict.fromkeys([primary.fact_id, anchor.fact_id])
    )
    product = anchor.value
    scenes = ["家庭厨房料理台", "节日家宴餐桌", "明亮食品展示台", "居家备餐区"]
    cameras = ["近景缓慢横移", "微距轻推", "中近景固定观察", "俯拍平稳跟随"]
    scene = scenes[(task.ordinal - 1) % len(scenes)]
    camera = cameras[((task.ordinal - 1) // len(scenes)) % len(cameras)]
    actions = [
        "被切开并整齐摆盘",
        "由筷子夹起后停在切面细节",
        "从蒸笼中取出并放到白瓷盘",
        "包装旁的成品被缓慢转动展示",
    ]
    action = actions[
        ((task.ordinal - 1) // (len(scenes) * len(cameras))) % len(actions)
    ]
    content = (
        f"{scene}内，{product}{action}，画面清楚呈现{primary.value}。"
        f"{camera}记录一个连续动作，暖色自然光突出真实质感，动作结束后主体稳定停留在画面中央。"
    )
    return CreativeCandidate(
        slot_id=task.slot_id,
        ordinal=task.ordinal,
        round=task.round,
        creative_core=f"用{scene}中的连续动作表现{primary.value}",
        declared_fact_ids=declared_fact_ids,
        dimensions=CreativeDimensions(
            narrative="从准备动作自然推进到产品细节停留",
            scene=scene,
            persona="仅一双成年人的手参与动作",
            product_relation=primary.value,
            camera=camera,
            emotion="温暖真实且具有食欲吸引力",
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
            preferred_primary_fact_ids=task.preferred_fact_ids,
        )[0]
    missing = [
        fact_id
        for fact_id in assignment.allowed_fact_ids
        if fact_id not in application.by_id
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
) -> dict[str, Any]:
    def fact_payload(fact_id: str) -> dict[str, str]:
        fact = application.by_id[fact_id]
        return {
            "factId": fact.fact_id,
            "field": fact.field.value,
            "value": fact.value,
        }

    if fact_visual_strategy is None:
        return {
            "slotId": task.slot_id,
            "ordinal": task.ordinal,
            "round": task.round,
            "targetDurationSeconds": task.target_duration_seconds,
            "primaryFact": fact_payload(assignment.primary_fact_id),
            "supportFacts": [
                fact_payload(fact_id) for fact_id in assignment.support_fact_ids
            ],
            "productAnchorFacts": [
                fact_payload(fact_id)
                for fact_id in assignment.product_anchor_fact_ids
            ],
            "productBoundaryFacts": [
                fact_payload(fact_id)
                for fact_id in assignment.product_boundary_fact_ids
            ],
        }

    policy_by_id = fact_visual_strategy.by_id
    visual_fact_id = assignment.visual_task_fact_id or assignment.primary_fact_id
    visual_policy = policy_by_id[visual_fact_id]
    business_context = []
    forbidden_inferences = list(visual_policy.forbidden_inferences)
    for fact_id in assignment.business_context_fact_ids:
        policy = policy_by_id[fact_id]
        business_context.append(
            {
                **fact_payload(fact_id),
                "instruction": policy.context_instruction,
                "visualUsage": policy.visual_usage.value,
            }
        )
        forbidden_inferences.extend(policy.forbidden_inferences)

    return {
        "slotId": task.slot_id,
        "ordinal": task.ordinal,
        "round": task.round,
        "targetDurationSeconds": task.target_duration_seconds,
        "visualTask": {
            **fact_payload(visual_fact_id),
            "instruction": visual_policy.visual_instruction,
            "visualUsage": visual_policy.visual_usage.value,
        },
        "businessContext": business_context,
        "productAnchorFacts": [
            fact_payload(fact_id)
            for fact_id in assignment.product_anchor_fact_ids
        ],
        "productBoundaryFacts": [
            fact_payload(fact_id)
            for fact_id in assignment.product_boundary_fact_ids
        ],
        "forbiddenInferences": list(dict.fromkeys(forbidden_inferences)),
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
) -> CreativeEvaluation:
    evidence = [
        FactEvidence(fact_id=fact_id, evidence_text=application.by_id[fact_id].value)
        for fact_id in candidate.declared_fact_ids
        if fact_id in application.by_id
        and application.by_id[fact_id].value in candidate.content
    ]
    purposes = list(FragmentType)
    primary = purposes[(candidate.ordinal - 1) % len(purposes)]
    compatible = [primary]
    if primary != FragmentType.PRODUCT_DISPLAY:
        compatible.append(FragmentType.PRODUCT_DISPLAY)
    hard_issues = [] if evidence else ["MISSING_PRODUCT_RELATION"]
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
        hard_issues=hard_issues,
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
