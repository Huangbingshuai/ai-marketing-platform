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
    SellingPointEvidence,
)

TARGETS = {
    FragmentType.HOOK: 10,
    FragmentType.PAIN: 8,
    FragmentType.PRODUCT_DISPLAY: 12,
    FragmentType.SELLING_POINT_EXPLANATION: 10,
    FragmentType.CTA: 6,
    FragmentType.OUTRO: 4,
}
DURATIONS = {fragment_type: 5 for fragment_type in FragmentType}


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
        fragment_targets=TARGETS,
        fragment_durations=DURATIONS,
    )

    assert len(planned) == 250
    assert min(
        dimension_distance(left.dimensions, right.dimensions)
        for left, right in combinations(planned, 2)
    ) >= 3
    assert {item.dimensions.selling_point for item in planned[:3]} == {"卖点甲", "卖点乙", "卖点丙"}


def test_replenishment_round_is_distinct_and_shards_are_bounded() -> None:
    first = plan_combinations(
        _pools(), count=20, round_number=0, ordinal_start=1,
        fragment_targets=TARGETS, fragment_durations=DURATIONS
    )
    second = plan_combinations(
        _pools(), count=20, round_number=1, ordinal_start=21,
        fragment_targets=TARGETS, fragment_durations=DURATIONS
    )
    shards = make_shards(second, round_number=1, shard_size=8)

    assert all(dimension_distance(left.dimensions, right.dimensions) >= 5 for left, right in zip(first, second))
    assert sum(len(shard.combinations) for shard in shards) == 20
    assert all(len(shard.combinations) <= 8 for shard in shards)
    assert all(len({item.fragment_type for item in shard.combinations}) == 1 for shard in shards)


def test_fragment_type_targets_use_explicit_six_type_counts() -> None:
    targets = fragment_type_targets(TARGETS)

    assert targets == {
        FragmentType.HOOK: 10,
        FragmentType.PAIN: 8,
        FragmentType.PRODUCT_DISPLAY: 12,
        FragmentType.SELLING_POINT_EXPLANATION: 10,
        FragmentType.CTA: 6,
        FragmentType.OUTRO: 4,
    }
    assert sum(targets.values()) == 50


def test_selling_point_branch_rotates_all_text_only_core_points() -> None:
    pools = _pools().model_copy(
        update={
            "evidence_plans": [
                SellingPointEvidence(
                    selling_point=item,
                    evidence_mode=EvidenceMode.TEXT_ONLY,
                    allowed_visual_evidence=f"只允许字幕表达{item}",
                    forbidden_inference=f"不得伪造{item}过程",
                )
                for item in ["卖点甲", "卖点乙", "卖点丙"]
            ]
        }
    )

    planned = plan_combinations(
        pools,
        count=50,
        round_number=0,
        ordinal_start=1,
        fragment_targets=TARGETS,
        fragment_durations=DURATIONS,
    )
    explanation_points = {
        item.dimensions.selling_point
        for item in planned
        if item.fragment_type == FragmentType.SELLING_POINT_EXPLANATION
    }

    assert explanation_points == {"卖点甲", "卖点乙", "卖点丙"}
