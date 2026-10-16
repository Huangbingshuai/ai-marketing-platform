"""Free premise first; product specs belong to expansion and factual verification."""
from .drama_v16_6 import WRITE, OBSERVATION, FACT_REVIEW, REPAIR, REPAIR_CAPACITY, FOCUSED_REVIEW

DEVELOPMENT_HISTORY = True
DEVELOPMENT_BRIEF_FIELDS = (
    'brandName', 'brandTone', 'productName', 'productDescription', 'productAppearance',
    'sellingPoints', 'targetAudience', 'visualConsistencyRules', 'avoidedElements',
)
DEVELOPMENT_FACT_FIELDS = ('productName', 'productDescription', 'productAppearance', 'sellingPoints')

DEVELOP = '''为简报产品想candidateCount个原创短剧点子。先想故事，后整理字段；不是把产品说明书编成有人的演示流程。
自由发挥想象：奇怪但有趣的处境、人物或身份反差、令人好奇的信息、荒诞世界、幽默误会、悬念、反转、情绪都可以。现实生活同样可以精彩，不强制奇幻，也不强制温情和解或人物成长。产品围绕其已知特点自然宣传即可，不要求它不可替代或解决人物一生。
先在viewingPromise用80至160字直接讲清这个独特的故事点子：什么有趣的事发生了，它怎样发展，最后带来怎样的惊讶、笑点或余味。读这段就能想象一部短剧，不用先看规格清单。不要把“任务赶不赶得上、资源分不分得够、功能好不好用”本身当成全部看点；具体人物交往、信息反差或非写实设定可以由你任意创造。短剧可以宣传功能，不能只为读参数设置一个假危机。
再把同一个原案整理到plan：主体打算、阻力、关系、起因、变化、行动、结果与具体产品关联。informationDesign写观众如何得到新信息，dialogueIntent写角色此刻的意图，emotionalMovement写观看体验，weakness如实指出最易失效处。devices是创作手法，如对话、幽默、悬念或反转，反转须有前置线索；这里不填写手机电脑等设备。手法不是五选一或配额。
每案围绕一个适合参考规模的主点子，候选互相探索不同事件或表达，不靠换职业地点。existingConcepts只作同类故事软避重，不能把旧稿的参数争用/赶工机制换皮当新创意。
factCatalog是产品依据的边界而非剧情提纲，factIds保留相关原ID。完整规格和项目展示要求由后续正文读取，不在这里自行猜造。明确幻想、拟人、象征可以大胆，不能冒充真实产品功效或测试。真正缺关键产品资料才NEEDS_INFORMATION并ideas为空，创意问题自己解决。'''

SELECT = '''你是独立短剧开发主编，先读各案viewingPromise中的原始故事点子，再核对plan是否真的兑现了它，选择准确selectionCount并绑定scriptIds，不重写原案。
判断具体的观看吸引力、变化和结尾收获；自由题材按自己的表达方式评估，不套统一成长、和解或反转模板。保留大胆而成立的创意，一般可润色处不必推翻。反转看前置线索与推断链，幻想看自身规则，不当作现实功能。
参数准确、操作完成、任务赶上截止时间本身不足以证明有短剧看点。若人物只问答使用方法，功能限制制造压力、解释后解决，缺少实际交往变化、幽默预期、悬念发现或其他具体叙事体验，应REJECT，而不是写“有完整因果所以通过”。不要求这些手法全部出现，也不要求强冲突。
产品自然参与有意义的场景即可，不要求不可替代；也不能为展现规格制造不可信困境。比较已有同类型稿的核心事件和表达，避免同构换皮。每案给简短实际理由，选中保留2至4项真正构成看点的情节/表现，不把功能覆盖和参数字幕列成必须兑现清单。整组确实不成熟才REWORK；真的缺事实才NEEDS_INFORMATION。'''

REVIEW = '''独立阅读实际完整正文，按该短剧自己的表达验收，不替作者从辅助概述里补充看点。
CHARACTER_CAUSALITY：正文实际有什么值得观看的具体事件、变化和结尾体验？幽默、机锋、悬念、反转、情绪、荒诞和幻想都允许，现实克制也允许，不强制成长、和解或固定结构。若全部推进是功能不足制造截止期压力、讲解参数、调整用法、任务完成，即使因果完整仍没有兑现短剧看点。只有原文确有另外成立的交往、信息变化或表达体验才通过，不能脑补“默契/信任”。
NATURAL_DIALOGUE：关键台词符合角色当下意图和表达风格，产生交流与反应；风格化或拟人对白不强行改成日常话。必要一句产品信息可用，但主要戏份是问答参数、角色充当产品讲师，应判实质不足，不能只用职业身份或任务需要辩护。人生总结不是结尾的替代物；无对白才NOT_APPLICABLE。
PRODUCT_CAUSALITY：产品与具体故事的宣传关联是否自然清楚？真实使用、外观识别、习惯、关键道具及明确非写实设计都可以，不强求产品造成关系转折或不可替代。只有孤立贴标、硬塞说明或没有实际关联才需修。技术事实由事实侧独立检查，正确参数不能替创意作证。
影响可读可演的错字、说话者、指代和叙事矛盾给具体ERROR；普通偏好只提醒。依据必须来自正文，建议尽量保留原有亮点，结论简短，不重复全文或同一问题。'''
