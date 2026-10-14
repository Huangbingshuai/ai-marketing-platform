from copy import deepcopy
import json
from pathlib import Path
from typing import Any

import pytest

from customized_storyboard.models import Concept, Concepts, Story
from customized_storyboard.pipeline import Pipeline
from customized_storyboard.screenplay import ScreenplayDraft, screenplay_issues
from test_story_only import Api


def draft(duration: int = 30) -> dict[str, Any]:
    count = max(1, duration // 30)
    return {"title": "候车时刻", "opening": "候车", "development": "连接设备", "ending": "离开",
        "dialoguePlan": "需要时对白", "beats": [
            {"id": f"b{i}", "content": f"S{i:02d}｜内景 · 候车区｜傍晚\n\n周越翻开电脑，确认修改后的方案。\n\n周越：（轻声）还差一页。", "durationSeconds": duration / count}
            for i in range(1, count + 1)]}


class Provider:
    def __init__(self, *, duration: int = 30, repair: bool = False, bad_format: bool = False) -> None:
        self.calls: list[str] = []
        self.duration, self.repair, self.bad_format = duration, repair, bad_format

    async def generate(self, stage: str, model: str, schema: Any, context: Any, instruction: str) -> Any:
        self.calls.append(stage)
        if stage == "STORY":
            value = draft(self.duration)
            if self.bad_format and self.calls.count("STORY") == 1:
                value["beats"][0]["content"] = "一段概述"
            return schema.model_validate(value)
        if stage in {"REVIEW", "RECHECK"}:
            assert "content" not in context["story"]  # Full text appears once in scenes.
            assert context["story"]["beats"][0]["content"].startswith("S01")
            return schema.model_validate({"summary": "核对场次行动与时长", "findings": [
                {"severity": "ERROR", "category": "STORY", "shotIds": [], "message": "动作未展开", "evidence": "第一场", "suggestion": "展开互动"}
            ] if stage == "REVIEW" and self.repair else []})
        assert stage == "REPAIR"
        assert "content" not in context["story"]
        value = draft(self.duration)
        value["beats"][0]["content"] += "\n\n她合上电脑，把线收进包内。"
        return schema.model_validate({"story": value, "concept": context["concept"]})


def pipeline(api: Api, provider: Provider, checkpoints: list[Any] | None = None) -> Pipeline:
    return Pipeline(api, provider, {"outputMode": "STORY_ONLY", "storyFormat": "SCREENPLAY_V1", "brief": {},
        "settings": {"targetDurationSeconds": provider.duration}, "existingConcepts": [],
        "models": {"creative": "controlled", "detail": "controlled"}}, checkpoints or [], [])  # type: ignore[arg-type]


def concept() -> Concept:
    return Concept(scriptId="s", name="候车时刻", synopsis="候车时修改方案", productFocus="便携", structure="候车、离开", difference="候车叙事")


@pytest.mark.parametrize("duration", [15, 30, 180])
@pytest.mark.asyncio
async def test_full_scene_text_is_the_published_body(duration: int) -> None:
    api, provider = Api(), Provider(duration=duration)
    c = concept()
    await pipeline(api, provider).script(c, Concepts(concepts=[c]))
    result = api.calls[-1][1]["script"]
    story = Story.model_validate(result["story"])
    assert story.content == "\n\n".join(b.content for b in story.beats)
    assert story.content != result["synopsis"]
    assert not screenplay_issues(story, duration)
    assert provider.calls == ["STORY", "REVIEW"]
    assert result["shots"] == [] and result["assets"] == []


@pytest.mark.asyncio
async def test_targeted_repair_rebuilds_body_and_rechecks_without_duplicate_text() -> None:
    api, provider = Api(), Provider(repair=True)
    c = concept()
    await pipeline(api, provider).script(c, Concepts(concepts=[c]))
    result = api.calls[-1][1]["script"]
    assert result["story"]["content"].endswith("她合上电脑，把线收进包内。")
    assert provider.calls == ["STORY", "REVIEW", "REPAIR", "RECHECK"]


@pytest.mark.asyncio
async def test_format_correction_is_bounded_and_persisted() -> None:
    api, provider = Api(), Provider(bad_format=True)
    c = concept()
    await pipeline(api, provider).script(c, Concepts(concepts=[c]))
    assert provider.calls == ["STORY", "STORY", "REVIEW"]
    checkpoint = next(value for path, value in api.calls if path == "steps" and isinstance(value.get("output"), dict) and value["output"].get("correctionComplete"))
    saved = deepcopy(checkpoint)
    saved["output"]["rejectedStory"]["beats"][0]["content"] = "仍然只有概述"
    resumed = Provider()
    with pytest.raises(ValueError, match="correction exhausted"):
        from customized_storyboard.screenplay import generate_screenplay
        await generate_screenplay(pipeline(Api(), resumed, [saved]), "s", {})
    assert resumed.calls == []


def test_schema_matches_shared_contract_and_rejects_disjoint_body() -> None:
    root = Path(__file__).resolve().parents[3]
    assert json.loads((root / "packages/contracts/schemas/customized-screenplay-draft.schema.json").read_text(encoding="utf-8")) == ScreenplayDraft.model_json_schema()
    story = ScreenplayDraft.model_validate(draft()).story()
    story.content = "另一个概述"
    assert screenplay_issues(story, 30)[0]["code"] == "BODY_SCENE_MISMATCH"


@pytest.mark.asyncio
async def test_resume_reuses_full_body_and_completed_review_without_new_model_calls() -> None:
    api, provider = Api(), Provider()
    c = concept()
    await pipeline(api, provider).script(c, Concepts(concepts=[c]))
    checkpoints = [value for path, value in api.calls if path == "steps" and value["status"] in {"SUCCEEDED", "SKIPPED"}]
    resumed_api, resumed_provider = Api(), Provider()
    await pipeline(resumed_api, resumed_provider, checkpoints).script(c, Concepts(concepts=[c]))
    assert resumed_provider.calls == []
    assert resumed_api.calls[-1][1]["script"]["story"] == api.calls[-1][1]["script"]["story"]


@pytest.mark.asyncio
async def test_recheck_error_preserves_repair_without_publishing_or_rebuying_it() -> None:
    class FailingRecheck(Provider):
        async def generate(self, stage: str, model: str, schema: Any, context: Any, instruction: str) -> Any:
            if stage == "RECHECK":
                self.calls.append(stage)
                return schema.model_validate({"summary": "仍未修复", "findings": [{"severity": "ERROR", "category": "FACT", "shotIds": [], "message": "无依据", "evidence": "第一场", "suggestion": "移除宣称"}]})
            return await super().generate(stage, model, schema, context, instruction)
    api, provider = Api(), FailingRecheck(repair=True)
    c = concept()
    with pytest.raises(ValueError, match="review remains incomplete"):
        await pipeline(api, provider).script(c, Concepts(concepts=[c]))
    assert not any(path == "scripts" for path, _ in api.calls)
    latest = {}
    for path, value in api.calls:
        if path == "steps" and value["output"] is not None:
            latest[value["nodeId"]] = value
    resumed = FailingRecheck(repair=True)
    with pytest.raises(ValueError, match="review remains incomplete"):
        await pipeline(Api(), resumed, list(latest.values())).script(c, Concepts(concepts=[c]))
    assert resumed.calls == []
