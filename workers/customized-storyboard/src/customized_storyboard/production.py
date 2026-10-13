from __future__ import annotations
import asyncio
from typing import Any, Annotated, Literal, Self
from pydantic import Field, model_validator
from .models import Model, Text, Id, Short, Seconds
from .api import Api
from .provider import Provider


class ObjectDefinition(Model):
    id: Id
    kind: Literal['PRODUCT', 'CHARACTER', 'SCENE', 'PROP']
    name: Id
    description: Text
    knownFacts: Text
    designNotes: Text
    sourceText: Text
    imageRequirements: Text = ""


class Catalog(Model):
    assets: Annotated[list[ObjectDefinition], Field(min_length=1, max_length=1000)]

    @model_validator(mode='after')
    def valid(self) -> Self:
        if len({a.id for a in self.assets}) != len(self.assets) or not any(a.kind == 'PRODUCT' for a in self.assets):
            raise ValueError('catalog requires unique identities and a product')
        return self


class Binding(Model):
    assetId: Id
    description: Text


class ProductionShot(Model):
    id: Id
    title: Short
    shotType: Short
    cameraMovement: Short
    durationSeconds: Seconds
    visual: Text
    dialogue: Text
    audio: Text
    atmosphere: Text
    bindings: Annotated[list[Binding], Field(max_length=100)]


class ShotList(Model):
    shots: Annotated[list[ProductionShot], Field(min_length=1, max_length=500)]


def scoped_shot_repair(shots: list[dict[str, Any]]) -> type[ShotList]:
    allowed = {s['id'] for s in shots}
    duration = sum(s['durationSeconds'] for s in shots)

    class ScopedShotRepair(ShotList):
        @classmethod
        def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
            schema = super().model_json_schema(*args, **kwargs)
            schema['$defs']['ProductionShot']['properties']['id']['enum'] = sorted(allowed)
            schema['properties']['shots'].update(minItems=len(allowed), maxItems=len(allowed))
            return schema

        @model_validator(mode='after')
        def preserve_scope(self) -> Self:
            if len(self.shots) != len(allowed) or {s.id for s in self.shots} != allowed:
                raise ValueError('repair changed shot identities')
            if abs(sum(s.durationSeconds for s in self.shots) - duration) > 1e-7:
                raise ValueError('repair changed selected shots total duration')
            return self

    return ScopedShotRepair


class Prompt(Model):
    shotId: Id
    content: Annotated[str, Field(min_length=1, max_length=20000)]
    assetIds: list[Id]


class Audit(Model):
    summary: Text
    issues: list[Text]
    affectedIds: list[Id] = []


class Segment(Model):
    content: Text
    durationSeconds: Annotated[float, Field(gt=0, le=60)]


class Plan(Model):
    summary: Text
    segments: Annotated[list[Segment], Field(max_length=60)] = []


def coalesce_segments(segments: list[Segment]) -> list[Segment]:
    """Batch adjacent narrative beats without dropping content or changing time."""
    batches: list[Segment] = []
    for segment in segments:
        if batches and batches[-1].durationSeconds + segment.durationSeconds <= 60:
            previous = batches[-1]
            batches[-1] = Segment(content=previous.content + '\n\n' + segment.content,
                                  durationSeconds=previous.durationSeconds + segment.durationSeconds)
        else:
            batches.append(segment.model_copy())
    return batches


def target_duration(snapshot: dict[str, Any]) -> float:
    script = snapshot['script']
    return float(sum(b['durationSeconds'] for b in script.get('story', {}).get('beats', [])) or sum(s['durationSeconds'] for s in script.get('shots', [])))


def story_context(script: dict[str, Any]) -> dict[str, Any]:
    # Narrative beat timings are an outline, not locked shot durations. The full
    # story remains authoritative; production must fit its own actual actions.
    value = {k: v for k, v in script.items() if k not in ('shots', 'assets', 'structure')}
    if 'story' in value:
        value['story'] = {k: v for k, v in value['story'].items() if k != 'beats'}
    return value


def text_assets(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: v for k, v in a.items() if k != 'image'} for a in assets]


def check_output(operation: str, value: dict[str, Any], snapshot: dict[str, Any]) -> None:
    if operation == 'ASSETS':
        Catalog.model_validate(value)
    elif operation == 'SHOTS':
        shots = ShotList.model_validate(value).shots
        assets = {a['id'] for a in snapshot['document']['assets']}
        if len({s.id for s in shots}) != len(shots):
            raise ValueError('duplicate shot identity')
        for shot in shots:
            refs = [b.assetId for b in shot.bindings]
            if len(refs) != len(set(refs)) or any(a not in assets for a in refs) or not shot.visual.strip():
                raise ValueError('invalid shot binding')
        target = target_duration(snapshot)
        if target and abs(sum(s.durationSeconds for s in shots) - target) > 1:
            raise ValueError('shot duration differs from story')
    else:
        prompt = Prompt.model_validate(value)
        shot = next(s for s in snapshot['document']['shots'] if s['id'] == snapshot['shotId'])
        if prompt.shotId != shot['id'] or set(prompt.assetIds) != {b['assetId'] for b in shot['bindings']} or len(prompt.assetIds) != len(set(prompt.assetIds)):
            raise ValueError('prompt binding differs from selected shot')


def describe(operation: str, value: dict[str, Any]) -> str:
    if operation == 'ASSETS':
        return '\n\n'.join(f"{a['name']}\n{a['description']}\n已知信息：{a['knownFacts']}\n设计内容：{a['designNotes']}\n图像制作要求：{a.get('imageRequirements', '')}\n依据：{a['sourceText']}" for a in value['assets'])
    if operation == 'SHOTS':
        return '\n\n'.join(f"镜头 {i+1} · {s['title']} · {s['durationSeconds']} 秒\n{s['shotType']} · {s['cameraMovement']}\n{s['visual']}\n{s['dialogue']}\n氛围：{s['atmosphere']}\n声音：{s['audio']}" for i, s in enumerate(value['shots']))
    return str(value['content'])


async def run(api: Api, provider: Provider, claim: dict[str, Any]) -> None:
    snapshot = claim['input']
    operation = snapshot['operation']
    checkpoints = {s['id']: s for s in claim['steps']}
    stored = claim.get('output') or {}
    modern = 'PLAN' in checkpoints

    async def step(node: str, status: str, title: str, content: str, output: dict[str, Any] | None = None) -> None:
        await api.call('PUT', 'checkpoint', {'step': {'id': node, 'status': status, 'title': title, 'content': content}, **({'output': output} if output is not None else {})})

    if operation == 'PROMPT':
        shot = next(s for s in snapshot['document']['shots'] if s['id'] == snapshot['shotId'])
        ids = {b['assetId'] for b in shot['bindings']}
        context = {'shot': shot, 'assets': text_assets([a for a in snapshot['document']['assets'] if a['id'] in ids]), 'brief': snapshot['brief']}
        schema: type[Model] = Prompt
        instruction = '仅为当前镜头写可执行的视频提示词，包含画面、动作、镜头运动、氛围、声音和连续变化。尊重绑定对象定义；assetIds准确等于该镜bindings，不引用其他对象。不补造产品事实，不写内部id进正文。图像尚未生成时不得声称已经观察图片。'
    elif operation == 'ASSETS':
        # Previous generated descriptions are not evidence. Keep only identity
        # hints so a fresh extraction cannot inherit an old invented feature.
        context = {'story': story_context(snapshot['script']), 'brief': snapshot['brief'], 'existingDefinitions': [{k: a[k] for k in ('id', 'kind', 'name')} for a in snapshot['document']['assets']]}
        schema = Catalog
        instruction = '从完整故事整理产品、人物、场景、道具四类共用定义。产品始终独立。相同实体复用existingDefinitions中的稳定id，旧定义仅用于身份对齐不当作事实来源，不同场景或角色不误合并。description为公共外观；产品description和knownFacts仅写简报明确的特征，未说明的结构位置、接口细节不得擅自确定；designNotes写允许创作的设定或待确认内容，明确标为设计方案而非真实产品事实。sourceText引用故事或简报依据。人物、场景与道具可补充故事所需的创作设定，保持动作和连接关系可执行。imageRequirements按实际形态逐行给出以后制作图片所需的视角、表情姿态、材质/界面细节或空间光影要求，未知产品结构仍标待确认，不借制作要求新增产品事实；软件不要机械套实物三视图。这些只是制作要求，不能声称图片已生成。不要生成分镜；不要把品牌Logo想象成产品外观。'
    else:
        context = {'story': story_context(snapshot['script']), 'assets': text_assets(snapshot['document']['assets']), 'brief': snapshot['brief'], 'targetDurationSeconds': target_duration(snapshot)}
        schema = ShotList
        instruction = '根据完整故事和已确认资产目录拆分为连续分镜，时长合计与目标相等。镜头之间动作和空间衔接自然，给出画面、景别、运镜、对白、声音、氛围。产品事实与结构位置以brief及已确认资产为准，故事或plan中的未经确认细节不能覆盖它们。先核对每镜实际时间容量，不在短镜头塞入长广播、对白与多步操作；可以缩短广播或调整各镜时长。省略耗时操作时必须明确实际剪辑切点、哪些操作不展示、切后哪种完成状态可见，不能只写快速利落、压缩动作或跟拍来假装时间省略。接线需说明两端已连接或实际接入过程，收纳前须先将充电器从电源插座拔离，再合插脚；省略动作须明确交代省略后的状态，不能让物体瞬移。bindings仅绑定当前镜头实际出场或需要参考的对象，禁止把全部目录塞进每镜。只引用给定资产id，共用外观不能随镜头跳变。'
    context['operation'] = operation
    audit_instruction = {
        'ASSETS': '本次仅审校result.assets资产目录，不审校或复述脚本分镜。逐项核对description、knownFacts、designNotes、imageRequirements与简报/故事的具体依据，检查必要对象遗漏、重复身份、产品结构位置与接口细节的无依据断言、连接关系和场景设计矛盾。产品未知细节须留待确认，不能由常识补成事实；允许的人物与场景创作设定不误判为产品事实错误。summary说明实际资产字段的核查结论。',
        'SHOTS': '本次仅审校result.shots完整分镜，逐镜而非凭故事概述判断。必须核对：每镜广播/对白的实际说话时间与操作耗时是否容纳于durationSeconds；接线两端是否明确已连接；从墙插拔离充电器之后才能合脚和收纳；省略过程是否明确状态衔接；插脚与端口具体位置是否有brief依据。另核对空间连续性、资产定义一致性及本镜实际绑定子集。summary提供这些实际检查的结论，不以“基本匹配”掩盖未检查项。',
        'PROMPT': '本次仅审校result中的当前镜头提示词。对照input.shot及已绑定资产，核对具体动作、时长、镜头运动、氛围、声音和产品事实。广播/对白必须来得及说完，连接与拔离动作必须可执行；来源镜头有歧义时提示词应澄清前后状态，不能继续照抄错误。不引入其他镜头或对象；不能声称已经观察尚未生成的参考图。',
    }[operation] + '产品事实只以input.brief为依据，故事只能证明叙事事件，input.plan与旧定义不能证明真实产品特征。issues只列必须修改的具体问题及依据，正常时为空；分镜问题affectedIds列出需修改的准确镜头ID，非分镜为空。不要输出思考过程。'
    if checkpoints['SNAPSHOT']['status'] != 'SUCCEEDED':
        source = snapshot['script']['name']+'\n'+snapshot['script'].get('story', {}).get('content', snapshot['script']['synopsis'])
        if operation == 'PROMPT':
            source = describe('SHOTS', {'shots': [context['shot']]})+'\n\n本镜对象：'+ '、'.join(a['name'] for a in context['assets'])
        await step('SNAPSHOT', 'SUCCEEDED', '创作依据', source)
    if modern and checkpoints['PLAN']['status'] != 'SUCCEEDED':
        await step('PLAN', 'RUNNING', '制作规划', '正在整理具体内容安排和依据')
        plan_instruction = {
            'ASSETS': '本次operation为ASSETS，仅规划共用资产。summary简洁列出必要实体、实际出处、身份对齐和关键待确认项，不超过800字；完整公共外观及图像制作要求留给下一阶段，不在本阶段重复生成整份资产目录。产品事实仅来自brief，existingDefinitions只用于稳定id对齐。不要创作镜头、分配时长或提前生成分镜；segments必须为空。',
            'SHOTS': '本次operation为SHOTS，按实际动作和说话容量重新规划连续叙事段落，不照搬故事概述的旧时间分配。segments覆盖完整故事，每段不超过60秒，合计与targetDurationSeconds误差不超过1秒。短片可使用明确的剪辑省略和简短广播，说明切前切后状态而非加速所有操作。这里只安排叙事段落，不提前重复输出完整逐镜内容，实际拆镜由下一阶段负责。',
            'PROMPT': '本次operation为PROMPT，仅规划当前shot的视频提示词。summary说明本镜动作、镜头运动、氛围、声音和已绑定对象的实际作用，尊重本镜时长。不增加其他镜头或额外资产；segments必须为空。',
        }[operation]
        plan = await provider.generate('PRODUCTION_PLAN', snapshot['models']['creative'], Plan, context,
            plan_instruction + 'summary面向创作者解释具体安排，不输出思考过程。')
        if operation != 'SHOTS' and plan.segments:
            raise ValueError('only shot production may plan timed story segments')
        if operation == 'SHOTS' and (not plan.segments or abs(sum(s.durationSeconds for s in plan.segments)-target_duration(snapshot)) > 1):
            raise ValueError('segment duration differs from story')
        if operation == 'SHOTS':
            plan.segments = coalesce_segments(plan.segments)
        stored = {'plan': plan.model_dump()}
        await step('PLAN', 'SUCCEEDED', '制作安排', plan.summary+'\n'+'\n'.join(f'{s.durationSeconds} 秒：{s.content}' for s in plan.segments), stored)
    context['plan'] = stored.get('plan', {})
    if checkpoints['GENERATE']['status'] == 'SUCCEEDED':
        value = stored.get('value', stored)
    else:
        await step('GENERATE', 'RUNNING', '内容创作', '正在根据已确认内容创作')
        if modern and operation == 'SHOTS':
            segments = Plan.model_validate(stored['plan']).segments
            chunks = dict(stored.get('chunks', {}))
            # Share the remaining one-second budget across chunks. Otherwise
            # individually valid checkpoints can add up to an unrecoverable total.
            timing_budget = max(0.0, 1 - abs(sum(s.durationSeconds for s in segments) - target_duration(snapshot))) / len(segments)
            lock = asyncio.Lock()
            semaphore = asyncio.Semaphore(2)

            async def chunk(index: int) -> None:
                key = str(index)
                segment = segments[index]
                if key in chunks:
                    if abs(sum(s['durationSeconds'] for s in chunks[key]['shots']) - segment.durationSeconds) <= timing_budget + 1e-7:
                        return
                    del chunks[key]
                async with semaphore:
                    result = await provider.generate('PRODUCTION_SHOTS', snapshot['models']['detail'], ShotList,
                        {**context, 'currentSegment': segment.model_dump(), 'previousSegment': segments[index-1].model_dump() if index else None, 'nextSegment': segments[index+1].model_dump() if index+1 < len(segments) else None},
                        instruction+'本次只生成currentSegment；这批镜头时长合计严格等于该段时长。完整故事与相邻段落仅用于确保衔接，不重复生成其镜头。')
                data = result.model_dump()
                local_snapshot = {**snapshot, 'script': {'story': {'beats': [{'durationSeconds': segment.durationSeconds}]}}}
                check_output('SHOTS', data, local_snapshot)
                if abs(sum(s['durationSeconds'] for s in data['shots']) - segment.durationSeconds) > timing_budget + 1e-7:
                    raise ValueError('chunk duration exceeds its share of the total timing budget')
                # Stable task-local namespacing avoids cross-chunk ID collisions.
                for i, item in enumerate(data['shots']):
                    item['id'] = f'segment-{index+1}-shot-{i+1}'
                async with lock:
                    chunks[key] = data
                    await step('GENERATE', 'RUNNING', '分段镜头', '\n\n'.join(describe('SHOTS', chunks[k]) for k in sorted(chunks, key=int)), {'plan': stored['plan'], 'chunks': chunks})

            results = await asyncio.gather(*(chunk(i) for i in range(len(segments))), return_exceptions=True)
            for result in results:
                if isinstance(result, BaseException):
                    raise result
            value = {'shots': [shot for i in range(len(segments)) for shot in chunks[str(i)]['shots']]}
        else:
            generated = await provider.generate('PRODUCTION_'+operation, snapshot['models']['detail'], schema, context, instruction)
            value = generated.model_dump()
        check_output(operation, value, snapshot)
        stored = {**stored, 'value': value}
        await step('GENERATE', 'SUCCEEDED', '创作内容', describe(operation,value), stored)
    if checkpoints['REVIEW']['status'] != 'SUCCEEDED':
        await step('REVIEW','RUNNING','独立审校','正在核对产品事实、画面连续性及实际使用的资产')
        review = Audit.model_validate(stored['audit']) if 'audit' in stored else await provider.generate('PRODUCTION_REVIEW',snapshot['models']['creative'],Audit,{'input':context,'result':value},audit_instruction)
        stored = {**stored, 'value': value, 'audit': review.model_dump()}
        await step('REVIEW', 'SUCCEEDED' if modern else 'RUNNING', '审校结果',review.summary+'\n'+'\n'.join(review.issues),stored)
    else:
        review = Audit.model_validate(stored.get('audit', {'summary': '审校通过', 'issues': []}))
    repair_node = 'REPAIR' if modern else 'REVIEW'
    if checkpoints[repair_node]['status'] != 'SUCCEEDED':
        if review.issues:
            await step(repair_node,'RUNNING','定向修订','\n'.join(review.issues),stored)
            if 'revised' in stored:
                value = stored['revised']
            else:
                affected = set(review.affectedIds)
                partial = operation == 'SHOTS' and bool(affected)
                original = value
                if partial:
                    if not affected <= {s['id'] for s in value['shots']}:
                        raise ValueError('review refers to unknown shots')
                    value = {'shots': [s for s in value['shots'] if s['id'] in affected]}
                repair_schema = scoped_shot_repair(value['shots']) if operation == 'SHOTS' else schema
                repair_instruction = ('仅修订result.shots中的准确镜头ID，保持这些镜头数量；其合计时长必须等于repairDurationSeconds，可重新分配各镜时长，不能使用完整影片目标作为局部合计。input和continuityContext只用于事实与前后衔接，不重新拆分故事，不输出其中其他镜头。需要省略耗时操作时，必须明确实际剪辑切点、哪些动作不展示，以及切后可见的完成状态；不能用快速、压缩动作或连贯跟拍代替时间省略。保留关键观看事件，不用增加更多动作来修复容量问题。补足产品连接和断开状态，产品事实以brief为准，bindings只引用本镜实际出场对象。'
                                      if operation == 'SHOTS' else instruction)
                revised = (await provider.generate('PRODUCTION_REPAIR',snapshot['models']['creative'],repair_schema,{'input':context,'result':value,'review':review.model_dump(), 'continuityContext': original if partial else None, 'repairDurationSeconds': sum(s['durationSeconds'] for s in value['shots']) if operation == 'SHOTS' else None},'按具体问题定向修订，保持正常内容和对象身份。'+repair_instruction)).model_dump()
                if partial:
                    if {s['id'] for s in revised['shots']} != affected:
                        raise ValueError('repair changed shot identities')
                    changed = {s['id']: s for s in revised['shots']}
                    revised = {'shots': [changed.get(s['id'], s) for s in original['shots']]}
                value = revised
            check_output(operation,value,snapshot)
            stored = {**stored,'value':value,'revised':value}
            await step(repair_node,'RUNNING','修订内容',describe(operation,value),stored)
            recheck = Audit.model_validate(stored['recheck']) if 'recheck' in stored else await provider.generate('PRODUCTION_RECHECK',snapshot['models']['creative'],Audit,{'input':context,'result':value,'previousIssues':review.issues},'独立复核修订后的完整结果，核查previousIssues是否实际解决。'+audit_instruction)
            stored = {**stored, 'recheck':recheck.model_dump()}
            await step(repair_node,'RUNNING','复核结果',recheck.summary+'\n'+'\n'.join(recheck.issues),stored)
            if recheck.issues:
                raise ValueError('review still has unresolved issues')
            conclusion = recheck.summary
        else:
            conclusion = '独立审校未发现必须修改的问题，无需定向修订。'
        output = value if operation == 'PROMPT' else {'assets':value['assets'] if operation=='ASSETS' else snapshot['document']['assets'],'shots':value['shots'] if operation=='SHOTS' else []}
        # Retain review/checkpoint evidence for retries without new paid calls.
        stored = {**stored, 'final': output}
        await step(repair_node,'SUCCEEDED','修订与复核结果',conclusion+'\n\n'+describe(operation,value),stored if modern else output)
    else:
        output = stored.get('final',stored)
    await api.call('POST','complete',{'output':output})
