from __future__ import annotations

from collections import Counter
from dataclasses import replace
from typing import Any

import pytest

from effect_prompt_generation.embeddings import MockEmbeddingProvider
from effect_prompt_generation.graph import build_graph
from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    CreativeCandidate,
    CreativeDimensions,
    CreativeDirectionResponse,
    CreativeEvaluation,
    CreativeScores,
    CreativeSemanticProfile,
    FragmentType,
    PromptGenerationSnapshot,
    PromptBatchSettings,
    StrategyCheckpoint,
)
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import (
    CREATIVE_DIRECTION_TEMPLATE_HASH,
    MockAiProvider,
)
from effect_prompt_generation.creative_directions import (
    allocate_direction_fact_focus_ids,
    allocate_creative_directions,
    complete_semantic_profile,
    creative_direction_source_hash,
    direction_allocation_bucket,
    scene_atom_from_text,
    validate_semantic_profile,
    validate_creative_direction_plan,
)

from test_creatives import PromptApi, _runtime, _snapshot


def _cluster_snapshot() -> PromptGenerationSnapshot:
    return _snapshot()


class ConcentratedClusterProvider(MockAiProvider):
    async def evaluate_creatives(
        self,
        candidates: list[Any],
        *,
        target_durations: Any,
        application: Any,
        assigned_context_fact_ids: Any = None,
        fact_visual_strategy: Any = None,
        direction_plan: Any = None,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            target_durations=target_durations,
            application=application,
            assigned_context_fact_ids=assigned_context_fact_ids,
            fact_visual_strategy=fact_visual_strategy,
            direction_plan=direction_plan,
        )
        assert direction_plan is not None
        crowded = direction_plan.directions[0].semantic_profile
        items = [
            item.model_copy(update={"semantic_profile": crowded})
            for item in call.value.items
        ]
        return replace(call, value=call.value.model_copy(update={"items": items}))


class MissingSemanticProfileProvider(MockAiProvider):
    async def evaluate_creatives(
        self,
        candidates: list[Any],
        *,
        target_durations: Any,
        application: Any,
        assigned_context_fact_ids: Any = None,
        fact_visual_strategy: Any = None,
        direction_plan: Any = None,
    ) -> Any:
        call = await super().evaluate_creatives(
            candidates,
            target_durations=target_durations,
            application=application,
            assigned_context_fact_ids=assigned_context_fact_ids,
            fact_visual_strategy=fact_visual_strategy,
            direction_plan=direction_plan,
        )
        items = [
            item.model_copy(update={"semantic_profile": None})
            if index % 2 == 0
            else item
            for index, item in enumerate(call.value.items)
        ]
        return replace(call, value=call.value.model_copy(update={"items": items}))


@pytest.mark.asyncio
async def test_cluster_policy_plans_directions_and_generates_140_percent() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    result = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert result["prompt_result_id"] == "prompt-result-current"
    assert api.result is not None
    assert api.result.metrics.candidate_target_count == 14
    assert api.result.metrics.generated_candidate_count == 16
    assert len(api.result.items) == 10
    creative_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE" and shard.round == 0
        for task in shard.creative_plan
    ]
    assert len(creative_tasks) == 14
    assert all(task.creative_direction is not None for task in creative_tasks)
    assert all(
        set(task.fact_assignment.allowed_fact_ids)
        & set(task.creative_direction.compatible_fact_ids)
        for task in creative_tasks
        if task.fact_assignment is not None and task.creative_direction is not None
    )
    counts = Counter(
        task.creative_direction.direction_id
        for task in creative_tasks
        if task.creative_direction is not None
    )
    assert max(counts.values()) - min(counts.values()) <= 1
    creative_stage = next(
        stage
        for stage in api.stages
        if stage.node_id.value == "COHERENT_CREATIVE_GENERATION"
        and "checkpoint" in stage.metadata
    )
    assert creative_stage.metadata["directionCount"] == 8
    assert creative_stage.metadata["checkpoint"]["templateHash"] == (
        CREATIVE_DIRECTION_TEMPLATE_HASH
    )
    selection_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert selection_stage.metadata["clusterAwareNoveltyWeight"] == 0.30
    assert selection_stage.metadata["contentNoveltyWeight"] == 0.70


@pytest.mark.asyncio
async def test_fifty_target_plans_exactly_seventy_initial_candidates() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    snapshot = _cluster_snapshot().model_copy(
        update={
            "settings": PromptBatchSettings(
                target_count=50,
                default_duration_seconds=15,
            )
        }
    )
    pipeline.register_snapshot(runtime, snapshot)
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    shards = await pipeline.plan_creatives(runtime, round_number=0)

    tasks = [task for shard in shards for task in shard.tasks]
    assert len(tasks) == 70
    assert sum(len(shard.tasks) for shard in shards) == 70
    assert all(task.creative_direction is not None for task in tasks)


@pytest.mark.asyncio
async def test_quantity_supplement_respects_total_candidate_ceiling() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MockAiProvider(),
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)

    initial = await pipeline.plan_creatives(runtime, round_number=0)
    initial_tasks = [task for shard in initial for task in shard.tasks]
    cache = pipeline._cache(runtime)
    cache.creatives = {
        task.slot_id: CreativeCandidate(
            slot_id=task.slot_id,
            ordinal=task.ordinal,
            round=0,
            creative_core=f"创意 {task.ordinal}",
            declared_fact_ids=[task.fact_assignment.primary_fact_id],
            dimensions=CreativeDimensions(
                narrative="连续叙事",
                scene="真实场景",
                persona="成年人",
                product_relation="产品动作",
                camera="稳定跟拍",
                emotion="自然",
            ),
            content=f"真实产品在一个连续场景中完成清晰可执行的展示动作，候选编号 {task.ordinal}",
        )
        for task in initial_tasks
        if task.fact_assignment is not None
    }

    supplement = await pipeline.plan_creatives(
        runtime,
        round_number=1,
        missing_count=10,
    )

    # A 10-item target starts with 14 candidates. Every supplement shares the
    # 16-item batch ceiling, so quantity recovery may request only two more.
    assert sum(len(shard.tasks) for shard in supplement) == 2


@pytest.mark.asyncio
async def test_cluster_concentration_triggers_only_one_diversity_supplement() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=ConcentratedClusterProvider(),
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert api.result is not None
    assert api.result.metrics.generated_candidate_count == 16
    diversity_tasks = [
        task
        for shard in api.shards.values()
        if shard.phase.value == "CREATIVE"
        for task in shard.creative_plan
        if task.supplement_kind == "DIVERSITY"
    ]
    assert len(diversity_tasks) == 2
    final_stage = next(
        stage
        for stage in reversed(api.stages)
        if stage.node_id.value == "EXACT_SELECTION_AND_SUPPLEMENT"
    )
    assert final_stage.metadata["diversitySupplementTriggered"] is True
    assert final_stage.metadata["diversitySupplementCount"] == 2
    assert any(
        reason.startswith("ACTION_CLUSTER_OVER_40_PERCENT")
        for reason in final_stage.metadata["diversitySupplementReasons"]
    )


@pytest.mark.asyncio
async def test_missing_semantic_profiles_do_not_fail_the_batch() -> None:
    api = PromptApi()
    pipeline = PromptGenerationPipeline(
        api=api,  # type: ignore[arg-type]
        provider=MissingSemanticProfileProvider(),
        embedding_provider=MockEmbeddingProvider(),
        similarity_mode="vector",
        shard_size=5,
    )
    runtime = _runtime()
    pipeline.register_snapshot(runtime, _cluster_snapshot())

    result = await build_graph(pipeline).ainvoke(
        {"project_id": runtime.project_id},
        context=runtime,
    )

    assert result["prompt_result_id"] == "prompt-result-current"
    assert api.result is not None
    assert len(api.result.items) == 10
    evaluations = [
        evaluation
        for shard in api.shards.values()
        for evaluation in shard.evaluations
    ]
    assert evaluations
    assert all(evaluation.semantic_profile is not None for evaluation in evaluations)


def test_direction_plan_rejects_unknown_facts_and_balances_allocations() -> None:
    application = map_insight(_cluster_snapshot().insight_artifact.result)
    provider = MockAiProvider()
    response = provider  # keep construction below explicit and synchronous
    del response
    from effect_prompt_generation.providers import _mock_creative_direction_response
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy
    from effect_prompt_generation.providers import _mock_fact_visual_strategy

    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="source",
        template_hash="0" * 64,
    )
    raw = _mock_creative_direction_response(application)
    source_hash = creative_direction_source_hash(
        insight_content_hash="insight",
        visual_strategy_hash=strategy.strategy_hash,
        shared_prompt_hash="shared",
        target_count=50,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    plan = validate_creative_direction_plan(
        raw,
        application,
        strategy,
        source_hash=source_hash,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    planned_fact_ids = {
        fact_id
        for direction in plan.directions
        for fact_id in direction.compatible_fact_ids
    }
    assert {fact.fact_id for fact in application.required}.issubset(
        planned_fact_ids
    )
    allocated = allocate_creative_directions(
        plan,
        count=70,
        ordinal_start=1,
    )
    counts = Counter(item.direction_id for item in allocated)
    assert max(counts.values()) - min(counts.values()) <= 1
    assert max(counts.values()) <= 9
    focus_ids = allocate_direction_fact_focus_ids(
        allocated,
        application,
        priority_fact_ids=[fact.fact_id for fact in application.required],
    )
    assert {fact.fact_id for fact in application.required}.issubset(focus_ids)
    assert {fact.fact_id for fact in application.usable}.issubset(focus_ids)

    invalid = raw.model_copy(
        update={
            "directions": [
                raw.directions[0].model_copy(
                    update={"compatible_fact_ids": ["unknown-fact"]}
                ),
                *raw.directions[1:],
            ]
        }
    )
    with pytest.raises(ValueError, match="unavailable fact"):
        validate_creative_direction_plan(
            CreativeDirectionResponse.model_validate(invalid),
            application,
            strategy,
            source_hash=source_hash,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        )

    repeated_directions = [
        direction.model_copy(
            update={
                "creative_direction": "在家庭餐桌完成端上产品",
                "semantic_profile": direction.semantic_profile.model_copy(
                    update={
                        "scene_family": "家庭餐桌",
                        "product_action_family": "端上产品",
                    }
                ),
            }
        )
        if index < 3
        else direction
        for index, direction in enumerate(raw.directions)
    ]
    repeated = raw.model_copy(update={"directions": repeated_directions})
    with pytest.raises(ValueError, match="repeat one scene-action combination"):
        validate_creative_direction_plan(
            CreativeDirectionResponse.model_validate(repeated),
            application,
            strategy,
            source_hash=source_hash,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        )


@pytest.mark.parametrize(
    "label",
    ["家庭厨房灶台", "岭南厨房", "砂锅台面备餐", "砧板旁的料理台"],
)
def test_scene_atom_collapses_kitchen_and_preparation_synonyms(label: str) -> None:
    assert scene_atom_from_text(label) == "KITCHEN_PREP"


def test_direction_allocation_caps_each_direction_after_scene_atom_collapsing() -> None:
    plan = _direction_plan_for_semantic_tests()
    scene_labels = [
        "家庭厨房灶台",
        "岭南厨房",
        "砂锅台面备餐",
        "家庭砧板",
        "家宴餐桌",
        "团圆饭围桌",
        "超市货架",
        "门店选购",
    ]
    directions = [
        direction.model_copy(
            update={
                "semantic_profile": direction.semantic_profile.model_copy(
                    update={"scene_family": scene_labels[index]}
                )
            }
        )
        for index, direction in enumerate(plan.directions)
    ]
    plan = plan.model_copy(update={"directions": directions})

    allocated = allocate_creative_directions(
        plan,
        count=12,
        ordinal_start=1,
    )
    direction_counts = Counter(item.direction_id for item in allocated)

    assert max(direction_counts.values()) - min(direction_counts.values()) <= 1
    assert max(direction_counts.values()) <= 2


def test_direction_allocation_prevents_single_dining_direction_from_taking_23_of_70() -> None:
    plan = _direction_plan_for_semantic_tests()
    scene_action_rows = [
        ("家庭厨房灶台", "整根放入煲仔饭烹制"),
        ("家庭厨房蒸制区", "整根上屉蒸制观察"),
        ("新春家庭玄关", "袋装整袋递赠送礼"),
        ("家庭厨房炒锅旁", "切段下锅翻炒"),
        ("家庭餐桌", "煲仔饭开盖展示"),
        ("家庭备餐台面", "少量切片展示切面"),
        ("家庭备餐区", "整根摆入家宴备菜盘"),
        ("居家客厅会客区", "袋装双手递赠"),
    ]
    directions = [
        direction.model_copy(
            update={
                "semantic_profile": direction.semantic_profile.model_copy(
                    update={
                        "scene_family": scene,
                        "product_action_family": action,
                    }
                ),
                "creative_direction": f"在{scene}完成{action}",
            }
        )
        for direction, (scene, action) in zip(
            plan.directions,
            scene_action_rows,
            strict=True,
        )
    ]
    plan = plan.model_copy(update={"directions": directions})

    allocated = allocate_creative_directions(plan, count=70, ordinal_start=1)
    direction_counts = Counter(item.direction_id for item in allocated)
    bucket_counts = Counter(direction_allocation_bucket(item) for item in allocated)

    assert len(direction_counts) == 8
    assert min(direction_counts.values()) == 8
    assert max(direction_counts.values()) == 9
    assert direction_counts[directions[4].direction_id] <= 9
    assert max(bucket_counts.values()) < 23


def test_direction_checkpoint_round_trip_parses_worker_plan() -> None:
    application = map_insight(_cluster_snapshot().insight_artifact.result)
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_fact_visual_strategy,
    )
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy

    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="source",
        template_hash="0" * 64,
    )
    source_hash = "a" * 64
    plan = validate_creative_direction_plan(
        _mock_creative_direction_response(application),
        application,
        strategy,
        source_hash=source_hash,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    checkpoint = StrategyCheckpoint.model_validate(
        {
            "nodeId": "COHERENT_CREATIVE_GENERATION",
            "sourceFingerprint": source_hash,
            "allocationHash": plan.plan_hash,
            "templateHash": plan.template_hash,
            "plan": plan.model_dump(mode="json", by_alias=True),
        }
    )
    assert checkpoint.plan == plan


def test_semantic_profile_only_accepts_dynamic_vocabulary_or_other() -> None:
    application = map_insight(_cluster_snapshot().insight_artifact.result)
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_fact_visual_strategy,
    )
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy

    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="source",
        template_hash="0" * 64,
    )
    plan = validate_creative_direction_plan(
        _mock_creative_direction_response(application),
        application,
        strategy,
        source_hash="b" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    base = plan.directions[0].semantic_profile
    evaluation = CreativeEvaluation(
        slot_id="candidate-1",
        primary_purpose=FragmentType.HOOK,
        compatible_purposes=[FragmentType.HOOK],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=90,
            visual_clarity=90,
        ),
        semantic_signature="semantic",
        visual_signature="visual",
        semantic_profile=base,
    )
    validate_semantic_profile(evaluation, plan)

    unknown = evaluation.model_copy(
        update={
            "semantic_profile": CreativeSemanticProfile(
                narrative_family=base.narrative_family,
                scene_family="不在本批动态词表内",
                persona_family=base.persona_family,
                product_action_family=base.product_action_family,
                camera_family=base.camera_family,
                emotion_family=base.emotion_family,
            )
        }
    )
    with pytest.raises(ValueError, match="unknown scene_family"):
        validate_semantic_profile(unknown, plan)

    other = unknown.model_copy(
        update={
            "semantic_profile": unknown.semantic_profile.model_copy(
                update={"scene_family": "OTHER"}
            )
        }
    )
    validate_semantic_profile(other, plan)


def test_missing_semantic_profile_is_completed_from_candidate_dimensions() -> None:
    plan = _direction_plan_for_semantic_tests()
    profile = plan.directions[0].semantic_profile
    candidate = _candidate_for_semantic_tests(profile)
    evaluation = _evaluation_for_semantic_tests(semantic_profile=None)

    completed = complete_semantic_profile(evaluation, candidate, plan)

    assert completed.semantic_profile == profile
    validate_semantic_profile(completed, plan)


def test_partial_blank_and_unknown_semantic_profile_is_repaired_or_other() -> None:
    plan = _direction_plan_for_semantic_tests()
    profile = plan.directions[0].semantic_profile
    candidate = _candidate_for_semantic_tests(profile)
    evaluation = CreativeEvaluation.model_validate(
        {
            **_evaluation_for_semantic_tests(semantic_profile=None).model_dump(
                mode="json", by_alias=True, exclude={"semantic_profile"}
            ),
            "semanticProfile": {
                "narrativeFamily": profile.narrative_family,
                "sceneFamily": "",
                "personaFamily": "模型返回的未知人物族",
                # productActionFamily intentionally omitted.
                "cameraFamily": profile.camera_family,
                "emotionFamily": profile.emotion_family,
            },
        }
    )

    completed = complete_semantic_profile(evaluation, candidate, plan)

    assert completed.semantic_profile is not None
    assert completed.semantic_profile.scene_family == profile.scene_family
    assert completed.semantic_profile.persona_family == profile.persona_family
    assert (
        completed.semantic_profile.product_action_family
        == profile.product_action_family
    )
    validate_semantic_profile(completed, plan)

    unrelated = candidate.model_copy(
        update={
            "dimensions": candidate.dimensions.model_copy(
                update={"scene": "完全无法归入动态词表的抽象空间"}
            ),
            "creative_core": "抽象构成",
            "content": "抽象色块保持静止，画面没有可识别地点，仅展示产品包装。",
        }
    )
    unknown_scene = evaluation.model_copy(
        update={
            "semantic_profile": evaluation.semantic_profile.model_copy(
                update={"scene_family": "仍然未知"}
            )
        }
    )
    fallback = complete_semantic_profile(unknown_scene, unrelated, plan)
    assert fallback.semantic_profile is not None
    assert fallback.semantic_profile.scene_family == "OTHER"
    validate_semantic_profile(fallback, plan)


def _direction_plan_for_semantic_tests() -> Any:
    application = map_insight(_cluster_snapshot().insight_artifact.result)
    from effect_prompt_generation.providers import (
        _mock_creative_direction_response,
        _mock_fact_visual_strategy,
    )
    from effect_prompt_generation.visual_strategy import validate_fact_visual_strategy

    strategy = validate_fact_visual_strategy(
        _mock_fact_visual_strategy(application),
        application,
        source_content_hash="source",
        template_hash="0" * 64,
    )
    return validate_creative_direction_plan(
        _mock_creative_direction_response(application),
        application,
        strategy,
        source_hash="c" * 64,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )


def _candidate_for_semantic_tests(profile: CreativeSemanticProfile) -> CreativeCandidate:
    return CreativeCandidate(
        slot_id="candidate-semantic-repair",
        ordinal=1,
        round=0,
        creative_core=f"{profile.narrative_family}的连贯创意",
        declared_fact_ids=["fact-1"],
        dimensions=CreativeDimensions(
            narrative=profile.narrative_family,
            scene=profile.scene_family,
            persona=profile.persona_family,
            product_relation=profile.product_action_family,
            camera=profile.camera_family,
            emotion=profile.emotion_family,
        ),
        content=(
            f"在{profile.scene_family}中，{profile.persona_family}完成"
            f"{profile.product_action_family}，采用{profile.camera_family}，"
            f"呈现{profile.emotion_family}。"
        ),
    )


def _evaluation_for_semantic_tests(
    *, semantic_profile: CreativeSemanticProfile | None
) -> CreativeEvaluation:
    return CreativeEvaluation(
        slot_id="candidate-semantic-repair",
        primary_purpose=FragmentType.HOOK,
        compatible_purposes=[FragmentType.HOOK],
        scores=CreativeScores(
            product_relevance=90,
            creative_coherence=90,
            visual_executability=90,
            commercial_usefulness=90,
            visual_clarity=90,
        ),
        semantic_signature="semantic",
        visual_signature="visual",
        semantic_profile=semantic_profile,
    )


def test_direction_source_hash_invalidates_every_authoritative_input() -> None:
    baseline = creative_direction_source_hash(
        insight_content_hash="insight-a",
        visual_strategy_hash="visual-a",
        shared_prompt_hash="shared-a",
        target_count=50,
        template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
    )
    variants = {
        creative_direction_source_hash(
            insight_content_hash="insight-b",
            visual_strategy_hash="visual-a",
            shared_prompt_hash="shared-a",
            target_count=50,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        ),
        creative_direction_source_hash(
            insight_content_hash="insight-a",
            visual_strategy_hash="visual-b",
            shared_prompt_hash="shared-a",
            target_count=50,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        ),
        creative_direction_source_hash(
            insight_content_hash="insight-a",
            visual_strategy_hash="visual-a",
            shared_prompt_hash="shared-b",
            target_count=50,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        ),
        creative_direction_source_hash(
            insight_content_hash="insight-a",
            visual_strategy_hash="visual-a",
            shared_prompt_hash="shared-a",
            target_count=51,
            template_hash=CREATIVE_DIRECTION_TEMPLATE_HASH,
        ),
    }
    assert baseline not in variants
    assert len(variants) == 4
