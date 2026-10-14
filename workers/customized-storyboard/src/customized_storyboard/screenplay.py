"""Scene-based screenplay generation; one authoritative copy of the scene text."""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Annotated

from pydantic import Field

from .models import Model, Beat, Short, Text, Story, Concept

if TYPE_CHECKING:
    from .pipeline import Pipeline


class ScreenplayDraft(Model):
    title: Short
    opening: Text
    development: Text
    ending: Text
    dialoguePlan: Text
    beats: Annotated[list[Beat], Field(min_length=1, max_length=60)]

    def story(self) -> Story:
        return Story(content="\n\n".join(b.content.strip() for b in self.beats), **self.model_dump())


class ScreenplayRevision(Model):
    story: ScreenplayDraft
    concept: Concept


FORMAT = """输出正式剧本，不是故事概述、广告策划说明或镜头表。
beats 中每一项写一个完整场次或连续叙事段落的实际正文，格式为：
S01｜内景 · 具体地点｜时间段

可观察的动作、人物反应、环境变化。

角色名：（必要的状态）实际说出的台词。
按 S01、S02 连续编号，内景/外景/内外景三选一。一个场次可以有多段动作和对白；
同一地点、同一时间连续发生的事件通常写为一个场次，不把拿取、接线、工作、收纳分别编成五个场次。
30秒短片通常只需一两个完整场次，180秒随故事发展展开多个场次；这不是固定配额。
超过60秒的连续场景可拆为相邻叙事段落，但每段仍保留充分展开的实际正文。
不要只列提纲，不要写“展示卖点”“体现便携”“营造高级感”一类拍摄意图来代替动作。
动作写现在正在发生的事，不写景别、运镜、秒级分镜或生成提示词。对白只在情节需要时出现，允许无对白。
每段 durationSeconds 大于0且不超过60秒，总时长等于目标时长。每段内容必须撑得起它的时长，
较长脚本应有充分展开的行动、互动与推进；短片聚焦一个完整观看事件，不靠堆台词填字数。
不得把几句概述分配很长时长，也不得无目的地重复插拔、转场或罗列规格。
无需逐一交代每个生活步骤：可用明确且不破坏因果的时间省略与并行动作，关键产品连接状态不能跳变。
产品事实、限制、未知事项以 brief 为准；允许创作人物与情节，但不能编造功效、规格和认证。
opening/development/ending/dialoguePlan 只是辅助创作说明，正式正文全部写入 beats[].content。
不重复输出另一份 content，不在辅助字段藏入正文。title 使用方案名称。"""

REVIEW = """独立审校正式剧本，beats 是全文，不是镜头表，shotIds 必须为空。
逐场核对可观察动作、对白与因果推进能否真实支撑各段及目标时长，检查人物动机、空间/时间转换、
物品及产品状态连续性、对白可说性、开场与收束、产品事实及品牌约束。
概述化正文、以拍摄意图代替事件、180秒仅几个简短动作而大段空耗，均为需要修订的 STORY 问题；
不以固定字数或对白数量评判，无对白、停顿和环境变化有明确戏剧或视觉作用即可。
场次不是镜头：同场自然并行的动作、明确的时间省略可以成立，不要求把一场全部动作逐步实时拍完；
但关键因果、台词可说时长和产品连接状态必须可理解，不用“快速”二字掩盖过载。
检查概述/结构/产品关联与实际正文一致，方案差异应在观看事件上成立。
不要求覆盖全部卖点，不强迫旁白解释参数，不把允许创作的普通人物道具视为虚构产品事实。
指出具体场次、实际内容、依据和可执行修改，不泛泛要求更精彩；正常时给出检查结论。"""

REPAIR = """修订后重新核算全篇场次的时间容量，不仅检查原问题位置。
不要把过多动作移到结尾或另一个短段来掩盖问题；优先删掉不必要的支线、重复规格与操作步骤，
必要时合并同一时空的段落、重分配时长并同步编号，保持完整且有因果的观看事件。
可使用合理的并行动作、明确时间省略，保留关键产品状态，不把所有生活细节都强制实时展开。
修订正文、开场/发展/收束和方案概述应一致；不得为容纳动作而超出目标总时长。"""


def review_context(story: Story, formatted: bool) -> dict[str, Any]:
    # Scene text already contains the whole screenplay; avoid sending it twice.
    return story.model_dump(exclude={"content"}) if formatted else story.model_dump()


def screenplay_issues(story: Story, target: int) -> list[dict[str, Any]]:
    from .pipeline import story_issues
    issues = story_issues(story, target, segment_limit=60)
    if story.content != "\n\n".join(b.content.strip() for b in story.beats):
        issues.append({"code": "BODY_SCENE_MISMATCH"})
    for i, beat in enumerate(story.beats, 1):
        pattern = rf"^S{i:02d}[｜|](?:内景|外景|内外景) · [^\n｜|]+[｜|][^\n]+\n\n[\s\S]*\S$"
        if not re.fullmatch(pattern, beat.content.strip()):
            issues.append({"code": "SCENE_FORMAT", "scene": i})
    return issues


async def generate_screenplay(p: Pipeline, sid: str, context: dict[str, Any]) -> Story:
    saved = p.checkpoints.get(("STORY", sid))
    if saved and saved["status"] == "SUCCEEDED":
        return Story.model_validate(saved["output"])
    partial = saved.get("output") if saved else None
    await p.step("STORY", sid, "RUNNING")
    story = (Story.model_validate(partial["rejectedStory"])
             if isinstance(partial, dict) and "rejectedStory" in partial
             else (await p.model("STORY", ScreenplayDraft, context, FORMAT)).story())
    target = p.input["settings"]["targetDurationSeconds"]
    issues = screenplay_issues(story, target)
    if issues:
        if isinstance(partial, dict) and partial.get("correctionComplete"):
            raise ValueError("screenplay format correction exhausted")
        await p.step("STORY", sid, "RUNNING", {"rejectedStory": story.model_dump(), "correctionComplete": False})
        story = (await p.model("STORY", ScreenplayDraft,
            {**context, "story": review_context(story, True), "validationIssues": issues},
            FORMAT + "\n只修正给出的结构和时长错误，保留完整情节及动作内容。" )).story()
        await p.step("STORY", sid, "RUNNING", {"rejectedStory": story.model_dump(), "correctionComplete": True})
        if screenplay_issues(story, target):
            raise ValueError("screenplay format correction exhausted")
    await p.step("STORY", sid, "SUCCEEDED", story.model_dump())
    return story
