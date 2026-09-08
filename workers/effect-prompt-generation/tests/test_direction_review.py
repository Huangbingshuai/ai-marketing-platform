from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import replace
from typing import Any

import pytest

from effect_prompt_generation.direction_review import review_batches, review_input_size
from effect_prompt_generation.models import StrategyCheckpoint
from effect_prompt_generation.pipeline import PromptGenerationPipeline
from effect_prompt_generation.providers import (
    MockAiProvider,
    ProviderError,
    ProviderErrorType,
)
from test_creatives import PromptApi, _runtime, _snapshot


class InterruptedReviewProvider(MockAiProvider):
    def __init__(self) -> None:
        self.fail = True
        self.failed_batch: tuple[str, ...] | None = None
        self.reviews: Counter[tuple[str, ...]] = Counter()
        self.landscape_calls = 0
        self.direction_calls = 0

    async def plan_creative_landscape(self, *args: Any, **kwargs: Any) -> Any:
        self.landscape_calls += 1
        return await super().plan_creative_landscape(*args, **kwargs)

    async def plan_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        self.direction_calls += 1
        return await super().plan_creative_directions(*args, **kwargs)

    async def audit_creative_directions(self, *args: Any, **kwargs: Any) -> Any:
        key = tuple(d.direction_id for d in kwargs["directions"].directions)
        self.reviews[key] += 1
        if self.failed_batch is None:
            self.failed_batch = key
        if self.fail and key == self.failed_batch:
            raise ProviderError(
                "timeout", retryable=True, error_type=ProviderErrorType.TIMEOUT
            )
        # Sibling results must still be persisted if an earlier task failed.
        await asyncio.sleep(0.01)
        return await super().audit_creative_directions(*args, **kwargs)


async def prepare(
    api: PromptApi,
    provider: MockAiProvider,
    checkpoints: list[StrategyCheckpoint],
    runtime: Any = None,
    snapshot: Any = None,
) -> tuple[Any, Any]:
    runtime = runtime or _runtime()
    pipeline = PromptGenerationPipeline(
        api=api,
        provider=provider,
        direction_review_batch_size=2,
        direction_review_input_budget=100000,
    )
    pipeline.register_snapshot(runtime, snapshot or _snapshot(), checkpoints)
    await pipeline.load_and_snapshot(runtime)
    await pipeline.map_insight(runtime)
    await pipeline.compile_fact_visual_strategy(runtime)
    await pipeline.compile_shared_prompt(runtime)
    return pipeline, runtime


def latest_checkpoints(api: PromptApi) -> list[StrategyCheckpoint]:
    by_node = {}
    for stage in api.stages:
        if "checkpoint" in stage.metadata:
            by_node[stage.node_id] = StrategyCheckpoint.model_validate(
                stage.metadata["checkpoint"]
            )
    return list(by_node.values())


@pytest.mark.asyncio
async def test_same_run_resumes_only_failed_review_without_replanning() -> None:
    api = PromptApi()
    provider = InterruptedReviewProvider()
    pipeline, runtime = await prepare(api, provider, [])
    with pytest.raises(ProviderError):
        await pipeline._ensure_creative_direction_plan(runtime)
    checkpoints = latest_checkpoints(api)
    partial = checkpoints[-1].plan
    assert partial.review_progress is not None
    assert len(partial.review_progress.completed_batches) == len(provider.reviews) - 1
    assert provider.reviews[provider.failed_batch] == 2
    calls_before = (provider.landscape_calls, provider.direction_calls)
    provider.reviews.clear()
    provider.fail = False
    resumed, runtime = await prepare(
        api, provider, checkpoints, replace(runtime, attempt_token="second-attempt")
    )
    plan = await resumed._ensure_creative_direction_plan(runtime)
    assert plan.semantic_audit is not None
    assert plan.diversity_audit is not None
    assert plan.review_progress is None
    assert (provider.landscape_calls, provider.direction_calls) == calls_before
    assert dict(provider.reviews) == {provider.failed_batch: 1}


@pytest.mark.parametrize(
    "change", ["run", "source", "settings", "template", "allocation", "content"]
)
@pytest.mark.asyncio
async def test_review_progress_is_not_reused_with_changed_identity(change: str) -> None:
    api = PromptApi()
    provider = InterruptedReviewProvider()
    pipeline, runtime = await prepare(api, provider, [])
    with pytest.raises(ProviderError):
        await pipeline._ensure_creative_direction_plan(runtime)
    checkpoints = latest_checkpoints(api)
    snapshot = _snapshot()
    if change == "run":
        runtime = replace(runtime, run_id="new-run")
    elif change == "source":
        runtime = replace(runtime, source_fingerprint="changed-source")
    elif change == "settings":
        snapshot = snapshot.model_copy(
            update={
                "settings": snapshot.settings.model_copy(
                    update={"default_duration_seconds": 15}
                )
            }
        )
    elif change == "content":
        checkpoint = checkpoints[-1]
        altered = checkpoint.plan.directions[0].model_copy(
            update={"creative_direction": "Changed visible action"}
        )
        checkpoints[-1] = checkpoint.model_copy(
            update={
                "plan": checkpoint.plan.model_copy(
                    update={"directions": [altered, *checkpoint.plan.directions[1:]]}
                )
            }
        )
    else:
        checkpoints[-1] = checkpoints[-1].model_copy(
            update={
                "template_hash" if change == "template" else "allocation_hash": "f" * 64
            }
        )
    calls_before = provider.landscape_calls
    provider.fail = False
    resumed, runtime = await prepare(api, provider, checkpoints, runtime, snapshot)
    await resumed._ensure_creative_direction_plan(runtime)
    assert provider.landscape_calls > calls_before


@pytest.mark.asyncio
async def test_global_audit_timeout_retains_all_completed_relation_batches() -> None:
    class GlobalFailureProvider(InterruptedReviewProvider):
        fail_global = True

        async def audit_creative_direction_diversity(
            self, *args: Any, **kwargs: Any
        ) -> Any:
            if self.fail_global:
                raise ProviderError(
                    "timeout", retryable=True, error_type=ProviderErrorType.TIMEOUT
                )
            return await super().audit_creative_direction_diversity(*args, **kwargs)

    api = PromptApi()
    provider = GlobalFailureProvider()
    provider.fail = False
    pipeline, runtime = await prepare(api, provider, [])
    with pytest.raises(ProviderError):
        await pipeline._ensure_creative_direction_plan(runtime)
    checkpoints = latest_checkpoints(api)
    assert len(checkpoints[-1].plan.review_progress.completed_batches) == len(
        provider.reviews
    )
    provider.reviews.clear()
    calls_before = (provider.landscape_calls, provider.direction_calls)
    provider.fail_global = False
    resumed, runtime = await prepare(api, provider, checkpoints)
    plan = await resumed._ensure_creative_direction_plan(runtime)
    assert plan.diversity_audit is not None
    assert provider.reviews == {}
    assert (provider.landscape_calls, provider.direction_calls) == calls_before


@pytest.mark.asyncio
async def test_input_sizing_splits_large_descriptions_without_dropping_content() -> (
    None
):
    api = PromptApi()
    provider = InterruptedReviewProvider()
    provider.fail = False
    pipeline, runtime = await prepare(api, provider, [])
    plan = await pipeline._ensure_creative_direction_plan(runtime)
    application = pipeline._require_application(runtime)
    strategy = pipeline._required_fact_visual_strategy(runtime)
    directions = plan.directions
    batches = review_batches(
        directions,
        application,
        strategy,
        plan.landscape,
        max_size=3,
        input_budget=1000000,
    )
    assert max(map(len, batches)) == 3
    assert [d for batch in batches for d in batch] == directions
    large = [
        d.model_copy(update={"creative_direction": "visual action " * 3000})
        for d in directions
    ]
    batches = review_batches(
        large, application, strategy, plan.landscape, max_size=6, input_budget=12000
    )
    assert all(len(batch) == 1 for batch in batches)
    assert [d for batch in batches for d in batch] == large
    assert review_input_size(large[:1], application, strategy, plan.landscape) > 12000
