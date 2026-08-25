from __future__ import annotations

from itertools import combinations

from effect_prompt_generation.combinations import (
    dimension_distance,
    fragment_type_targets,
    make_shards,
    plan_combinations,
)
from effect_prompt_generation.models import (
    DimensionPools,
    EvidenceMode,
    FragmentType,
    FRAGMENT_TYPE_WEIGHTS,
    SellingPointEvidence,
)


def _pools() -> DimensionPools:
    return DimensionPools(
        narratives=["痛点前置型", "效果展示型", "场景代入型"],
        scenes=["家庭", "户外", "职场"],
        personas=["年轻女性", "成熟男性", "专业测评者"],
        selling_points=["卖点甲", "卖点乙", "卖点丙"],
        cameras=["特写推进", "第一视角", "俯拍"],
        emotions=["温馨", "专业", "活力"],
        actions=["一名人物拿起产品并停住", "一名人物按下按键后停住", "一名人物放下产品后离开"],
        evidence_plans=[
            SellingPointEvidence(
                selling_point=item,
                evidence_mode=EvidenceMode.USAGE_ACTION,
                allowed_visual_evidence=f"一次{item}动作",
                forbidden_inference=f"不得扩展{item}",
            )
            for item in ["卖点甲", "卖点乙", "卖点丙"]
        ],
    )


def test_linear_code_supports_250_candidates_with_minimum_distance() -> None:
    planned = plan_combinations(
        _pools(),
        count=250,
        round_number=0,
        ordinal_start=1,
        target_duration_seconds=5,
    )

    assert len(planned) == 250
    assert min(
        dimension_distance(left.dimensions, right.dimensions)
        for left, right in combinations(planned, 2)
    ) >= 3
    assert {item.dimensions.selling_point for item in planned[:3]} == {"卖点甲", "卖点乙", "卖点丙"}


def test_replenishment_round_is_distinct_and_shards_are_bounded() -> None:
    first = plan_combinations(
        _pools(), count=20, round_number=0, ordinal_start=1, target_duration_seconds=5
    )
    second = plan_combinations(
        _pools(), count=20, round_number=1, ordinal_start=21, target_duration_seconds=5
    )
    shards = make_shards(second, round_number=1, shard_size=8)

    assert all(dimension_distance(left.dimensions, right.dimensions) >= 5 for left, right in zip(first, second))
    assert [len(shard.combinations) for shard in shards] == [8, 8, 4]


def test_fragment_type_targets_follow_approved_weights() -> None:
    targets = fragment_type_targets(50, FRAGMENT_TYPE_WEIGHTS)

    assert targets == {
        FragmentType.HOOK: 8,
        FragmentType.PAIN: 7,
        FragmentType.PRODUCT_DISPLAY: 9,
        FragmentType.EFFECT_DEMONSTRATION: 9,
        FragmentType.SELLING_POINT_EXPLANATION: 8,
        FragmentType.CTA: 5,
        FragmentType.OUTRO: 4,
    }
    assert sum(targets.values()) == 50
