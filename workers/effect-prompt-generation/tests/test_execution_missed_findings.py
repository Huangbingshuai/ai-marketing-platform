from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from effect_prompt_generation.execution_correction import validate_execution_reviews
from effect_prompt_generation.models import ExecutionReviewBatch, ExecutionIssue
from effect_prompt_generation.providers import ArkResponsesProvider, ProviderError, _safe_http_diagnostic
from test_material_planning import ready


@pytest.mark.asyncio
async def test_explicit_ai_conflicts_are_targeted_even_if_issue_list_omitted() -> None:
    pipeline, runtime, _ = await ready()
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    item = (await pipeline.generate_creative_shard(runtime, shard))[0]
    review = item.execution_correction.review.model_copy(deep=True)
    review.beats[0].camera_conflict = True
    review.beats[0].handoff_gap = True
    review.beats[0].evidence = "AI 明确指出机位冲突及未放下原物"
    normalized = validate_execution_reviews([item], ExecutionReviewBatch(items=[review]))[item.slot_id]
    assert {issue.code for issue in normalized.issues} == {"CAMERA_VIEW", "TOOL_CONTINUITY"}
    assert all(issue.sequences == [1] for issue in normalized.issues)
    again = validate_execution_reviews([item], ExecutionReviewBatch(items=[normalized]))[item.slot_id]
    assert again == normalized
    assert review.issues == []


@pytest.mark.asyncio
async def test_camera_only_or_no_change_is_not_a_worker_semantic_gate() -> None:
    pipeline, runtime, _ = await ready()
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    item = (await pipeline.generate_creative_shard(runtime, shard))[0]
    review = item.execution_correction.review.model_copy(deep=True)
    review.beats[0].novelty_kind = "CAMERA_ONLY"
    review.beats[0].information_status = "HOLD"
    review.beats[0].evidence = "同一对象更近；由 AI 判断留白观看价值"
    review.beats[0].camera_conflict = False
    review.beats[0].handoff_gap = False
    assert validate_execution_reviews([item], ExecutionReviewBatch(items=[review]))[item.slot_id].issues == []


@pytest.mark.asyncio
async def test_new_requests_require_contrast_state_and_complete_targeted_replacement() -> None:
    pipeline, runtime, _ = await ready()
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    items = await pipeline.generate_creative_shard(runtime, shard)
    requests: list[Any] = []
    reviews = {item.slot_id: item.execution_correction.review.model_copy(deep=True) for item in items}
    for review in reviews.values():
        review.issues = [ExecutionIssue(issue_id="I1", code="TOOL_CONTINUITY", sequences=[1], diagnosis="交接缺失")]

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        requests.append(payload)
        if payload["text"]["format"]["name"] == "effect_prompt_execution_diagnosis":
            value = {"items": [review.model_dump(mode="json", by_alias=True) for review in reviews.values()]}
        else:
            value = {"items": [{"slotId": item.slot_id, "changed": True,
                "creativeCore": item.creative_core, "dimensions": item.dimensions.model_dump(by_alias=True),
                "shotPlan": item.shot_plan.model_dump(by_alias=True),
                "resolutions": [{"issueId": "I1", "revisedSequences": [1], "changeSummary": "补明确落点"}],
            } for item in items]}
        return httpx.Response(200, json={"status": "completed", "output_text": json.dumps(value)})

    provider = ArkResponsesProvider(base_url="https://ark.example/v3", api_key="test",
        candidate_model="candidate", strategy_model="strategy", evaluation_model="evaluation",
        transport=httpx.MockTransport(handler))
    kwargs = dict(tasks=shard.tasks, application=pipeline._require_application(runtime),
                  shared_prompt=pipeline._required_shared_prompt(runtime),
                  fact_visual_strategy=pipeline._required_fact_visual_strategy(runtime))
    try:
        await provider.diagnose_creative_execution(items, **kwargs)
        await provider.correct_creative_execution(items, reviews=reviews, **kwargs)
    finally:
        await provider.aclose()
    beat = requests[0]["text"]["format"]["schema"]["$defs"]["ExecutionBeatReview"]
    fields = {"noveltyKind", "visibleDelta", "stateBefore", "stateAfter",
              "cameraMotion", "cameraConflict", "handoffGap"}
    assert fields <= set(beat["required"])
    assert all("anyOf" not in beat["properties"][name] for name in fields)
    correction = requests[1]["text"]["format"]["schema"]["$defs"]["ExecutionCorrectionItem"]
    assert correction["properties"]["changed"]["const"] is True
    assert {"creativeCore", "dimensions", "shotPlan", "resolutions"} <= set(correction["required"])
    assert all("anyOf" not in correction["properties"][name] for name in ("creativeCore", "dimensions", "shotPlan"))


@pytest.mark.asyncio
@pytest.mark.parametrize("code,expected", [
    ("InvalidParameter.JSONSchema", "InvalidParameter"),
    ("OutputTextSensitiveContentDetected", "OutputTextSensitiveContentDetected"),
    ("InputTextSensitiveContentDetected.PolicyViolation", "InputTextSensitiveContentDetected"),
    ("SECRET_PRODUCT_AND_KEY", "UNRECOGNIZED"),
])
async def test_http_400_records_safe_code_and_request_id_without_retry_or_leak(
    code: str, expected: str, caplog: Any,
) -> None:
    pipeline, runtime, _ = await ready()
    shard = (await pipeline.plan_creatives(runtime, round_number=0))[0]
    items = await pipeline.generate_creative_shard(runtime, shard)
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(400, headers={"x-request-id": "20261016ABCDEF0123456789"},
            json={"error": {"code": code, "message": "SECRET_MESSAGE input echo key=SECRET_KEY"}})

    provider = ArkResponsesProvider(base_url="https://ark.example/v3", api_key="SECRET_KEY",
        candidate_model="candidate", strategy_model="strategy", evaluation_model="evaluation",
        max_attempts=3, transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ProviderError) as caught:
            await provider.diagnose_creative_execution(items, tasks=shard.tasks,
                application=pipeline._require_application(runtime),
                shared_prompt=pipeline._required_shared_prompt(runtime),
                fact_visual_strategy=pipeline._required_fact_visual_strategy(runtime))
    finally:
        await provider.aclose()
    assert calls == 1 and not caught.value.retryable
    assert caught.value.http_status == 400 and caught.value.supplier_error_code == expected
    assert caught.value.supplier_request_id == "20261016ABCDEF0123456789"
    assert "http_status=400" in caplog.text and "schema_hash=" in caplog.text
    assert "SECRET" not in caplog.text and "SECRET" not in str(caught.value)
    assert items[0].content not in caplog.text


@pytest.mark.parametrize("body", [[], {"error": "SECRET"}, {"error": {"code": ["SECRET"]}}])
def test_invalid_error_shapes_and_unsafe_request_id_are_not_logged(body: Any) -> None:
    diagnostic = _safe_http_diagnostic(httpx.Response(400, json=body,
        headers={"x-request-id": "https://unsafe.example/?key=SECRET"}))
    assert diagnostic["supplier_code"] == "UNRECOGNIZED"
    assert diagnostic["supplier_request_id"] is None
    assert "SECRET" not in json.dumps(diagnostic)
