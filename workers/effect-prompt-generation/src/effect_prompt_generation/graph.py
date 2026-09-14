from __future__ import annotations

import asyncio
from collections.abc import Awaitable

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime

from .models import CreativeShardPlan, GraphState, InputState, NodeId, OutputState, RuntimeContext
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
    async def process_round(
        context: RuntimeContext, pending: list[CreativeShardPlan], round_number: int,
    ) -> None:
        if pipeline.snapshot(context).operation == "BATCH_GENERATE":
            # Bound entire shard chains, not just HTTP calls: an early shard
            # can reach correction/scoring without queuing behind all producers.
            chains = asyncio.Semaphore(pipeline.ai_max_concurrency)
            restored = await pipeline.restored_round_candidates(context, round_number=round_number)

            async def process_shard(shard: CreativeShardPlan) -> None:
                async with chains:
                    items = await pipeline.generate_creative_shard(context, shard)
                    await pipeline.classify_ready_candidates(context, items, round_number=round_number)

            await _gather_cancel_on_error([
                pipeline.classify_ready_candidates(context, restored, round_number=round_number),
                *(process_shard(shard) for shard in pending),
            ])
            await pipeline.complete_creative_generation(context, round_number=round_number)
        else:
            await _gather_cancel_on_error([
                pipeline.generate_creative_shard(context, shard) for shard in pending
            ])
            await pipeline.complete_creative_generation(context, round_number=round_number)
            classifications = await pipeline.plan_classification(context, round_number=round_number)
            await _gather_cancel_on_error([
                pipeline.evaluate_classification_shard(context, shard) for shard in classifications
            ])
        await pipeline.complete_classification(context, round_number=round_number)

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
        await process_round(runtime.context, pending, 0)
        supplement, needed = await pipeline.select_creatives(
            runtime.context, round_number=0
        )
        supplement_round = 1
        while needed and supplement_round <= MAX_REPLENISHMENT_ROUNDS:
            await process_round(runtime.context, supplement, supplement_round)
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
    builder.add_node(
        NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value, compile_visual_strategy
    )
    builder.add_node(NodeId.SHARED_PROMPT_COMPILATION.value, compile_shared_prompt)
    builder.add_node(NodeId.COHERENT_CREATIVE_GENERATION.value, generate_and_evaluate)
    builder.add_node(NodeId.ITEM_EVALUATE.value, generate_and_evaluate)
    builder.add_node(NodeId.RESULT_SAVE.value, save)

    builder.add_edge(START, NodeId.LOAD_AND_SNAPSHOT.value)
    builder.add_edge(NodeId.LOAD_AND_SNAPSHOT.value, NodeId.INSIGHT_MAPPING.value)
    builder.add_edge(
        NodeId.INSIGHT_MAPPING.value, NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value
    )
    builder.add_edge(
        NodeId.FACT_VISUAL_STRATEGY_COMPILATION.value,
        NodeId.SHARED_PROMPT_COMPILATION.value,
    )
    builder.add_conditional_edges(
        NodeId.SHARED_PROMPT_COMPILATION.value,
        route_after_shared_prompt,
        [NodeId.COHERENT_CREATIVE_GENERATION.value, NodeId.ITEM_EVALUATE.value],
    )
    builder.add_edge(
        NodeId.COHERENT_CREATIVE_GENERATION.value, NodeId.RESULT_SAVE.value
    )
    builder.add_edge(NodeId.ITEM_EVALUATE.value, NodeId.RESULT_SAVE.value)
    builder.add_edge(NodeId.RESULT_SAVE.value, END)
    return builder.compile()
