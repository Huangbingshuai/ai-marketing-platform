from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import Literal

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime
from langgraph.types import Send

from .models import (
    BlueprintShardPlan,
    FragmentRelationshipPlan,
    GraphState,
    FragmentFactAllocation,
    FragmentType,
    InputState,
    NodeId,
    OutputState,
    RuntimeContext,
    ShardPlan,
)
from .pipeline import (
    BLUEPRINT_NODE_BY_FRAGMENT,
    GENERATION_NODE_BY_FRAGMENT,
    MAX_REPLENISHMENT_ROUNDS,
    PromptGenerationPipeline,
)


async def _gather_cancel_on_error(calls: list[Awaitable[object]]) -> None:
    tasks: list[asyncio.Future[object]] = [
        asyncio.ensure_future(call) for call in calls
    ]
    try:
        await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


def build_graph(
    pipeline: PromptGenerationPipeline,
) -> CompiledStateGraph[GraphState, RuntimeContext, InputState, OutputState]:
    async def load(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        loaded = await pipeline.load_and_snapshot(runtime.context)
        return {
            "graph_version": loaded.snapshot.graph_version,
            "operation": loaded.snapshot.operation,
            "round": loaded.highest_round,
            "target_count": loaded.snapshot.settings.target_count,
            "retained_count": len(loaded.snapshot.retained_manual_items),
            "completed_shard_keys": loaded.completed_shard_keys,
            "generated_candidate_count": len(loaded.candidates),
            "completed_blueprint_shard_keys": loaded.completed_blueprint_shard_keys,
        }

    async def global_fact_allocation(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        allocations = await pipeline.allocate_strategy_facts(
            runtime.context, state["insight_map"]
        )
        return {"fact_allocations": allocations}

    async def relationship_router(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        reusable = await pipeline.prepare_relationship_router(
            runtime.context, state["fact_allocations"]
        )
        return {
            "fragment_relationship_plans": reusable,
            "relationship_checkpoint_types": [item.fragment_type for item in reusable],
            "expected_fragment_types": list(pipeline._expected_strategy_fragments(runtime.context)),
        }

    async def plan_relationship(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        allocation = FragmentFactAllocation.model_validate(
            state["active_relationship_allocation"]
        )
        if allocation.fragment_type in set(state.get("relationship_checkpoint_types", [])):
            return {}
        plan = await pipeline.plan_fragment_relationships(runtime.context, allocation)
        return {"fragment_relationship_plans": [plan]}

    async def merge_relationships(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        plans = await pipeline.merge_relationship_plans(
            runtime.context, state.get("fragment_relationship_plans", [])
        )
        del plans
        return {}

    async def coordinate_router(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        reusable = await pipeline.prepare_coordinate_router(
            runtime.context, state["fragment_relationship_plans"]
        )
        return {
            "dimension_coordinate_plans": reusable,
            "coordinate_checkpoint_types": [item.fragment_type for item in reusable],
        }

    async def plan_coordinates(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        relationship = FragmentRelationshipPlan.model_validate(
            state["active_coordinate_request"]
        )
        if relationship.fragment_type in set(state.get("coordinate_checkpoint_types", [])):
            return {}
        plan = await pipeline.plan_dimension_coordinates(runtime.context, relationship)
        return {"dimension_coordinate_plans": [plan]}

    async def merge_coordinates(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        plans = await pipeline.merge_coordinate_plans(
            runtime.context, state.get("dimension_coordinate_plans", [])
        )
        del plans
        return {}

    async def allocate_blueprints(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        pending = await pipeline.allocate_and_plan_blueprints(
            runtime.context,
            relationships=state["fragment_relationship_plans"],
            round_number=0,
            ordinal_start=state.get("retained_count", 0) + 1,
        )
        return {"round": 0, "pending_blueprint_shards": pending}

    async def blueprint_router(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        return {}

    async def generate_blueprints(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        shard = BlueprintShardPlan.model_validate(state["active_blueprint_shard"])
        items = await pipeline.generate_blueprint_shard(runtime.context, shard)
        return {"generated_blueprints": items}

    async def blueprint_gate(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        pending, deficits = await pipeline.gate_blueprints_and_plan_prompts(
            runtime.context,
            round_number=state.get("round", 0),
            completed_prompt_keys=state.get("completed_shard_keys", []),
        )
        return {"pending_shards": pending, "blueprint_deficits": deficits}

    async def strategy_router(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        reusable = await pipeline.prepare_strategy_router(
            runtime.context, state["fact_allocations"]
        )
        return {
            "fragment_strategy_plans": reusable,
            "strategy_checkpoint_types": [item.fragment_type for item in reusable],
        }

    async def plan_fragment_strategy(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        allocation = FragmentFactAllocation.model_validate(
            state["active_strategy_allocation"]
        )
        checkpoints = set(state.get("strategy_checkpoint_types", []))
        expected = pipeline._expected_strategy_fragments(runtime.context)
        if allocation.fragment_type not in expected:
            await pipeline.skip_fragment_strategy(
                runtime.context, allocation, "单条重新生成无需执行本类营销规划"
            )
            return {}
        if allocation.fragment_type in checkpoints:
            return {}
        plan = await pipeline.plan_fragment_strategy(runtime.context, allocation)
        return {"fragment_strategy_plans": [plan]}

    async def merge_strategy(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        plan = await pipeline.merge_strategy_plans(
            runtime.context, state.get("fragment_strategy_plans", [])
        )
        return {"strategy_plan": plan}

    async def map_insight(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        application = await pipeline.map_insight(runtime.context)
        snapshot = pipeline.snapshot(runtime.context)
        target_fact_ids = (
            [binding.fact_id for binding in snapshot.target_item.insight_bindings]
            if snapshot.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"}
            and snapshot.target_item
            else [fact.fact_id for fact in application.required]
        )
        return {"insight_map": application, "missing_fact_ids": target_fact_ids}

    async def shared_prompt_compilation(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        prompt = await pipeline.compile_shared_prompt(runtime.context)
        return {"shared_prompt": prompt}

    async def fact_visual_strategy_compilation(
        state: GraphState,
        runtime: Runtime[RuntimeContext],
    ) -> dict[str, object]:
        del state
        strategy = await pipeline.compile_fact_visual_strategy(runtime.context)
        return {"fact_visual_strategy": strategy}

    async def coherent_creative_generation(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        del state
        pending = await pipeline.plan_v11_creatives(
            runtime.context,
            round_number=0,
        )
        if pending:
            await _gather_cancel_on_error(
                [
                    pipeline.generate_v11_creative_shard(runtime.context, shard)
                    for shard in pending
                ]
            )
        await pipeline.complete_v11_creative_generation(
            runtime.context,
            round_number=0,
        )
        classifications = await pipeline.plan_v11_classification(
            runtime.context,
            round_number=0,
        )
        if classifications:
            await _gather_cancel_on_error(
                [
                    pipeline.evaluate_v11_classification_shard(runtime.context, shard)
                    for shard in classifications
                ]
            )
        await pipeline.complete_v11_classification(
            runtime.context,
            round_number=0,
        )
        supplement, needed = await pipeline.select_v11_creatives(
            runtime.context,
            round_number=0,
        )
        supplement_round = 1
        # Quantity recovery may run for three rounds. A separate, optional fourth
        # pass is reserved for the one-shot semantic-diversity supplement.
        while needed and supplement_round <= MAX_REPLENISHMENT_ROUNDS + 1:
            if supplement:
                await _gather_cancel_on_error(
                    [
                        pipeline.generate_v11_creative_shard(runtime.context, shard)
                        for shard in supplement
                    ]
                )
            await pipeline.complete_v11_creative_generation(
                runtime.context,
                round_number=supplement_round,
            )
            classifications = await pipeline.plan_v11_classification(
                runtime.context,
                round_number=supplement_round,
            )
            if classifications:
                await _gather_cancel_on_error(
                    [
                        pipeline.evaluate_v11_classification_shard(
                            runtime.context, shard
                        )
                        for shard in classifications
                    ]
                )
            await pipeline.complete_v11_classification(
                runtime.context,
                round_number=supplement_round,
            )
            supplement, needed = await pipeline.select_v11_creatives(
                runtime.context,
                round_number=supplement_round,
            )
            supplement_round += 1
        return {}

    async def combine(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        retained_count = state.get("retained_count", 0)
        missing = max(0, state["target_count"] - retained_count)
        pending = await pipeline.plan_round(
            runtime.context,
            strategy=state["strategy_plan"],
            application=state["insight_map"],
            round_number=0,
            missing_count=missing,
            ordinal_start=retained_count + 1,
            completed_keys=state.get("completed_shard_keys", []),
            priority_fact_ids=state.get("missing_fact_ids", []),
        )
        return {"round": 0, "pending_shards": pending}

    async def router(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        return {}

    async def generate(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        shard = ShardPlan.model_validate(state["active_shard"])
        candidates = await pipeline.generate_shard(runtime.context, shard)
        return {"generated_candidate_count": len(candidates)}

    async def normalize(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        await pipeline.normalize(runtime.context)
        return {}

    async def semantic(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        pairs = await pipeline.semantic_check(runtime.context)
        return {"semantic_pairs": pairs}

    async def visual(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        pairs = await pipeline.visual_check(runtime.context)
        return {"visual_pairs": pairs}

    async def insight_coverage(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        evaluation = await pipeline.evaluate_insight_coverage(
            runtime.context,
            round_number=state.get("round", 0),
        )
        return {
            "accepted_count": len(evaluation.items),
            "metrics": evaluation.metrics,
            "missing_fact_ids": evaluation.missing_fact_ids,
            "semantic_pairs": evaluation.semantic_pairs,
            "visual_pairs": evaluation.visual_pairs,
        }

    async def quality(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        evaluation = await pipeline.quality_gate(
            runtime.context,
            round_number=state.get("round", 0),
        )
        missing = state["target_count"] - len(evaluation.items)
        return {
            "accepted_count": len(evaluation.items),
            "metrics": evaluation.metrics,
            "semantic_pairs": evaluation.semantic_pairs,
            "visual_pairs": evaluation.visual_pairs,
            "missing_fact_ids": evaluation.missing_fact_ids,
            "needs_replenish": (missing > 0 or bool(evaluation.missing_fact_ids))
            and state.get("round", 0) < MAX_REPLENISHMENT_ROUNDS,
        }

    async def replenish(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        next_round = state.get("round", 0) + 1
        if state.get("graph_version") == "V10_RELATION_COORDINATE_BLUEPRINT":
            deficits = state.get("blueprint_deficits") or pipeline.blueprint_deficits_from_accepted(
                runtime.context
            )
            pending_blueprints = await pipeline.allocate_and_plan_blueprints(
                runtime.context,
                relationships=state["fragment_relationship_plans"],
                round_number=next_round,
                ordinal_start=pipeline.next_blueprint_ordinal(runtime.context),
                deficits=deficits,
            )
            return {
                "round": next_round,
                "pending_blueprint_shards": pending_blueprints,
                "blueprint_deficits": {},
            }
        item_deficit = max(0, state["target_count"] - state.get("accepted_count", 0))
        missing = max(item_deficit, len(state.get("missing_fact_ids", [])))
        ordinal_start = pipeline.next_ordinal(runtime.context)
        pending = await pipeline.plan_round(
            runtime.context,
            strategy=state["strategy_plan"],
            application=state["insight_map"],
            round_number=next_round,
            missing_count=missing,
            ordinal_start=ordinal_start,
            completed_keys=state.get("completed_shard_keys", []),
            priority_fact_ids=state.get("missing_fact_ids", []),
        )
        return {"round": next_round, "pending_shards": pending}

    async def save(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        if state.get("graph_version") in {
            "V11_COHERENT_CREATIVE_GENERATION",
            "V11_VISUAL_USAGE_STRATEGY",
        }:
            result_id = await pipeline.save_v11_result(runtime.context)
        else:
            result_id = await pipeline.save_result(
                runtime.context,
                metrics=state["metrics"],
                shared_prompt=state["shared_prompt"],
            )
        return {"prompt_result_id": result_id}

    def dispatch_shards(state: GraphState) -> list[Send] | Literal["NORMALIZATION"]:
        pending = state.get("pending_shards", [])
        if not pending:
            return "NORMALIZATION"
        return [
            Send(
                GENERATION_NODE_BY_FRAGMENT[shard.fragment_type].value,
                {
                    "project_id": state["project_id"],
                    "active_shard": shard.model_dump(mode="json"),
                },
            )
            for shard in pending
        ]

    def dispatch_strategy_branches(state: GraphState) -> list[Send]:
        shared = {
            "project_id": state["project_id"],
            "strategy_checkpoint_types": state.get("strategy_checkpoint_types", []),
        }
        node_by_fragment = {
            FragmentType.HOOK: NodeId.PLAN_HOOK_STRATEGY,
            FragmentType.PAIN: NodeId.PLAN_PAIN_STRATEGY,
            FragmentType.PRODUCT_DISPLAY: NodeId.PLAN_PRODUCT_DISPLAY_STRATEGY,
            FragmentType.SELLING_POINT_EXPLANATION: NodeId.PLAN_SELLING_POINT_EXPLANATION_STRATEGY,
            FragmentType.CTA: NodeId.PLAN_CTA_STRATEGY,
            FragmentType.OUTRO: NodeId.PLAN_OUTRO_STRATEGY,
        }
        return [
            Send(
                node_by_fragment[fragment_type].value,
                {
                    **shared,
                    "active_strategy_allocation": allocation.model_dump(
                        mode="json", by_alias=True
                    ),
                },
            )
            for fragment_type, allocation in state["fact_allocations"].items()
        ]

    relationship_node_by_fragment = {
        FragmentType.HOOK: NodeId.PLAN_HOOK_RELATIONSHIPS,
        FragmentType.PAIN: NodeId.PLAN_PAIN_RELATIONSHIPS,
        FragmentType.PRODUCT_DISPLAY: NodeId.PLAN_PRODUCT_DISPLAY_RELATIONSHIPS,
        FragmentType.SELLING_POINT_EXPLANATION: NodeId.PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS,
        FragmentType.CTA: NodeId.PLAN_CTA_RELATIONSHIPS,
        FragmentType.OUTRO: NodeId.PLAN_OUTRO_RELATIONSHIPS,
    }
    coordinate_node_by_fragment = {
        FragmentType.HOOK: NodeId.PLAN_HOOK_COORDINATES,
        FragmentType.PAIN: NodeId.PLAN_PAIN_COORDINATES,
        FragmentType.PRODUCT_DISPLAY: NodeId.PLAN_PRODUCT_DISPLAY_COORDINATES,
        FragmentType.SELLING_POINT_EXPLANATION: NodeId.PLAN_SELLING_POINT_EXPLANATION_COORDINATES,
        FragmentType.CTA: NodeId.PLAN_CTA_COORDINATES,
        FragmentType.OUTRO: NodeId.PLAN_OUTRO_COORDINATES,
    }

    def route_graph_version(state: GraphState) -> str:
        return (
            NodeId.RELATIONSHIP_FRAGMENT_ROUTER.value
            if state.get("graph_version") == "V10_RELATION_COORDINATE_BLUEPRINT"
            else NodeId.STRATEGY_FRAGMENT_ROUTER.value
        )

    def route_after_shared_prompt(state: GraphState) -> str:
        if state.get("graph_version") not in {
            "V11_COHERENT_CREATIVE_GENERATION",
            "V11_VISUAL_USAGE_STRATEGY",
        }:
            return NodeId.GLOBAL_FACT_ALLOCATION.value
        return (
            NodeId.ITEM_EVALUATE.value
            if state.get("operation") == "ITEM_EVALUATE"
            else NodeId.COHERENT_CREATIVE_GENERATION.value
        )

    def route_after_insight_mapping(state: GraphState) -> str:
        return (
            NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value
            if state.get("graph_version")
            == "V11_VISUAL_USAGE_STRATEGY"
            else NodeId.SHARED_PROMPT_COMPILATION.value
        )

    def dispatch_relationship_branches(state: GraphState) -> list[Send]:
        expected = set(state.get("expected_fragment_types", list(FragmentType)))
        return [
            Send(
                relationship_node_by_fragment[fragment_type].value,
                {
                    "project_id": state["project_id"],
                    "relationship_checkpoint_types": state.get("relationship_checkpoint_types", []),
                    "active_relationship_allocation": allocation.model_dump(mode="json", by_alias=True),
                },
            )
            for fragment_type, allocation in state["fact_allocations"].items()
            if fragment_type in expected
        ]

    def dispatch_coordinate_branches(state: GraphState) -> list[Send]:
        return [
            Send(
                coordinate_node_by_fragment[relationship.fragment_type].value,
                {
                    "project_id": state["project_id"],
                    "coordinate_checkpoint_types": state.get("coordinate_checkpoint_types", []),
                    "active_coordinate_request": relationship.model_dump(mode="json", by_alias=True),
                },
            )
            for relationship in state["fragment_relationship_plans"]
        ]

    def dispatch_blueprint_shards(state: GraphState) -> list[Send] | str:
        pending = state.get("pending_blueprint_shards", [])
        if not pending:
            return NodeId.BLUEPRINT_ORTHOGONAL_GATE.value
        return [
            Send(
                BLUEPRINT_NODE_BY_FRAGMENT[shard.fragment_type].value,
                {"project_id": state["project_id"], "active_blueprint_shard": shard.model_dump(mode="json", by_alias=True)},
            )
            for shard in pending
        ]

    def route_blueprint_gate(state: GraphState) -> str:
        # Quantity and quality are decided only after the available blueprints
        # have produced Prompt candidates. Even when the blueprint gate reports
        # a gap (for example, exact duplicate coordinates), send the selected
        # blueprints forward first; QUALITY_GATE then routes the real type and
        # relationship deficits back to blueprint replenishment.
        return NodeId.FRAGMENT_TYPE_ROUTER.value

    def route_replenish(state: GraphState) -> str:
        return (
            NodeId.BLUEPRINT_FRAGMENT_ROUTER.value
            if state.get("graph_version") == "V10_RELATION_COORDINATE_BLUEPRINT"
            else NodeId.FRAGMENT_TYPE_ROUTER.value
        )

    def route_quality(state: GraphState) -> Literal["REPLENISH", "RESULT_SAVE"]:
        return "REPLENISH" if state.get("needs_replenish", False) else "RESULT_SAVE"

    builder = StateGraph(
        state_schema=GraphState,
        context_schema=RuntimeContext,
        input_schema=InputState,
        output_schema=OutputState,
    )
    builder.add_node(NodeId.LOAD_AND_SNAPSHOT.value, load)
    builder.add_node(NodeId.INSIGHT_MAPPING.value, map_insight)
    builder.add_node(
        NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value,
        fact_visual_strategy_compilation,
    )
    builder.add_node(NodeId.SHARED_PROMPT_COMPILATION.value, shared_prompt_compilation)
    builder.add_node(NodeId.GLOBAL_FACT_ALLOCATION.value, global_fact_allocation)
    builder.add_node(NodeId.RELATIONSHIP_FRAGMENT_ROUTER.value, relationship_router)
    relationship_nodes = tuple(relationship_node_by_fragment.values())
    for relationship_node in relationship_nodes:
        builder.add_node(relationship_node.value, plan_relationship)
    builder.add_node(NodeId.RELATIONSHIP_MERGE_VALIDATION.value, merge_relationships)
    builder.add_node(NodeId.DIMENSION_COORDINATE_ROUTER.value, coordinate_router)
    coordinate_nodes = tuple(coordinate_node_by_fragment.values())
    for coordinate_node in coordinate_nodes:
        builder.add_node(coordinate_node.value, plan_coordinates)
    builder.add_node(NodeId.COORDINATE_MERGE_VALIDATION.value, merge_coordinates)
    builder.add_node(NodeId.BLUEPRINT_QUOTA_ALLOCATION.value, allocate_blueprints)
    builder.add_node(NodeId.BLUEPRINT_FRAGMENT_ROUTER.value, blueprint_router)
    for blueprint_node in BLUEPRINT_NODE_BY_FRAGMENT.values():
        builder.add_node(blueprint_node.value, generate_blueprints)
    builder.add_node(NodeId.BLUEPRINT_ORTHOGONAL_GATE.value, blueprint_gate)
    builder.add_node(NodeId.STRATEGY_FRAGMENT_ROUTER.value, strategy_router)
    strategy_nodes = (
        NodeId.PLAN_HOOK_STRATEGY,
        NodeId.PLAN_PAIN_STRATEGY,
        NodeId.PLAN_PRODUCT_DISPLAY_STRATEGY,
        NodeId.PLAN_SELLING_POINT_EXPLANATION_STRATEGY,
        NodeId.PLAN_CTA_STRATEGY,
        NodeId.PLAN_OUTRO_STRATEGY,
    )
    for strategy_node in strategy_nodes:
        builder.add_node(strategy_node.value, plan_fragment_strategy)
    builder.add_node(NodeId.STRATEGY_MERGE_VALIDATION.value, merge_strategy)
    builder.add_node(NodeId.DIMENSION_COMBINATION.value, combine)
    builder.add_node(NodeId.FRAGMENT_TYPE_ROUTER.value, router)
    for generation_node in GENERATION_NODE_BY_FRAGMENT.values():
        builder.add_node(generation_node.value, generate)
    builder.add_node(NodeId.NORMALIZATION.value, normalize)
    builder.add_node(NodeId.SEMANTIC_DEDUP.value, semantic)
    builder.add_node(NodeId.VISUAL_DEDUP.value, visual)
    builder.add_node(NodeId.INSIGHT_COVERAGE.value, insight_coverage)
    builder.add_node(NodeId.QUALITY_GATE.value, quality)
    builder.add_node(NodeId.REPLENISH.value, replenish)
    builder.add_node(NodeId.RESULT_SAVE.value, save)
    builder.add_node(
        NodeId.COHERENT_CREATIVE_GENERATION.value,
        coherent_creative_generation,
    )
    builder.add_node(NodeId.ITEM_EVALUATE.value, coherent_creative_generation)

    builder.add_edge(START, NodeId.LOAD_AND_SNAPSHOT.value)
    builder.add_edge(NodeId.LOAD_AND_SNAPSHOT.value, NodeId.INSIGHT_MAPPING.value)
    builder.add_conditional_edges(
        NodeId.INSIGHT_MAPPING.value,
        route_after_insight_mapping,
        [
            NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value,
            NodeId.SHARED_PROMPT_COMPILATION.value,
        ],
    )
    builder.add_edge(
        NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value,
        NodeId.SHARED_PROMPT_COMPILATION.value,
    )
    builder.add_conditional_edges(
        NodeId.SHARED_PROMPT_COMPILATION.value,
        route_after_shared_prompt,
        [
            NodeId.GLOBAL_FACT_ALLOCATION.value,
            NodeId.COHERENT_CREATIVE_GENERATION.value,
            NodeId.ITEM_EVALUATE.value,
        ],
    )
    builder.add_edge(
        NodeId.COHERENT_CREATIVE_GENERATION.value,
        NodeId.RESULT_SAVE.value,
    )
    builder.add_edge(NodeId.ITEM_EVALUATE.value, NodeId.RESULT_SAVE.value)
    builder.add_conditional_edges(
        NodeId.GLOBAL_FACT_ALLOCATION.value,
        route_graph_version,
        [
            NodeId.STRATEGY_FRAGMENT_ROUTER.value,
            NodeId.RELATIONSHIP_FRAGMENT_ROUTER.value,
        ],
    )
    builder.add_conditional_edges(
        NodeId.RELATIONSHIP_FRAGMENT_ROUTER.value,
        dispatch_relationship_branches,
        [node.value for node in relationship_nodes],
    )
    builder.add_edge(
        [node.value for node in relationship_nodes],
        NodeId.RELATIONSHIP_MERGE_VALIDATION.value,
    )
    builder.add_edge(
        NodeId.RELATIONSHIP_MERGE_VALIDATION.value,
        NodeId.DIMENSION_COORDINATE_ROUTER.value,
    )
    builder.add_conditional_edges(
        NodeId.DIMENSION_COORDINATE_ROUTER.value,
        dispatch_coordinate_branches,
        [node.value for node in coordinate_nodes],
    )
    builder.add_edge(
        [node.value for node in coordinate_nodes],
        NodeId.COORDINATE_MERGE_VALIDATION.value,
    )
    builder.add_edge(
        NodeId.COORDINATE_MERGE_VALIDATION.value,
        NodeId.BLUEPRINT_QUOTA_ALLOCATION.value,
    )
    builder.add_edge(
        NodeId.BLUEPRINT_QUOTA_ALLOCATION.value,
        NodeId.BLUEPRINT_FRAGMENT_ROUTER.value,
    )
    builder.add_conditional_edges(
        NodeId.BLUEPRINT_FRAGMENT_ROUTER.value,
        dispatch_blueprint_shards,
        [
            *(node.value for node in BLUEPRINT_NODE_BY_FRAGMENT.values()),
            NodeId.BLUEPRINT_ORTHOGONAL_GATE.value,
        ],
    )
    for blueprint_node in BLUEPRINT_NODE_BY_FRAGMENT.values():
        builder.add_edge(blueprint_node.value, NodeId.BLUEPRINT_ORTHOGONAL_GATE.value)
    builder.add_conditional_edges(
        NodeId.BLUEPRINT_ORTHOGONAL_GATE.value,
        route_blueprint_gate,
        [NodeId.FRAGMENT_TYPE_ROUTER.value],
    )
    builder.add_conditional_edges(
        NodeId.STRATEGY_FRAGMENT_ROUTER.value,
        dispatch_strategy_branches,
        [node.value for node in strategy_nodes],
    )
    builder.add_edge(
        [node.value for node in strategy_nodes],
        NodeId.STRATEGY_MERGE_VALIDATION.value,
    )
    builder.add_edge(
        NodeId.STRATEGY_MERGE_VALIDATION.value, NodeId.DIMENSION_COMBINATION.value
    )
    builder.add_edge(
        NodeId.DIMENSION_COMBINATION.value, NodeId.FRAGMENT_TYPE_ROUTER.value
    )
    builder.add_conditional_edges(
        NodeId.FRAGMENT_TYPE_ROUTER.value,
        dispatch_shards,
        [
            *(node.value for node in GENERATION_NODE_BY_FRAGMENT.values()),
            NodeId.NORMALIZATION.value,
        ],
    )
    for generation_node in GENERATION_NODE_BY_FRAGMENT.values():
        builder.add_edge(generation_node.value, NodeId.NORMALIZATION.value)
    builder.add_edge(NodeId.NORMALIZATION.value, NodeId.SEMANTIC_DEDUP.value)
    builder.add_edge(NodeId.NORMALIZATION.value, NodeId.VISUAL_DEDUP.value)
    builder.add_edge(
        [NodeId.SEMANTIC_DEDUP.value, NodeId.VISUAL_DEDUP.value],
        NodeId.INSIGHT_COVERAGE.value,
    )
    builder.add_edge(NodeId.INSIGHT_COVERAGE.value, NodeId.QUALITY_GATE.value)
    builder.add_conditional_edges(
        NodeId.QUALITY_GATE.value,
        route_quality,
        [NodeId.REPLENISH.value, NodeId.RESULT_SAVE.value],
    )
    builder.add_conditional_edges(
        NodeId.REPLENISH.value,
        route_replenish,
        [NodeId.BLUEPRINT_FRAGMENT_ROUTER.value, NodeId.FRAGMENT_TYPE_ROUTER.value],
    )
    builder.add_edge(NodeId.RESULT_SAVE.value, END)
    return builder.compile()
