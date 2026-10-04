import asyncio
import base64
import json
import logging
import math
import re
import time
from collections.abc import Mapping
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .models import ClassificationResult, IncrementalPlan, IncrementalReview, IncrementalVariant, Material, OmittedMaterial, Slot, Snapshot, TrimChoice
from .reliability import classification_output_token_budget

T = TypeVar("T", bound=BaseModel)
LOGGER = logging.getLogger(__name__)


class ProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool,
        split_recommended: bool = False,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.split_recommended = split_recommended


class ProviderOutputError(ProviderError):
    """A received model response failed mechanical JSON/schema validation."""


SLOT_ROLE_DESCRIPTIONS: dict[str, str] = {
    "HOOK": "开头抓眼球、制造好奇、冲击或情绪共鸣的画面（动作、特写、反差、悬念、诱人瞬间）",
    "PAIN_POINT": "唤起目标用户的需求、渴望、困扰或不满足感——既包括使用前的困扰与负面状态，也包括「想要、缺少、还没得到」的欲望与期待",
    "PRODUCT": "产品外观、质感、细节或使用过程的清晰展示",
    "SELLING_POINT": "突出产品核心卖点或优势（工艺、材质、功能、效果、对比优势）",
    "TRANSFORMATION": "使用后的满足、改善、前后对比或成果展示",
    "END": "收尾、总结升华、品牌露出或行动号召",
}


def classification_payload(slots: list[Slot], materials: list[Material]) -> dict[str, Any]:
    """Frozen classifier input boundary: only slot semantics and original Prompt text."""
    return {
        "task": (
            "评估每条原始视频 Prompt 描述的画面作为各槽位镜头的适配程度。"
            "用宽口径理解槽位：画面不必直接呈现该槽位的典型场景，只要能间接呼应、铺垫或唤起相应情绪、需求或期待，就应给予正向分。"
            "只依据 Prompt 画面语义与槽位定义判断，不要猜测任何未提供的推荐用途。"
        ),
        "slots": [
            {
                "role": slot.role,
                "label": slot.label,
                "description": SLOT_ROLE_DESCRIPTIONS.get(slot.role, slot.label),
            }
            for slot in slots
        ],
        "materials": [
            {"materialId": material.id, "code": material.code, "prompt": material.prompt}
            for material in materials
        ],
        "rules": [
            "每个分数为 0 到 1 的连续值",
            "每个素材必须输出六个分数",
            "按适配程度分档：0=完全无关，0.1-0.3=弱相关，0.4-0.6=可勉强使用，0.7+=直接契合",
            "不要轻易给 0 分：只要画面与该槽位存在任何可解释的关联（铺垫、过渡、情绪呼应、需求唤起），就给 0.3 以上的分；只有完全无法服务于该槽位时才给 0",
            "理由简短且只引用 Prompt 画面语义与槽位定义",
        ],
    }


def _output_text(payload: Any) -> str:
    if isinstance(payload, Mapping):
        direct = payload.get("output_text")
        if isinstance(direct, str) and direct.strip():
            return direct
        for item in payload.get("output", []):
            if not isinstance(item, Mapping):
                continue
            for part in item.get("content", []):
                if isinstance(part, Mapping) and part.get("type") == "output_text":
                    value = part.get("text")
                    if isinstance(value, str) and value.strip():
                        return value
    raise ValueError("missing output_text")


class ArkProvider:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float,
        max_output_tokens: int,
        reasoning_effort: str,
    ) -> None:
        self.model = model
        self.request_timeout = timeout
        self.max_output_tokens = max_output_tokens
        self.reasoning_effort = reasoning_effort
        self.retry_not_before = 0.0
        self.client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/", timeout=timeout,
            headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def wait_for_provider(self) -> None:
        # All concurrent requests share the supplier's cooldown, including new chunks.
        while (delay := self.retry_not_before - time.monotonic()) > 0:
            await asyncio.sleep(delay)

    def defer_requests(self, failures: int, retry_after: str | None = None) -> None:
        delay = min(30.0, 2.0 ** failures)
        if retry_after is not None:
            try:
                supplied = float(retry_after)
                if math.isfinite(supplied):
                    delay = max(delay, min(60.0, supplied))
            except ValueError:
                pass
        self.retry_not_before = max(self.retry_not_before, time.monotonic() + delay)

    async def structured(
        self,
        content: list[dict[str, Any]],
        output: type[T],
        name: str,
        *,
        max_output_tokens: int,
        max_attempts: int = 2,
        max_transient_attempts: int | None = None,
    ) -> T:
        payload = {
            "model": self.model,
            "input": [{"role": "user", "content": content}],
            "store": False,
            "max_output_tokens": min(self.max_output_tokens, max_output_tokens),
            "reasoning": {"effort": self.reasoning_effort},
            "text": {"format": {"type": "json_schema", "name": name, "schema": output.model_json_schema(), "strict": True}},
        }
        last: Exception | None = None
        invalid_outputs = 0
        transient_failures = 0
        transient_limit = max_transient_attempts or max_attempts
        while invalid_outputs < max_attempts and transient_failures < transient_limit:
            await self.wait_for_provider()
            try:
                started = time.monotonic()
                async with asyncio.timeout(self.request_timeout):
                    response = await self.client.post("responses", json=payload)
                if name.startswith('packaging_'):
                    request_id = response.headers.get('x-request-id', '')
                    if not re.fullmatch(r'[a-zA-Z0-9_.:-]{0,160}', request_id):
                        request_id = 'redacted'
                    LOGGER.info('packaging model stage=%s status=%s elapsed=%.3f request_id=%s',
                        name, response.status_code, time.monotonic() - started, request_id)
                if response.is_error:
                    request_id = response.headers.get('x-request-id', '')
                    if not re.fullmatch(r'[a-zA-Z0-9_.:-]{0,160}', request_id):
                        request_id = 'redacted'
                    LOGGER.warning('model request failed stage=%s status=%s request_id=%s',
                        name, response.status_code, request_id)
                    retryable = response.status_code >= 500 or response.status_code in (408, 429)
                    error = ProviderError(
                        "AI 服务请求受限，请稍后重试" if response.status_code == 429 else "AI 服务暂时不可用",
                        retryable=retryable,
                    )
                    if not retryable:
                        raise error
                    last = error
                    transient_failures += 1
                    self.defer_requests(transient_failures,
                        response.headers.get('retry-after') or ('5' if response.status_code == 429 else None))
                    continue
                response_payload = response.json()
                if response_payload.get("status") == "incomplete":
                    if name.startswith('packaging_'):
                        LOGGER.warning('packaging model incomplete stage=%s token_budget=%s request_id=%s',
                            name, payload['max_output_tokens'], request_id)
                    raise ProviderError(
                        "AI 输出超过当前分片容量",
                        retryable=False,
                        split_recommended=True,
                    )
                return output.model_validate_json(_output_text(response_payload))
            except ProviderError:
                raise
            except (TimeoutError, httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as exc:
                LOGGER.warning('%s transport failed stage=%s type=%s elapsed=%.3f',
                    'packaging model' if name.startswith('packaging_') else 'model',
                    name, type(exc).__name__, time.monotonic() - started)
                last = exc
                transient_failures += 1
                self.defer_requests(transient_failures)
            except (ValueError, ValidationError, json.JSONDecodeError) as exc:
                if name.startswith('packaging_'):
                    # Error input/ctx can contain model text; record only mechanical field locations.
                    fields = [str(error['loc']) for error in exc.errors(include_input=False, include_context=False)] if isinstance(exc, ValidationError) else []
                    LOGGER.warning('packaging model invalid stage=%s type=%s fields=%s', name, type(exc).__name__, fields)
                last = exc
                invalid_outputs += 1
        if isinstance(last, ProviderError):
            raise last
        error_type = ProviderOutputError if isinstance(last, ValueError) else ProviderError
        raise error_type(
            ("AI 服务响应超时，已保留成功步骤，请恢复未完成项"
             if isinstance(last, (TimeoutError, httpx.TimeoutException)) else
             "AI 服务连接中断，已保留成功步骤，请恢复未完成项"
             if isinstance(last, (httpx.NetworkError, httpx.RemoteProtocolError)) else "AI 返回结构无效"),
            retryable=isinstance(last, (TimeoutError, httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)),
            split_recommended=isinstance(
                last,
                (
                    TimeoutError,
                    httpx.TimeoutException,
                    ValueError,
                    ValidationError,
                    json.JSONDecodeError,
                ),
            ),
        ) from last

    async def classify(self, slots: list[Slot], materials: list[Material]) -> ClassificationResult:
        # Deliberately compile only slot definitions and original Prompt text. Upstream
        # purpose/recommendation fields are neither accepted nor forwarded here.
        prompt = classification_payload(slots, materials)
        return await self.structured(
            [{"type": "input_text", "text": json.dumps(prompt, ensure_ascii=False)}],
            ClassificationResult,
            "effect_template_mix_classification",
            max_output_tokens=classification_output_token_budget(materials),
            max_transient_attempts=4,
        )

    async def plan_incremental(self, snapshot: Snapshot, roles: dict[str, str]) -> IncrementalPlan:
        if snapshot.incremental is None:
            raise ProviderError("缺少新增素材输入", retryable=False)
        accepted: list[IncrementalVariant] = []
        omitted: dict[str, OmittedMaterial] = {}
        # Capacity paging bounds each response; AI chooses count and semantic differences.
        # A separate AI review rejects repetitive viewing events. No combinatorial fallback.
        for _ in range(math.ceil(snapshot.maxOutputVariants / 8)):
            remaining = snapshot.maxOutputVariants - len(accepted)
            if remaining <= 0:
                break
            context = {
                "task": "使用新增素材追加有实际观看差异的成片方案，不改动已有成片。",
                "slots": [slot.model_dump() for slot in snapshot.slots],
                "newMaterialIds": snapshot.incremental.materialIds,
                "materials": [{"materialId": material.id, "prompt": material.prompt,
                               "duration": material.duration, "assignedRole": roles.get(material.id)}
                              for material in snapshot.materials],
                "existingBindings": [[binding.model_dump() for binding in bindings]
                                     for bindings in snapshot.existingVariantBindings],
                "acceptedPlans": [variant.model_dump() for variant in accepted],
                "maximumThisPage": min(8, remaining),
                "rules": [
                    "每条成片恰好六个槽位，六个素材互不重复，素材必须满足已归槽角色和时长",
                    "允许复用旧素材，但每条必须至少包含一个新增素材",
                    "尽可能让每个可用新增素材参与多条方案，优先覆盖尚未参与的新增素材；数量由有意义的差异决定",
                    "difference 解释真实观看事件、产品关联点或情绪节奏的区别，不得编造未提供事实",
                    "禁止机械枚举、仅换顺序或截取起点来凑数量，避免与已有和已接受方案语义重复",
                    "没有足够的有意义差异时返回空 variants；omitted 逐条解释尚未被 acceptedPlans 或本页方案使用的所有新增素材",
                ],
            }
            candidate = await self.structured(
                [{"type": "input_text", "text": json.dumps(context, ensure_ascii=False)}],
                IncrementalPlan, "effect_template_mix_incremental_plan", max_output_tokens=8192,
                max_transient_attempts=4,
            )
            if len(candidate.variants) > min(8, remaining):
                raise ProviderError("AI 追加方案超过当前容量", retryable=False)
            omitted.update({item.materialId: item for item in candidate.omitted})
            if not candidate.variants:
                break
            review = await self.structured(
                [{"type": "input_text", "text": json.dumps({
                    **context, "task": "独立审核新增成片的真实观看差异与事实可靠性，选择应保留的候选索引（从0开始）。",
                    "candidates": [variant.model_dump() for variant in candidate.variants],
                    "reviewRules": ["剔除与已有成片、已接受方案及其他候选实质重复的观看事件",
                                    "不因措辞不同就判定有差异；不允许无来源产品事实；可以全部拒绝"],
                }, ensure_ascii=False)}],
                IncrementalReview, "effect_template_mix_incremental_review", max_output_tokens=2048,
                max_transient_attempts=4,
            )
            indexes = review.acceptedIndexes
            if len(set(indexes)) != len(indexes) or any(index < 0 or index >= len(candidate.variants) for index in indexes):
                raise ProviderError("AI 方案审核索引无效", retryable=False)
            if not indexes:
                break
            accepted.extend(candidate.variants[index] for index in indexes)
        if not accepted:
            raise ProviderError("新增素材暂时无法组成有观看差异的完整成片，旧工程已保留", retryable=False)
        used = {binding.materialId for variant in accepted for binding in variant.bindings}
        return IncrementalPlan(variants=accepted, omitted=[item for material_id, item in omitted.items()
                                                        if material_id not in used])

    async def trim(
        self,
        slot: Slot,
        material: Material,
        frames: list[tuple[float, bytes]],
        correction: str | None = None,
    ) -> TrimChoice:
        max_start = max(0.0, material.duration - slot.duration)
        text = {
            "task": "从抽帧中选择最适合槽位的连续截取起点。输出起点，结束时间由服务端按槽位时长计算。",
            "slot": {"role": slot.role, "label": slot.label, "durationSeconds": slot.duration},
            "material": {"materialId": material.id, "code": material.code, "durationSeconds": material.duration, "prompt": material.prompt},
            "frameTimestamps": [timestamp for timestamp, _ in frames],
            "allowedTrimStartSeconds": {"minimum": 0, "maximum": max_start},
            "rules": [
                f"trimStartSeconds 必须在 0 到 {max_start:.3f} 秒之间（含边界）",
                "必须保证起点加槽位时长不超过源视频时长",
            ],
        }
        if correction:
            text["correction"] = correction
        content: list[dict[str, Any]] = [{"type": "input_text", "text": json.dumps(text, ensure_ascii=False)}]
        for timestamp, data in frames:
            content.append({"type": "input_text", "text": f"帧时间戳 {timestamp:.3f} 秒"})
            content.append({"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")})
        return await self.structured(
            content,
            TrimChoice,
            "effect_template_mix_trim",
            max_output_tokens=1_024,
            max_transient_attempts=4,
        )
