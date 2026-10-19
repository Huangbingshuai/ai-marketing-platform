"""Controlled review decisions verify orchestration, not a real model's semantics."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from customized_production_runtime.video_pipeline import run_video
from customized_production_runtime.video_prompt import reference_header
from test_video_v2 import FakeApi, FakeProvider, clean_audit, snapshot

MARKER = "【表达条件核对·V1】"
GOAL = "人物用一只手独立持杯并按键开启杯盖，另一只手继续原有出门动作，不辅助杯体。"
FIXED = "人物右手独立持杯，右手拇指按下按键开启杯盖，左手继续原有出门动作，全程不接触或支撑杯体。"
CASES = {
    "independent": (FIXED, "右手持杯，左手继续出门动作", "展示独立开启", None),
    "assisted-during": (
        "右手拿杯并按键，同时左手扶住杯身完成开启。",
        "双手持杯",
        "已展示独立开启",
        "ERROR",
    ),
    "support-after": (
        "右手独立持杯按键，杯盖开启完成后左手才接触杯体，双手自然持杯离开。",
        "双手持杯",
        "展示独立开启后自然持杯",
        None,
    ),
    "not-requested": (
        "人物双手自然拿起杯子，放入随行袋后离开。",
        "双手离开杯体",
        "自然出门",
        None,
    ),
    "ambiguous-order": (
        "人物右手按键，左手自然靠近杯身，镜头未说明是否接触及先后。",
        "右手持杯",
        "开启与出门",
        "WARNING",
    ),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("version", [2, "1", True])
async def test_unknown_or_invalid_policy_fails_before_model_calls(version: Any) -> None:
    api, provider, data = FakeApi(), FakeProvider(), snapshot()
    data["shotBenefitPolicyVersion"] = version
    with pytest.raises(ValueError, match="unsupported shot benefit policy"):
        await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == [] and api.output == {} and api.completed is None


def input_for(case: str, enabled: bool = True) -> dict[str, Any]:
    data = snapshot()
    data["strategyVersion"] = "2026-10-19-capacity-clips.7"
    if enabled:
        data["shotBenefitPolicyVersion"] = 1
    data["brief"]["sellingPoints"] = ["按键翻盖，可单手开启杯盖"]
    units = data["sourceUnits"]
    units[0]["text"] = "人物拿起杯子收拾出门。" if case == "not-requested" else GOAL
    cursor = 0
    for unit in units:
        unit["start"], unit["end"] = cursor, cursor + len(unit["text"])
        cursor = unit["end"] + 2
    data["script"]["story"]["content"] = "\n\n".join(u["text"] for u in units)
    return data


class ControlledBenefitProvider(FakeProvider):
    def __init__(
        self, case: str, *, enabled: bool = True, unresolved: bool = False
    ) -> None:
        super().__init__()
        self.case = case
        self.enabled = enabled
        self.unresolved = unresolved
        self.instructions: dict[str, str] = {}
        self.review_input: dict[str, Any] | None = None

    async def generate(
        self,
        stage: str,
        model: str,
        schema: Any,
        context: dict[str, Any],
        instruction: str,
    ) -> Any:
        self.instructions[stage] = instruction
        assert (MARKER in instruction) == self.enabled
        if stage == "VIDEO_DIRECTOR":
            value = (
                await super().generate(stage, model, schema, context, instruction)
            ).model_dump()
            value["events"][0]["sourceRefs"] = [
                context["immutableSourceUnits"][0]["fullReference"]
            ]
            return schema.model_validate(value)
        if stage == "VIDEO_SHOTS":
            value = (
                await super().generate(stage, model, schema, context, instruction)
            ).model_dump()
            visual, end, information, _ = CASES[self.case]
            value["shots"][0].update(
                visual=visual, endState=end, information=information
            )
            return schema.model_validate(value)
        self.calls.append(stage)
        if stage == "VIDEO_REVIEW":
            self.review_input = copy.deepcopy(context)
            value = clean_audit()
            severity = CASES[self.case][3]
            if severity:
                shot, clip = (
                    context["result"]["shots"][0],
                    context["result"]["clips"][0],
                )
                value["findings"] = [
                    {
                        "id": "condition-1",
                        "severity": severity,
                        "category": "COVERAGE",
                        "title": "核对当前动作的表达条件",
                        "impact": "核对原稿要求与实际辅助时机，不以观看结论代替画面",
                        "evidence": [
                            {
                                "entity": "SOURCE",
                                "id": context["immutableSourceUnits"][0]["id"],
                                "field": "text",
                            },
                            {"entity": "SHOT", "id": shot["id"], "field": "visual"},
                        ],
                        "affectedShotIds": [shot["id"]],
                        "affectedClipIds": [clip["id"]],
                        "suggestedFix": "明确辅助时机并保持已确认要求",
                        "repairKind": "FIELDS",
                    }
                ]
            return schema.model_validate(value)
        if stage == "VIDEO_REPAIR":
            shot = context["result"]["shots"][0]
            fields = {
                key: None
                for key in (
                    "title",
                    "shotType",
                    "cameraMovement",
                    "visual",
                    "audio",
                    "atmosphere",
                    "information",
                    "framing",
                    "angle",
                    "startState",
                    "endState",
                    "bindings",
                )
            }
            patch: dict[str, Any] = {
                **fields,
                "shotId": shot["id"],
                "visual": FIXED,
                "endState": "右手持杯，左手继续原有出门动作",
                "information": "独立完成开启",
            }
            return schema.model_validate(
                {
                    "baseHash": context["candidateHash"],
                    "issueIds": ["condition-1"],
                    "fields": [patch],
                    "ranges": [],
                    "timingExplanation": "只修改动作和对应说明，时间不变",
                    "cueUpdates": [],
                }
            )
        if stage == "VIDEO_RECHECK":
            value = clean_audit()
            shot = context["result"]["shots"][0]
            value["severityChanges"] = []
            value["resolutions"] = [
                {
                    "issueId": "condition-1",
                    "status": "UNRESOLVED" if self.unresolved else "RESOLVED",
                    "evidence": [
                        {"entity": "SHOT", "id": shot["id"], "field": "visual"}
                    ],
                    "explanation": "受控独立核对修改后的实际动作",
                }
            ]
            return schema.model_validate(value)
        raise AssertionError(stage)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", list(CASES))
async def test_conditions_are_reviewed_in_existing_calls_without_rewriting_normal_content(
    case: str,
) -> None:
    api, provider, data = FakeApi(), ControlledBenefitProvider(case), input_for(case)
    original = copy.deepcopy(data)
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert api.completed is not None and data == original
    normal = ["VIDEO_DIRECTOR", "VIDEO_SHOTS", "VIDEO_REVIEW"]
    assert provider.calls == normal + (
        ["VIDEO_REPAIR", "VIDEO_RECHECK"] if case == "assisted-during" else []
    )
    assert provider.review_input is not None
    actual = provider.review_input["result"]["shots"][0]
    assert actual["visual"] == CASES[case][0]
    assert actual["information"] == CASES[case][2]
    if case == "assisted-during":
        before, after = api.output["value"]["videoPlan"], api.completed["videoPlan"]
        assert before["shots"][0]["information"] == "已展示独立开启"
        assert after["shots"][0]["visual"] == FIXED
        assert after["shots"][1:] == before["shots"][1:]
        assert after["cues"] == before["cues"]
        assert [s["durationSeconds"] for s in after["shots"]] == [
            s["durationSeconds"] for s in before["shots"]
        ]
        assert [s["id"] for s in after["shots"]] == [s["id"] for s in before["shots"]]
    else:
        assert api.completed["videoPlan"]["shots"][0]["visual"] == CASES[case][0]
    calls = provider.calls.copy()
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == calls


@pytest.mark.asyncio
async def test_unresolved_independent_recheck_does_not_complete_or_buy_another_repair() -> (
    None
):
    api, provider, data = (
        FakeApi(),
        ControlledBenefitProvider("assisted-during", unresolved=True),
        input_for("assisted-during"),
    )
    with pytest.raises(ValueError, match="recheck unresolved"):
        await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert api.completed is None and api.output["failureReason"] == "REVIEW_UNRESOLVED"
    calls = provider.calls.copy()
    with pytest.raises(ValueError):
        await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert provider.calls == calls and provider.calls.count("VIDEO_REPAIR") == 1


@pytest.mark.asyncio
async def test_unmarked_historical_snapshot_never_receives_new_guidance_or_is_rewritten() -> (
    None
):
    api, provider, data = (
        FakeApi(),
        ControlledBenefitProvider("independent", enabled=False),
        input_for("independent", enabled=False),
    )
    original = copy.deepcopy(data)
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert data == original and "shotBenefitPolicyVersion" not in data
    assert all(MARKER not in value for value in provider.instructions.values())


@pytest.mark.asyncio
async def test_shot_policy_is_not_applied_to_a_prompt_task_even_if_present_in_its_snapshot() -> (
    None
):
    api, data = FakeApi(), snapshot()
    data.update(
        operation="PROMPT",
        promptWorkflowVersion=3,
        shotBenefitPolicyVersion=1,
        strategyVersion="2026-10-19-capacity-clips.7",
        target={"kind": "CLIP", "id": "clip-b"},
    )

    class PromptProvider:
        def __init__(self) -> None:
            self.calls: list[str] = []

        async def generate(
            self,
            stage: str,
            model: str,
            schema: Any,
            context: dict[str, Any],
            instruction: str,
        ) -> Any:
            self.calls.append(stage)
            assert MARKER not in instruction
            if stage == "VIDEO_PROMPT":
                asset = context["assets"][0]
                text = (
                    reference_header([asset])
                    + "\n"
                    + "\n".join(
                        f"{w['startSeconds']}–{w['endSeconds']}秒：@{asset['name']}保持原有画面。"
                        for w in context["timeWindows"]
                    )
                )
                text += "\n声音与画面文字安排\n" + "\n".join(
                    c["sourceText"] for c in context["cues"]
                )
                return schema.model_validate(
                    {
                        "target": context["target"],
                        "content": text,
                        "assetIds": [asset["id"]],
                    }
                )
            if stage == "VIDEO_REVIEW":
                return schema.model_validate({**clean_audit(), "promptEvidence": []})
            raise AssertionError(stage)

    provider = PromptProvider()
    await run_video(api, provider, api.claim(data))  # type: ignore[arg-type]
    assert api.completed is not None and provider.calls == [
        "VIDEO_PROMPT",
        "VIDEO_REVIEW",
    ]
