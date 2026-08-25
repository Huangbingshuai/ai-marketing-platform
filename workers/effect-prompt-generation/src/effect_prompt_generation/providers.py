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

from .models import DimensionPools, GeneratedText, GeneratedTextBatch, PlannedCombination
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
    ) -> AiCallResult[GeneratedTextBatch]: ...


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
            narratives=["痛点前置型", "效果展示型", "场景代入型", "科普讲解型", "对比测评型", "开箱体验型"],
            scenes=scenes or ["家庭日常", "户外出行", "职场间歇", "线下门店", "实验室演示", "生活化使用"],
            personas=[
                audience,
                f"注重体验的{audience}",
                f"理性决策的{audience}",
                f"首次尝试的{audience}",
                f"长期使用的{audience}",
            ],
            selling_points=selling_points,
            cameras=["中景转产品特写", "第一视角跟拍", "俯拍开箱", "低机位推进", "手持纪实", "固定机位对比"],
            emotions=["温馨治愈", "专业严谨", "活力明快", "焦虑唤醒", "干货科普", "轻松可信"],
            fragment_types=["完整营销片段", "开场钩子", "卖点演示", "场景种草", "信任收束"],
        )
        return _mock_result(pools, "STRATEGY_PLANNING", STRATEGY_PROMPT)

    async def generate_candidates(
        self,
        combinations: list[PlannedCombination],
        *,
        insight: Mapping[str, Any],
        duration_seconds: int,
    ) -> AiCallResult[GeneratedTextBatch]:
        product_name = _first_text(insight, "productName", "product_name") or "产品"
        items = []
        for combo in combinations:
            dims = combo.dimensions
            content = (
                f"{dims.narrative}：在{dims.scene}中，由{dims.persona}自然出镜，围绕“{dims.selling_point}”"
                f"完成单一卖点表达。镜头采用{dims.camera}，以{dims.emotion}的节奏呈现{product_name}的"
                f"真实使用动作与关键细节；前段建立情境，中段给出可见演示，结尾回到产品主体。"
                f"总时长{duration_seconds}秒，画面连贯、主体清晰，不添加未经确认的功效或背书。"
            )
            items.append(
                GeneratedText(
                    slot_id=combo.slot_id,
                    fragment_type=combo.fragment_type,
                    content=content,
                )
            )
        return _mock_result(GeneratedTextBatch(items=items), "CANDIDATE_GENERATION", CANDIDATE_PROMPT)


class ArkResponsesProvider:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float = 120.0,
        max_attempts: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not model.strip():
            raise ValueError("Ark prompt model cannot be empty")
        self._model = model.strip()
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
        )
        # Selling points are a protected hard-fact field; model output cannot change them.
        return AiCallResult(
            value=call.value.model_copy(update={"selling_points": allowed}),
            metadata=call.metadata,
        )

    async def generate_candidates(
        self,
        combinations: list[PlannedCombination],
        *,
        insight: Mapping[str, Any],
        duration_seconds: int,
    ) -> AiCallResult[GeneratedTextBatch]:
        prompt = render_prompt(
            CANDIDATE_PROMPT,
            duration_seconds=str(duration_seconds),
            aspect_ratio=_first_text(insight, "aspectRatio", "aspect_ratio") or "以信息卡为准",
            delivery_channels=_first_text(insight, "deliveryChannels", "delivery_channels") or "以信息卡为准",
            visual_style=_first_text(insight, "visualStyleBaseline", "visual_style_baseline") or "以信息卡为准",
            disabled_elements_json=json.dumps(
                _text_list(insight, "disabledElements", "disabled_elements"), ensure_ascii=False
            ),
            combinations_json=json.dumps(
                [item.model_dump(mode="json", by_alias=True) for item in combinations],
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        call = await self._structured(
            prompt,
            GeneratedTextBatch,
            schema_name="effect_prompt_candidate_batch",
            stage="CANDIDATE_GENERATION",
            prompt_file=CANDIDATE_PROMPT,
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
    ) -> AiCallResult[TModel]:
        payload = {
            "model": self._model,
            "input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            "store": False,
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
