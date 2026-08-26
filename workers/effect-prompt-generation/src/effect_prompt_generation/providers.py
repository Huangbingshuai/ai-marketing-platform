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
    FragmentType,
    GeneratedPromptText,
    GeneratedPromptTextBatch,
    InsightApplicationMap,
    InsightFact,
    InsightField,
    MarketingRelationshipBundle,
    NodeId,
    PlannedCombination,
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
        regeneration_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[GeneratedPromptTextBatch]: ...


class MockAiProvider:
    async def plan_strategy(
        self, application: InsightApplicationMap, *, target_count: int
    ) -> AiCallResult[StrategyPlan]:
        selling_points = [
            fact.value
            for fact in application.usable
            if fact.field in {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT}
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
            narratives=[
                "痛点前置型", "效果展示型", "场景代入型", "科普讲解型", "对比测评型", "开箱体验型",
                "第一视角体验日记", "问题清单逐项解答", "错误做法纠正型", "限时任务挑战型", "微故事转折型",
                "反常识切入型", "步骤教程型", "细节放大型", "一天使用记录型", "问答访谈型", "使用前后流程型",
            ],
            scenes=(concrete_scenes + [
                "家庭清晨准备", "厨房午后整理", "雨天通勤入口", "地铁换乘间隙", "办公室桌面工作",
                "会议前快速准备", "午休生活化使用", "户外短途出行", "周末公园休息", "线下门店体验",
                "明亮实验演示台", "居家夜间收纳", "旅行行李整理", "朋友分享时刻", "极简产品展示台",
            ])[:17],
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
            cameras=[
                "肩后中近景连续推近产品", "第一视角稳定跟拍", "俯拍近景连续靠近手部", "低机位缓慢推进",
                "手持纪实侧向跟随", "固定机位保持产品居中", "正面半身镜头连续聚焦局部", "桌面俯视连续长镜头",
                "侧逆光下缓慢环绕", "快速推近后稳定定格", "全景环境中连续靠近主体", "中近景从人物视线平滑移焦到产品",
                "贴近手部动作连续跟拍", "中近景让前景掠过后连续靠近产品", "轻微横移展示产品轮廓", "静态构图内跟随动作",
                "产品主观低机位连续跟随人物",
            ],
            emotions=[
                "温馨治愈的舒缓节奏", "专业严谨的克制节奏", "活力明快的快速节奏", "焦虑唤醒后及时缓解",
                "干货科普的清晰节奏", "轻松可信的生活节奏", "好奇探索的渐进节奏", "从容安心的稳定节奏",
                "真实纪实的自然停顿", "清爽利落的短句节奏", "细腻专注的慢速观察", "亲切陪伴的温和推进",
                "理性比较的明确停顿", "惊喜发现的层层递进", "日常松弛的呼吸感", "目标明确的任务节奏",
                "安静高级的极简节奏",
            ],
            actions=[
                "右手拿起产品并把正面转向镜头，动作结束后停住",
                "双手取出产品并缓慢调整朝向，露出外观后平稳放下",
                "食指沿产品边缘移动到已确认细节，随后保持不动",
                "双手握住产品完成一次连续使用动作，然后自然停下",
                "右手把产品平稳放入当前环境，随后退出画面",
                "左手托住产品，右手指向一个已确认细节并停住",
                "右手将产品从画面侧边平稳移动到中央并停住",
                "双手托住产品缓慢转动半圈，让正面朝向镜头",
                "右手从桌面提起产品到胸前高度并保持稳定",
                "左手扶住产品，右手沿一个真实外观细节缓慢移动",
                "双手把产品摆到单一场景道具旁并自然松开",
                "右手托住产品向光源方向轻微倾斜后停住",
                "双手将产品正面朝上放到桌面中央并离开",
                "右手拎起产品进入画面，在主体位置保持不动",
                "左手把产品从背景移到前景，焦点跟随到产品表面",
                "双手稳定托住产品，只调整一次面向镜头的角度",
                "右手轻放产品后退出画面，产品保持居中",
            ],
            evidence_plans=[_mock_evidence_plan(item) for item in selling_points],
        )
        return _mock_result(
            StrategyPlan(
                dimension_pools=pools,
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
            headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def plan_strategy(
        self, application: InsightApplicationMap, *, target_count: int
    ) -> AiCallResult[StrategyPlan]:
        allowed = [
            fact.value
            for fact in application.usable
            if fact.field in {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT}
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
                application.model_dump(mode="json", by_alias=True),
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            StrategyPlan,
            schema_name="effect_prompt_strategy_plan_v4",
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
        protected_evidence = [
            evidence_by_point.get(_normalized_text(item), _safe_text_evidence_plan(item))
            for item in allowed
        ]
        protected_bundles = _complete_relationship_bundles(
            call.value.relationship_bundles,
            application,
        )
        # Selling points are protected hard facts; model output cannot add or remove them.
        return AiCallResult(
            value=call.value.model_copy(
                update={
                    "dimension_pools": call.value.dimension_pools.model_copy(
                        update={"selling_points": allowed, "evidence_plans": protected_evidence}
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
        regeneration_context: Mapping[str, Any] | None = None,
    ) -> AiCallResult[GeneratedPromptTextBatch]:
        fragment_type = _homogeneous_fragment_type(combinations)
        product_context = _candidate_product_context(insight)
        prompt = render_prompt(
            CANDIDATE_TASK_PROMPT,
            delivery_channels=_first_text(insight, "deliveryChannels", "delivery_channels") or "以信息卡为准",
            visual_style=_first_text(insight, "visualStyleBaseline", "visual_style_baseline")
            or "以信息卡为准",
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
                max(1024, len(combinations) * 480),
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
                binding.fact_id for binding in combinations_by_slot[item.slot_id].insight_bindings
            }
            if set(item.used_fact_ids) != expected_fact_ids or len(item.used_fact_ids) != len(
                set(item.used_fact_ids)
            ):
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
            "input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
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
                        value = model_type.model_validate_json(_output_text(response_payload))
                        usage = _usage(response_payload)
                        elapsed = max(0, round((time.perf_counter() - started_at) * 1000))
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
                    last_error, error_type, retryable = RuntimeError("rate limited"), ProviderErrorType.RATE_LIMIT, True
                elif response.status_code >= 500:
                    last_error, error_type, retryable = RuntimeError("service unavailable"), ProviderErrorType.SERVICE, True
                else:
                    last_error, error_type, retryable = RuntimeError("request rejected"), ProviderErrorType.REQUEST_REJECTED, False
            if not retryable or attempt >= self._max_attempts:
                break
            await asyncio.sleep(min(4.0, 0.4 * (2 ** (attempt - 1))) + random.uniform(0, 0.15))
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
        ("secondarySellingPoints", ("secondarySellingPoints", "secondary_selling_points")),
        ("targetAudience", ("targetAudience", "target_audience")),
        ("corePainPoints", ("corePainPoints", "core_pain_points")),
        ("decisionDrivers", ("decisionDrivers", "decision_drivers")),
        ("marketingGoal", ("marketingGoal", "marketing_goal")),
        ("usageScenarios", ("usageScenarios", "usage_scenarios")),
        ("purchaseScenarios", ("purchaseScenarios", "purchase_scenarios")),
        ("emotionalScenarios", ("emotionalScenarios", "emotional_scenarios")),
        ("durationSeconds", ("durationSeconds", "duration_seconds")),
        ("aspectRatio", ("aspectRatio", "aspect_ratio")),
        ("deliveryChannels", ("deliveryChannels", "delivery_channels")),
        ("disabledElements", ("disabledElements", "disabled_elements")),
        ("visualStyleBaseline", ("visualStyleBaseline", "visual_style_baseline")),
    )
    result: dict[str, object] = {}
    for output_key, input_keys in aliases:
        value = next((insight[key] for key in input_keys if key in insight), None)
        if isinstance(value, (str, int, float, bool)) or value is None:
            result[output_key] = value
        elif isinstance(value, list):
            result[output_key] = [item for item in value if isinstance(item, (str, int, float, bool))]
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
    persona_position = (
        dims.persona
        if dims.persona.startswith("无人出镜")
        else f"{dims.persona}位于画面主体位置"
    )
    prefix = f"{dims.scene}，{persona_position}"
    action = combination.visible_action.replace("产品", product_name).replace("·", "，")
    price = next(
        (
            binding.value
            for binding in combination.insight_bindings
            if binding.field == InsightField.PRICE_RANGE
        ),
        "",
    )
    trust = next(
        (
            binding.value
            for binding in combination.insight_bindings
            if binding.field == InsightField.TRUST_BACKING
        ),
        "",
    )
    role_text = {
        FragmentType.HOOK: (
            f"首帧从一个反常但真实的动作细节开始：{action}。画面只保留动作悬念，"
            f"不解释完整功能；{dims.camera}，焦点锁定正在发生的动作"
        ),
        FragmentType.PAIN: (
            f"首帧呈现一个尚未解决的真实不便，{action}，画面停在受阻状态，不给出解决动作；"
            f"{dims.camera}，焦点跟住手部与问题状态"
        ),
        FragmentType.PRODUCT_DISPLAY: (
            f"只展示{product_name}的一次连续拿取动作：{action}，产品外观始终清楚可辨；"
            f"{dims.camera}，焦点落在轮廓与真实表面细节，不演示额外效果"
        ),
        FragmentType.SELLING_POINT_EXPLANATION: (
            f"围绕{product_name}只做一次细节指示：{action}。字幕只出现“{dims.selling_point}”；"
            f"{dims.camera}，稳定聚焦被指向的位置"
            + (f"，旁白只按信息卡原文说“{trust}”" if trust else "")
        ),
        FragmentType.CTA: (
            f"以{product_name}完成一次收束动作：{action}；{dims.camera}并留出干净字幕安全区，"
            + (
                f"短字幕只写信息卡确认价格“{price}”，不增加折扣、库存或销量"
                if price
                else "短字幕为“现在去了解”，不出现价格、折扣或销量"
            )
        ),
        FragmentType.OUTRO: (
            f"让{product_name}形成稳定品牌定格：{action}；{dims.camera}缓慢停住，"
            f"结尾只保留产品与简洁背景"
        ),
    }[combination.fragment_type]
    prompt = (
        f"{prefix}，{role_text}。光线和色彩呈现{dims.emotion}，动作速度与镜头运动保持一致，环境声自然，"
        "结尾停在主体与产品关系清楚的稳定画面，场景和人物保持一致。"
    )
    return GeneratedPromptText(
        slot_id=combination.slot_id,
        prompt_text=prompt,
        used_fact_ids=[binding.fact_id for binding in combination.insight_bindings],
    )


def _mock_evidence_plan(selling_point: str) -> SellingPointEvidence:
    normalized = selling_point.casefold()
    if any(token in normalized for token in ("工艺", "配方", "技术", "理念", "品质", "匠心", "专业", "配比", "比例", "口感", "香味", "酒香", "回甘", "无淀粉", "纯猪肉", "锁鲜")):
        mode = EvidenceMode.TEXT_ONLY
        allowed = f"只允许以信息卡原文字幕“{selling_point}”配合真实产品细节"
    elif any(token in normalized for token in ("开", "关", "按", "操作", "使用", "清洗", "切割", "烹饪", "适配", "便于")):
        mode = EvidenceMode.USAGE_ACTION
        allowed = f"一次可见、连续且不增加结论的{selling_point}使用动作"
    elif any(token in normalized for token in ("外观", "颜色", "轻量", "便携", "尺寸", "设计")):
        mode = EvidenceMode.VISIBLE_ATTRIBUTE
        allowed = f"产品在人物手部或真实场景中的{selling_point}可见属性"
    else:
        mode = EvidenceMode.TEXT_ONLY
        allowed = f"只允许以信息卡原文字幕“{selling_point}”配合真实产品细节"
    return SellingPointEvidence(
        selling_point=selling_point,
        evidence_mode=mode,
        allowed_visual_evidence=allowed,
        forbidden_inference=f"不得把{selling_point}扩展为未确认功效、数据、认证或绝对化结论",
    )


def _safe_text_evidence_plan(selling_point: str) -> SellingPointEvidence:
    return SellingPointEvidence(
        selling_point=selling_point,
        evidence_mode=EvidenceMode.TEXT_ONLY,
        allowed_visual_evidence=f"只允许按信息卡原文表达“{selling_point}”，不得伪造证明画面",
        forbidden_inference=f"不得把{selling_point}扩展为未确认功效、数据、认证、销量或承诺",
    )


def _mock_relationship_bundles(
    application: InsightApplicationMap,
) -> list[MarketingRelationshipBundle]:
    bundles: list[MarketingRelationshipBundle] = []
    for fragment_type in FragmentType:
        eligible = [
            fact for fact in application.usable if fragment_type in fact.eligible_fragment_types
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
                    in {InsightField.CORE_SELLING_POINT, InsightField.SECONDARY_SELLING_POINT}
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
                (fact.value for fact in selected if fact.field == InsightField.TARGET_AUDIENCE),
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
            _validate_relationship_bundles([bundle], application, require_complete=False)
        except ProviderError:
            continue
        completed.append(bundle)
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
            key=lambda item: len(missing.intersection(item.fact_ids))
            + len(missing_types.intersection(item.eligible_fragment_types)),
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
                update={"bundle_id": f"worker-coverage-{fallback_index}-{candidate.bundle_id}"}
            )
        )
        missing.difference_update(candidate.fact_ids)
        missing_types.difference_update(candidate.eligible_fragment_types)
        fallbacks.remove(candidate)
    _validate_relationship_bundles(completed, application)
    return completed


def _mock_concrete_scene(value: str) -> str:
    if any(token in value for token in ("烹饪", "蒸制", "炒制", "切配", "佐餐", "食材准备")):
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
        return "一位35岁左右、穿纯色围裙的美食爱好者"
    return "一位30至40岁、穿简洁生活装的成年使用者"


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
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


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
                        if isinstance(part, Mapping) and part.get("type") == "output_text":
                            text = part.get("text")
                            if isinstance(text, str) and text.strip():
                                return text
    raise ValueError("Ark response does not contain output_text")
