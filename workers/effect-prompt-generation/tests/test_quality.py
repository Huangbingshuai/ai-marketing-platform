from __future__ import annotations

from datetime import datetime, timezone

import pytest

from effect_prompt_generation.models import PromptDimensions, PromptItem
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
        fragment_type="完整片段",
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


def test_evaluation_removes_dimension_conflict_before_other_checks(
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

    assert result.metrics.removed_dimension_conflicts == 1
    assert result.metrics.accepted_count == 1
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
