"""Complete stories only. Asset preparation and shot production run independently."""
from __future__ import annotations
from typing import TYPE_CHECKING
from .models import Concept, Concepts, Story, Review, Model
from .pipeline import story_issues
if TYPE_CHECKING:
    from .pipeline import Pipeline


class StoryRevision(Model):
    story: Story
    concept: Concept


async def create_story(p: Pipeline, concept: Concept, concepts: Concepts) -> None:
    sid = concept.scriptId
    story = await p.generate("STORY", sid, Story,
        {"concept": concept.model_dump(), "otherConcepts": p.other_concepts(concepts, sid)},
        "写可阅读的完整故事，包含开场、发展、收束、对白安排。只写故事，不拆镜、不编资产目录。连续故事段落每段不超过30秒，段落时长合计等于目标时长。")
    saved_review = p.checkpoints.get(("REVIEW", sid))
    if saved_review and saved_review["status"] == "SUCCEEDED":
        review = Review.model_validate(saved_review["output"])
    else:
        await p.step("REVIEW", sid, "RUNNING")
        review = await p.model("REVIEW", Review,
            {"story": story.model_dump(), "otherConcepts": p.other_concepts(concepts, sid)},
            "独立审校完整故事的产品事实、品牌约束、叙事可理解性、目标时长的信息容量与方案差异。未开始拆镜，shotIds必须为空；给出具体依据和建议，不要求覆盖全部卖点。")
        if any(f.shotIds for f in review.findings):
            raise ValueError("story review must not reference shots")
        await p.step("REVIEW", sid, "SUCCEEDED", review.model_dump())
    script = {"id": sid, "name": concept.name, "synopsis": concept.synopsis,
        "structure": concept.structure, "productFocus": concept.productFocus,
        "story": story.model_dump(), "shots": [], "assets": []}
    repaired = p.checkpoints.get(("REPAIR", sid))
    if repaired and repaired["status"] == "SUCCEEDED":
        script = repaired["output"]["script"]
    elif review.findings:
        partial = repaired.get("output") if repaired else None
        await p.step("REPAIR", sid, "RUNNING")
        if isinstance(partial, dict) and "story" in partial:
            revised = Story.model_validate(partial["story"])
            revised_concept = Concept.model_validate(partial.get("concept", concept.model_dump()))
        else:
            revision = await p.model(
                "REPAIR", StoryRevision, {"concept": concept.model_dump(), "story": story.model_dump(), "review": review.model_dump()},
                "按审校指出的问题定向修订完整故事，保持未受影响的情节及已确认产品事实。不得拆镜。保持目标总时长。同步concept的名称、故事概述、叙事发展和产品关联，确保它们准确描述修订后的故事；scriptId不变，不保留已删除的情节、地点或卖点，不额外增加产品呈现要求。story.title与concept.name一致。")
            revised, revised_concept = revision.story, revision.concept
        if revised_concept.scriptId != sid:
            raise ValueError("story repair changed identity")
        if story_issues(revised, p.input["settings"]["targetDurationSeconds"]):
            raise ValueError("revised story has invalid duration")
        await p.step("REPAIR", sid, "RUNNING", {"story": revised.model_dump(), "concept": revised_concept.model_dump()})
        recheck = Review.model_validate(partial["review"]) if isinstance(partial, dict) and "review" in partial else await p.model(
            "RECHECK", Review, {"concept": revised_concept.model_dump(), "story": revised.model_dump(), "originalReview": review.model_dump()},
            "独立复核修订后的完整故事及概述/叙事发展/产品关联的一致性，产品事实及叙事错误为ERROR。没有镜头，shotIds必须为空。")
        await p.step("REPAIR", sid, "RUNNING", {"story": revised.model_dump(), "concept": revised_concept.model_dump(), "review": recheck.model_dump()})
        if any(f.severity == "ERROR" or f.shotIds for f in recheck.findings):
            raise ValueError("story review remains incomplete")
        script.update({"name": revised_concept.name, "synopsis": revised_concept.synopsis,
            "structure": revised_concept.structure, "productFocus": revised_concept.productFocus,
            "story": revised.model_dump()})
        await p.step("REPAIR", sid, "SUCCEEDED", {"script": script, "review": recheck.model_dump(),
            "reason": review.summary, "changes": [{"before": story.content, "after": revised.content, "reason": review.summary}]})
    else:
        await p.step("REPAIR", sid, "SKIPPED", {"reason": "完整故事审校通过，无需修订"})
    await p.api.call("POST", "scripts", {"script": script})
