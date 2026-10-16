"""Distinguish a publishable dramatic experience from coherent product operations."""
from .drama_v16_9 import DEVELOP, WRITE, REPAIR, PREMISE_FIRST
from .drama_v16_8 import FACT_REVIEW, STORY_DURATION_ADVISORY
from .drama_v16_7 import DEVELOPMENT_BRIEF_FIELDS, DEVELOPMENT_FACT_FIELDS
from .drama_v16_6 import REPAIR_CAPACITY, FOCUSED_REVIEW, DEVELOPMENT_HISTORY
from .drama_v16_10 import SELECT, OBSERVATION, REVIEW as MECHANISM_REVIEW

MECHANISM_AUDIT = True
MERIT_AUDIT = True

REVIEW = '''验收目标是可以采用的原创产品短剧，不只是“剧情逻辑通顺”。先输出viewingValue，再诊断机制和给三项质量判断，同一次请求完成。
viewingEvent用一句普通话说明观众除了了解/正确使用产品，还看到了什么具体戏剧体验；若只有技术取舍、任务完成、人物善良，要诚实这样写，不自行补“默契、温度、信任”。classification区分DRAMA_DRIVEN与EXPLANATION_WITH_PLOT_WRAP：前者由实际人物交锋、独特信息错位、喜剧规则或被具体行为发展的情绪驱动；后者主要是为说明特征/使用规则安排职业、截止期、问答、测试或认领，再点缀一句关照/赞许/感谢/善举。这是在判断表达主线，不是限制题材。
因果完整、参数影响行动、职业有理由说说明、末尾回收一个物件，最多证明流程成立，不能单独证明达到短剧质量。EXPLANATION_WITH_PLOT_WRAP必须使CHARACTER_CAUSALITY为FAIL，即使对白在任务情境中看似合理、或结尾有形式回收；reason给正文主导模式，evidenceId选代表片段，revision要求实际改变推进而非删除几个数字。
判断薄弱人情点缀与真实情绪发展：如果去掉大段功能问答，只剩“我看你热”“原来是好人”“谢谢”，没有实际展开的人物反应与变化，不能拿这一点小善意放行。若整篇动作/误会/交流都在发展那份情绪，结尾只是揭示之前留下的具体行为，则可以DRAMA_DRIVEN。安静、温暖、日常不等于平庸，不要求必须离谱。
校准例仅解释门槛，不可植入当前稿：弱例是人物依次讲容量/材质/用法、解释后完成工作、最后感谢体贴，或轮流报商品特点认物、末尾突然说主人热心；职业、认物目的及善举并不能抵消讲解主导。成立例是裁缝嫌孩子画的线歪，却反复在布角留下那条线，结尾翻开衣领看见它被绣成孩子的名字；或月亮向天文台请病假，职员拿星星补缺口，它躲在窗外偷看，最后偷偷把请假单改成半天。其情绪/荒诞规则才是发展主线，产品自然参与就可成立。
不要用“有事件、有操作、有起承转合”代替创作质量判断，也不要强行判所有稿失败。允许幻想、不现实和开放结尾，不审核现实可行性。所有Reason/Revision一句话，输出短业务结论，不输出内部推理。单个evidenceId只选一条给定编号，不把多个编号拼成字符串；多个对白依据放在dialogueEvidenceIds数组。
''' + MECHANISM_REVIEW
