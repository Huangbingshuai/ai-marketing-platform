"""Natural-part recovery for confirmed output overflow, using the existing STORY checkpoint."""
from __future__ import annotations

from typing import Annotated, Any, TYPE_CHECKING
from pydantic import Field
from .models import Model, Id, Text, Beat

if TYPE_CHECKING:
    from .pipeline import Pipeline
    from .typed_creation import TypedStory


class Part(Model):
    id: Id
    title: Id
    development: Text
    continuity: Text


class Outline(Model):
    title: Id
    opening: Text
    development: Text
    ending: Text
    dialoguePlan: Text
    parts: Annotated[list[Part], Field(min_length=2, max_length=60)]


class Passage(Model):
    beat: Beat


async def generate_parts(p: Pipeline, sid: str, stage: str, context: dict[str, Any], instruction: str) -> TypedStory:
    # Only a confirmed provider output-limit error selects this path; no fixed seconds quota.
    from .typed_creation import TypedStory, StructureMapping

    class Mapping(Model):
        structureMapping: Annotated[list[StructureMapping], Field(max_length=20)]

    partial = dict(p.checkpoints.get((stage, sid), {}).get('output') or {})
    if partial.get('longform') is not True:
        partial = {'longform': True, 'parts': []}
        await p.step(stage, sid, 'RUNNING', partial)
    if not partial.get('outline'):
        outline = await p.model(stage, Outline, context, instruction + '\n全篇输出超出容量。先按内容发展规划自然篇章parts，只写每篇的事件、衔接和标题，不写完整正文，不按固定秒数切段。id从P01连续编号。保持原创意、全部事实边界与结构要求。')
        if [v.id for v in outline.parts] != [f'P{i+1:02d}' for i in range(len(outline.parts))]:
            raise ValueError('invalid natural-part outline')
        partial['outline'] = outline.model_dump()
        await p.step(stage, sid, 'RUNNING', partial)
    outline = Outline.model_validate(partial['outline'])
    completed = [Beat.model_validate(b) for b in partial.get('parts', [])]
    if [b.id for b in completed] != [v.id for v in outline.parts[:len(completed)]]:
        raise ValueError('natural-part checkpoint mismatch')
    for index in range(len(completed), len(outline.parts)):
        part = outline.parts[index]
        passage = await p.model(stage, Passage, {**context, 'outline': outline.model_dump(), 'currentPart': part.model_dump(), 'previousParts': [b.model_dump() for b in completed], 'nextPart': outline.parts[index+1].model_dump() if index+1 < len(outline.parts) else None}, instruction + '\n只展开currentPart这一自然篇章，返回一个beat，保留其id和标题。按全局安排延续已完成正文，不能重复事件或提前写后篇；前文和完整事实不截断。')
        if passage.beat.id != part.id:
            raise ValueError('natural-part identity mismatch')
        completed.append(passage.beat)
        partial['parts'] = [b.model_dump() for b in completed]
        await p.step(stage, sid, 'RUNNING', partial)
    metadata = outline.model_dump(exclude={'parts'})
    if p.context['structureRequirements'] and 'structureMapping' not in partial:
        mapping = await p.model(stage, Mapping, {**context, 'beats': [b.model_dump() for b in completed]}, '只为完整正文建立有序structureMapping，逐一引用结构要求、实际正文ID及准确短引文，不修改正文。')
        partial['structureMapping'] = mapping.model_dump()['structureMapping']
        await p.step(stage, sid, 'RUNNING', partial)
    return TypedStory(**metadata, beats=completed, content='\n\n'.join(b.content.strip() for b in completed), structureMapping=partial.get('structureMapping', []))
