from __future__ import annotations
import asyncio
import copy
import json
from typing import Any, Callable, TypeVar
from ai_runtime.http import InternalApiError
from .api import Api
from .provider import Provider
from .models import Model
from .video_identity import compact_references, rewrite, restore_review_text
from .video_prompt import reference_header, time_windows, validate_prompt_presentation, validate_prompt_audit_evidence, PROMPT_INSTRUCTION, PROMPT_REVIEW, PROMPT_GROUNDED_REVIEW, PROMPT_REVIEW_CORE
from .video_models import DirectorPlan, ShotBatch, Audit, ScopedAudit, PromptAudit, PromptScopedAudit, Repair, TimingRepair, ClipPrompt
from .video_review import repair_context as scoped_repair_context, review_context as delta_review_context, finish_review, performance_timeline
from .video_domain import fingerprint, ms, excerpt, validate_director, validate_plan, validate_audit, apply_repair, validate_prompt, identity_prefix, align_clip_boundaries

T = TypeVar('T', bound=Model)

DIRECTOR = '''你负责把已确认视频脚本变成可拍摄的制作安排，不重写脚本。先读不可变sourceUnits中的全文与明确语音/画面文字，再检查容量，然后分场和视频片段。
REFERENCE的秒数仅为参考；按原文完整语音、自然停顿、可见动作与信息阅读合理安排实际制作时长，不把故事篇章的旧估时锁成镜头。FIXED必须满足明确总时长；装不下就feasible=false并指出DURATION_CAPACITY_CONFLICT，不能删原话、加速表演或编造口播来凑数。来源有与设置矛盾的明确硬时长时报告SOURCE_CONSTRAINT_CONFLICT。
一个scene是连续时空，引用真实SCENE资产；同一scene可有多个clip，一个clip对应未来一次视频生成，包含多个真实连续镜头。clip在本次capability上下限内；换时空、明显场景或独立产品定版另起片段。不要预设镜头数，不把请求批次当片段。
events逐条记录需要兑现的原稿观看事件，sourceRefs只引用对应unit.text内部的Unicode字符区间，start含、end不含。索引从该unit的0开始；引用完整单元时直接使用提供的fullReference，不能重新计算或抄全文偏移。不要将相邻标题单元误当作动作正文。明确语音、画面文字必须完整保留；cue引用完整原文区间，不复制或改写文字。sourceUnits中VOICE/ON_SCREEN_TEXT的全部字符必须覆盖一次，不包含原文外标签或引号。未标注的剧本对白也应识别并定位真实原文。
长语句可按语义分配到连续片段，allocations.textStart/textEnd相对于该cue原句，语音连续不漏字不重复；画面文字跨镜重复显示时每次保留完整文字。可以让画外音跨视觉镜头，不能每镜重说整句。明确口播角色与画外声源的区别。
用timing解释具体声音/动作可并行与必须串行的负担，估时只是文字判断，不声称做过TTS或视频播放。产品事实只用brief；故事不能证明未知机械结构和功效。未知产品特征保持未知，必要对象不存在就ASSET_INPUT_GAP，不伪造资产ID。场次边界明确持物/连接/位置状态；摄影省略可以明确切前切后，不添加剧情。summary面向用户简洁说明具体选择，不输出思考过程。'''

SHOTS = '''严格实现本批confirmedClipPlans，只生成指定clip，不重复邻段。电影镜头是连续观察，一个镜头内不能又写硬切到另一机位；需要切镜就生成下一shot，放进同一个适合的clip。每镜说明观众获得什么新信息、准确构图/角度、起幅与落幅、可执行运镜、可见动作和起止状态。
按内容选择镜头数量，不强制每片段2-4镜，不固定景别配额，不堆运镜。各clip时长以规划为依据，REFERENCE可在能力内合理微调以保证内容；FIXED全片时长预算已分配，本批必须保持其合计。每镜毫秒精度，用秒表示。
只用brief明确的产品事实和资产公共外观；当前姿态、接电/持物/位置等状态写在本镜。虚构人物/场景的美术设定不能决定真实产品结构。连接、取放与状态变化可明确摄影省略，不能用“快速利落”代替实际可执行状态。独立定版是单独镜头，必要时已有规划另分场/片段。
bindings仅引用本镜实际可见或身份连续需要的对象，场景与关键产品/道具不漏绑，不把整个素材库绑定进每镜。画外声音不是人物露脸。ID只用输入实际资产。
按本批cueAllocations精确安排cueParts，textStart/textEnd是原句范围，不改原句。startMs/endMs是当前shot内相对时间，声音可以跨镜、画外持续，语音与画面可以并行；不把同一段原话重复到每镜。优先按完整词语、型号或自然句法边界承接，避免在USB-A这类名称内部切分；声音跨镜可以连续，不因视觉切镜强加停顿。所有原稿事件引用sourceEventIds，本批相关事件不能遗漏。clips.shotIds必须准确按时序列出真实shot，cueParts.shotId与之相同。'''

REVIEW = '''独立审阅实际result，对照immutableSourceUnits、brief、真实对象、能力和时长政策。不要读作者的规划来证明成稿做到了。逐项核对原稿事件/原句/画面文字兑现、说话与表演容量、摄影语法、产品事实、动作/空间连续及实际对象引用。
checks的七个dimension准确为：原稿兑现、时间容量、镜头表达、产品事实、动作与空间、素材绑定、模型能力，各出现一次；每项简短提供实际内容结论，问题细节放findings。PENDING_MODEL_CHECK只表示尚未确定实际渲染模式，不因这个标记拒绝合法文字计划。
REFERENCE允许合理制作时长，不要求强套原参考；FIXED检查确切要求。语音可连续跨镜，画外音和动作可并行；不能把字数除以统一语速当声学实测或把所有操作时间相加。具体指出哪句/哪组动作和时间矛盾。
正常项简短checks结论即可，只列有实际依据的问题。title、impact、suggestedFix、conclusion和summary面向使用者，使用实际镜头标题、台词和对象名称，不写内部ID、REF标记或JSON字段名；准确ID仅放结构化引用字段。ERROR用于确切事实/遗漏/不可执行/能力冲突；WARNING用于可选审美建议或证据不足的风险，不为个人镜头偏好硬拒绝。总体好评不能覆盖实质ERROR。
evidence只选择当前result中确实存在的实体ID和直接业务字段（不要把id本身当证据），系统回填原文；SOURCE是不可变原文单元，CUE.sourceRef表示实际原句。缺失问题同时定位应兑现的原文和已检查的实际镜头/片段，不能凭空捏造证据。已经明确另起独立定版/摄影省略时，按实际起止状态审阅，不能重复声称没有说明；有其他矛盾须具体说出。没有图片像素或媒体不能声称检查过实际渲染、口型或配音。
affectedShotIds/affectedClipIds必须定位当前对象；INPUT只用于必须回上游调整的真实缺口。首次resolutions为空。复核时逐条回答previousErrors是否真实解决，必须有当前证据；不能把未改原话说成已缩短，不能把旧意见抄到与当前稿矛盾的结论。previousFindings保留首审完整问题定级：未改范围内同一项可选建议不要仅换措辞升级为ERROR；确有新事实或发现此前遗漏的不可执行证据时可以升级，但impact须说明新依据及为何原定级不足。允许提出有证据的新问题。'''

REPAIR = '''只处理review中ERROR，不为WARNING重写。baseHash原样返回输入candidateHash，issueIds准确覆盖所有ERROR。
只改局部字段时用fields，其余字段填null；需要拆镜、合镜、延时、重排、声音跨镜或重新分片段时用ranges，明确连续旧clipIds和replacement。结构替换可改变镜头数量、片段数量和参考模式实际时长，不要求原数量/合计不变。FIXED仍必须保留全片明确时长，不可行应报告而非删原文。ranges只命中问题片段及确需衔接的邻片，不能重写无关全片。
新镜头用局部唯一ID，系统确定性分配最终ID；replacement.cueParts仍使用已有cueId和准确原文范围，范围外声音系统保留。正常对象及字段由代码原样合并，不需要返回全片。不要同时fields修改将被ranges删除的镜头。
替换范围内的全部cueParts都必须返回，包括没有修改的画面文字；只返回replacement.shots内的落点，范围外原样保留的声音不必复制。不要只返回被指出的那一句而漏掉同范围的其他原句或画面文字。
不修改events、sourceUnits、原句、产品事实、公共资产定义和任务来源。已有scene定义不得重新解释；新增独立定版场次可用新的scene ID和已有真实场景资产。不能造假资产ID或通过丢事件/删语音解决容量。原句和事件全部保留，动作省略必须明确起止状态和真实切镜。timingExplanation只解释这次实际改动。'''


REVIEW_CONSISTENCY = '\n首审必须一次分清：同一连续动作内明确的持物/连接状态矛盾、原话时间不足、已知产品事实冲突是ERROR；跨镜省略允许合理时间跳跃，画外连接对象不强制露脸或绑定。开场/章节标题是结构标记，未声明为画面文字的不要求上屏。不要把“没逐项写出来”自动等同于“物理上没发生”。确实需要先放下手中道具才能完成当前连续镜头时首次即列ERROR，不先列为建议等到复核再加码。每个checks.conclusion用一句简短结论，问题细节只写findings；避免在summary/checks/impact中反复复制同一整段原文。'
SCOPED_RECHECK = '\n本次为局部修改独立复核，不重新给未改全片打分。只重新审阅result中的真实改动和相邻衔接；范围外未改WARNING由系统原样保留。全局原句/事件覆盖及引用的确定性校验已完成，不要求result片段子集独自涵盖整片。previousFindings是首审问题账本：同一问题沿用原id，不用新id重提。原ERROR逐项写resolutions和当前实际证据。若旧问题确需改变级别，severityChanges必须关联原issueId、原/新级别、准确当前证据及具体原因；NEW_EVIDENCE必须是真实变化，首审错判则用INITIAL_REVIEW_CORRECTION明确说明首审哪里错。不能以“这次再看觉得更严重”作为新证据。没有级别变化时severityChanges为空。checks七项各用一句话说明本次改动的核对结果，正常范围无需复述；summary简短总结实际修订，不重复全文。'

def assets_projection(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: a[k] for k in ('id', 'kind', 'name', 'description', 'knownFacts', 'designNotes') if k in a} for a in assets]


def scope_plan(plan: dict[str, Any], seed: str) -> dict[str, Any]:
    value = copy.deepcopy(plan)
    short={'events':'e','scenes':'sc','clips':'c','cues':'q'}
    mappings = {k: {v['id']: f'{identity_prefix(seed)}-{short[k]}{i+1}' for i, v in enumerate(value[k])} for k in ('events', 'scenes', 'clips', 'cues')}
    for key, mapping in mappings.items():
        for item in value[key]:
            item['id'] = mapping[item['id']]
    for clip in value['clips']:
        clip['sceneId'] = mappings['scenes'][clip['sceneId']]
        clip['eventIds'] = [mappings['events'][e] for e in clip['eventIds']]
    for cue in value['cues']:
        for allocation in cue['allocations']:
            allocation['clipId'] = mappings['clips'][allocation['clipId']]
    return value


def request_batches(clips: list[dict[str, Any]], max_seconds: float = 60) -> list[list[dict[str, Any]]]:
    batches: list[list[dict[str, Any]]] = []
    for clip in clips:
        if batches and batches[-1][-1]['sceneId'] == clip['sceneId'] and sum(c['durationSeconds'] for c in batches[-1]) + clip['durationSeconds'] <= max_seconds and len(batches[-1]) < 8:
            batches[-1].append(clip)
        else:
            batches.append([clip])
    return batches


def normalize_batch(raw: dict[str, Any], batch_index: int, seed: str) -> dict[str, Any]:
    value = copy.deepcopy(raw)
    mapping = {s['id']: f'{identity_prefix(seed)}-b{batch_index+1}-s{i+1}' for i, s in enumerate(value['shots'])}
    if len(mapping) != len(value['shots']):
        raise ValueError('duplicate shot IDs inside request')
    for shot in value['shots']:
        shot['id'] = mapping[shot['id']]
    for clip in value['clips']:
        clip['shotIds'] = [mapping[s] for s in clip['shotIds']]
    for cue in value['cueParts']:
        for part in cue['parts']:
            part['shotId'] = mapping[part['shotId']]
    ordered = [sid for c in value['clips'] for sid in c['shotIds']]
    value['shots'].sort(key=lambda s: ordered.index(s['id']))
    return value


def assemble(plan: dict[str, Any], batches: list[dict[str, Any]], snapshot: dict[str, Any]) -> dict[str, Any]:
    cue_parts = [cp for b in batches for cp in b['cueParts']]
    result = {'durationPolicy': snapshot['durationPolicy'], 'timing': plan['timing'], 'capability': snapshot['renderCapability'], 'sourceUnits': snapshot['sourceUnits'], 'sources': snapshot['sources'], 'events': plan['events'], 'scenes': plan['scenes'], 'clips': [c for b in batches for c in b['clips']], 'shots': [s for b in batches for s in b['shots']],
            'cues': [{k: v for k, v in c.items() if k != 'allocations'} | {'parts': [p for cp in cue_parts if cp['cueId'] == c['id'] for p in cp['parts']]} for c in plan['cues']]}
    if snapshot.get('strategyVersion') in {'2026-10-19-capacity-clips.6','2026-10-19-capacity-clips.7'}:
        align_clip_boundaries(result)
    return result


def readable(plan: dict[str, Any]) -> str:
    shots = {s['id']: s for s in plan['shots']}
    return '\n\n'.join(clip['title'] + f" · {sum(shots[s]['durationSeconds'] for s in clip['shotIds']):g}秒\n" + '\n'.join(f"镜头{i+1} · {shots[s]['title']}\n{shots[s]['visual']}\n开始：{shots[s]['startState']}\n结束：{shots[s]['endState']}" for i, s in enumerate(clip['shotIds'])) for clip in plan['clips'])


async def run_video(api: Api, provider: Provider, claim: dict[str, Any]) -> None:
    snapshot = claim['input']
    stored: dict[str, Any] = copy.deepcopy(claim.get('output') or {})
    operation = snapshot['operation']
    scoped_review = snapshot.get('strategyVersion') in {'2026-10-19-capacity-clips.4', '2026-10-19-capacity-clips.5', '2026-10-19-capacity-clips.6','2026-10-19-capacity-clips.7'}
    timing_repair = snapshot.get('strategyVersion') in {'2026-10-19-capacity-clips.5', '2026-10-19-capacity-clips.6','2026-10-19-capacity-clips.7'}
    timeline_review = snapshot.get('strategyVersion') in {'2026-10-19-capacity-clips.6','2026-10-19-capacity-clips.7'}
    single_task = snapshot.get('strategyVersion') == '2026-10-19-capacity-clips.7'
    review_instruction = REVIEW + (REVIEW_CONSISTENCY if scoped_review else '')
    if timing_repair:
        review_instruction += '\n逐一核对镜头里新增的产品外观和机械断言是否有brief/资产事实依据。规格没有给出的制式、轴位、收纳槽结构、端口左右顺序、完全齐平等，不能因为听起来合理就作为真实产品事实通过；摄影取景方位与产品真实部件布局要区分。连接演示不等于已接通电源，不能凭一根连线虚构充电状态或进度。连续持物与换手要按当前visual和起止状态判断：确有同镜同时手持、桌面并排且未释放原物的矛盾，应在首审指出。以实际证据定级，不使用统一字数公式或假想最慢操作硬拒绝可执行动作。'
    if timeline_review:
        review_instruction += '\nperformanceTimeline是代码从当前原句与cueParts确定性展开的实际时间窗，from/to是片段内秒数，allocatedSeconds才是该段原话真实获得的时间，不是全片或整片段时长。时间容量逐一阅读voiceWindows中的原话与实际秒数，包含型号、单位、停顿和动作配合；不能以全片或片段总时长笼统判定所有口播来得及。允许声音连续跨镜、画外延续和正常语速，不拿统一字符速度或假想最慢操作作硬门槛。若片段后半仍有时间却把长句挤在前几秒，优先建议在现有片段内重排声音，仍不足才延时或重分片段；不改原话。performanceTimeline是只读展开，不是新的持久化实体；引用证据时直接选各时间窗自带的evidence，指向原始CUE.parts、CUE.sourceRef及SHOT.durationSeconds，不把allocatedSeconds或voiceWindows等派生字段当成原始字段。'
    if single_task:
        review_instruction += '\n本次一条视频任务对应一份完整分镜，clip与shot一对一。分镜是完整视频生成单元，一份画面描述可有必要的机位/画面变化，不另拆可编辑子镜头；不能仅因同一分镜描述有明确切镜判结构错误。原句、动作、声音时间窗与素材都按这份完整分镜核对。'
    limits = snapshot.get('requestLimits') or {'maxSourceCharacters': 40000, 'maxModelInputCharacters': 120000, 'maxBatches': 60, 'maxClips': 120, 'maxShots': 500, 'maxBatchSeconds': 60}
    lock = asyncio.Lock()
    statuses = {s['id']: s['status'] for s in claim['steps']}

    async def persist(node: str, status: str, title: str, content: str) -> None:
        async with lock:
            payload = {'step': {'id': node, 'status': status, 'title': title, 'content': content[:100000]}, 'output': copy.deepcopy(stored)}
            try:
                await api.call('PUT', 'checkpoint', payload)
            except InternalApiError as error:
                if not error.retryable:
                    raise
                # Keep the already bought response in memory for one more bounded
                # persistence attempt. The parallel lease keeper still cancels us
                # before its deadline, and the API rejects stale attempt tokens.
                await asyncio.sleep(1)
                await api.call('PUT', 'checkpoint', payload)

    async def require_capacity(node: str, actual: int, maximum: int, label: str) -> None:
        if actual <= maximum:
            return
        stored['failureReason'] = 'REQUEST_LIMIT'
        await persist(node, 'FAILED', '内容超出本次处理容量', f'{label}为{actual}，当前单次范围上限为{maximum}；已保留候选，请缩小制作范围，不会截断原文。')
        raise ValueError('production exceeds frozen request capacity')

    async def generate_candidate(node: str, stage: str, model: str, schema: type[T], context: dict[str, Any], instruction: str) -> dict[str, Any]:
        if snapshot.get('strategyVersion') in {'2026-10-19-capacity-clips.3','2026-10-19-capacity-clips.4','2026-10-19-capacity-clips.5','2026-10-19-capacity-clips.6','2026-10-19-capacity-clips.7'}:
            request, restore = compact_references(context)
            instruction += '\nREF标记仅为本次请求中的准确对象引用；已有引用照抄REF字段，新实体使用N前缀局部唯一ID。自由正文使用对象名称，不展示内部标记。'
            await require_capacity(node, len(json.dumps(request, ensure_ascii=False, separators=(',', ':'))), limits['maxModelInputCharacters'], '请求字符量')
            result = (await provider.generate(stage, model, schema, request, instruction)).model_dump()
            restored: dict[str, Any] = rewrite(result, restore)
            if schema in (Audit, ScopedAudit, PromptAudit, PromptScopedAudit):
                restored = restore_review_text(restored, restore)
            return schema.model_validate(restored).model_dump()
        await require_capacity(node, len(json.dumps(context, ensure_ascii=False, separators=(',', ':'))), limits['maxModelInputCharacters'], '请求字符量')
        return (await provider.generate(stage, model, schema, context, instruction)).model_dump()

    async def ask(key: str, node: str, stage: str, model: str, schema: type[T], context: dict[str, Any], instruction: str, validate: Callable[[dict[str, Any]], Any]) -> dict[str, Any]:
        corrected_key = key + 'Corrected'
        if corrected_key in stored:
            validate(copy.deepcopy(stored[corrected_key]))
            stored[key] = copy.deepcopy(stored[corrected_key])
            return copy.deepcopy(stored[key])
        if key not in stored:
            title = {'PLAN': '导演规划与容量核对', 'GENERATE': '分场创作与绑定', 'REVIEW': '对照原文独立审校', 'REPAIR': '问题修订与独立复核'}[node]
            if snapshot.get('promptWorkflowVersion') in (2, 3) and operation == 'PROMPT':
                title = {'PLAN':'画面与素材安排','GENERATE':'视频提示词创作','REVIEW':'独立审校','REPAIR':'定向修订与复核'}[node]
            await persist(node, 'RUNNING', title, '正在处理当前阶段；结果返回并校验后展示实际内容。')
            stored[key] = await generate_candidate(node, stage, model, schema, context, instruction)
            await persist(node, 'RUNNING', '候选已保存', '正在核对实际来源、结构、时长和对象引用，尚未采用。')
        try:
            validate(copy.deepcopy(stored[key]))
        except (ValueError, KeyError, StopIteration) as error:
            corrections = stored.setdefault('corrections', {})
            if corrections.get(key, 0) or sum(corrections.values()) >= 2:
                stored['failureReason'] = 'INVALID_CANDIDATE'
                await persist(node, 'FAILED', '结构需核对', '候选已保留；结构或引用仍未通过校验，纠错预算已用尽。')
                raise ValueError('candidate correction budget exhausted') from error
            corrections[key] = 1  # Persist budget BEFORE buying a correction.
            stored.setdefault('mechanicalErrors', {})[key] = str(error)[:1000]
            await persist(node, 'RUNNING', '核对结构与引用', '正在针对已定位的结构或引用错误纠正一次，保留正常内容。')
            if corrected_key not in stored:
                stored[corrected_key] = await generate_candidate(node, stage + '_CORRECT', model, schema, {**context, 'candidate': stored[key], 'mechanicalError': str(error)[:1000]}, instruction + '\n只修正所报告的结构/引用错误，正常语义保持，不新增一轮创作。')
                await persist(node, 'RUNNING', '结构纠正候选已保存', '正在验证纠正后的候选。')
            validate(copy.deepcopy(stored[corrected_key]))
            stored[key] = stored[corrected_key]
        return copy.deepcopy(stored[key])

    await require_capacity('SNAPSHOT', sum(len(u['text']) for u in snapshot['sourceUnits']), limits['maxSourceCharacters'], '原稿字符量')
    if statuses.get('SNAPSHOT') != 'SUCCEEDED':
        await persist('SNAPSHOT', 'SUCCEEDED', '本镜创作依据' if snapshot.get('promptWorkflowVersion') in (2, 3) and operation == 'PROMPT' else '创作依据', snapshot['script']['name'] + '\n已固定本次使用的正文、信息卡、分镜、素材与制作能力。')
    assets = assets_projection(snapshot['document']['assets'])
    base = {'immutableSourceUnits': [{k: u[k] for k in ('id', 'text', 'kind', 'speaker')} | {'length': len(u['text']), 'fullReference': {'unitId': u['id'], 'start': 0, 'end': len(u['text'])}} for u in snapshot['sourceUnits']], 'brief': snapshot['brief'], 'assets': assets, 'durationPolicy': snapshot['durationPolicy'], 'capability': snapshot['renderCapability']}
    if operation == 'PROMPT':
        prompt_v2 = snapshot.get('promptWorkflowVersion') in (2, 3)
        grounded_review = snapshot.get('promptWorkflowVersion') == 3
        plan = snapshot['document']['videoPlan']
        clip_id = snapshot['target']['id']
        clip = next(c for c in plan['clips'] if c['id'] == clip_id)
        subset = [s for s in plan['shots'] if s['id'] in clip['shotIds']]
        object_ids = {b['assetId'] for s in subset for b in s['bindings']}
        scene_ids = {clip['sceneId']}
        cues=[]
        for cue in plan['cues']:
            parts=[p for p in cue['parts'] if p['shotId'] in clip['shotIds']]
            if not parts:
                continue
            full=excerpt(cue['sourceRef'],plan['sourceUnits'])
            cues.append(cue | {'parts':parts,'sourceText':''.join(full[p['textStart']:p['textEnd']] for p in parts) if cue['kind']!='ON_SCREEN_TEXT' else full,'continuedFromPrevious':parts[0]['textStart']>0,'continuesNextClip':parts[-1]['textEnd']<len(full)})
        context = {'clip': clip,'durationSeconds':sum(s['durationSeconds'] for s in subset), 'shots': subset, 'cues':cues, 'assets': [a for a in assets if a['id'] in object_ids], 'scenes': [s for s in plan['scenes'] if s['id'] in scene_ids], 'brief': snapshot['brief'], 'capability': plan['capability'], 'target': snapshot['target']}
        if timeline_review:
            context['performanceTimeline'] = performance_timeline(plan, {clip_id})
        if prompt_v2:
            context['referenceHeader'] = reference_header(context['assets'])
            context['timeWindows'] = time_windows(context['durationSeconds'])
        stored.setdefault('plan', {'summary': '直接使用已确认片段的镜头顺序、声音与对象需求，不重复调用模型规划。'})
        if prompt_v2 and statuses.get('PLAN') != 'SUCCEEDED':
            stored['plan'] = {'summary': clip['title'] + '：沿用已确认画面、氛围和真实素材，整理本镜的声音与画面文字时间窗；不重新拆分分镜。', 'referenceHeader':context['referenceHeader'], 'timeWindows':context['timeWindows']}
        if statuses.get('PLAN') != 'SUCCEEDED':
            await persist('PLAN', 'SUCCEEDED', '画面与素材安排' if prompt_v2 else '片段呈现安排', stored['plan']['summary'])
        def validate_current_prompt(v: dict[str, Any]) -> None:
            validate_prompt(v, plan, clip_id, mentions_only=prompt_v2)
            if prompt_v2:
                validate_prompt_presentation(v, context)
        value = await ask('promptCandidate', 'GENERATE', 'VIDEO_PROMPT', snapshot['models']['detail'], ClipPrompt, context,
            PROMPT_INSTRUCTION if prompt_v2 else '仅为当前已确认视频片段生成可执行视频提示词，逐镜写相对时间、构图、运镜、动作、氛围、声音、切镜和起止状态。target原样返回，assetIds准确覆盖本片段实际bindings，不增加或少用对象。cues.sourceText只包含本片段应说/显示的准确原文，逐字保留；跨片段语音按continuedFromPrevious/continuesNextClip承接，不重复其他片段或每镜重说整句。不要擅自修上游分镜；出现必须修改的来源问题由独立审校指出。没有图片像素不声称观察过图片，缺图不伪装成已经渲染。', validate_current_prompt)
        stored['value'] = value
        if statuses.get('GENERATE') != 'SUCCEEDED':
            await persist('GENERATE', 'SUCCEEDED', '视频提示词创作' if prompt_v2 else '片段提示词', value['content'])
        # Reviews get only this clip and its necessary immutable source, never the entire asset library.
        review_context: dict[str, Any] = {'result': context, 'prompt': value} if grounded_review else {'result': context, 'prompt': value, 'immutableSourceUnits': snapshot['sourceUnits'], 'brief': snapshot['brief']}
        def validate_current_review(v: dict[str, Any], previous: dict[str, Any] | None = None) -> None:
            validate_audit(v, plan, previous, value)
            if grounded_review:
                validate_prompt_audit_evidence(v, value)
        prompt_review_instruction = PROMPT_GROUNDED_REVIEW + PROMPT_REVIEW + PROMPT_REVIEW_CORE if grounded_review else (review_instruction + PROMPT_REVIEW if prompt_v2 else REVIEW)
        review = await ask('audit', 'REVIEW', 'VIDEO_REVIEW', snapshot['models']['creative'], PromptAudit if grounded_review else Audit, review_context,
            prompt_review_instruction + '\n本次仅审校prompt与当前已确认clip分配的事件和语音范围，不要求本片段覆盖全片原句。cues.sourceText是本段原话，跨片段语音保持承接。提示词问题的证据用PROMPT实体（id为目标片段ID，field为content），同时可引用当前镜头/片段/声音/来源字段。影响说明准确指出提示词中的具体矛盾。', validate_current_review)
        stored['auditHash'] = fingerprint(value)
        if statuses.get('REVIEW') != 'SUCCEEDED':
            await persist('REVIEW', 'SUCCEEDED', '提示词核对', review['summary'])
        errors = [f for f in review['findings'] if f['severity'] == 'ERROR']
        if errors:
            if any(f['repairKind'] == 'INPUT' for f in errors):
                stored['failureReason'] = 'REVIEW_UNRESOLVED'
                await persist('REPAIR', 'FAILED', '来源需修改', '请核对已确认分镜中的具体问题，提示词不会静默修改来源。')
                raise ValueError('prompt source needs an explicit edit')
            value = await ask('revised', 'REPAIR', 'VIDEO_PROMPT_REPAIR', snapshot['models']['creative'], ClipPrompt, {**review_context, 'review': review}, '按具体ERROR修订当前提示词，已确认镜头、原句、时长和绑定保持。'+(PROMPT_INSTRUCTION if prompt_v2 else '')+(PROMPT_REVIEW_CORE if grounded_review else REVIEW), validate_current_prompt)
            recheck = await ask('recheck', 'REPAIR', 'VIDEO_RECHECK', snapshot['models']['creative'], PromptScopedAudit if grounded_review else ScopedAudit if prompt_v2 else Audit, {**review_context, 'prompt': value, 'previousErrors': errors, **({'previousFindings':review['findings']} if prompt_v2 else {})}, prompt_review_instruction + '\n仅核对当前片段已分配的事件和cues.sourceText，不要求覆盖其他片段原句。跨片段声音按承接标记核对。提示词证据使用PROMPT实体与实际片段ID，field为content。', lambda v: validate_current_review(v, review))
            stored['recheckHash'] = fingerprint(value)
            if any(f['severity'] == 'ERROR' for f in recheck['findings']) or any(r['status'] != 'RESOLVED' for r in recheck['resolutions']):
                stored['failureReason'] = 'REVIEW_UNRESOLVED'
                await persist('REPAIR', 'FAILED', '提示词仍需核对', recheck['summary'])
                raise ValueError('prompt recheck unresolved')
        stored['final'] = value
        if statuses.get('REPAIR') != 'SUCCEEDED':
            await persist('REPAIR', 'SUCCEEDED', '修订与复核', '具体问题已解决。' if errors else '独立审校未发现必须修改的问题，无需修订。')
        await api.call('POST', 'complete', {'output': value})
        return

    director_instruction = DIRECTOR + ('\nP01/P02等篇章标题只是脚本结构，不是必须上屏的字幕，也不必为每个标题建立单独镜头或事件。只有明确ON_SCREEN_TEXT原句需逐字呈现。按实际观看事件组织镜头，避免标题展示占用声音/动作容量。逐段考虑真实口播负担和可并行动作，长句分配到足够的片段时间；不能全片估时合理但把最密集的一句压在几秒内。说明简洁，不重复列产品完整规格。' if scoped_review else '')
    if timing_repair:
        director_instruction += '\n先设计清楚观看顺序：每镜一个主要可见事件，信息变化决定切镜与景别，不机械凑不同景别。品牌质感落实到具体光线方向、材质表现和干净空间层次，不堆电影感形容词。动作前后手、物体、连接状态清楚；摄影省略明确切前切后。产品未知制式、轴位、端口左右次序、外壳与插脚是否齐平不能由美术设计补成事实；可用构图避开未知结构，同时兑现原稿动作目的。'
    if single_task:
        director_instruction = director_instruction.replace('一个clip对应未来一次视频生成，包含多个真实连续镜头。', '一个clip对应一次独立视频任务，也就是一份完整分镜，后续只输出一个对应shot。')
        director_instruction += '\n一个clip是一份完整分镜和一次独立视频任务，后续不再细分可编辑子镜头；按主观看事件和完整原话安排这份分镜的容量。需要独立描述/生成的画面另建clip，不能把多个需分别编辑的分镜套入一个clip。必要连贯画面变化可在一份完整分镜中自然表达，不机械按每个动作建任务。'
    raw_plan = await ask('directorCandidate', 'PLAN', 'VIDEO_DIRECTOR', snapshot['models']['creative'], DirectorPlan, base, director_instruction, lambda v: validate_director(v, snapshot))
    if not raw_plan['feasible']:
        stored['plan'] = raw_plan
        stored['failureReason'] = raw_plan['inputIssue']
        await persist('PLAN', 'FAILED', '制作条件需调整', raw_plan['timing']['explanation'])
        raise ValueError('director input capacity conflict')
    if 'plan' not in stored:
        stored['plan'] = scope_plan(raw_plan, snapshot['identitySeed'])
    director = stored['plan']
    if statuses.get('PLAN') != 'SUCCEEDED':
        await persist('PLAN', 'SUCCEEDED', '导演规划与容量核对', director['summary'])
    batches = request_batches(director['clips'], limits['maxBatchSeconds'] if snapshot.get('strategyVersion') in {'2026-10-19-capacity-clips.3','2026-10-19-capacity-clips.4','2026-10-19-capacity-clips.5','2026-10-19-capacity-clips.6','2026-10-19-capacity-clips.7'} else 60)
    stored['batchCount']=len(batches)
    await require_capacity('PLAN', len(director['clips']), limits['maxClips'], '视频片段量')
    await require_capacity('PLAN', len(batches), limits['maxBatches'], '创作请求批次量')
    semaphore = asyncio.Semaphore(2)

    async def generate_batch(index: int, layouts: list[dict[str, Any]]) -> dict[str, Any]:
        ids = {c['id'] for c in layouts}
        allocations = [c | {'sourceText': excerpt(c['sourceRef'], snapshot['sourceUnits']), 'allocations': [a for a in c['allocations'] if a['clipId'] in ids]} for c in director['cues'] if any(a['clipId'] in ids for a in c['allocations'])]
        events = {e for c in layouts for e in c['eventIds']}
        context = {**base, 'events': [e for e in director['events'] if e['id'] in events], 'scenes': director['scenes'], 'confirmedClipPlans': layouts, 'cueAllocations': allocations, 'previousBoundary': batches[index-1][-1] if index else None, 'nextBoundary': batches[index+1][0] if index+1 < len(batches) else None}

        def validate_batch(v: dict[str, Any]) -> None:
            normalized = normalize_batch(v, index, snapshot['identitySeed'])
            if [c['id'] for c in normalized['clips']] != [c['id'] for c in layouts]:
                raise ValueError('request returned different clips or order')
            if any(c['sceneId'] != layouts[i]['sceneId'] for i, c in enumerate(normalized['clips'])):
                raise ValueError('clip changed planned scene identity')
            shot_ids = {s['id'] for s in normalized['shots']}
            assigned = [s for c in normalized['clips'] for s in c['shotIds']]
            if single_task and any(len(c['shotIds']) != 1 for c in normalized['clips']):
                raise ValueError('each video task must have exactly one complete storyboard, without child shots')
            if len(assigned) != len(shot_ids) or set(assigned) != shot_ids:
                raise ValueError('request has invalid shot membership')
            allowed_cues = {c['id'] for c in allocations}
            if {c['cueId'] for c in normalized['cueParts']} != allowed_cues or len(normalized['cueParts']) != len(allowed_cues):
                raise ValueError('request did not return exact speech/screen cue subset')
            objects = {a['id'] for a in assets}
            if any(b['assetId'] not in objects for s in normalized['shots'] for b in s['bindings']):
                raise ValueError('request invented an asset identity')
            if any(p['shotId'] not in shot_ids for cp in normalized['cueParts'] for p in cp['parts']):
                raise ValueError('cue refers to another request')
            shot_map={s['id']:s for s in normalized['shots']}
            for shot in normalized['shots']:
                if not all(shot[k].strip() for k in ('visual','information','startState','endState')) or len(shot['sourceEventIds'])!=len(set(shot['sourceEventIds'])) or not set(shot['sourceEventIds'])<=events or len(shot['bindings'])!=len({b['assetId'] for b in shot['bindings']}) or abs(shot['durationSeconds']*1000-ms(shot['durationSeconds']))>1e-6:
                    raise ValueError('shot structure, event references or millisecond precision invalid')
            for returned_clip in normalized['clips']:
                duration=sum(ms(shot_map[s]['durationSeconds']) for s in returned_clip['shotIds'])
                if not snapshot['renderCapability']['minClipMs']<=duration<=snapshot['renderCapability']['maxClipMs']:
                    raise ValueError('generated clip exceeds configured time capability')
            if any(not any(event in s['sourceEventIds'] for s in normalized['shots']) for event in events):
                raise ValueError('batch omitted a planned source event')
            for cp in normalized['cueParts']:
                cue = next(c for c in allocations if c['id'] == cp['cueId'])
                for part in cp['parts']:
                    if part['startMs']>=part['endMs'] or part['endMs']>ms(shot_map[part['shotId']]['durationSeconds']) or part['textStart']>=part['textEnd'] or part['textEnd']>len(cue['sourceText']):
                        raise ValueError('cue time or text range outside current shot/source')
                for allocation in cue['allocations']:
                    clip = next(c for c in normalized['clips'] if c['id'] == allocation['clipId'])
                    parts = [p for p in cp['parts'] if p['shotId'] in clip['shotIds']]
                    if not parts:
                        raise ValueError('planned cue missing from clip')
                    if cue['kind'] != 'ON_SCREEN_TEXT' and (parts[0]['textStart'] != allocation['textStart'] or parts[-1]['textEnd'] != allocation['textEnd'] or any(parts[j]['textEnd'] != parts[j+1]['textStart'] for j in range(len(parts)-1))):
                        raise ValueError('request changed planned speech range')
                    if cue['kind']=='ON_SCREEN_TEXT' and any(p['textStart']!=0 or p['textEnd']!=len(cue['sourceText']) for p in parts):
                        raise ValueError('on-screen text must remain complete')
            if snapshot['durationPolicy']['mode'] == 'FIXED' and sum(ms(s['durationSeconds']) for s in normalized['shots']) != sum(ms(c['durationSeconds']) for c in layouts):
                raise ValueError('fixed batch changed allocated duration')

        async with semaphore:
            instruction = SHOTS + ('\n只将明确ON_SCREEN_TEXT作为必须上屏的文字，不把P01等结构标题都加进画面。每个镜头的visual写实际可见动作，information/state简短准确，避免在多个字段复制整段描述。按本批完整原句安排足够的实际cueParts说话时间；可覆盖整镜或连续跨镜，不能给片段留足总时长却只让长口播在几秒内说完。拿起、放回、再取物的连续手部动作明确交代，不靠隐含第三只手完成。' if scoped_review else '')
            if timing_repair:
                instruction += '\n把information写成观众实际看懂的信息；visual用明确主体、动作、光线与构图实现它，不用抽象质感描述代替画面。运镜服务观察，避免无因环绕、反复推近和每镜只静置产品。连续操作明确持物与放下时机，必要切镜可以自然省略。产品没有确认的内部结构、制式、左右位置、卡扣或齐平程度不要补造；用观察角度避免未知细节。画面不凭连线就暗示未接电设备正在充电或显示虚构进度。'
            if single_task:
                instruction = instruction.replace('电影镜头是连续观察，一个镜头内不能又写硬切到另一机位；需要切镜就生成下一shot，放进同一个适合的clip。', '一个clip就是左侧一条视频任务，只能输出一条对应shot作为完整分镜；必要画面变化写在同一份visual中，不输出子镜头。')
                instruction = instruction.replace('按内容选择镜头数量，不强制每片段2-4镜，不固定景别配额，不堆运镜。', '每份规划恰好输出一份完整分镜，不固定景别配额，不堆运镜。')
                instruction += '\n每个clip的shotIds必须只有一个ID，shots数量等于本批clip数量。一份完整分镜统一维护名称、画面描述、氛围、完整时长和实际素材，cueParts使用分镜内相对时间。复杂动作应拆为另一条独立任务时先由导演规划决定，不在当前分镜里追加多个子镜头。'
            raw = await ask(f'batch{index}', 'GENERATE', 'VIDEO_SHOTS', snapshot['models']['detail'], ShotBatch, context, instruction, validate_batch)
            done=stored.setdefault('completedBatches',[])
            if index not in done:
                done.append(index)
                await persist('GENERATE','RUNNING','分场镜头已保存',f'已完成 {len(done)}/{len(batches)} 个实际创作批次，正在核对其余内容。')
            return normalize_batch(raw, index, snapshot['identitySeed'])

    # Only two request coroutines are in flight; no unbounded gather over a long script.
    if 'value' not in stored:
        generated: list[dict[str, Any]] = []
        for start in range(0, len(batches), 2):
            generated.extend(await asyncio.gather(*(generate_batch(i, batches[i]) for i in range(start, min(start+2, len(batches))))))
        plan = assemble(director, generated, snapshot)
        stored['value'] = {'schemaVersion': 2, 'assets': snapshot['document']['assets'], 'videoPlan': plan}
        await persist('GENERATE', 'RUNNING', '完整候选已保存', '正在检查全片来源、原句覆盖、镜头归属及时间轴。')
    plan = stored['value']['videoPlan']
    await require_capacity('GENERATE', len(plan['shots']), limits['maxShots'], '镜头量')
    validate_plan(plan, snapshot)
    if statuses.get('GENERATE') != 'SUCCEEDED':
        await persist('GENERATE', 'SUCCEEDED', '分场创作与绑定', readable(plan))
    review_context = {'immutableSourceUnits': base['immutableSourceUnits'], 'brief': snapshot['brief'], 'assets': assets, 'result': {k: v for k, v in plan.items() if k not in ('sourceUnits', 'sources')}}
    if timeline_review:
        review_context['performanceTimeline'] = performance_timeline(plan)
    audit = await ask('audit', 'REVIEW', 'VIDEO_REVIEW', snapshot['models']['creative'], Audit, review_context, review_instruction, lambda v: validate_audit(v, plan))
    stored['auditHash'] = fingerprint(plan)
    if statuses.get('REVIEW') != 'SUCCEEDED':
        await persist('REVIEW', 'SUCCEEDED', '对照原文独立审校', audit['summary'])
    errors = [f for f in audit['findings'] if f['severity'] == 'ERROR']
    if errors:
        if any(f['repairKind'] == 'INPUT' for f in errors):
            stored['failureReason'] = 'REVIEW_UNRESOLVED'
            await persist('REPAIR', 'FAILED', '来源内容需核对', '分镜不能擅自修改原稿或公共资产，请核对具体问题。')
            raise ValueError('source-level issue cannot be silently repaired')
        if 'revised' not in stored:
            repair_input = {**review_context, 'candidateHash': fingerprint(plan), 'review': audit}
            if scoped_review:
                repair_input.update(scoped_repair_context(plan, audit))
            if timeline_review:
                repair_input['performanceTimeline'] = performance_timeline(plan, {c['id'] for c in repair_input['result']['clips']})
            repair_instruction = REPAIR + ('\n若镜头数量、画面和片段归属无需变化，优先fields.durationSeconds调整现有镜长、cueUpdates调整已有原句的实际落点；不要为了调秒数重新输出完整镜头。cueUpdates每项返回该原句在受影响片段内的全部parts；范围外自动保留。字段只填有实际修改的内容，其余null。只有确需拆并、换镜或重分片段才用ranges。' if timing_repair else '')
            if single_task:
                repair_instruction += '\n保持一个clip恰好对应一个shot的一对一关系。必要拆分时拆成独立clip及各自完整分镜，不在一个clip下生成多个子镜头；普通内容问题优先fields原位修正，保持正常任务身份。'
            patch = await ask('repairCandidate', 'REPAIR', 'VIDEO_REPAIR', snapshot['models']['creative'], TimingRepair if timing_repair else Repair, repair_input, repair_instruction, lambda v: apply_repair(plan, v, audit, snapshot))
            revised = apply_repair(plan, patch, audit, snapshot)
            stored['revised'] = {'schemaVersion': 2, 'assets': snapshot['document']['assets'], 'videoPlan': revised}
            old_shots = {s['id']: s for s in plan['shots']}
            new_shots = {s['id']: s for s in revised['shots']}
            stored['changes'] = [{'label': s['title'], 'before': '\n'.join(str(v) for k, v in old_shots.get(s['id'], {}).items() if k not in ('id', 'bindings', 'sourceEventIds')), 'after': '\n'.join(str(v) for k, v in s.items() if k not in ('id', 'bindings', 'sourceEventIds'))} for s in revised['shots'] if s != old_shots.get(s['id'])] + [{'label': s['title'], 'before': s['visual'], 'after': '已由结构修订中的新镜头接替'} for s in plan['shots'] if s['id'] not in new_shots]
            await persist('REPAIR', 'RUNNING', '修订候选已保存', '实际结构与字段变化已保存，正在独立复核。')
        revised = stored['revised']['videoPlan']
        validate_plan(revised, snapshot)
        if scoped_review:
            delta_input, review_scope = delta_review_context(plan, revised, audit)
            if timeline_review:
                delta_input['performanceTimeline'] = performance_timeline(revised, review_scope)
            instruction = review_instruction + SCOPED_RECHECK
            raw_review = await ask('scopedRecheck', 'REPAIR', 'VIDEO_RECHECK', snapshot['models']['creative'], ScopedAudit, {k: v for k, v in review_context.items() if k != 'result'} | delta_input, instruction, lambda v: finish_review(v, plan, revised, audit, review_scope))
            recheck = finish_review(raw_review, plan, revised, audit, review_scope)
            stored['recheck'] = recheck
        else:
            recheck = await ask('recheck', 'REPAIR', 'VIDEO_RECHECK', snapshot['models']['creative'], Audit, {**review_context, 'result': {k: v for k, v in revised.items() if k not in ('sourceUnits', 'sources')}, 'previousErrors': errors, 'previousFindings': audit['findings'], 'actualChanges': stored.get('changes', [])}, REVIEW, lambda v: validate_audit(v, revised, audit))
        stored['recheckHash'] = fingerprint(revised)
        if any(f['severity'] == 'ERROR' for f in recheck['findings']) or any(r['status'] != 'RESOLVED' for r in recheck['resolutions']):
            stored['failureReason'] = 'REVIEW_UNRESOLVED'
            await persist('REPAIR', 'FAILED', '修订后仍需核对', recheck['summary'])
            raise ValueError('independent recheck unresolved')
        plan = revised
    stored['final'] = {'schemaVersion': 2, 'assets': snapshot['document']['assets'], 'videoPlan': plan}
    if statuses.get('REPAIR') != 'SUCCEEDED':
        await persist('REPAIR', 'SUCCEEDED', '修订与独立复核', '原问题已逐条核对，修订结果通过。' if errors else '独立审校未发现必须修改的问题，无需修订。')
    await api.call('POST', 'complete', {'output': stored['final']})
