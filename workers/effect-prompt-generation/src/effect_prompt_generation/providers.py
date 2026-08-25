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
    PlannedCombination,
    SellingPointEvidence,
)
from .prompt_loader import load_prompt_version, render_prompt


TModel = TypeVar("TModel", bound=BaseModel)
LOGGER = logging.getLogger(__name__)
STRATEGY_PROMPT = "strategy_planning.prompt.txt"
CANDIDATE_PROMPT = "candidate_generation.prompt.txt"


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
        self, insight: Mapping[str, Any], *, target_count: int
    ) -> AiCallResult[DimensionPools]: ...

    async def generate_candidates(
        self,
        combinations: list[PlannedCombination],
        *,
        insight: Mapping[str, Any],
        duration_seconds: int,
        style_override: str | None,
        additional_disabled_elements: list[str],
    ) -> AiCallResult[GeneratedPromptTextBatch]: ...


class MockAiProvider:
    async def plan_strategy(
        self, insight: Mapping[str, Any], *, target_count: int
    ) -> AiCallResult[DimensionPools]:
        selling_points = _selling_points(insight)
        if not selling_points:
            raise ProviderError(
                "产品素材制作信息卡缺少已确认卖点",
                retryable=False,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        audience = _first_text(insight, "targetAudience", "target_audience") or "目标用户"
        scenes = _text_list(
            insight,
            "usageScenarios",
            "usage_scenarios",
            "purchaseScenarios",
            "purchase_scenarios",
            "emotionalScenarios",
            "emotional_scenarios",
        )
        pools = DimensionPools(
            narratives=[
                "痛点前置型", "效果展示型", "场景代入型", "科普讲解型", "对比测评型", "开箱体验型",
                "第一视角体验日记", "问题清单逐项解答", "错误做法纠正型", "限时任务挑战型", "微故事转折型",
                "反常识切入型", "步骤教程型", "细节放大型", "一天使用记录型", "问答访谈型", "使用前后流程型",
            ],
            scenes=(scenes + [
                "家庭清晨准备", "厨房午后整理", "雨天通勤入口", "地铁换乘间隙", "办公室桌面工作",
                "会议前快速准备", "午休生活化使用", "户外短途出行", "周末公园休息", "线下门店体验",
                "明亮实验演示台", "居家夜间收纳", "旅行行李整理", "朋友分享时刻", "极简产品展示台",
            ])[:17],
            personas=[
                f"一名穿简洁日常服装的{audience}",
                f"一名清晨赶时间、穿轻便外套的{audience}", f"一名重视细节的{audience}", f"一名理性比较的{audience}",
                f"一名首次体验产品的{audience}", f"一名长期使用产品的{audience}", f"一名穿轻户外服装的{audience}",
                f"一名穿商务通勤服装的{audience}", f"一名穿居家休闲服的{audience}", f"一名负责家庭采购的{audience}",
                f"一名喜欢步骤讲解的{audience}", f"一名关注产品外观的{audience}", f"一名关注使用效率的{audience}",
                f"一名谨慎验证信息的{audience}", f"一名主动分享体验的{audience}", f"一名追求简单操作的{audience}",
                f"一名正在移动中的{audience}",
            ],
            selling_points=selling_points,
            cameras=[
                "肩后中近景连续推近产品", "第一视角稳定跟拍", "俯拍近景连续靠近手部", "低机位缓慢推进",
                "手持纪实侧向跟随", "固定机位保持产品居中", "正面半身镜头连续聚焦局部", "桌面俯视连续长镜头",
                "侧逆光下缓慢环绕", "快速推近后稳定定格", "广角环境中连续靠近主体", "从人物视线平滑移焦到产品",
                "贴近手部动作连续跟拍", "前景掠过后连续靠近产品", "轻微横移展示产品轮廓", "静态构图内跟随动作",
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
                f"一名{audience}拿起产品并按下已确认操作位置，动作结束后停住",
                f"一名{audience}拿起产品缓慢调整朝向，露出外观后平稳放下",
                f"一名{audience}停下当前动作并指向产品细节，手指保持不动",
                f"一名{audience}握住产品完成一次连续使用动作，然后自然停下",
                f"一名{audience}把产品平稳放入当前生活环境并自然走出画面",
                f"一名{audience}拿起产品指向一个已确认细节，字幕出现后停住",
            ],
            evidence_plans=[_mock_evidence_plan(item) for item in selling_points],
        )
        return _mock_result(pools, "STRATEGY_PLANNING", STRATEGY_PROMPT)

    async def generate_candidates(
        self,
        combinations: list[PlannedCombination],
        *,
        insight: Mapping[str, Any],
        duration_seconds: int,
        style_override: str | None,
        additional_disabled_elements: list[str],
    ) -> AiCallResult[GeneratedPromptTextBatch]:
        product_name = _first_text(insight, "productName", "product_name") or "产品"
        items = []
        for combo in combinations:
            dims = combo.dimensions
            items.append(
                _mock_prompt_text(
                    combo,
                    product_name=product_name,
                    duration_seconds=duration_seconds,
                    aspect_ratio=_first_text(insight, "aspectRatio", "aspect_ratio") or "9:16",
                )
            )
        return _mock_result(
            GeneratedPromptTextBatch(items=items), "CANDIDATE_GENERATION", CANDIDATE_PROMPT
        )


class ArkResponsesProvider:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        strategy_model: str,
        candidate_model: str,
        strategy_max_output_tokens: int = 2048,
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
        self, insight: Mapping[str, Any], *, target_count: int
    ) -> AiCallResult[DimensionPools]:
        allowed = _selling_points(insight)
        if not allowed:
            raise ProviderError(
                "产品素材制作信息卡缺少已确认卖点",
                retryable=False,
                error_type=ProviderErrorType.REQUEST_REJECTED,
            )
        prompt = render_prompt(
            STRATEGY_PROMPT,
            target_count=str(target_count),
            insight_json=json.dumps(dict(insight), ensure_ascii=False, sort_keys=True),
        )
        call = await self._structured(
            prompt,
            DimensionPools,
            schema_name="effect_prompt_dimension_pools",
            stage="STRATEGY_PLANNING",
            prompt_file=STRATEGY_PROMPT,
            model=self._strategy_model,
            max_output_tokens=self._strategy_max_output_tokens,
        )
        evidence_by_point = {
            _normalized_text(item.selling_point): item for item in call.value.evidence_plans
        }
        if set(evidence_by_point) != {_normalized_text(item) for item in allowed}:
            raise ProviderError(
                "AI evidence plans do not match the confirmed selling points",
                retryable=False,
                error_type=ProviderErrorType.RESPONSE_INVALID,
                attempts=call.metadata.attempts,
                elapsed_ms=call.metadata.latency_ms,
            )
        protected_evidence = [evidence_by_point[_normalized_text(item)] for item in allowed]
        # Selling points are protected hard facts; model output cannot add or remove them.
        return AiCallResult(
            value=call.value.model_copy(
                update={"selling_points": allowed, "evidence_plans": protected_evidence}
            ),
            metadata=call.metadata,
        )

    async def generate_candidates(
        self,
        combinations: list[PlannedCombination],
        *,
        insight: Mapping[str, Any],
        duration_seconds: int,
        style_override: str | None,
        additional_disabled_elements: list[str],
    ) -> AiCallResult[GeneratedPromptTextBatch]:
        product_context = _candidate_product_context(insight)
        prompt = render_prompt(
            CANDIDATE_PROMPT,
            duration_seconds=str(duration_seconds),
            aspect_ratio=_first_text(insight, "aspectRatio", "aspect_ratio") or "以信息卡为准",
            delivery_channels=_first_text(insight, "deliveryChannels", "delivery_channels") or "以信息卡为准",
            visual_style=style_override
            or _first_text(insight, "visualStyleBaseline", "visual_style_baseline")
            or "以信息卡为准",
            disabled_elements_json=json.dumps(
                [
                    *_text_list(insight, "disabledElements", "disabled_elements"),
                    *additional_disabled_elements,
                ],
                ensure_ascii=False,
            ),
            product_context_json=json.dumps(
                product_context, ensure_ascii=False, sort_keys=True
            ),
            combinations_json=json.dumps(
                [item.model_dump(mode="json", by_alias=True) for item in combinations],
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            GeneratedPromptTextBatch,
            schema_name="effect_prompt_candidate_batch",
            stage="CANDIDATE_GENERATION",
            prompt_file=CANDIDATE_PROMPT,
            model=self._candidate_model,
            max_output_tokens=self._candidate_max_output_tokens,
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


def _mock_prompt_text(
    combination: PlannedCombination,
    *,
    product_name: str,
    duration_seconds: int,
    aspect_ratio: str,
) -> GeneratedPromptText:
    dims = combination.dimensions
    prefix = f"{duration_seconds}秒，{aspect_ratio}竖屏。{dims.scene}，{dims.persona}"
    action = combination.visible_action
    role_text = {
        FragmentType.HOOK: (
            f"从一个出人意料但真实的手部动作开始，{action}；画面只制造注意力和动作悬念，"
            f"不解释完整功能。{dims.camera}连续靠近动作焦点"
        ),
        FragmentType.PAIN: (
            f"正处于与{dims.selling_point}相关的具体不便中，{action}但问题仍未解决，产品不必出现；"
            f"{dims.camera}持续跟住人物手部与受阻动作"
        ),
        FragmentType.PRODUCT_DISPLAY: (
            f"自然拿起{product_name}并缓慢调整朝向，完整露出已确认外观，{action}；"
            f"{dims.camera}平滑聚焦产品轮廓和可见细节，不演示额外效果"
        ),
        FragmentType.EFFECT_DEMONSTRATION: (
            f"使用{product_name}只完成一次连续动作：{action}，画面明确呈现{dims.selling_point}允许的"
            f"可见证据——{combination.allowed_visual_evidence}；{dims.camera}跟随动作且保持产品清晰"
        ),
        FragmentType.SELLING_POINT_EXPLANATION: (
            f"手持{product_name}指向一个已确认细节并保持动作连续，{action}；字幕或一句自然口播只写"
            f"“{dims.selling_point}”，{dims.camera}稳定聚焦讲解位置"
        ),
        FragmentType.CTA: (
            f"把{product_name}平稳放入当前生活环境并准备离开，{action}；{dims.camera}轻缓后拉并留出"
            f"干净字幕空间，安全短字幕为“现在去了解”，不出现价格、折扣或销量"
        ),
        FragmentType.OUTRO: (
            f"将{product_name}正面稳定留在画面中心，人物的手自然离开，{action}；{dims.camera}缓慢停住，"
            f"只保留产品和品牌收尾画面"
        ),
    }[combination.fragment_type]
    prompt = (
        f"{prefix}，{role_text}。光线和色彩呈现{dims.emotion}，动作速度与镜头运动保持一致，环境声自然，"
        "结尾停在单一清晰状态；全片同一地点、同一人物、一个连续视觉事件，不使用分镜列表或场景切换。"
    )
    return GeneratedPromptText(slot_id=combination.slot_id, prompt_text=prompt)


def _mock_evidence_plan(selling_point: str) -> SellingPointEvidence:
    normalized = selling_point.casefold()
    if any(token in normalized for token in ("开", "关", "按", "操作", "使用", "清洗")):
        mode = EvidenceMode.USAGE_ACTION
        allowed = f"一次可见、连续且不增加结论的{selling_point}使用动作"
    elif any(token in normalized for token in ("外观", "颜色", "轻量", "便携", "尺寸", "设计")):
        mode = EvidenceMode.VISIBLE_ATTRIBUTE
        allowed = f"产品在人物手部或真实场景中的{selling_point}可见属性"
    else:
        mode = EvidenceMode.VISIBLE_RESULT
        allowed = f"仅呈现信息卡已经确认的{selling_point}可见结果，不做前后对比扩展"
    return SellingPointEvidence(
        selling_point=selling_point,
        evidence_mode=mode,
        allowed_visual_evidence=allowed,
        forbidden_inference=f"不得把{selling_point}扩展为未确认功效、数据、认证或绝对化结论",
    )


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
