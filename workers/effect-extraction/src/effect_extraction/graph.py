from __future__ import annotations

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime

from .models import GraphState, InputState, OutputState, RuntimeContext
from .pipeline import ExtractionPipeline

BRANCH_NODES = ("documents", "images", "commerce", "form")


def build_graph(
    pipeline: ExtractionPipeline,
) -> CompiledStateGraph[GraphState, RuntimeContext, InputState, OutputState]:
    builder = StateGraph(
        GraphState,
        context_schema=RuntimeContext,
        input_schema=InputState,
        output_schema=OutputState,
    )

    async def load_snapshot(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, str]:
        await pipeline.snapshot(state["project_id"], runtime.context)
        return {}

    async def documents(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, str]:
        await pipeline.document_branch(runtime.context)
        return {}

    async def images(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, str]:
        await pipeline.image_branch(runtime.context)
        return {}

    async def commerce(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, str]:
        await pipeline.commerce_branch(runtime.context)
        return {}

    async def form(state: GraphState, runtime: Runtime[RuntimeContext]) -> dict[str, str]:
        await pipeline.form_branch(runtime.context)
        return {}

    async def fuse_sources(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, str]:
        await pipeline.fuse_sources(runtime.context)
        return {}

    async def semantic_refinement(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, str]:
        await pipeline.refine_semantics(runtime.context)
        return {}

    async def normalize_and_store(
        state: GraphState, runtime: Runtime[RuntimeContext]
    ) -> dict[str, str]:
        result_id = await pipeline.normalize_and_finalize(runtime.context)
        return {"extract_result_id": result_id}

    builder.add_node("load_snapshot", load_snapshot)
    builder.add_node("documents", documents)
    builder.add_node("images", images)
    builder.add_node("commerce", commerce)
    builder.add_node("form", form)
    builder.add_node("fuse_sources", fuse_sources)
    builder.add_node("semantic_refinement", semantic_refinement)
    builder.add_node("normalize_and_store", normalize_and_store)
    builder.add_edge(START, "load_snapshot")
    for branch in BRANCH_NODES:
        builder.add_edge("load_snapshot", branch)
    builder.add_edge(list(BRANCH_NODES), "fuse_sources")
    builder.add_edge("fuse_sources", "semantic_refinement")
    builder.add_edge("semantic_refinement", "normalize_and_store")
    builder.add_edge("normalize_and_store", END)
    return builder.compile()
