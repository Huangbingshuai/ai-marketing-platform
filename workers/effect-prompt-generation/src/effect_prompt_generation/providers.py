from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Generic, Protocol, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .models import (
    DimensionPools,
    EvidenceMode,
    FragmentStrategyPool,
    FragmentType,
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

TModel = TypeVar("TModel", bound=BaseModel)
LOGGER = logging.getLogger(__name__)
STRATEGY_PROMPT = "strategy_planning.prompt.txt"
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


class ProviderErrorType(StrEnum):
    TIMEOUT = "AI_TIMEOUT"
    NETWORK = "AI_NETWORK"
    RATE_LIMIT = "AI_RATE_LIMIT"
    SERVICE = "AI_SERVICE"
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


@dataclass(frozen=True, slots=True)
class AiCallResult(Generic[TModel]):
    value: TModel
    metadata: AiCallMetadata


class AiProvider(Protocol):
    async def plan_strategy(
        self, application: InsightApplicationMap, *, target_count: int
    ) -> AiCallResult[StrategyPlan]: ...

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
        selling_points = [
            fact.value
            for fact in application.usable
            if fact.field
            in {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT}
        ]
        if not selling_points:
            raise ProviderError(
                "产品素材制作信息卡缺少已确认卖点",
                retryable=False,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        scenes = [
            fact.value
            for fact in application.usable
            if fact.field
            in {
                InsightField.USAGE_SCENARIO,
                InsightField.PURCHASE_SCENARIO,
                InsightField.EMOTIONAL_SCENARIO,
            }
        ]
        concrete_scenes = [_mock_concrete_scene(item) for item in scenes]
        pools = DimensionPools(
            scenes=(
                concrete_scenes
                + [
                    "家庭清晨准备",
                    "厨房午后整理",
                    "雨天通勤入口",
                    "地铁换乘间隙",
                    "办公室桌面工作",
                    "会议前快速准备",
                    "午休生活化使用",
                    "户外短途出行",
                    "周末公园休息",
                    "线下门店体验",
                    "明亮实验演示台",
                    "居家夜间收纳",
                    "旅行行李整理",
                    "朋友分享时刻",
                    "极简产品展示台",
                ]
            )[:17],
            personas=[
                "一位35岁左右、穿米色针织家居服的女性",
                "一位30岁左右、穿深蓝围裙的男性",
                "一位45岁左右、穿浅灰居家衬衫的女性",
                "一位28岁左右、穿卡其通勤外套的男性",
                "一位40岁左右、穿棉麻上衣的女性",
                "一位33岁左右、穿白色厨师服的男性",
                "一位50岁左右、穿深色针织衫的女性",
                "一位26岁左右、穿浅色休闲衬衫的男性",
                "一双成年人的手，人物不露脸",
                "一双戴纯色棉质围裙的成年人的手",
                "无人出镜，产品独立放在桌面中央",
                "无人出镜，产品与餐具保持静物构图",
                "一位38岁左右、穿暖棕家居服的男性",
                "一位42岁左右、穿墨绿针织衫的女性",
                "一位31岁左右、穿浅蓝衬衫的女性",
                "一位47岁左右、穿米白围裙的男性",
                "一双从画面右侧伸入的成年人的手",
            ],
            selling_points=selling_points,
            evidence_plans=[_mock_evidence_plan(item) for item in selling_points],
        )
        return _mock_result(
            StrategyPlan(
                dimension_pools=pools,
                fragment_strategy_pools=_mock_fragment_strategy_pools(),
                relationship_bundles=_mock_relationship_bundles(application),
            ),
            "STRATEGY_PLANNING",
            STRATEGY_PROMPT,
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
        strategy_max_output_tokens: int = 8192,
        candidate_max_output_tokens: int = 4096,
        reasoning_effort: str = "minimal",
        timeout: float = 120.0,
        max_attempts: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not strategy_model.strip() or not candidate_model.strip():
            raise ValueError("Ark prompt models cannot be empty")
        self._strategy_model = strategy_model.strip()
        self._candidate_model = candidate_model.strip()
        self._strategy_max_output_tokens = strategy_max_output_tokens
        self._candidate_max_output_tokens = candidate_max_output_tokens
        self._reasoning_effort = reasoning_effort
        self._max_attempts = max(1, max_attempts)
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=timeout,
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
            StrategyPlan,
            schema_name="effect_prompt_strategy_plan_v7",
            stage="STRATEGY_PLANNING",
            prompt_file=STRATEGY_PROMPT,
            model=self._strategy_model,
            max_output_tokens=self._strategy_max_output_tokens,
        )
        allowed_by_key = {_normalized_text(item): item for item in allowed}
        evidence_by_point = {
            key: item.model_copy(update={"selling_point": allowed_by_key[key]})
            for item in call.value.dimension_pools.evidence_plans
            if (key := _normalized_text(item.selling_point)) in allowed_by_key
        }
        # Selling-point names are hard facts. A model may omit or rewrite an evidence row even
        # when strict JSON validation succeeds; keep every confirmed point and fill omissions
        # with the safest deterministic representation instead of aborting the entire batch.
        protected_evidence = []
        for item in allowed:
            deterministic = _mock_evidence_plan(item)
            model_evidence = evidence_by_point.get(_normalized_text(item))
            protected_evidence.append(
                deterministic
                if deterministic.evidence_mode
                in {EvidenceMode.TEXT_ONLY, EvidenceMode.PROCESS_ONLY}
                else model_evidence or deterministic
            )
        protected_bundles = _complete_relationship_bundles(
            call.value.relationship_bundles,
            application,
        )
        # Selling points are protected hard facts; model output cannot add or remove them.
        return AiCallResult(
            value=call.value.model_copy(
                update={
                    "dimension_pools": call.value.dimension_pools.model_copy(
                        update={
                            "selling_points": allowed,
                            "evidence_plans": protected_evidence,
                        }
                    ),
                    "relationship_bundles": protected_bundles,
                }
            ),
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
        for item in call.value.items:
            expected_fact_ids = {
                binding.fact_id
                for binding in combinations_by_slot[item.slot_id].insight_bindings
            }
            if set(item.used_fact_ids) != expected_fact_ids or len(
                item.used_fact_ids
            ) != len(set(item.used_fact_ids)):
                raise ProviderError(
                    "AI structured response changed the assigned insight facts",
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
                response = await self._client.post("responses", json=payload)
            except httpx.TimeoutException as exc:
                last_error, error_type, retryable = exc, ProviderErrorType.TIMEOUT, True
            except httpx.NetworkError as exc:
                last_error, error_type, retryable = exc, ProviderErrorType.NETWORK, True
            else:
                if not response.is_error:
                    try:
                        response_payload = response.json()
                        value = model_type.model_validate_json(
                            _output_text(response_payload)
                        )
                        usage = _usage(response_payload)
                        elapsed = max(
                            0, round((time.perf_counter() - started_at) * 1000)
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
                                prompt_version=load_prompt_version(prompt_file),
                                input_tokens=usage["inputTokens"],
                                output_tokens=usage["outputTokens"],
                                total_tokens=usage["totalTokens"],
                                latency_ms=elapsed,
                                attempts=attempt,
                            ),
                        )
                    except (ValueError, ValidationError, KeyError, TypeError) as exc:
                        last_error, error_type = exc, ProviderErrorType.RESPONSE_INVALID
                        retryable = attempt == 1
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


def _mock_result(value: TModel, stage: str, prompt_file: str) -> AiCallResult[TModel]:
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
            f"{scene}，{persona}。{opening}；{action}。{camera}，自然光下{emotion}。{ending}。"
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


def _mock_fragment_strategy_pools() -> list[FragmentStrategyPool]:
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
