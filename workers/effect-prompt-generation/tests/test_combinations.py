from __future__ import annotations

from itertools import combinations

from effect_prompt_generation.combinations import (
    dimension_distance,
    fragment_type_targets,
    make_shards,
    plan_combinations,
)
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    DimensionPools,
    EvidenceMode,
    FragmentStrategyPool,
    FragmentType,
    InsightApplicationMap,
    MarketingRelationshipBundle,
    SellingPointEvidence,
    StrategyPlan,
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
        scenes=["家庭", "户外", "职场"],
        personas=["年轻女性", "成熟男性", "专业测评者"],
        selling_points=["卖点甲", "卖点乙", "卖点丙"],
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


def _fragment_strategy_pools() -> list[FragmentStrategyPool]:
    return [
        FragmentStrategyPool(
            fragment_type=fragment_type,
            opening_states=[
                f"{fragment_type.value}首帧方案甲",
                f"{fragment_type.value}首帧方案乙",
                f"{fragment_type.value}首帧方案丙",
            ],
            action_arcs=[
                f"{fragment_type.value}一名人物拿起产品并停住",
                f"{fragment_type.value}一名人物按下按键后停住",
                f"{fragment_type.value}一名人物放下产品后离开",
            ],
            cameras=[
                f"{fragment_type.value}特写推进",
                f"{fragment_type.value}第一视角固定观察",
                f"{fragment_type.value}俯拍近景固定观察",
            ],
            emotions=[
                f"{fragment_type.value}自然光与短暂停顿",
                f"{fragment_type.value}柔和侧光与舒缓节奏",
                f"{fragment_type.value}中性光与稳定停顿",
            ],
            ending_states=[
                f"{fragment_type.value}结束状态甲",
                f"{fragment_type.value}结束状态乙",
                f"{fragment_type.value}结束状态丙",
            ],
        )
        for fragment_type in FragmentType
    ]


def _strategy(
    pools: DimensionPools | None = None,
) -> tuple[StrategyPlan, InsightApplicationMap]:
    application = map_insight(
        {
            "productName": "测试产品",
            "productCategory": "日用品",
            "coreSpecification": "便携规格",
            "visualFeatures": "圆角外观",
            "coreSellingPoints": ["卖点甲", "卖点乙", "卖点丙"],
            "targetAudience": "通勤人群",
            "corePainPoints": ["携带不便"],
            "decisionDrivers": ["操作简单"],
            "marketingGoal": "引导了解",
            "usageScenarios": ["办公室"],
            "purchaseScenarios": ["通勤选购"],
            "emotionalScenarios": ["从容出门"],
        }
    )
    points = ["卖点甲", "卖点乙", "卖点丙"]
    bundles = []
    for fragment_type in FragmentType:
        eligible = [
            fact
            for fact in application.usable
            if fragment_type in fact.eligible_fragment_types
        ]
        for index, point in enumerate(points):
            selected = [
                fact
                for fact in eligible
                if fact.field.value != "CORE_SELLING_POINT" or fact.value == point
            ]
            bundles.append(
                MarketingRelationshipBundle(
                    bundle_id=f"{fragment_type.value}-{index}",
                    fact_ids=[fact.fact_id for fact in selected],
                    eligible_fragment_types=[fragment_type],
                    scene=["家庭", "户外", "职场"][index],
                    persona=["年轻女性", "成熟男性", "专业测评者"][index],
                    selling_point=point
                    if any(fact.value == point for fact in selected)
                    else "不提前展示产品解决方案",
                )
            )
    return StrategyPlan(
        dimension_pools=pools or _pools(),
        fragment_strategy_pools=_fragment_strategy_pools(),
        relationship_bundles=bundles,
    ), application


def test_linear_code_supports_250_candidates_with_minimum_distance() -> None:
    strategy, application = _strategy()
    planned = plan_combinations(
        strategy,
        application,
        count=250,
        round_number=0,
        ordinal_start=1,
        fragment_targets=TARGETS,
        fragment_durations=DURATIONS,
    )

    assert len(planned) == 250
    assert (
        min(
            dimension_distance(left.dimensions, right.dimensions)
            for left, right in combinations(planned, 2)
        )
        >= 3
    )
    assert all(item.insight_bindings for item in planned)
    assert all(1 <= len(item.insight_bindings) <= 3 for item in planned)
    assert all(item.opening_state.startswith(item.fragment_type.value) for item in planned)
    assert all(item.visible_action.startswith(item.fragment_type.value) for item in planned)
    assert all(item.dimensions.camera.startswith(item.fragment_type.value) for item in planned)
    assert all(item.dimensions.emotion.startswith(item.fragment_type.value) for item in planned)
    assert all(item.planning_version == "six-branch-v1" for item in planned)


def test_expression_facts_rotate_without_overloading_one_short_clip() -> None:
    strategy, application = _strategy()
    planned = plan_combinations(
        strategy,
        application,
        count=50,
        round_number=0,
        ordinal_start=1,
        fragment_targets=TARGETS,
        fragment_durations=DURATIONS,
        priority_fact_ids=[fact.fact_id for fact in application.required],
    )

    covered = {binding.fact_id for item in planned for binding in item.insight_bindings}
    assert {fact.fact_id for fact in application.required} <= covered
    assert max(len(item.insight_bindings) for item in planned) == 3


def test_replenishment_round_is_distinct_and_shards_are_bounded() -> None:
    strategy, application = _strategy()
    first = plan_combinations(
        strategy,
        application,
        count=20,
        round_number=0,
        ordinal_start=1,
        fragment_targets=TARGETS,
        fragment_durations=DURATIONS,
    )
    second = plan_combinations(
        strategy,
        application,
        count=20,
        round_number=1,
        ordinal_start=21,
        fragment_targets=TARGETS,
        fragment_durations=DURATIONS,
    )
    shards = make_shards(second, round_number=1, shard_size=8)

    assert all(
        dimension_distance(left.dimensions, right.dimensions) >= 5
        for left, right in zip(first, second)
    )
    assert sum(len(shard.combinations) for shard in shards) == 20
    assert all(len(shard.combinations) <= 8 for shard in shards)
    assert all(
        len({item.fragment_type for item in shard.combinations}) == 1
        for shard in shards
    )


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

    strategy, application = _strategy(pools)
    planned = plan_combinations(
        strategy,
        application,
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
