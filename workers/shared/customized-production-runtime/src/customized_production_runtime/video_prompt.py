"""Deterministic presentation inputs and formatting checks, not story generation."""
from __future__ import annotations
import json
import re
from typing import Any
from .video_identity import compact_references


def reference_header(assets: list[dict[str, Any]]) -> str:
    if not assets:
        return '参考素材：无。'
    labels = [('CHARACTER', '角色'), ('PRODUCT', '产品'), ('SCENE', '场景'), ('PROP', '道具')]
    return '；'.join(label + '：' + '、'.join('@' + a['name'] for a in assets if a['kind'] == kind)
                    for kind, label in labels if any(a['kind'] == kind for a in assets)) + '。'


def time_windows(seconds: float) -> list[dict[str, float]]:
    total = round(seconds * 1000)
    return [{'startSeconds': start / 1000, 'endSeconds': min(start + 3000, total) / 1000}
            for start in range(0, total, 3000)]


def validate_prompt_presentation(value: dict[str, Any], context: dict[str, Any]) -> None:
    content = value['content']
    candidates = sorted(context['assets'], key=lambda a: -len(a['name']))
    mentioned: list[str] = []
    for match in re.finditer('@', content):
        rest = content[match.end():]
        asset = next((a for a in candidates if rest.startswith(a['name'])), None)
        if asset is None:
            raise ValueError('every @reference must use a full readable bound asset name')
        if asset['id'] not in mentioned:
            mentioned.append(asset['id'])
    if set(mentioned) != set(value['assetIds']) or len(mentioned) != len(value['assetIds']):
        raise ValueError('assetIds must exactly match actual @references, not all candidate assets')
    selected = [a for a in context['assets'] if a['id'] in mentioned]
    if not content.startswith(reference_header(selected)):
        raise ValueError('first line must list exactly the actually referenced assets by readable names')
    picture = content.split('声音与画面文字安排', 1)[0]
    ranges = re.findall(r'(?m)^\s*(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*秒[：:]', picture)
    expected = [(w['startSeconds'], w['endSeconds']) for w in context['timeWindows']]
    if [(float(a), float(b)) for a, b in ranges] != expected:
        raise ValueError('time lines must exactly match timeWindows in order, e.g. 0–3秒：画面内容')
    for cue in context['cues']:
        if cue['sourceText'] not in content:
            raise ValueError('preserve each allocated sourceText verbatim in the sound/text section')
    # Request-local machine labels are not presentation text. Preserve genuine
    # source text that happens to contain the same literal, rather than guessing.
    _, aliases = compact_references(context)
    business_assets = []
    for asset in context['assets']:
        readable = {k:v for k,v in asset.items() if k not in ('id', 'imageOwnership')}
        if asset.get('imageOwnership'):
            readable['imageOwnership'] = {k:v for k,v in asset['imageOwnership'].items() if k != 'sourceObjectId'}
        business_assets.append(readable)
    business = json.dumps({'clipTitle':context['clip']['title'], 'shots':[
        {k:v for k,v in s.items() if k not in ('id','sourceEventIds','bindings')} for s in context['shots']],
        'assets':business_assets,
        'speech':[c['sourceText'] for c in context['cues']]}, ensure_ascii=False)
    for literal in [*aliases, *aliases.values()]:
        if literal not in business and re.search(r'(?<![A-Za-z0-9_-])' + re.escape(literal) + r'(?![A-Za-z0-9_-])', content):
            raise ValueError('prompt prose contains a request-internal reference; use the actual asset or storyboard name')


PROMPT_INSTRUCTION = '''只转换当前已确认分镜，不重新写故事、拆分其他任务或修改上游。assets是本镜候选素材，按实际画面需要选择引用，不要求用完。imageOwnership表示随指定父场景/人物准备的细节，引用该对象时渲染会使用父图中对应细节，不要求单独生图，不额外强制引用未绑定父对象，不声称已看过图片。第一行按角色、产品、场景、道具的顺序列出实际引用的素材，格式“角色：@素材全名；产品：@素材全名；场景：@素材全名；道具：@素材全名。”，同类用“、”分隔，省略未引用类别；同类按assets顺序。referenceHeader仅示范完整候选集的写法，不能机械照抄。完全不引用时首行为“参考素材：无。”。不写内部ID、REF标记、字段标签或模型参数。
随后每个timeWindows对应一行，格式为“0–3秒：画面内容”。时间段连续完整覆盖本镜，最后一段可不足3秒。分段是同一视频的时间安排，不意味着必须每3秒切镜；仅兑现已确认描述中的画面变化。每段写具体可见动作、准确机位/构图、合理运镜、光线与氛围，必要时以“切到”连接已有变化。不堆抽象情绪或新增产品事实。
各段使用@素材全名引用实际使用的参考对象，首段建立空间与主体关系。只从本镜实际绑定素材选取，不把整个素材库写进来；assetIds精确返回正文@引用的ID，未引用的候选不得放入assetIds。已确认画面中的对象可以文字描述，但不强制为每个普通背景物绑定参考图。
原稿声音和画面文字在时间段之后单列“声音与画面文字安排”，按performanceTimeline和cues.sourceText完整逐字保留原句及实际时间窗；performanceTimeline是已确认的时间依据，优先于画面描述末尾顺带提及文字的句子顺序。声音可跨画面连续，不在每段重说整句，不创作额外台词。屏显原文和开始/结束时间只在此区域安排，画面段落不另写字幕浮现、消失或新的出现时间，避免同一屏显有两个冲突的安排。环境声/动作音可以按已确认动作写入画面段落，不虚构说话。target原样返回。
缺图仍可做文字提示词，不声称观察过图片或已渲染。尚未锁定实际视频模型时不虚构厂商参数。遇到上游实质问题由审校指出，不擅自修改分镜。'''

PROMPT_REVIEW = '''独立核对当前提示词全部画面时间段以及文末声音/屏显安排，不能只看文末时间表就推断前文一致。逐项比较performanceTimeline中的原句及真实时间窗；画面中写明的首次出现、持续、消失必须与末尾时间安排一致，冲突属于可局部修改的提示词ERROR。画面时间段只是连续呈现安排，不要求每3秒切镜。原分镜的候选素材不要求全部用作参考图；只有实际@引用的素材才进入assetIds。普通物体可以文字描述，不能因此误报漏绑；引用身份及产品事实仍须准确。只修当前提示词，不借审校改写上游分镜。'''

PROMPT_GROUNDED_REVIEW = '''本次待审成稿仅为prompt.content，result.shots是固定上游画面依据，不是本次生成的提示词。对每个提示词问题（非INPUT）在promptEvidence中提供issueId和从当前prompt.content逐字摘取的具体excerpt。不能把上游visual的原句冒充提示词原句，不能只因上游描述末尾顺带提及屏显就推断当前提示词把屏显延迟。屏显时间以已确认performanceTimeline为准；提示词在独立声音/屏显区给出准确时间窗且画面段未另行改时完全合法，不要求每个时间段重复字幕持续说明。原句依据只能证明实际候选中的问题，语义仍须独立判断，不能因为能摘到文字就拒绝。没有问题返回promptEvidence空数组；上游实质不可执行问题明确INPUT，不能要求当前提示词修复上游。'''

PROMPT_REVIEW_CORE = '''checks准确覆盖原稿兑现、时间容量、镜头表达、产品事实、动作与空间、素材绑定、模型能力，各一次。核对提示词是否兑现result中已确认观看事件、cues.sourceText准确原句、performanceTimeline实际窗口及原有氛围。产品规格、端口数量、机械结构、充电状态与功效只用result.brief及素材明确事实；未知结构不因合理而补造。以当前提示词的实际动作与构图判断连续性，声音/动作可以并行，不能拿统一字数公式、最慢假设或个人镜头偏好拒绝。确定性矛盾/事实错误才ERROR，审美建议为WARNING；不要把上游的起止摘要或语序当作当前候选正文。能力标记尚待确认不等于拒绝合法文字计划。全部结论面向用户，以实际对象名称说明，不显示内部ID/REF。不声称看过未提供的图片、视频或口型。首次resolutions为空；复核逐一解决previousErrors，保留原问题身份和定级依据；发现首审误判通过severityChanges明确记录，不为凑修订夸大正常项。'''

def validate_prompt_audit_evidence(audit: dict[str, Any], prompt: dict[str, Any]) -> None:
    quotes = audit.get('promptEvidence')
    if not isinstance(quotes, list):
        raise ValueError('promptEvidence is required for the actual prompt review')
    seen: set[tuple[str, str]] = set()
    covered: set[str] = set()
    findings = {f['id']: f for f in audit['findings']}
    for quote in quotes:
        if quote['issueId'] not in findings:
            raise ValueError('prompt review quote refers to an unknown finding')
        if not quote['excerpt'].strip() or quote['excerpt'] not in prompt['content']:
            raise ValueError('review excerpt must be a verbatim quote from current prompt.content, not upstream visual or invented text')
        pair = (quote['issueId'], quote['excerpt'])
        if pair in seen:
            raise ValueError('duplicate prompt review quote for the same finding and excerpt')
        seen.add(pair)
        covered.add(quote['issueId'])
    if any(f['repairKind'] != 'INPUT' and f['id'] not in covered for f in findings.values()):
        raise ValueError('every prompt finding needs its exact current prompt.content excerpt')
