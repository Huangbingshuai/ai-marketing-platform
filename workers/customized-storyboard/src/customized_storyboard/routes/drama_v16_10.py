"""Body mechanism diagnosis before editorial quality labels."""
from .drama_v16_9 import DEVELOP, WRITE, REPAIR, PREMISE_FIRST
from .drama_v16_8 import FACT_REVIEW, STORY_DURATION_ADVISORY
from .drama_v16_7 import DEVELOPMENT_BRIEF_FIELDS, DEVELOPMENT_FACT_FIELDS
from .drama_v16_6 import REPAIR_CAPACITY, FOCUSED_REVIEW, DEVELOPMENT_HISTORY

MECHANISM_AUDIT = True

SELECT = '''独立选择最值得展开的实际故事点子，准确绑定selectionCount/scriptIds，不改写原案。先比较具体观看事件与结尾，不将因果完整、参数准确或职业合理当创意质量。
主要发展若只是角色问答功能、依次猜规格/试用、调整连接，最后补好人身份/感谢/和解，就是讲解套情绪外壳；先判断整个点子去掉说明书后还剩什么具体剧情，不拿“有温度、有误会”作辩护。真有人物交锋、信息错位、行动回应、喜剧规则或悬念发展则按实际安排判断，不禁止温暖、认领或测试题材。
允许荒诞幻想不现实，品牌克制不是创意保守。比较本项目既有同类型稿的事件与收束，软避重，不因共同地点/产品而拒绝。每案给简短具体取舍，mustPreserve只保留2至4个实际看点/铺垫/回收，不把数字和功能列成任务。无成熟点子可整组REWORK，不硬选最不差者；缺真正关键事实才NEEDS_INFORMATION。'''

REVIEW = '''同一次请求，先给mechanism的可核对正文诊断，再给qualityChecks，不输出内部推理。
mainLine用普通动词简述全文主要事件，不能写“充满温度/体现信任”等评价。dialogueMode判断大部分对白的实际工作：DRAMATIC_EXCHANGE为实际交锋/试探/误导/回应/喜剧规则驱动剧情；EXPOSITORY_SPINE为主要发展靠问答参数、操作解释、展示理解正确，再加薄弱的人情外壳；真正没对白才NO_DIALOGUE。dialogueEvidenceIds选1至3条代表性实际段落，dialogueReason说清主导作用，不凭一条有利话盖过全文。
把说明包装成考试、认领、调查、面试或朋友聊天，不自动产生戏剧性。判断的是正文是否真的推进角色打算或观众信息，不是“该职业有没有理由讲参数”。若多个角色仅轮流报特点、被纠正或证明记得说明书，之后靠临时外部信息揭晓主人/好人，问答本身仍是EXPOSITORY_SPINE。数字被当台词梗也不能自动免责；若确实造成独特的误导、交锋和后果，可以是DRAMATIC_EXCHANGE，须引用实际发展而非脑补。
endingMode判断结尾与此前主线：DEVELOPED_PAYOFF有实际行为/规则/线索/信息在前后得到回应，endingSetupEvidenceId选真实铺垫、endingEvidenceId选收束；EMOTIONAL_COVER是前面主要解释演示，最后临时加善举身份、感谢、亲情理解或旁白升华来替代主线收获；开放但有意留下未决体验可OPEN_OR_UNRESOLVED。没有铺垫时setup为空，不可编造。单纯“监控/第三人说他其实是好人”解释失物来源，不等于为前面参数问答提供了情绪或人物铺垫。
自然温暖不是问题：前面实际的留饭/等待/拒绝/试探等行为在结尾被重新理解，且对白在交往，可正常通过。荒诞与幻想也可在自己的规则里回收，无须现实合理、人物成长、产品不可替代或强制反转。不要把上述例子移入待评正文。
三项qualityChecks依次CHARACTER_CAUSALITY/NATURAL_DIALOGUE/PRODUCT_CAUSALITY。前两项对应实际剧情推进及对白工作，EXPOSITORY_SPINE必须使对白FAIL，EMOTIONAL_COVER必须使剧情FAIL，不能用总体好评覆盖结构诊断。必要一句说明和局部润色不算主导缺陷。产品具体参与或自然有意义地使用即可，不强求救场，事实另查。
mechanism中每项Reason与Revision一句话，结构问题给实际可执行的修改方向，正常项Revision可空；额外findings仅列其他实质语言/叙事错误。温柔语气、职业合理、对质形式和正面价值不能单独证明剧情精彩。'''

OBSERVATION = '''先做全文机制诊断，再独立选择实际原文evidenceId支持三项qualityChecks；每项observed/limitation/suggestion短而具体，不重复复述正文。NONE为无实质问题、LOCAL_PREFERENCE为局部润色、STRUCTURAL为主导对白/关键推进/收束失效。DEMONSTRATED为正文实有表现，CONTRADICTED/NOT_DEMONSTRATED为实质反证/未体现；结构诊断不能在最后被降成偏好。幻想和温暖均按实际展开判断，不输出题材禁令或额外反转要求。'''
