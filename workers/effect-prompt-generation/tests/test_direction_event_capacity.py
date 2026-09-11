from __future__ import annotations

from collections import Counter

import pytest

from effect_prompt_generation.creative_directions import allocate_creative_directions
from effect_prompt_generation.models import CreativeDirectionResponse
from effect_prompt_generation.providers import (
    MockAiProvider, ProviderError, _direction_event_capacity_schema,
    _validate_direction_event_capacity,
)
from test_supplement_recovery import ready_pipeline


@pytest.mark.asyncio
async def test_ai_event_capacity_not_uniform_worker_quota() -> None:
    pipeline, runtime = await ready_pipeline(MockAiProvider())
    plan = pipeline._cache(runtime).creative_direction_plan
    assert plan is not None
    first, second = plan.directions[:2]
    first = first.model_copy(update={"execution_routes": first.execution_routes[:1]})
    second = second.model_copy(update={"execution_routes": second.execution_routes[:3]})
    plan = plan.model_copy(update={"directions": [first, second]})
    assigned = allocate_creative_directions(plan, count=20, ordinal_start=1, respect_route_capacity=True)
    assert Counter(d.direction_id for d in assigned) == {
        first.direction_id: 1, second.direction_id: 3,
    }
    # Quantity recovery is explicit and count-first, not a new hard quality gate.
    recovered = allocate_creative_directions(plan, count=5, ordinal_start=10)
    assert len(recovered) == 5


@pytest.mark.asyncio
async def test_initial_tasks_consume_each_authored_route_at_most_once() -> None:
    pipeline, runtime = await ready_pipeline(MockAiProvider())
    cache = pipeline._cache(runtime)
    plan = cache.creative_direction_plan
    assert plan is not None
    directions = [d.model_copy(update={"execution_routes": d.execution_routes[:1]}) for d in plan.directions]
    cache.creative_direction_plan = plan.model_copy(update={"directions": directions})
    shards = await pipeline.plan_creatives(runtime, round_number=0)
    tasks = [t for shard in shards for t in shard.tasks]
    assert len(tasks) == min(cache.candidate_target_count, len(directions))
    identities = [(t.creative_direction.direction_id, t.execution_route.route_id) for t in tasks]
    assert len(set(identities)) == len(identities)
    assert all(t.sibling_variant_total == 1 for t in tasks)


def test_new_response_accepts_variable_capacity_without_changing_checkpoint_model() -> None:
    schema = _direction_event_capacity_schema()
    routes = schema["$defs"]["CreativeDirection"]["properties"]["executionRoutes"]
    assert routes["minItems"] == 1
    assert routes["maxItems"] == 5


@pytest.mark.asyncio
async def test_legacy_empty_routes_remain_readable_but_new_ai_cannot_omit_events() -> None:
    pipeline, runtime = await ready_pipeline(MockAiProvider())
    cache = pipeline._cache(runtime)
    plan = cache.creative_direction_plan
    assert plan is not None
    directions = [d.model_copy(update={"execution_routes": []}) for d in plan.directions]
    restored = CreativeDirectionResponse.model_validate({"directions": [d.model_dump() for d in directions]})
    with pytest.raises(ProviderError):
        _validate_direction_event_capacity(restored)
    cache.creative_direction_plan = plan.model_copy(update={"directions": restored.directions})
    tasks = [t for shard in await pipeline.plan_creatives(runtime, round_number=0) for t in shard.tasks]
    assert len(tasks) == cache.candidate_target_count
    assert all(t.execution_route is None for t in tasks)
