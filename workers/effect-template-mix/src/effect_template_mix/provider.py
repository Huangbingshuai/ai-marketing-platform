import asyncio
import base64
import json
from collections.abc import Mapping
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from .models import ClassificationResult, Material, Slot, TrimChoice
from .reliability import classification_output_token_budget

T = TypeVar("T", bound=BaseModel)


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


def classification_payload(slots: list[Slot], materials: list[Material]) -> dict[str, Any]:
    """Frozen classifier input boundary: only slot semantics and original Prompt text."""
    return {
        "task": "仅按每条原始视频 Prompt 的画面语义，对六种槽位分别评分。不要猜测任何未提供的推荐用途。",
        "slots": [{"role": slot.role, "label": slot.label} for slot in slots],
        "materials": [
            {"materialId": material.id, "code": material.code, "prompt": material.prompt}
            for material in materials
        ],
        "rules": ["每个分数为0到1", "每个素材必须输出六个分数", "理由简短且只引用Prompt画面语义"],
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
        self.client = httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/", timeout=timeout,
            headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def structured(
        self,
        content: list[dict[str, Any]],
        output: type[T],
        name: str,
        *,
        max_output_tokens: int,
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
        for _ in range(2):
            try:
                async with asyncio.timeout(self.request_timeout):
                    response = await self.client.post("responses", json=payload)
                if response.is_error:
                    raise ProviderError("AI 服务暂时不可用", retryable=response.status_code >= 500 or response.status_code == 429)
                response_payload = response.json()
                if response_payload.get("status") == "incomplete":
                    raise ProviderError(
                        "AI 输出超过当前分片容量",
                        retryable=False,
                        split_recommended=True,
                    )
                return output.model_validate_json(_output_text(response_payload))
            except ProviderError:
                raise
            except (TimeoutError, httpx.TimeoutException, httpx.NetworkError) as exc:
                last = exc
            except (ValueError, ValidationError, json.JSONDecodeError) as exc:
                last = exc
        raise ProviderError(
            "AI 返回结构无效",
            retryable=isinstance(last, (TimeoutError, httpx.TimeoutException, httpx.NetworkError)),
            split_recommended=isinstance(
                last,
                (
                    TimeoutError,
                    httpx.TimeoutException,
                    httpx.NetworkError,
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
        )

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
        )
