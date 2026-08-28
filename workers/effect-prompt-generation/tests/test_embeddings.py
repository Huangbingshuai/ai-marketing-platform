from __future__ import annotations

import asyncio
import json

import httpx
import pytest
import effect_prompt_generation.embeddings as embeddings_module

from effect_prompt_generation.embeddings import (
    ArkEmbeddingProvider,
    EmbeddingProviderError,
    MockEmbeddingProvider,
    build_creative_vector_index,
    compile_content_embedding_text,
    compile_creative_embedding_text,
)
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDimensions,
    SharedPrompt,
    SharedPromptSection,
)


def _shared_prompt() -> SharedPrompt:
    content = "画面中不得出现以下内容：价格贴纸；二维码。"
    return SharedPrompt(
        sections=[
            SharedPromptSection(
                key="DISABLED_ELEMENTS",
                title="禁用元素",
                source="SYSTEM",
                content=content,
                editable=False,
                source_hash="1" * 64,
            )
        ],
        compiled_content=content,
        content_hash="2" * 64,
    )


def _candidate(index: int) -> CreativeCandidate:
    return CreativeCandidate(
        slot_id=f"candidate-{index:03d}",
        ordinal=index,
        round=0,
        creative_core=f"第{index}个连续产品动作",
        declared_fact_ids=["fact-product"],
        dimensions=CreativeDimensions(
            narrative=f"动作叙事{index}",
            scene=f"场景{index}",
            persona=f"成年人主体{index}",
            product_relation=f"便携杯状态{index}",
            camera=f"镜头方式{index}",
            emotion=f"情绪氛围{index}",
        ),
        content=(
            f"5秒，9:16画幅。场景{index}里成年人拿起便携杯完成动作{index}，"
            "镜头在稳定画面结束。画面中不得出现以下内容：价格贴纸；二维码。"
        ),
    )


def test_embedding_text_compiler_removes_shared_tail_and_common_product_tokens() -> (
    None
):
    candidate = _candidate(1)
    content = compile_content_embedding_text(
        candidate.content,
        product_name="便携杯",
        product_category="随行杯",
        shared_prompt=_shared_prompt(),
    )
    creative = compile_creative_embedding_text(
        candidate,
        product_name="便携杯",
        product_category="随行杯",
    )

    assert "5秒" not in content
    assert "9:16" not in content
    assert "价格贴纸" not in content
    assert "便携杯" not in content
    assert "[产品]" in content
    assert all(
        label in creative
        for label in ("叙事：", "场景：", "人物：", "产品关联：", "镜头：", "情绪：")
    )


@pytest.mark.asyncio
async def test_ark_embedding_provider_restores_out_of_order_vectors() -> None:
    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 1, "embedding": [0.0, 1.0]},
                    {"index": 0, "embedding": [1.0, 0.0]},
                ],
                "usage": {"prompt_tokens": 8, "total_tokens": 8},
            },
        )

    provider = ArkEmbeddingProvider(
        base_url="https://ark.example/api/v3",
        api_key="test-key",
        model="embedding-model",
        api_mode="text",
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.embed(["第一条", "第二条"])
    finally:
        await provider.aclose()

    assert seen == {
        "model": "embedding-model",
        "input": ["第一条", "第二条"],
        "encoding_format": "float",
    }
    assert result.vectors == [(1.0, 0.0), (0.0, 1.0)]
    assert result.input_tokens == 8
    assert result.request_count == 1


@pytest.mark.asyncio
async def test_ark_multimodal_embedding_provider_uses_single_text_request() -> None:
    seen: dict[str, object] = {}
    seen_path = ""

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal seen_path
        seen_path = request.url.path
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "data": [{"object": "embedding", "embedding": [[1.0, 0.0]]}],
                "usage": {"prompt_tokens": 7, "total_tokens": 7},
            },
        )

    provider = ArkEmbeddingProvider(
        base_url="https://ark.example/api/v3",
        api_key="test-key",
        model="doubao-embedding-vision-251215",
        api_mode="multimodal",
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.embed(["单条素材画面描述"])
        with pytest.raises(ValueError, match="between 1 and 1"):
            await provider.embed(["第一条", "第二条"])
    finally:
        await provider.aclose()

    assert seen_path == "/api/v3/embeddings/multimodal"
    assert seen == {
        "model": "doubao-embedding-vision-251215",
        "input": [{"type": "text", "text": "单条素材画面描述"}],
        "encoding_format": "float",
    }
    assert result.vectors == [(1.0, 0.0)]
    assert result.input_tokens == 7
    assert provider.max_inputs_per_request == 1


@pytest.mark.asyncio
async def test_ark_multimodal_embedding_provider_accepts_current_data_object() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(
            200,
            json={
                "data": {"object": "embedding", "embedding": [1.0, 0.0]},
                "usage": {"prompt_tokens": 5},
            },
        )

    provider = ArkEmbeddingProvider(
        base_url="https://ark.example/api/v3",
        api_key="test-key",
        model="doubao-embedding-vision-251215",
        api_mode="multimodal",
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.embed(["单条素材画面描述"])
    finally:
        await provider.aclose()

    assert result.vectors == [(1.0, 0.0)]
    assert result.input_tokens == 5


@pytest.mark.asyncio
async def test_ark_embedding_provider_retries_429_and_obeys_retry_after() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        del request
        calls += 1
        if calls == 1:
            return httpx.Response(429, headers={"retry-after": "0"})
        return httpx.Response(
            200,
            json={"data": [{"index": 0, "embedding": [1.0, 0.0]}]},
        )

    provider = ArkEmbeddingProvider(
        base_url="https://ark.example/api/v3",
        api_key="test-key",
        model="embedding-model",
        api_mode="text",
        max_attempts=3,
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.embed(["测试文本"])
    finally:
        await provider.aclose()

    assert calls == 2
    assert result.request_count == 2
    assert result.retry_count == 1


@pytest.mark.asyncio
async def test_ark_embedding_provider_retries_server_and_transport_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def no_wait(delay: float) -> None:
        assert delay >= 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(503)
        if calls == 2:
            raise httpx.ReadTimeout("timeout", request=request)
        return httpx.Response(
            200,
            json={"data": [{"index": 0, "embedding": [1.0, 0.0]}]},
        )

    monkeypatch.setattr(asyncio, "sleep", no_wait)
    provider = ArkEmbeddingProvider(
        base_url="https://ark.example/api/v3",
        api_key="test-key",
        model="embedding-model",
        api_mode="text",
        max_attempts=3,
        transport=httpx.MockTransport(handler),
    )
    try:
        result = await provider.embed(["测试文本"])
    finally:
        await provider.aclose()

    assert calls == 3
    assert result.retry_count == 2


@pytest.mark.asyncio
async def test_ark_embedding_provider_rejects_invalid_dimensions() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 0, "embedding": [1.0, 0.0]},
                    {"index": 1, "embedding": [1.0, 0.0, 0.0]},
                ]
            },
        )

    provider = ArkEmbeddingProvider(
        base_url="https://ark.example/api/v3",
        api_key="test-key",
        model="embedding-model",
        api_mode="text",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(EmbeddingProviderError, match="无效响应") as exc_info:
            await provider.embed(["第一条", "第二条"])
    finally:
        await provider.aclose()

    assert exc_info.value.retryable is False


@pytest.mark.asyncio
async def test_vector_index_batches_120_inputs_and_reuses_run_cache() -> None:
    candidates = [_candidate(index) for index in range(1, 61)]
    provider = MockEmbeddingProvider()
    cache: dict[str, tuple[float, ...]] = {}

    first = await build_creative_vector_index(
        candidates,
        provider=provider,
        vector_cache=cache,
        product_name="便携杯",
        product_category="随行杯",
        shared_prompt=_shared_prompt(),
        batch_size=64,
        max_concurrency=2,
    )
    second = await build_creative_vector_index(
        candidates,
        provider=provider,
        vector_cache=cache,
        product_name="便携杯",
        product_category="随行杯",
        shared_prompt=_shared_prompt(),
        batch_size=64,
        max_concurrency=2,
    )

    assert first.stats.input_count == 120
    assert first.stats.request_count == 2
    assert first.stats.comparison_count == 1770
    assert first.stats.local_comparison_ms <= 300
    assert second.stats.request_count == 0
    assert second.stats.cache_hit_count == 120
    assert 0 <= first.dual_novelty("candidate-001", "candidate-002") <= 100


@pytest.mark.asyncio
async def test_vector_index_normalizes_each_document_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    normalize_calls = 0
    original = embeddings_module._normalize_vector

    def counting_normalize(vector: tuple[float, ...]) -> tuple[float, ...]:
        nonlocal normalize_calls
        normalize_calls += 1
        return original(vector)

    monkeypatch.setattr(embeddings_module, "_normalize_vector", counting_normalize)
    result = await build_creative_vector_index(
        [_candidate(index) for index in range(1, 61)],
        provider=MockEmbeddingProvider(),
        vector_cache={},
        product_name="便携杯",
        product_category="随行杯",
        shared_prompt=_shared_prompt(),
        batch_size=64,
        max_concurrency=2,
    )

    assert result.stats.input_count == 120
    assert result.stats.comparison_count == 1770
    assert normalize_calls == 120


class _ConcurrencyProvider(MockEmbeddingProvider):
    max_inputs_per_request = 1

    def __init__(self) -> None:
        self.active = 0
        self.maximum = 0

    async def embed(self, texts: list[str]):  # type: ignore[no-untyped-def]
        self.active += 1
        self.maximum = max(self.maximum, self.active)
        await asyncio.sleep(0)
        try:
            return await super().embed(texts)
        finally:
            self.active -= 1


@pytest.mark.asyncio
async def test_vector_index_respects_independent_concurrency_limit() -> None:
    provider = _ConcurrencyProvider()
    await build_creative_vector_index(
        [_candidate(index) for index in range(1, 31)],
        provider=provider,
        vector_cache={},
        product_name="便携杯",
        product_category="随行杯",
        shared_prompt=_shared_prompt(),
        batch_size=10,
        max_concurrency=2,
    )

    assert provider.maximum == 2
