from __future__ import annotations

import pytest

from effect_prompt_generation.insight_mapping import map_insight
from effect_prompt_generation.models import (
    FragmentType,
    PromptGenerationSnapshot,
    SharedPrompt,
    SharedPromptSection,
)
from effect_prompt_generation.providers import MockAiProvider, merge_fragment_marketing_plans
from effect_prompt_generation.strategy_planning import (
    allocate_fragment_facts,
    validate_fragment_marketing_plan,
)


def _counts(snapshot: PromptGenerationSnapshot) -> dict[FragmentType, int]:
    return {
        fragment_type: snapshot.settings.fragment_configs[fragment_type].count
        for fragment_type in FragmentType
    }


def test_global_fact_allocation_assigns_every_required_fact_once(
    snapshot: PromptGenerationSnapshot,
) -> None:
    application = map_insight(snapshot.insight_artifact.result)
    allocations = allocate_fragment_facts(application, _counts(snapshot))

    assigned = [
        fact_id
        for allocation in allocations.values()
        for fact_id in allocation.mandatory_fact_ids
    ]
    assert set(allocations) == set(FragmentType)
    assert set(assigned) == {fact.fact_id for fact in application.required}
    assert len(assigned) == len(set(assigned))
    assert all(
        allocation.bundle_target
        == min(4, max(1, (allocation.target_count + 2) // 3))
        for allocation in allocations.values()
    )


@pytest.mark.asyncio
async def test_six_ai_plans_merge_without_breaking_master_coherence(
    snapshot: PromptGenerationSnapshot,
) -> None:
    application = map_insight(snapshot.insight_artifact.result)
    allocations = allocate_fragment_facts(application, _counts(snapshot))
    provider = MockAiProvider()
    shared_prompt = SharedPrompt(
        sections=[
            SharedPromptSection(
                key="USER_ADDITIONAL",
                title="共用提示词",
                source="USER",
                content="",
                editable=True,
                source_hash="0" * 64,
            )
        ],
        compiled_content="",
        content_hash="0" * 64,
    )

    plans = []
    for allocation in allocations.values():
        result = await provider.plan_fragment_strategy(
            allocation,
            application=application,
            shared_prompt=shared_prompt,
        )
        validate_fragment_marketing_plan(result.value, allocation, application)
        plans.append(result.value)

    strategy = merge_fragment_marketing_plans(application, plans)
    assert {bundle.eligible_fragment_types[0] for bundle in strategy.relationship_bundles} == set(
        FragmentType
    )
    assert all(bundle.primary_fact_id for bundle in strategy.relationship_bundles)
    assert all(bundle.action_arc and bundle.camera for bundle in strategy.relationship_bundles)
