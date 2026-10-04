from unittest.mock import AsyncMock
import json

import pytest

from effect_template_mix.models import IncrementalPlan, IncrementalReview, OmittedMaterial, Snapshot
from effect_template_mix.provider import ArkProvider, ProviderError


def snapshot(capacity=8):
    return Snapshot.model_validate({
        "schemaVersion": 1, "template": {"id": "t", "slots": []}, "draftRevision": 2,
        "targetVariantId": None, "lockedBindings": [], "promptArtifacts": [], "materials": [],
        "maxOutputVariants": capacity,
        "incremental": {"materialIds": ["new", "unused"], "oldVariantIds": ["old"], "packageNewVariants": True},
        "existingVariantBindings": [[{"slotId": "s", "materialId": "old"}]],
    })


def plan():
    return IncrementalPlan.model_validate({"variants": [
        {"difference": "新动作展开", "bindings": [{"slotId": "s", "materialId": "new"}]},
        {"difference": "只是换措辞", "bindings": [{"slotId": "s", "materialId": "new"}]},
    ], "omitted": [{"materialId": "unused", "reason": "不能提供真实观看差异"}]})


async def test_incremental_independent_review_selects_plans_without_enumeration():
    provider = ArkProvider("https://test.invalid", "secret", "model", 1, 8192, "minimal")
    provider.structured = AsyncMock(side_effect=[plan(), IncrementalReview(acceptedIndexes=[0], reason="另一条重复")])
    try:
        result = await provider.plan_incremental(snapshot(), {"new": "HOOK"})
        assert len(result.variants) == 1 and result.variants[0].difference == "新动作展开"
        assert result.omitted[0].materialId == "unused"
        assert provider.structured.await_count == 2
        context = json.loads(provider.structured.await_args_list[0].args[0][0]["text"])
        assert context["maximumThisPage"] == 8
        assert context["existingBindings"] == [[{"slotId": "s", "materialId": "old"}]]
        assert "每条必须至少包含一个新增素材" in context["rules"][1]
    finally:
        await provider.close()


@pytest.mark.parametrize("indexes", [[], [2], [0, 0]])
async def test_incremental_rejection_keeps_old_projects_and_has_no_fallback(indexes):
    provider = ArkProvider("https://test.invalid", "secret", "model", 1, 8192, "minimal")
    provider.structured = AsyncMock(side_effect=[plan(), IncrementalReview(acceptedIndexes=indexes, reason="不通过")])
    try:
        with pytest.raises(ProviderError):
            await provider.plan_incremental(snapshot(), {})
        assert provider.structured.await_count == 2
    finally:
        await provider.close()


async def test_incremental_paging_obeys_capacity_and_drops_obsolete_omissions():
    provider = ArkProvider("https://test.invalid", "secret", "model", 1, 8192, "minimal")
    candidate = plan()
    candidate.omitted.append(OmittedMaterial(materialId="new", reason="此前未采用"))
    provider.structured = AsyncMock(side_effect=[candidate, IncrementalReview(acceptedIndexes=[0], reason="通过"),
        IncrementalPlan(variants=[], omitted=[])])
    try:
        result = await provider.plan_incremental(snapshot(9), {})
        assert [item.materialId for item in result.omitted] == ["unused"]
        context = json.loads(provider.structured.await_args_list[2].args[0][0]["text"])
        assert len(context["acceptedPlans"]) == 1 and context["maximumThisPage"] == 8
    finally:
        await provider.close()
