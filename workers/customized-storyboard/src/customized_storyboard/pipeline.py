from __future__ import annotations
import asyncio
import logging
from typing import Any, TypeVar
from pydantic import BaseModel
from ai_runtime.http import InternalApiError
from ai_runtime.responses import ProviderError
from .api import Api
from .provider import Provider
from .models import (
    AssetCatalog,
    Concepts,
    Concept,
    Story,
    Shot,
    ShotChunk,
    Script,
    Review,
    Repair,
    Beat,
)

T = TypeVar("T", bound=BaseModel)


def group_shot_beats(beats: list[Beat]) -> list[Beat]:
    """Batch adjacent story beats without changing their order or duration."""
    groups: list[Beat] = []
    for beat in beats:
        if (
            groups
            and groups[-1].durationSeconds + beat.durationSeconds <= 30
            and len(groups[-1].content) + len(beat.content) + 2 <= 20000
        ):
            previous = groups[-1]
            groups[-1] = Beat(
                id=previous.id,
                content=previous.content + "\n\n" + beat.content,
                durationSeconds=previous.durationSeconds + beat.durationSeconds,
            )
        else:
            groups.append(beat.model_copy())
    return groups


class Pipeline:
    def __init__(
        self,
        api: Api,
        provider: Provider,
        value: dict[str, Any],
        checkpoints: list[dict[str, Any]],
        completed: list[str],
        retry_script_ids: list[str] | None = None,
    ) -> None:
        self.api, self.provider, self.input = api, provider, value
        self.checkpoints = {(s["nodeId"], s["scriptId"]): s for s in checkpoints}
        self.completed = set(completed)
        self.retry_script_ids = (
            set(retry_script_ids) if retry_script_ids is not None else None
        )
        # Brand references remain frozen on API; never feed images or opaque refs to a model.
        self.context = {k: value[k] for k in ("brief", "settings", "existingConcepts")}

    async def heartbeat(self) -> None:
        while True:
            await asyncio.sleep(20)
            await self.api.call("PUT", "heartbeat")

    async def step(
        self,
        node: str,
        script: str,
        status: str,
        output: Any = None,
        error: str | None = None,
    ) -> None:
        await self.api.call(
            "PUT",
            "steps",
            {
                "nodeId": node,
                "scriptId": script,
                "status": status,
                "output": output,
                "errorMessage": error,
            },
        )
        if output is not None or status in {"SUCCEEDED", "SKIPPED"}:
            self.checkpoints[node, script] = {"output": output, "status": status}

    async def model(
        self,
        stage: str,
        schema: type[T],
        context: dict[str, Any],
        instruction: str,
        *,
        detail: bool = False,
    ) -> T:
        return await self.provider.generate(
            stage,
            self.input["models"]["detail" if detail else "creative"],
            schema,
            {**self.context, **context},
            instruction,
        )

    async def generate(
        self,
        node: str,
        script: str,
        schema: type[T],
        context: dict[str, Any],
        instruction: str,
        *,
        detail: bool = False,
    ) -> T:
        saved = self.checkpoints.get((node, script))
        if saved and saved["status"] in {"SUCCEEDED", "SKIPPED"}:
            return schema.model_validate(saved["output"])
        await self.step(node, script, "RUNNING")
        try:
            result = await self.model(node, schema, context, instruction, detail=detail)
            if isinstance(result, Concepts) and sorted(
                c.scriptId for c in result.concepts
            ) != sorted(self.input["scriptIds"]):
                raise ValueError("concept identity mismatch")
            if isinstance(result, Story) and (
                abs(
                    sum(b.durationSeconds for b in result.beats)
                    - self.input["settings"]["targetDurationSeconds"]
                )
                > 1
                or any(b.durationSeconds > 30 for b in result.beats)
                or len({b.id for b in result.beats}) != len(result.beats)
            ):
                raise ValueError("invalid story segments")
            if isinstance(result, AssetCatalog) and (
                len({a.id for a in result.assets}) != len(result.assets)
                or not any(a.kind == "products" for a in result.assets)
            ):
                raise ValueError("invalid asset catalog")
            if isinstance(result, Review) and any(
                any(
                    s not in {shot["id"] for shot in context["script"]["shots"]}
                    for s in f.shotIds
                )
                for f in result.findings
            ):
                raise ValueError("review references unknown shots")
            await self.step(node, script, "SUCCEEDED", result.model_dump())
            return result
        except Exception:
            await self.step(
                node,
                script,
                "FAILED",
                error="本阶段生成未完成，可重试恢复；已完成的方案会保留。",
            )
            raise

    async def run(self) -> None:
        if ("SNAPSHOT", "") not in self.checkpoints:
            await self.step(
                "SNAPSHOT",
                "",
                "SUCCEEDED",
                {
                    "source": self.input["source"],
                    "brief": self.input["brief"],
                    "settings": self.input["settings"],
                },
            )
        concepts = await self.generate(
            "CONCEPT",
            "",
            Concepts,
            {"scriptIds": self.input["scriptIds"]},
            "为给定每个 scriptId 规划一个完整视频方案，数量准确。联合考虑全部方案与已有方案，写清真实差异，不只改名字和镜头顺序。",
        )
        if sorted(c.scriptId for c in concepts.concepts) != sorted(
            self.input["scriptIds"]
        ):
            raise ValueError("concept identity mismatch")
        pending = [
            c
            for c in concepts.concepts
            if c.scriptId not in self.completed
            and (self.retry_script_ids is None or c.scriptId in self.retry_script_ids)
        ]
        outcomes = await asyncio.gather(
            *(self.script(c, concepts) for c in pending),
            return_exceptions=True,
        )
        for outcome in outcomes:
            if isinstance(outcome, InternalApiError):
                raise outcome
            if isinstance(outcome, BaseException):
                logging.warning("script incomplete type=%s", type(outcome).__name__)
        retry_ids = [
            c.scriptId
            for c, outcome in zip(pending, outcomes)
            if isinstance(outcome, ProviderError) and outcome.retryable
        ]
        await self.api.call(
            "POST",
            "finish",
            {"retryable": bool(retry_ids), "retryScriptIds": retry_ids},
        )

    def other_concepts(self, concepts: Concepts, sid: str) -> dict[str, Any]:
        return {
            "concepts": [c.model_dump() for c in concepts.concepts if c.scriptId != sid]
        }

    async def script(self, concept: Concept, concepts: Concepts) -> None:
        sid = concept.scriptId
        stage = "STORY"
        try:
            story = await self.generate(
                "STORY",
                sid,
                Story,
                {
                    "concept": concept.model_dump(),
                    "otherConcepts": self.other_concepts(concepts, sid),
                },
                "为本方案写完整故事，包含开场、发展、收束与对白安排；按连续叙事段落分 beats，每段不超过30秒，所有段落时长之和等于目标时长。",
            )
            target = self.input["settings"]["targetDurationSeconds"]
            if (
                abs(sum(b.durationSeconds for b in story.beats) - target) > 1
                or any(b.durationSeconds > 30 for b in story.beats)
                or len({b.id for b in story.beats}) != len(story.beats)
            ):
                raise ValueError("invalid story segments")
            stage = "ASSETS"
            assets = await self.generate(
                "ASSETS",
                sid,
                AssetCatalog,
                {"story": story.model_dump()},
                "从完整故事整理全部人物、产品与场景文字定义。至少一个独立产品对象。每项包含稳定id、名称、公共外观、已知特征与明确待设计内容；不能把待设计说成产品事实。",
                detail=True,
            )
            stage = "SHOTS"
            saved = self.checkpoints.get(("SHOTS", sid))
            if saved and saved["status"] == "SUCCEEDED":
                script = Script.model_validate(saved["output"])
            else:
                await self.step("SHOTS", sid, "RUNNING")
                shots: list[Shot] = []
                chunks = (
                    saved["output"].get("chunks", [])
                    if saved and isinstance(saved["output"], dict)
                    else []
                )
                # Freeze the grouping with the first checkpoint. Legacy chunks
                # retain the original per-beat plan so a deploy cannot reinterpret
                # paid results as a different segment or bill for them twice.
                output = saved.get("output") if saved else None
                chunk_plan = (
                    [Beat.model_validate(b) for b in output["chunkPlan"]]
                    if isinstance(output, dict) and "chunkPlan" in output
                    else story.beats
                    if chunks
                    else group_shot_beats(story.beats)
                )
                plan = [b.model_dump() for b in chunk_plan]
                await self.step(
                    "SHOTS",
                    sid,
                    "RUNNING",
                    {
                        "chunks": chunks,
                        "chunkPlan": plan,
                        **(
                            {"rejectedChunk": output["rejectedChunk"]}
                            if isinstance(output, dict) and "rejectedChunk" in output
                            else {}
                        ),
                    },
                )
                for index, beat in enumerate(chunk_plan):
                    chunk = (
                        ShotChunk.model_validate(chunks[index])
                        if index < len(chunks)
                        else None
                    )
                    rejected = (
                        output.get("rejectedChunk")
                        if isinstance(output, dict)
                        else None
                    )
                    if chunk is None:
                        rejected = (
                            rejected
                            if isinstance(rejected, dict)
                            and rejected.get("index") == index
                            else None
                        )
                        for correction in range(2):
                            if rejected and rejected.get("correctionComplete"):
                                raise ValueError("shot chunk correction exhausted")
                            chunk = await self.model(
                                "SHOTS",
                                ShotChunk,
                                {
                                    "story": story.model_dump(exclude={"beats"}),
                                    "assets": assets.model_dump(),
                                    "beat": beat.model_dump(),
                                    "beatIndex": index,
                                    "previousShots": [
                                        s.model_dump() for s in shots[-3:]
                                    ],
                                    "usedShotIds": [s.id for s in shots],
                                    **(
                                        {
                                            "previousInvalidChunk": rejected["chunk"],
                                            "validationIssues": rejected["issues"],
                                        }
                                        if rejected
                                        else {}
                                    ),
                                },
                                "只细化当前 beat.content 指定的完整片段。beat.durationSeconds 是本次镜头总时长，beatIndex 仅为请求序号，不是 story.beats 索引。"
                                "前后衔接参考完整故事及相邻镜头，不增删对象目录，只引用已有id。每镜明确三类资产，无使用选NONE。镜头与对白id不能重复。"
                                "如提供 previousInvalidChunk，保留合理内容，纠正 validationIssues 中的机械错误；所有镜头时长之和必须准确等于 beat.durationSeconds。",
                                detail=True,
                            )
                            issues = []
                            duration = sum(s.durationSeconds for s in chunk.shots)
                            if abs(duration - beat.durationSeconds) > 0.01:
                                issues.append(
                                    {
                                        "code": "DURATION_SUM",
                                        "expected": beat.durationSeconds,
                                        "actual": duration,
                                    }
                                )
                            try:
                                Script.model_validate(
                                    {
                                        "id": sid,
                                        "name": concept.name,
                                        "synopsis": concept.synopsis,
                                        "structure": concept.structure,
                                        "productFocus": concept.productFocus,
                                        "assets": assets.assets,
                                        "shots": [*shots, *chunk.shots],
                                    },
                                    context={"partial": True},
                                )
                            except ValueError:
                                issues.append(
                                    {
                                        "code": "SHOT_IDS_OR_ASSET_REFERENCES",
                                        "allowedAssetIds": [
                                            a.id for a in assets.assets
                                        ],
                                        "usedShotIds": [s.id for s in shots],
                                    }
                                )
                            if not issues:
                                break
                            rejected = {
                                "index": index,
                                "chunk": chunk.model_dump(),
                                "issues": issues,
                                "correctionComplete": bool(rejected) or correction == 1,
                            }
                            await self.step(
                                "SHOTS",
                                sid,
                                "RUNNING",
                                {
                                    "chunks": chunks,
                                    "chunkPlan": plan,
                                    "rejectedChunk": rejected,
                                },
                            )
                            if rejected["correctionComplete"]:
                                raise ValueError("shot chunk correction exhausted")
                    assert chunk is not None
                    shots.extend(chunk.shots)
                    if index >= len(chunks):
                        chunks.append(chunk.model_dump())
                        await self.step(
                            "SHOTS",
                            sid,
                            "RUNNING",
                            {"chunks": chunks, "chunkPlan": plan},
                        )
                script = Script(
                    id=sid,
                    name=concept.name,
                    synopsis=concept.synopsis,
                    structure=concept.structure,
                    productFocus=concept.productFocus,
                    shots=shots,
                    assets=assets.assets,
                )
                script.check_duration(target)
                await self.step("SHOTS", sid, "SUCCEEDED", script.model_dump())
            stage = "REVIEW"
            review = await self.generate(
                "REVIEW",
                sid,
                Review,
                {
                    "script": script.model_dump(),
                    "story": story.model_dump(),
                    "otherConcepts": self.other_concepts(concepts, sid),
                },
                "独立审校脚本：核对事实依据、品牌约束、故事连贯、镜头可执行、对象引用和方案差异。问题必须具体并关联有效镜头id，正常则给清楚结论。事实/结构/引用错误为ERROR，创意优化建议为WARNING。不要求穷尽全部卖点。",
            )
            if any(
                any(s not in {shot.id for shot in script.shots} for s in f.shotIds)
                for f in review.findings
            ):
                raise ValueError("review references unknown shots")
            stage = "REPAIR"
            repaired = self.checkpoints.get(("REPAIR", sid))
            if repaired and repaired["status"] == "SUCCEEDED":
                script = Script.model_validate(repaired["output"]["script"])
                review = Review.model_validate(repaired["output"]["review"])
            elif not repaired or repaired["status"] != "SKIPPED":
                if not review.findings:
                    await self.step(
                        "REPAIR",
                        sid,
                        "SKIPPED",
                        {"reason": "独立审校未发现需要修订的问题"},
                    )
                else:
                    await self.step("REPAIR", sid, "RUNNING")
                    partial = repaired.get("output") if repaired else None
                    repair = (
                        Repair.model_validate(partial["repair"])
                        if isinstance(partial, dict) and "repair" in partial
                        else await self.model(
                            "REPAIR",
                            Repair,
                            {
                                "script": script.model_dump(),
                                "review": review.model_dump(),
                            },
                            "只针对审校问题修改，保留正常部分及对象身份；返回完整脚本、修改原因和逐项前后对照，脚本id不变。",
                            detail=all(
                                f.category == "STRUCTURE" for f in review.findings
                            ),
                        )
                    )
                    script = repair.script
                    if script.id != sid:
                        raise ValueError("repair changed script identity")
                    script.check_duration(target)
                    await self.step(
                        "REPAIR", sid, "RUNNING", {"repair": repair.model_dump()}
                    )
                    review = (
                        Review.model_validate(partial["review"])
                        if isinstance(partial, dict)
                        and "review" in partial
                        and partial.get("reviewContextVersion") == 2
                        else await self.model(
                            "RECHECK",
                            Review,
                            {
                                "script": script.model_dump(),
                                "originalReview": review.model_dump(),
                                "otherConcepts": self.other_concepts(concepts, sid),
                            },
                            "独立复核当前 script 修订后的完整脚本，检查问题是否解决，以及新增事实、结构或引用错误；不要因为上一轮已修改就默认通过。"
                            "originalReview 仅是旧问题清单，otherConcepts 仅用于方案差异比较；不要把旧描述或其他方案当成当前稿内容，也不要要求当前脚本修订其他方案。",
                        )
                    )
                    if any(
                        shot_id not in {shot.id for shot in script.shots}
                        for finding in review.findings
                        for shot_id in finding.shotIds
                    ):
                        raise ValueError("recheck references unknown shots")
                    if any(f.severity == "ERROR" for f in review.findings):
                        await self.step(
                            "REPAIR",
                            sid,
                            "FAILED",
                            {
                                **repair.model_dump(),
                                "repair": repair.model_dump(),
                                "review": review.model_dump(),
                                "reviewContextVersion": 2,
                            },
                            "修订后仍有需要处理的问题，脚本尚未发布。可调整设置后再次创作。",
                        )
                        return
                    await self.step(
                        "REPAIR",
                        sid,
                        "SUCCEEDED",
                        {
                            **repair.model_dump(),
                            "review": review.model_dump(),
                            "reviewContextVersion": 2,
                        },
                    )
            script.check_duration(target)
            stage = "SAVE"
            await self.api.call("POST", "scripts", {"script": script.model_dump()})
        except InternalApiError:
            raise
        except Exception:
            if stage != "SAVE":
                await self.step(
                    stage,
                    sid,
                    "FAILED",
                    error="本方案尚未完整完成，可恢复重试；已发布脚本不受影响。",
                )
            raise
