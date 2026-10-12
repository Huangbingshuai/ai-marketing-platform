import asyncio
from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
from uuid import uuid4
import pytest
from customized_storyboard.models import (
    Asset,
    AssetCatalog,
    Concepts,
    Concept,
    Story,
    ShotChunk,
    Shot,
    Script,
    Review,
    Repair,
    Beat,
)
from customized_storyboard.pipeline import Pipeline


def inputs(count=3, duration=30, product="陶瓷杯"):
    return {
        "source": {"artifactId": str(uuid4()), "revision": 1, "fingerprint": "a" * 64},
        "scriptIds": [str(uuid4()) for _ in range(count)],
        "brief": {
            "productName": product,
            "sellingPoints": ["有文档支持的特点"],
            "productAppearance": "待设计",
            "avoidedElements": "不得宣称获奖",
        },
        "settings": {
            "targetDurationSeconds": duration,
            "variantCount": count,
            "structureMode": "AI",
            "structure": "",
            "instructions": "",
        },
        "existingConcepts": [],
        "models": {"creative": "controlled-pro", "detail": "controlled-turbo"},
        "brandReferences": [{"url": "must-not-reach-model"}],
    }


def shot(id="s1", duration=30):
    return {
        "id": id,
        "title": "产品细节",
        "shotType": "特写",
        "cameraMovement": "缓慢推进",
        "durationSeconds": duration,
        "visual": "自然侧光中展示产品已知外观",
        "dialogues": [],
        "audio": "环境声",
        "continuity": "产品轮廓保持一致",
        "assetRequirements": {
            "characters": {"state": "NONE", "items": []},
            "products": {
                "state": "DEFINED",
                "items": [{"assetId": "product", "description": "保持正面朝向"}],
            },
            "scenes": {"state": "NONE", "items": []},
        },
    }


class FakeApi:
    def __init__(self):
        self.saved = {}
        self.published = {}
        self.finished = False
        self.first_published = asyncio.Event()

    async def call(self, method, path, value=None):
        if path == "steps":
            key = value["nodeId"], value["scriptId"]
            old = self.saved.get(key)
            if old and old["status"] in {"SUCCEEDED", "SKIPPED"}:
                return {}
            if old and value["output"] is None:
                value = {**value, "output": old["output"]}
            self.saved[key] = deepcopy(value)
        elif path == "scripts":
            script = Script.model_validate(value["script"])
            self.published[script.id] = script
            self.first_published.set()
        elif path == "finish":
            self.finished = True
        return {}


class ControlledProvider:
    def __init__(self):
        self.calls = Counter()
        self.fail_id = None
        self.block_id = None
        self.release = asyncio.Event()
        self.review_errors = False
        self.recheck_errors = False
        self.fail_chunk = None

    async def generate(self, stage, model, result, context, instruction):
        assert "brandReferences" not in context
        assert "must-not-reach-model" not in json.dumps(context)
        self.calls[stage] += 1
        target = context["settings"]["targetDurationSeconds"]
        if stage == "CONCEPT":
            return Concepts(
                concepts=[
                    Concept(
                        scriptId=id,
                        name=f"方案{i + 1}",
                        synopsis=f"不同叙事事件{i + 1}",
                        productFocus="已有特点",
                        structure="日常",
                        difference=f"切入{i + 1}",
                    )
                    for i, id in enumerate(context["scriptIds"])
                ]
            )
        if stage == "STORY":
            sid = context["concept"]["scriptId"]
            if sid == self.block_id:
                await self.release.wait()
            if sid == self.fail_id:
                raise TimeoutError()
            lengths = [30] * (target // 30) + ([target % 30] if target % 30 else [])
            return Story(
                title=sid,
                content="完整故事",
                opening="开场",
                development="发展",
                ending="收束",
                dialoguePlan="无对白",
                beats=[
                    Beat(id=f"b{i}", content=f"故事段落{i}", durationSeconds=n)
                    for i, n in enumerate(lengths)
                ],
            )
        if stage == "ASSETS":
            return AssetCatalog(
                assets=[
                    Asset(
                        id="product",
                        kind="products",
                        name=context["brief"]["productName"],
                        description="外观待设计；不添加未知事实",
                    )
                ]
            )
        if stage == "SHOTS":
            if self.fail_chunk == context["beatIndex"]:
                raise TimeoutError()
            return ShotChunk(
                shots=[
                    Shot.model_validate(
                        shot(
                            f"s{context['beatIndex']}",
                            context["beat"]["durationSeconds"],
                        )
                    )
                ]
            )
        if stage in {"REVIEW", "RECHECK"}:
            bad = self.review_errors if stage == "REVIEW" else self.recheck_errors
            return Review(
                summary="核对完毕",
                findings=[
                    {
                        "severity": "ERROR",
                        "category": "FACT",
                        "shotIds": [context["script"]["shots"][0]["id"]],
                        "message": "缺少事实依据",
                        "evidence": "简报未提供",
                        "suggestion": "移除未知规格",
                    }
                ]
                if bad
                else [],
            )
        if stage == "REPAIR":
            return Repair(
                script=Script.model_validate(context["script"]),
                reason="删除未知规格",
                changes=[
                    {"before": "未知规格", "after": "已知事实", "reason": "简报依据"}
                ],
            )
        raise AssertionError(stage)


@pytest.mark.parametrize(
    "count,duration,product",
    [
        (1, 15, "燕麦片"),
        (3, 30, "保湿霜"),
        (5, 180, "充电器"),
        (3, 30, "落地灯"),
        (1, 30, "预约软件"),
    ],
)
async def test_complete_scripts(count, duration, product):
    api, provider = FakeApi(), ControlledProvider()
    await Pipeline(api, provider, inputs(count, duration, product), [], []).run()
    assert len(api.published) == count and api.finished
    assert provider.calls["REVIEW"] == count
    assert provider.calls["REPAIR"] == 0
    assert all(
        sum(s.durationSeconds for s in script.shots) == duration
        for script in api.published.values()
    )


async def test_first_publication_does_not_wait_for_other_scripts():
    api, provider, value = FakeApi(), ControlledProvider(), inputs(3)
    provider.block_id = value["scriptIds"][1]
    task = asyncio.create_task(Pipeline(api, provider, value, [], []).run())
    await asyncio.wait_for(api.first_published.wait(), 2)
    assert api.published and not api.finished
    provider.release.set()
    await task
    assert len(api.published) == 3


async def test_partial_resume_keeps_published_scripts_and_shared_plan():
    api, provider, value = FakeApi(), ControlledProvider(), inputs(3)
    provider.fail_id = value["scriptIds"][1]
    await Pipeline(api, provider, value, [], []).run()
    assert len(api.published) == 2
    previous = deepcopy(api.published)
    provider.fail_id = None
    await Pipeline(
        api, provider, value, list(api.saved.values()), list(api.published)
    ).run()
    assert len(api.published) == 3 and provider.calls["CONCEPT"] == 1
    assert all(api.published[id] == script for id, script in previous.items())


async def test_long_story_resumes_validated_chunks_without_rebilling_them():
    api, provider, value = FakeApi(), ControlledProvider(), inputs(1, 180)
    provider.fail_chunk = 2
    await Pipeline(api, provider, value, [], []).run()
    assert not api.published
    provider.fail_chunk = None
    await Pipeline(api, provider, value, list(api.saved.values()), []).run()
    assert provider.calls["SHOTS"] == 7 and len(api.published) == 1


async def test_unresolved_facts_never_publish_or_repeat_repair():
    api, provider, value = FakeApi(), ControlledProvider(), inputs(1)
    provider.review_errors = provider.recheck_errors = True
    await Pipeline(api, provider, value, [], []).run()
    assert not api.published
    await Pipeline(api, provider, value, list(api.saved.values()), []).run()
    assert (
        not api.published
        and provider.calls["REPAIR"] == 1
        and provider.calls["RECHECK"] == 1
    )


def test_contract_schema_and_python_stay_in_sync():
    root = Path(__file__).resolve().parents[3]
    schema = json.loads(
        (
            root / "packages/contracts/schemas/customized-storyboard-script.schema.json"
        ).read_text(encoding="utf-8")
    )
    assert schema == Script.model_json_schema()


@pytest.mark.parametrize(
    "change",
    [
        lambda x: x["shots"][0].update(durationSeconds=0),
        lambda x: x["shots"][0]["assetRequirements"]["products"]["items"][0].update(
            assetId="unknown"
        ),
        lambda x: x["shots"].append(deepcopy(x["shots"][0])),
    ],
)
def test_invalid_scripts(change):
    value = {
        "id": "script",
        "name": "名字",
        "synopsis": "故事",
        "structure": "日常",
        "productFocus": "特点",
        "assets": [
            {"id": "product", "kind": "products", "name": "产品", "description": "描述"}
        ],
        "shots": [shot()],
    }
    change(value)
    with pytest.raises(ValueError):
        Script.model_validate(value)
