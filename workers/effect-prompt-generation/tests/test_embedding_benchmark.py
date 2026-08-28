from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass

import pytest

from effect_prompt_generation.embeddings import (
    ArkEmbeddingProvider,
    EmbeddingProvider,
)
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDimensions,
    CreativeEvaluation,
    CreativeScores,
    FragmentType,
    SharedPrompt,
)
from effect_prompt_generation.quality import trigram_dice


@dataclass(frozen=True, slots=True)
class LabeledPair:
    left: str
    right: str
    similar: bool


PRODUCTS = (
    ("广式腊肠", "食品"),
    ("保温杯", "日用品"),
    ("桌面空气净化器", "设备"),
)

CONCEPTS = (
    (
        "产品展示",
        "暖色桌面上，成年人扶正{product}，保持正面朝向镜头后移开双手。",
        "温暖桌面场景中，一名成年人把{product}摆正，让主体正面稳定面对摄影机。",
    ),
    (
        "使用动作",
        "通勤环境里，成年人单手拿起{product}完成一次自然使用动作并停住。",
        "在上班途中，一名成年人只用一只手取用{product}，动作完成后保持稳定。",
    ),
    (
        "痛点状态",
        "狭小空间里，成年人反复整理杂乱物品仍无法腾出位置，问题保持未解决。",
        "局促环境中，一名成年人试着收拾散乱物件，却依旧没有获得足够空间。",
    ),
    (
        "悬念钩子",
        "近景只露出被遮挡的{product}局部，成年人将要揭开遮挡时突然停住。",
        "画面靠近一处被盖住的{product}细节，手即将掀开覆盖物却悬停不动。",
    ),
    (
        "转化收束",
        "成年人把{product}轻放到干净台面中央，右侧留白，画面稳定结束。",
        "一名成年人将{product}置于整洁展台中心，主体停稳并在右边保留空白区域。",
    ),
    (
        "细节讲解",
        "微距画面沿{product}表面缓慢靠近，焦点停在已确认的真实材质细节。",
        "摄影机近距离接近{product}外表，最终清楚聚焦于能够观察的材质纹理。",
    ),
)

VARIATIONS = (
    ("午后", "自然侧光"),
    ("清晨", "柔和窗光"),
    ("傍晚", "暖色灯光"),
    ("室内", "均匀漫射光"),
    ("安静环境", "清晰轮廓光"),
)


def labeled_pairs() -> list[LabeledPair]:
    pairs: list[LabeledPair] = []
    for product, _category in PRODUCTS:
        for concept_index, (_name, source, paraphrase) in enumerate(CONCEPTS):
            negative = CONCEPTS[(concept_index + 2) % len(CONCEPTS)][2]
            for moment, light in VARIATIONS:
                left = f"{moment}，{source.format(product=product)}光线为{light}"
                right = f"{light}下，{paraphrase.format(product=product)}时间是{moment}"
                unrelated = (
                    f"{light}下，{negative.format(product=product)}时间是{moment}"
                )
                pairs.append(LabeledPair(left=left, right=right, similar=True))
                pairs.append(LabeledPair(left=left, right=unrelated, similar=False))
    return pairs


def _empty_shared_prompt() -> SharedPrompt:
    return SharedPrompt(sections=[], compiled_content="", content_hash="0" * 64)


def _candidate(index: int) -> CreativeCandidate:
    product, _ = PRODUCTS[index % len(PRODUCTS)]
    name, source, _ = CONCEPTS[index % len(CONCEPTS)]
    moment, light = VARIATIONS[index % len(VARIATIONS)]
    return CreativeCandidate(
        slot_id=f"benchmark-{index:03d}",
        ordinal=index + 1,
        round=0,
        creative_core=f"{name}-{index}",
        declared_fact_ids=["fact-product"],
        dimensions=CreativeDimensions(
            narrative=f"{name}结构{index}",
            scene=f"{moment}场景{index}",
            persona=f"成年主体{index}",
            product_relation=f"{product}关系{index}",
            camera=f"单一镜头{index}",
            emotion=f"{light}氛围{index}",
        ),
        content=source.format(product=product) + f"结束状态{index}。",
    )


def _evaluation(candidate: CreativeCandidate) -> CreativeEvaluation:
    quality = 82 + candidate.ordinal % 14
    return CreativeEvaluation(
        slot_id=candidate.slot_id,
        primary_purpose=FragmentType.PRODUCT_DISPLAY,
        compatible_purposes=[FragmentType.PRODUCT_DISPLAY],
        fact_evidence=[],
        realized_fact_ids=[],
        scores=CreativeScores(
            product_relevance=quality,
            creative_coherence=quality,
            visual_executability=quality,
            commercial_usefulness=quality,
            visual_clarity=quality,
        ),
        semantic_signature=f"semantic-{candidate.ordinal}",
        visual_signature=f"visual-{candidate.ordinal}",
    )


def test_labeled_embedding_benchmark_has_balanced_180_pairs() -> None:
    pairs = labeled_pairs()
    assert len(pairs) == 180
    assert sum(item.similar for item in pairs) == 90
    assert sum(not item.similar for item in pairs) == 90


async def _embed_texts(
    provider: EmbeddingProvider,
    texts: list[str],
    *,
    batch_size: int,
    concurrency: int,
) -> tuple[dict[str, tuple[float, ...]], int, int]:
    unique = list(dict.fromkeys(texts))
    semaphore = asyncio.Semaphore(concurrency)
    effective_batch_size = min(batch_size, provider.max_inputs_per_request)
    batches = [
        unique[index : index + effective_batch_size]
        for index in range(0, len(unique), effective_batch_size)
    ]

    async def run(batch: list[str]):  # type: ignore[no-untyped-def]
        async with semaphore:
            return batch, await provider.embed(batch)

    responses = await asyncio.gather(*(run(batch) for batch in batches))
    vectors: dict[str, tuple[float, ...]] = {}
    request_count = 0
    input_tokens = 0
    for batch, result in responses:
        vectors.update(zip(batch, result.vectors, strict=True))
        request_count += result.request_count
        input_tokens += result.input_tokens
    return vectors, request_count, input_tokens


def _cosine(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = sum(value * value for value in left) ** 0.5
    right_norm = sum(value * value for value in right) ** 0.5
    return max(0.0, min(dot / (left_norm * right_norm), 1.0))


def _metrics(
    scores: list[float], labels: list[bool], threshold: float
) -> tuple[float, float]:
    positives = sum(labels)
    negatives = len(labels) - positives
    true_positives = sum(
        score >= threshold and label
        for score, label in zip(scores, labels, strict=True)
    )
    false_positives = sum(
        score >= threshold and not label
        for score, label in zip(scores, labels, strict=True)
    )
    return true_positives / positives, false_positives / negatives


def _percentile(values: list[float], percentile: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * percentile))))
    return ordered[index]


@pytest.mark.ark_integration
@pytest.mark.asyncio
async def test_paid_ark_embedding_accuracy_and_batch_latency() -> None:
    api_key = os.getenv("ARK_API_KEY", "").strip()
    model = os.getenv("ARK_PROMPT_EMBEDDING_MODEL", "").strip()
    if not api_key or not model:
        pytest.skip("ARK_API_KEY and ARK_PROMPT_EMBEDDING_MODEL are required")
    api_mode = os.getenv("ARK_PROMPT_EMBEDDING_API_MODE", "multimodal")
    assert api_mode in {"text", "multimodal"}
    provider = ArkEmbeddingProvider(
        base_url=os.getenv(
            "ARK_BASE_URL",
            "https://ark.cn-beijing.volces.com/api/v3",
        ),
        api_key=api_key,
        model=model,
        api_mode=api_mode,  # type: ignore[arg-type]
        timeout=30,
        max_attempts=1,
    )
    try:
        smoke = await provider.embed(["效果类视频素材向量接口连通性检查"])
        # 多模态端点每次最多接收一个 text。本测试覆盖完整 180 组标注对，
        # 其中相同文本会在调用前确定性去重。
        pairs = labeled_pairs()
        texts = [text for pair in pairs for text in (pair.left, pair.right)]
        vectors, accuracy_requests, accuracy_tokens = await _embed_texts(
            provider,
            texts,
            batch_size=provider.max_inputs_per_request,
            concurrency=8,
        )
        labels = [pair.similar for pair in pairs]
        trigram_scores = [trigram_dice(pair.left, pair.right) for pair in pairs]
        vector_scores = [
            _cosine(vectors[pair.left], vectors[pair.right]) for pair in pairs
        ]
        baseline_recall, baseline_fpr = _metrics(trigram_scores, labels, 0.82)
        vector_recall, vector_fpr = _metrics(vector_scores, labels, 0.82)

        latency_texts = list(dict.fromkeys(texts))[:4]
        latency_ms: dict[int, float] = {}
        performance_requests = 0
        performance_tokens = 0
        for concurrency in (2, 8):
            started = time.perf_counter()
            _, requests, tokens = await _embed_texts(
                provider,
                latency_texts,
                batch_size=provider.max_inputs_per_request,
                concurrency=concurrency,
            )
            latency_ms[concurrency] = (time.perf_counter() - started) * 1000.0
            performance_requests += requests
            performance_tokens += tokens

        total_requests = smoke.request_count + accuracy_requests + performance_requests
        assert total_requests <= 190
        assert vector_recall >= baseline_recall + 0.20
        assert vector_fpr <= 0.10
        assert vector_fpr <= baseline_fpr + 0.03
        assert latency_ms[8] <= 5000
        assert latency_ms[8] < latency_ms[2]
        print(
            {
                "baselineRecall": round(baseline_recall, 4),
                "baselineFalsePositiveRate": round(baseline_fpr, 4),
                "vectorRecall": round(vector_recall, 4),
                "vectorFalsePositiveRate": round(vector_fpr, 4),
                "requestCount": total_requests,
                "inputTokens": accuracy_tokens + performance_tokens,
                "concurrency2Ms": round(latency_ms[2], 2),
                "concurrency8Ms": round(latency_ms[8], 2),
            }
        )
    finally:
        await provider.aclose()
