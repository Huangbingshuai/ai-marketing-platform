from __future__ import annotations

import asyncio
from collections.abc import Awaitable

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime

from .models import GraphState, InputState, NodeId, OutputState, RuntimeContext
from .pipeline import MAX_REPLENISHMENT_ROUNDS, PromptGenerationPipeline


async def _gather_cancel_on_error(calls: list[Awaitable[object]]) -> None:
    tasks = [asyncio.ensure_future(call) for call in calls]
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
        del state
        loaded = await pipeline.load_and_snapshot(runtime.context)
        return {
            "project_id": loaded.snapshot.project_id,
        }

    async def map_insight(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        del state
        application = await pipeline.map_insight(runtime.context)
        snapshot = pipeline.snapshot(runtime.context)
        target_fact_ids = (
            [binding.fact_id for binding in snapshot.target_item.insight_bindings]
            if snapshot.operation in {"ITEM_REGENERATE", "ITEM_EVALUATE"}
            and snapshot.target_item
            else [fact.fact_id for fact in application.required]
        )
        return {"insight_map": application, "missing_fact_ids": target_fact_ids}

    async def compile_visual_strategy(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        del state
        strategy = await pipeline.compile_fact_visual_strategy(runtime.context)
        return {"fact_visual_strategy": strategy}

    async def compile_shared_prompt(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        del state
        prompt = await pipeline.compile_shared_prompt(runtime.context)
        return {"shared_prompt": prompt}

    async def generate_and_evaluate(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        del state
        pending = await pipeline.plan_creatives(runtime.context, round_number=0)
        if pending:
            await _gather_cancel_on_error(
                [pipeline.generate_creative_shard(runtime.context, shard) for shard in pending]
            )
        await pipeline.complete_creative_generation(runtime.context, round_number=0)
        classifications = await pipeline.plan_classification(runtime.context, round_number=0)
        if classifications:
            await _gather_cancel_on_error(
                [
                    pipeline.evaluate_classification_shard(runtime.context, shard)
                    for shard in classifications
                ]
            )
        await pipeline.complete_classification(runtime.context, round_number=0)
        supplement, needed = await pipeline.select_creatives(runtime.context, round_number=0)
        supplement_round = 1
        while needed and supplement_round <= MAX_REPLENISHMENT_ROUNDS + 1:
            if supplement:
                await _gather_cancel_on_error(
                    [
                        pipeline.generate_creative_shard(runtime.context, shard)
                        for shard in supplement
                    ]
                )
            await pipeline.complete_creative_generation(
                runtime.context, round_number=supplement_round
            )
            classifications = await pipeline.plan_classification(
                runtime.context, round_number=supplement_round
            )
            if classifications:
                await _gather_cancel_on_error(
                    [
                        pipeline.evaluate_classification_shard(runtime.context, shard)
                        for shard in classifications
                    ]
                )
            await pipeline.complete_classification(
                runtime.context, round_number=supplement_round
            )
            supplement, needed = await pipeline.select_creatives(
                runtime.context, round_number=supplement_round
            )
            supplement_round += 1
        return {}

    async def save(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, object]:
        del state
        result_id = await pipeline.save_result(runtime.context)
        return {"prompt_result_id": result_id}

    def route_after_shared_prompt(state: GraphState) -> str:
        return (
            NodeId.ITEM_EVALUATE.value
            if state.get("operation") == "ITEM_EVALUATE"
            else NodeId.COHERENT_CREATIVE_GENERATION.value
        )

    builder = StateGraph(
        state_schema=GraphState,
        context_schema=RuntimeContext,
        input_schema=InputState,
        output_schema=OutputState,
    )
    builder.add_node(NodeId.LOAD_AND_SNAPSHOT.value, load)
    builder.add_node(NodeId.INSIGHT_MAPPING.value, map_insight)
    builder.add_node(NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value, compile_visual_strategy)
    builder.add_node(NodeId.SHARED_PROMPT_COMPILATION.value, compile_shared_prompt)
    builder.add_node(NodeId.COHERENT_CREATIVE_GENERATION.value, generate_and_evaluate)
    builder.add_node(NodeId.ITEM_EVALUATE.value, generate_and_evaluate)
    builder.add_node(NodeId.RESULT_SAVE.value, save)

    builder.add_edge(START, NodeId.LOAD_AND_SNAPSHOT.value)
    builder.add_edge(NodeId.LOAD_AND_SNAPSHOT.value, NodeId.INSIGHT_MAPPING.value)
    builder.add_edge(NodeId.INSIGHT_MAPPING.value, NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value)
    builder.add_edge(
        NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value,
        NodeId.SHARED_PROMPT_COMPILATION.value,
    )
    builder.add_conditional_edges(
        NodeId.SHARED_PROMPT_COMPILATION.value,
        route_after_shared_prompt,
        [NodeId.COHERENT_CREATIVE_GENERATION.value, NodeId.ITEM_EVALUATE.value],
    )
    builder.add_edge(NodeId.COHERENT_CREATIVE_GENERATION.value, NodeId.RESULT_SAVE.value)
    builder.add_edge(NodeId.ITEM_EVALUATE.value, NodeId.RESULT_SAVE.value)
    builder.add_edge(NodeId.RESULT_SAVE.value, END)
    return builder.compile()
