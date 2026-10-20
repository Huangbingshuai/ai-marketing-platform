from __future__ import annotations

import copy
from typing import Any

import pytest
from customized_production_runtime.video_domain import (
    apply_repair,
    fingerprint,
    validate_plan,
)
from customized_production_runtime.video_pipeline import run_video
from customized_production_runtime.video_models import RetimedShotFields
from test_video_v2 import FakeApi, FakeProvider, fixture, finding, snapshot

MARKER = "【完整分镜整数秒】"


class Provider(FakeProvider):
    def __init__(self, bad_stage: str | None = None, enabled: bool = True) -> None:
        super().__init__()
        self.bad_stage = bad_stage
        self.enabled = enabled

    async def generate(
        self,
        stage: str,
        model: str,
        schema: Any,
        context: dict[str, Any],
        instruction: str,
    ) -> Any:
        assert (MARKER in instruction) is self.enabled
        actual_stage = stage.removesuffix("_CORRECT")
        value = (
            await super().generate(actual_stage, model, schema, context, instruction)
        ).model_dump()
        self.calls[-1] = stage
        if actual_stage == "VIDEO_DIRECTOR":
            assert ("shotDurationStepMs" in context) is self.enabled
            if self.bad_stage == actual_stage:
                value["clips"][-1]["durationSeconds"] = 5.5
        if actual_stage == "VIDEO_SHOTS":
            if self.bad_stage == actual_stage:
                value["shots"][-1]["durationSeconds"] = 5.5
            else:
                value["cueParts"][0]["parts"][0]["startMs"] = 125
        return schema.model_validate(value)


@pytest.mark.asyncio
async def test_new_integer_plan_preserves_millisecond_cues_without_extra_calls() -> (
    None
):
    api, provider, data = FakeApi(), Provider(), snapshot()
    data["shotDurationStepMs"] = 1000
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == ["VIDEO_DIRECTOR", "VIDEO_SHOTS", "VIDEO_REVIEW"]
    assert api.completed is not None
    assert all(
        float(s["durationSeconds"]).is_integer()
        for s in api.completed["videoPlan"]["shots"]
    )
    assert api.completed["videoPlan"]["cues"][0]["parts"][0]["startMs"] == 125


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["VIDEO_DIRECTOR", "VIDEO_SHOTS"])
async def test_fractional_candidates_fail_bounded_correction_and_resume_without_new_calls(
    stage: str,
) -> None:
    api, provider, data = FakeApi(), Provider(stage), snapshot()
    data["shotDurationStepMs"] = 1000
    original = copy.deepcopy(data)
    with pytest.raises(ValueError, match="whole seconds"):
        await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls.count(stage + "_CORRECT") == 1
    assert api.completed is None and api.output["failureReason"] == "INVALID_CANDIDATE"
    calls = list(provider.calls)
    with pytest.raises(ValueError, match="whole seconds"):
        await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == calls and data == original


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [500, "1000", True, None])
async def test_invalid_duration_marker_fails_before_models(value: Any) -> None:
    api, provider, data = FakeApi(), FakeProvider(), snapshot()
    data["shotDurationStepMs"] = value
    with pytest.raises(ValueError, match="unsupported shot duration step"):
        await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == [] and api.output == {}


@pytest.mark.asyncio
async def test_unmarked_historical_fractional_task_keeps_original_precision() -> None:
    api, provider, data = FakeApi(), Provider("VIDEO_SHOTS", enabled=False), snapshot()
    original = copy.deepcopy(data)
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert api.completed is not None
    assert api.completed["videoPlan"]["shots"][-1]["durationSeconds"] == 5.5
    assert data == original and "shotDurationStepMs" not in data
    assert not any(stage.endswith("_CORRECT") for stage in provider.calls)


@pytest.mark.parametrize("kind", ["FIELDS", "STRUCTURE"])
def test_half_second_repair_rejected_only_for_marked_tasks(kind: str) -> None:
    data = snapshot()
    data["strategyVersion"] = "2026-10-19-capacity-clips.6"
    plan = fixture()["document"]["videoPlan"]
    target = plan["shots"][-1]
    issue = finding(plan)
    issue.update(
        affectedShotIds=[target["id"]], affectedClipIds=["clip-b"], repairKind=kind
    )
    review = {"findings": [issue]}
    patch: dict[str, Any] = {
        "baseHash": fingerprint(plan),
        "issueIds": [issue["id"]],
        "fields": [],
        "ranges": [],
        "cueUpdates": [],
        "timingExplanation": "受控时长调整",
    }
    if kind == "FIELDS":
        patch["fields"] = [
            {
                **{key: None for key in RetimedShotFields.model_fields},
                "shotId": target["id"],
                "durationSeconds": 5.5,
            }
        ]
    else:
        clip = copy.deepcopy(plan["clips"][-1])
        new_shot = copy.deepcopy(target)
        new_shot.update(id="replacement-shot", durationSeconds=5.5)
        clip.update(id="replacement-clip", shotIds=["replacement-shot"])
        cue = plan["cues"][-1]
        parts = [{**part, "shotId": "replacement-shot"} for part in cue["parts"]]
        patch["ranges"] = [
            {
                "clipIds": ["clip-b"],
                "replacement": {
                    "clips": [clip],
                    "shots": [new_shot],
                    "cueParts": [{"cueId": cue["id"], "parts": parts}],
                },
                "scenes": [],
                "reason": "受控替换",
            }
        ]
    original = copy.deepcopy(plan)
    assert (
        apply_repair(plan, patch, review, data)["shots"][-1]["durationSeconds"] == 5.5
    )
    data["shotDurationStepMs"] = 1000
    with pytest.raises(ValueError, match="whole seconds"):
        apply_repair(plan, patch, review, data)
    bad = copy.deepcopy(plan)
    bad["shots"][-1]["durationSeconds"] = 5.5
    with pytest.raises(ValueError, match="whole seconds"):
        validate_plan(bad, data)
    assert plan == original
