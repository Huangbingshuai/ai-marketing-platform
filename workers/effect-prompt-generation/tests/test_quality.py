from __future__ import annotations

from datetime import datetime, timezone

import pytest

from effect_prompt_generation.models import FragmentType, PromptDimensions, PromptItem
from effect_prompt_generation.quality import (
    evaluate_candidates,
    pair_rate,
    semantic_similarity,
    trigram_dice,
    visual_overlap,
)


def _item(identifier: str, dimensions: PromptDimensions, content: str) -> PromptItem:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return PromptItem(
        id=identifier,
        code=identifier,
        origin="AI",
        fragment_type=FragmentType.PRODUCT_DISPLAY,
        material_tags=["产品", "特写"],
        target_duration_seconds=5,
        dimensions=dimensions,
        content=content,
        manual_edited=False,
        created_at=now,
        updated_at=now,
    )


def test_quality_constants_have_golden_scores(dimensions: PromptDimensions) -> None:
    same_signature = _item("a", dimensions, "abcdef")
    changed = dimensions.model_copy(
        update={"narrative": "效果展示型", "selling_point": "耐用", "scene": "户外"}
    )
    other = _item("b", changed, "abcxef")
    visual = dimensions.model_copy(
        update={"narrative": "科普型", "selling_point": "耐用", "persona": "成熟男性"}
    )

    assert trigram_dice("abcdef", "abcxef") == pytest.approx(0.25)
    assert semantic_similarity(same_signature, _item("same", dimensions, "完全不同正文")) == 1.0
    assert visual_overlap(same_signature, _item("visual", visual, "另一正文")) == pytest.approx(0.8)
    assert pair_rate(1, 4) == pytest.approx(16.67)
    assert pair_rate(63, 64) == pytest.approx(3.13)
    assert semantic_similarity(same_signature, other) == pytest.approx(0.25)


def test_evaluation_keeps_dimension_conflict_as_a_ranking_signal(
    prompt_item: PromptItem,
) -> None:
    candidates = [
        prompt_item.model_copy(update={"id": "duplicate-dimensions", "content": "全新文本"}),
    ]
    result = evaluate_candidates(
        [prompt_item],
        candidates,
        target_count=10,
        semantic_limit=15,
        visual_limit=20,
        round_number=0,
    )

    assert result.metrics.removed_dimension_conflicts == 0
    assert result.metrics.accepted_count == 2
    assert result.quality_status == "NEEDS_REVIEW"


def test_batch_allows_similar_pair_within_configured_rates(
    prompt_item: PromptItem,
) -> None:
    similar = prompt_item.model_copy(
        update={"id": "similar", "code": "similar", "content": "同坐标但正文不同"}
    )
    diverse_contents = [
        "窗边成年人缓慢扶正产品后停住",
        "门店展示台上产品在冷光下保持稳定",
        "户外长椅旁单手轻放主体并退出画面",
        "厨房木桌旁双手移开遮挡后停下",
        "玄关矮柜上主体在暖光里保持清楚",
        "办公桌前成年人触碰产品侧面细节",
        "卧室收纳区单手取出主体并扶正",
        "简洁展台中央产品形成稳定结束构图",
    ]
    diverse = [
        prompt_item.model_copy(
            update={
                "id": f"diverse-{index}",
                "code": f"diverse-{index}",
                "content": diverse_contents[index],
                "dimensions": prompt_item.dimensions.model_copy(
                    update={
                        "narrative": f"叙事{index}",
                        "scene": f"场景{index}",
                        "persona": f"人物{index}",
                        "camera": f"镜头{index}",
                    }
                ),
            }
        )
        for index in range(8)
    ]
    result = evaluate_candidates(
        [],
        [prompt_item, similar, *diverse],
        target_count=10,
        semantic_limit=15,
        visual_limit=20,
        round_number=0,
    )

    assert result.metrics.accepted_count == 10
    assert result.metrics.semantic_duplicate_rate == pytest.approx(2.22)
    assert result.metrics.visual_overlap_rate == pytest.approx(2.22)
    assert result.metrics.removed_semantic_duplicates == 0
    assert result.metrics.removed_visual_duplicates == 0
    assert result.quality_status == "PASS"


def test_exact_prompt_duplicate_remains_a_hard_rejection(
    prompt_item: PromptItem,
) -> None:
    duplicate = prompt_item.model_copy(
        update={"id": "duplicate", "code": "duplicate"}
    )
    result = evaluate_candidates(
        [],
        [prompt_item, duplicate],
        target_count=10,
        semantic_limit=15,
        visual_limit=20,
        round_number=0,
    )

    assert result.metrics.accepted_count == 1
    assert result.metrics.removed_semantic_duplicates == 1
    assert result.quality_status == "NEEDS_REVIEW"


def test_over_limit_similarity_preserves_exact_quantity_for_review(
    prompt_item: PromptItem,
) -> None:
    candidates = [
        prompt_item.model_copy(
            update={
                "id": f"similar-{index}",
                "code": f"similar-{index}",
                "content": f"相同画面关系下的不同动作描述版本 {index}",
            }
        )
        for index in range(10)
    ]
    result = evaluate_candidates(
        [],
        candidates,
        target_count=10,
        semantic_limit=15,
        visual_limit=20,
        round_number=3,
    )

    assert result.metrics.accepted_count == 10
    assert result.metrics.semantic_duplicate_rate == pytest.approx(100)
    assert result.metrics.visual_overlap_rate == pytest.approx(100)
    assert result.metrics.removed_semantic_duplicates == 0
    assert result.quality_status == "NEEDS_REVIEW"


def test_core_selling_point_coverage_is_a_quality_gate(prompt_item: PromptItem) -> None:
    result = evaluate_candidates(
        [prompt_item],
        [],
        target_count=10,
        semantic_limit=15,
        visual_limit=20,
        round_number=3,
        required_selling_points=[prompt_item.dimensions.selling_point, "尚未覆盖的核心卖点"],
    )

    assert result.missing_selling_points == ["尚未覆盖的核心卖点"]
    assert result.quality_status == "NEEDS_REVIEW"
