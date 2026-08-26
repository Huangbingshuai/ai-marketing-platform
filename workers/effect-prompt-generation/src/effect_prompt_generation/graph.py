from __future__ import annotations

from typing import Literal

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime
from langgraph.types import Send

from .models import (
    GraphState,
    InputState,
    NodeId,
    OutputState,
    RuntimeContext,
    ShardPlan,
)
from .pipeline import (
    GENERATION_NODE_BY_FRAGMENT,
    MAX_REPLENISHMENT_ROUNDS,
    PromptGenerationPipeline,
)


def build_graph(
    pipeline: PromptGenerationPipeline,
) -> CompiledStateGraph[GraphState, RuntimeContext, InputState, OutputState]:
    async def load(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        loaded = await pipeline.load_and_snapshot(runtime.context)
        return {
            "round": loaded.highest_round,
            "target_count": loaded.snapshot.settings.target_count,
            "retained_count": len(loaded.snapshot.retained_manual_items),
            "completed_shard_keys": loaded.completed_shard_keys,
            "generated_candidate_count": len(loaded.candidates),
        }

    async def strategy(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        plan = await pipeline.plan_strategy(
            runtime.context,
            application=state["insight_map"],
            target_count=state["target_count"],
        )
        return {"strategy_plan": plan}

    async def map_insight(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        application = await pipeline.map_insight(runtime.context)
        snapshot = pipeline.snapshot(runtime.context)
        target_fact_ids = (
            [binding.fact_id for binding in snapshot.target_item.insight_bindings]
            if snapshot.operation == "ITEM_REGENERATE" and snapshot.target_item
            else [fact.fact_id for fact in application.required]
        )
        return {"insight_map": application, "missing_fact_ids": target_fact_ids}

    async def shared_prompt_compilation(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        prompt = await pipeline.compile_shared_prompt(runtime.context)
        return {"shared_prompt": prompt}

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
    builder.add_node(NodeId.SHARED_PROMPT_COMPILATION.value, shared_prompt_compilation)
    builder.add_node(NodeId.STRATEGY_PLANNING.value, strategy)
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

    builder.add_edge(START, NodeId.LOAD_AND_SNAPSHOT.value)
    builder.add_edge(NodeId.LOAD_AND_SNAPSHOT.value, NodeId.INSIGHT_MAPPING.value)
    builder.add_edge(
        NodeId.INSIGHT_MAPPING.value, NodeId.SHARED_PROMPT_COMPILATION.value
    )
    builder.add_edge(
        NodeId.SHARED_PROMPT_COMPILATION.value, NodeId.STRATEGY_PLANNING.value
    )
    builder.add_edge(NodeId.STRATEGY_PLANNING.value, NodeId.DIMENSION_COMBINATION.value)
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
    builder.add_edge(NodeId.REPLENISH.value, NodeId.FRAGMENT_TYPE_ROUTER.value)
    builder.add_edge(NodeId.RESULT_SAVE.value, END)
    return builder.compile()
