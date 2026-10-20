from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from customized_production_runtime.video_pipeline import run_video
from customized_production_runtime.video_models import PromptMechanicalRecovery
from test_video_v2 import FakeApi, clean_audit, snapshot

CONTENT = "产品：@陶瓷杯。\n0–3秒：暖灰杯盖闭合，杯底硅胶圈稳稳留在杯底。\n3–5秒：保持归位画面。\n声音与画面文字安排\n屏显（0–5秒）：一杯清晨"


@pytest.mark.parametrize(
    "item",
    json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "packages/contracts/fixtures/customized-prompt-mechanical-recovery.json"
        ).read_text(encoding="utf-8")
    ),
)
def test_recovery_metadata_matches_typescript(item: dict[str, Any]) -> None:
    if item["valid"]:
        PromptMechanicalRecovery.model_validate(item["value"])
    else:
        with pytest.raises(ValueError):
            PromptMechanicalRecovery.model_validate(item["value"])


def review(broken: bool) -> dict[str, Any]:
    issue = {
        "id": "A1",
        "severity": "ERROR",
        "category": "COVERAGE",
        "title": "缺少归位信息",
        "impact": "需对齐分镜明确的归位状态",
        "evidence": [
            {"entity": "PROMPT", "id": "clip-b", "field": "content"},
            {"entity": "SHOT", "id": "shot-c", "field": "audio"},
            {
                "entity": "TIMING" if broken else "SHOT",
                "id": "clip-b" if broken else "shot-c",
                "field": "inventedField" if broken else "durationSeconds",
            },
        ],
        "affectedShotIds": ["shot-c"],
        "affectedClipIds": ["clip-b"],
        "suggestedFix": "补充已确认归位状态",
        "repairKind": "FIELDS",
    }
    return clean_audit() | {
        "findings": [issue],
        "promptEvidence": [
            {
                "issueId": "A1",
                "excerpt": "0–3秒：……暖灰杯盖" if broken else "暖灰杯盖闭合",
            },
            {"issueId": "A1", "excerpt": "3–5秒：……保持" if broken else "保持归位画面"},
            {"issueId": "A1", "excerpt": "杯底硅胶圈稳稳留在杯底"},
        ],
    }


class Provider:
    def __init__(
        self, corrected_valid: bool = True, erase_finding: bool = False
    ) -> None:
        self.calls: list[str] = []
        self.corrected_valid = corrected_valid
        self.erase_finding = erase_finding
        self.correction_issues: list[list[str]] = []

    async def generate(
        self,
        stage: str,
        model: str,
        schema: Any,
        context: dict[str, Any],
        instruction: str,
    ) -> Any:
        self.calls.append(stage)
        if stage in ("VIDEO_PROMPT", "VIDEO_PROMPT_REPAIR"):
            value = {
                "target": {"kind": "CLIP", "id": "clip-b"},
                "assetIds": ["cup"],
                "content": CONTENT,
            }
        elif stage == "VIDEO_REVIEW":
            value = review(True)
        elif stage == "VIDEO_REVIEW_CORRECT":
            self.correction_issues.append(context["mechanicalIssues"])
            value = review(not self.corrected_valid)
            if self.erase_finding:
                value.update(findings=[], promptEvidence=[])
        elif stage == "VIDEO_RECHECK":
            assert context["previousErrors"][0]["id"] == "A1"
            value = clean_audit() | {
                "promptEvidence": [],
                "severityChanges": [],
                "resolutions": [
                    {
                        "issueId": "A1",
                        "status": "RESOLVED",
                        "evidence": [
                            {"entity": "PROMPT", "id": "clip-b", "field": "content"}
                        ],
                        "explanation": "受控复核通过",
                    },
                ],
            }
        else:
            raise AssertionError(stage)
        return schema.model_validate(value)


def data() -> dict[str, Any]:
    value = snapshot()
    value.update(
        operation="PROMPT",
        promptWorkflowVersion=3,
        target={"kind": "CLIP", "id": "clip-b"},
    )
    return value


def explicit_round(api: FakeApi) -> None:
    """Expected API/Worker boundary; API transaction tests exercise the real archive implementation."""
    output = copy.deepcopy(api.output)
    previous = output.get("mechanicalRecovery", {})
    history = list(previous.get("history", []))
    history.append(
        {
            "epoch": previous.get("epoch", 0),
            "phase": "audit",
            "candidate": output["audit"],
            "correctedCandidate": output["auditCorrected"],
            "correctionCount": output["corrections"]["audit"],
        }
    )
    output["mechanicalRecovery"] = PromptMechanicalRecovery(
        version=1, epoch=previous.get("epoch", 0) + 1, phase="audit", history=history
    ).model_dump()
    output["audit"] = output.pop("auditCorrected")
    output["corrections"]["audit"] = 0
    output.pop("failureReason", None)
    api.output = output


@pytest.mark.asyncio
async def test_one_correction_gets_invalid_field_and_all_bad_quotes_then_keeps_business_repair() -> (
    None
):
    api, provider = FakeApi(), Provider()
    await run_video(api, provider, api.claim(data()))  # type: ignore[arg-type]
    issues = provider.correction_issues[0]
    assert any("TIMING:" in issue and "inventedField" in issue for issue in issues)
    assert any("promptEvidence[0]" in issue for issue in issues)
    assert any("promptEvidence[1]" in issue for issue in issues)
    assert provider.calls == [
        "VIDEO_PROMPT",
        "VIDEO_REVIEW",
        "VIDEO_REVIEW_CORRECT",
        "VIDEO_PROMPT_REPAIR",
        "VIDEO_RECHECK",
    ]
    assert api.completed is not None
    # Success checkpoints are reused without fresh review/creation.
    never = Provider()
    await run_video(api, never, api.claim(data()))  # type: ignore[arg-type]
    assert never.calls == []


@pytest.mark.asyncio
async def test_full_issue_list_is_not_cut_off_by_legacy_thousand_character_summary() -> (
    None
):
    class ManyErrors(Provider):
        async def generate(
            self,
            stage: str,
            model: str,
            schema: Any,
            context: dict[str, Any],
            instruction: str,
        ) -> Any:
            if stage == "VIDEO_REVIEW":
                self.calls.append(stage)
                value = review(True)
                value["findings"][0]["evidence"] = [
                    {
                        "entity": "TIMING",
                        "id": "clip-b",
                        "field": f"invalidField{index}",
                    }
                    for index in range(30)
                ]
                return schema.model_validate(value)
            if stage == "VIDEO_REVIEW_CORRECT":
                assert len(context["mechanicalError"]) == 1000
                assert any(
                    "invalidField29" in issue for issue in context["mechanicalIssues"]
                )
                assert any(
                    "promptEvidence[1]" in issue
                    for issue in context["mechanicalIssues"]
                )
                assert len(context["mechanicalIssues"]) == 32
            return await super().generate(stage, model, schema, context, instruction)

    api, provider = FakeApi(), ManyErrors()
    await run_video(api, provider, api.claim(data()))  # type: ignore[arg-type]
    assert (
        api.completed is not None and provider.calls.count("VIDEO_REVIEW_CORRECT") == 1
    )


@pytest.mark.asyncio
async def test_invalid_cached_correction_is_not_rebought_until_explicit_round_and_history_is_retained() -> (
    None
):
    api, provider = FakeApi(), Provider(corrected_valid=False)
    with pytest.raises(ValueError, match="current prompt.content|actual field"):
        await run_video(api, provider, api.claim(data()))  # type: ignore[arg-type]
    cached = copy.deepcopy(api.output)
    for _ in range(2):
        no_auto = Provider()
        with pytest.raises(ValueError):
            await run_video(api, no_auto, api.claim(data()))  # type: ignore[arg-type]
        assert no_auto.calls == []
    explicit_round(api)
    assert (
        api.output["mechanicalRecovery"]["history"][0]["correctedCandidate"]
        == cached["auditCorrected"]
    )
    # Even if the task lifetime's other correction budget is exhausted, this explicit
    # round permits exactly one correction for this phase and no automatic extra loop.
    api.output["corrections"]["promptCandidate"] = 2
    again = Provider(corrected_valid=False)
    with pytest.raises(ValueError):
        await run_video(api, again, api.claim(data()))  # type: ignore[arg-type]
    assert again.calls == ["VIDEO_REVIEW_CORRECT"]
    assert api.output["corrections"]["audit"] == 1
    assert len(api.output["mechanicalRecovery"]["history"]) == 1
    no_auto = Provider()
    with pytest.raises(ValueError):
        await run_video(api, no_auto, api.claim(data()))  # type: ignore[arg-type]
    assert no_auto.calls == []
    explicit_round(api)
    fixed = Provider()
    await run_video(api, fixed, api.claim(data()))  # type: ignore[arg-type]
    assert fixed.calls == [
        "VIDEO_REVIEW_CORRECT",
        "VIDEO_PROMPT_REPAIR",
        "VIDEO_RECHECK",
    ]
    assert (
        api.completed is not None
        and len(api.output["mechanicalRecovery"]["history"]) == 2
    )
    assert (
        api.output["mechanicalRecovery"]["history"][0]["correctedCandidate"]
        == cached["auditCorrected"]
    )


@pytest.mark.asyncio
async def test_structural_correction_cannot_erase_real_error_to_pass() -> None:
    api, provider = FakeApi(), Provider(erase_finding=True)
    with pytest.raises(ValueError, match="preserve original business findings"):
        await run_video(api, provider, api.claim(data()))  # type: ignore[arg-type]
    assert provider.calls == ["VIDEO_PROMPT", "VIDEO_REVIEW", "VIDEO_REVIEW_CORRECT"]
    assert api.completed is None
    assert api.output["audit"]["findings"][0]["severity"] == "ERROR"


@pytest.mark.asyncio
async def test_recheck_phase_has_one_explicit_correction_without_regenerating_successful_content() -> (
    None
):
    api, first = FakeApi(), Provider()
    await run_video(api, first, api.claim(data()))  # type: ignore[arg-type]
    original = copy.deepcopy(api.output)
    bad = copy.deepcopy(api.output["recheck"])
    bad["resolutions"][0]["evidence"][0]["field"] = "inventedField"
    api.output.update(
        recheck=bad,
        mechanicalRecovery={
            "version": 1,
            "epoch": 1,
            "phase": "recheck",
            "history": [],
        },
    )
    api.output["corrections"]["recheck"] = 0

    class Recheck(Provider):
        async def generate(
            self,
            stage: str,
            model: str,
            schema: Any,
            context: dict[str, Any],
            instruction: str,
        ) -> Any:
            self.calls.append(stage)
            assert stage == "VIDEO_RECHECK_CORRECT"
            assert any(
                "inventedField" in issue for issue in context["mechanicalIssues"]
            )
            return schema.model_validate(original["recheck"])

    provider = Recheck()
    await run_video(api, provider, api.claim(data()))  # type: ignore[arg-type]
    assert provider.calls == ["VIDEO_RECHECK_CORRECT"]
    assert api.completed == original["final"]
