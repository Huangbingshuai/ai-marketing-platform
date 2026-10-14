"""Type-aware creative writing. Reference time is advisory, never a repair quota."""
from __future__ import annotations
import re
from typing import Any, TYPE_CHECKING
from .models import Story
from .screenplay import ScreenplayDraft, review_context
if TYPE_CHECKING:
    from .pipeline import Pipeline

PROFILES = {
    "ECOMMERCE": "电商带货：围绕清楚的购买理由设计吸引点、产品价值及行动引导。可以用演示、对比、口播等表达，不强制人物故事或全规格解说。价格、优惠、测评及背书必须有资料依据。",
    "LOCAL_STORE": "同城到店：围绕值得到店的理由、空间体验、服务价值展开。不能凭空编造门店地址、营业信息、活动、价格、服务和真实顾客证言；资料未提供时在对应正文明确待补充内容，不冒充真实门店。",
    "BRAND_AD": "品牌广告：先设计一个鲜明而具体的视觉创意或主题表达，再围绕它展开视觉篇章，建立产品与品牌的记忆。允许无人、无对白、抽象空间和视觉隐喻；隐喻不能冒充产品真实能力。不强加生活人物、冲突、接线操作或购买号召。",
    "DRAMA": "剧情短片：以有欲望与动机的人物、值得观看的冲突、选择及变化展开。产品自然参与事件，不是机械地拿取、使用、收纳。对白有潜台词和人物差异，避免流水账、说教、尴尬反转或无关煽情。",
}

CONCEPT = """联合规划每个scriptId的一份完整视频脚本，数量准确，按settings.videoType执行相应创作方法。
每份明确coreIdea核心创意、openingHook开场吸引点、productRole产品参与方式、memoryPoint记忆点，
给出可展开的synopsis和structure。差异体现在表达机制、观看体验与品牌/产品关联，不只是更换人物职业地点。
existingConcepts仅用于避重，不能将旧短剧当范本。不要求每份覆盖全部卖点，不把资料中的限制清单写成创意主体。
若指定structureSections，按给定顺序逐段展开，不能另起一套结构；没有指定时系统自行编排。
参考时长仅用于内容规模，不能为凑秒数重复动作。先比较并优化本批构思，淘汰流水账和生硬植入，再输出这些数量的最终方案。
构思阶段只确定各段的表达内容，不预分配秒数、不在synopsis和structure锁定“30秒”等总时长；具体预计时长由完整正文按实际容量计算，不能把构思时间表当硬约束。
品牌广告不必制造人物事件；剧情必须有可理解的动机与变化；带货要讲清价值；到店要有资料支持的体验依据。
"""

FORMAT = """写可直接阅读的完整视频脚本，不能只写概述、策划意图或镜头表。
每个beats项是一个完整传播段落、视觉篇章或剧情场次，id按P01、P02连续编号，content格式为：
P01｜篇章标题

充分展开的实际画面内容、动作与变化。需要时明确旁白、人物对白、环境声音及画面文字。
按所选视频类型组织正文：视觉篇章不强加内外景/人物，剧情可以在正文交代地点时间和对白。
指定structureSections时一项对应一篇章，标题逐字采用对应结构项且顺序一致；段内允许多个合理场景。
默认系统编排时自行决定篇章，不套用固定短剧模板。不写逐镜景别、运镜或生成提示词。
durationSeconds是按实际画面、动作、口播容量估算的时长，必须为正数；参考时长是软约束，允许合理浮动。
先按自然语速、完整数字读法、文字停留和实际动作估时，再填写每段durationSeconds；禁止先分完参考秒数再往里塞内容。
当指定结构较多或真实信息复杂时，优先选择少量适合本片的事实并展开，必要时主动增加预计时长；不为了恰好合计参考时长省略必要时间。
预计时长可以明显长于参考时长。旁白按清晰自然口播估算，通常每秒3至4个汉字只是参考，数字、英文和符号须展开实际读法，再留停顿、画面理解及不能并行的动作时间。
不要在每段反复讲全部规格与免责信息，不把“已确认”“不虚构认证”等内部审核说明写成消费者旁白；用实际内容保证准确即可。
不能为凑时长填充、重复、压缩动作，不因几秒差异重写。单篇章不超过3600秒，全稿预计合计不超过3600秒。
opening/development/ending/dialoguePlan仅作辅助说明，正文全部放beats.content，不重复输出content。
产品事实、品牌约束、禁用元素以brief为准；不编造认证、疗效、充电速度、价格、店铺、销量和用户评价。
未明确提供的内部结构、端口左右上下位置、支持协议及性能条件不能自行确定；产品的已知事实与可设计视觉表现严格分开。
产品的连接与使用状态须物理成立：例如插脚合回或收纳前必须先把充电器拔离电源，不能只拔设备线就合起仍插在墙面的插脚。可明确剪辑省略，但切前切后状态及关键动作不能矛盾。
用户指定的背书/到店等段落如缺依据，可保留标题、采用真实资料支持的表达，并明确待补充事项；不得虚构填空。
"""

REVIEW = """独立审校完整视频脚本，而非仅检查格式。beats为全文，shotIds必须为空。
按视频类型评价：带货的吸引点与购买理由；到店的体验价值和资料依据；品牌广告的核心视觉创意、主题推进与记忆点；剧情的人物动机、冲突、选择、变化和对白。
核对构思承诺是否真的落实，指定结构各段是否在正文有实际内容且顺序正确，方案之间是否只有换名换地点。
整篇只是产品操作流水账、空泛口号堆叠、没有展开正文、与所选类型明显不符、未落实指定结构、严重生硬植入等实质问题为ERROR，引用具体篇章与正文并给可执行建议。
一般审美偏好或轻微优化为WARNING，不能因为不同风格或无人物无对白判错；正常时说明具体检查结论。
严重程度必须按实质判定：新增未确认的产品事实、规格、结构位置、认证或功效为FACT/ERROR，即便一句话能改好也不能降为WARNING。
动作/口播/字幕实际无法容纳于段落估时、产品状态或空间缺乏可理解衔接为STORY/ERROR；必须修订正文或增加真实预计时长，而非建议后仍通过。
逐次核对产品从接入到断开的完整状态，设备线与电源连接分别核对；充电器仍在墙插时折叠插脚、收纳等物理矛盾必须ERROR，明确拔离电源后才可合脚，不因短片剪辑而略过关键安全动作。
WARNING仅限不影响事实正确性、结构执行和实际理解的审美偏好。每项问题引用确切正文和依据，简明描述，不重复整篇脚本。
核对事实及品牌约束、语言可说性、视觉/叙事连续性。创作隐喻不当作事实；禁止把隐喻写成真实产品性能。
参考时长是软约束，不因总秒数差异提出修订；仍检查估计时长与实际文字、画面容量是否合理。
不要求覆盖全部卖点，不用关键词、固定字数或强制反转评判。缺失背书等资料不能虚构。
"""

REPAIR = """按具体ERROR修订实质问题，保留正常创意、真实事实与所选类型，按指定有序结构同步全文及concept。
参考时长是软约束，重新估算实际内容时长，不为凑秒数改变正文。不要用增加泛泛对白、过密收尾或重复产品操作补齐时长。
审校建议的秒数也只是参考，必须自己按修订后实际口播读法、文字停留和动作容量重新核算全部段落，给足自然节奏与停顿余量；不能把原来不够的时长小幅增加后仍塞入原内容。
先选择删去非必要重复信息或给出充分真实时长；若保留长段数字说明，必须允许其完整读听和看清，不能在收束段累积全部收纳动作。
保持P编号和指定结构标题，重新检查全篇连贯性；不因为审校意见而切换视频类型。
"""

def profile(settings: dict[str, Any]) -> str:
    return PROFILES.get(settings.get("videoType", "BRAND_AD"), PROFILES["BRAND_AD"])

def video_script_issues(story: Story, sections: list[str]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    if story.content != "\n\n".join(b.content.strip() for b in story.beats):
        issues.append({"code": "BODY_SECTION_MISMATCH"})
    if sections and len(story.beats) != len(sections):
        issues.append({"code": "STRUCTURE_SECTION_COUNT"})
    if sum(b.durationSeconds for b in story.beats) > 3600:
        issues.append({"code": "CAPACITY_LIMIT"})
    for i, beat in enumerate(story.beats):
        expected = f"P{i+1:02d}"
        if beat.id != expected or not re.fullmatch(rf"{expected}[｜|][^\n]+\n\n[\s\S]*\S", beat.content.strip()):
            issues.append({"code": "SECTION_FORMAT", "section": expected})
        elif sections and (i >= len(sections) or beat.content.splitlines()[0][4:].strip() != sections[i].strip()):
            issues.append({"code": "STRUCTURE_ORDER", "section": expected})
    return issues

async def generate_video_script(p: Pipeline, sid: str, context: dict[str, Any]) -> Story:
    saved = p.checkpoints.get(("STORY", sid))
    if saved and saved["status"] == "SUCCEEDED":
        return Story.model_validate(saved["output"])
    partial = saved.get("output") if saved else None
    await p.step("STORY", sid, "RUNNING")
    instruction = profile(p.input["settings"]) + FORMAT
    story = (Story.model_validate(partial["rejectedStory"]) if isinstance(partial, dict) and "rejectedStory" in partial
             else (await p.model("STORY", ScreenplayDraft, context, instruction)).story())
    issues = video_script_issues(story, p.input["settings"].get("structureSections", []))
    if issues:
        if isinstance(partial, dict) and partial.get("correctionComplete"):
            raise ValueError("video script format correction exhausted")
        await p.step("STORY", sid, "RUNNING", {"rejectedStory": story.model_dump(), "correctionComplete": False})
        story = (await p.model("STORY", ScreenplayDraft, {**context, "story": review_context(story, True), "validationIssues": issues}, instruction + "仅修正结构编号、标题顺序与缺失正文，不因参考秒数差异修改。" )).story()
        await p.step("STORY", sid, "RUNNING", {"rejectedStory": story.model_dump(), "correctionComplete": True})
        if video_script_issues(story, p.input["settings"].get("structureSections", [])):
            raise ValueError("video script format correction exhausted")
    await p.step("STORY", sid, "SUCCEEDED", story.model_dump())
    return story
