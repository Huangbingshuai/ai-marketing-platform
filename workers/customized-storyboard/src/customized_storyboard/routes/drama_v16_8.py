"""Drama screenplay timing is advisory before actual shot planning."""
from .drama_v16_7 import (
    DEVELOP, SELECT, REVIEW, DEVELOPMENT_HISTORY, DEVELOPMENT_BRIEF_FIELDS, DEVELOPMENT_FACT_FIELDS,
)
from .drama_v16_6 import WRITE, OBSERVATION, REPAIR, REPAIR_CAPACITY, FOCUSED_REVIEW

STORY_DURATION_ADVISORY = True
FACT_REVIEW = '''核对完整简报与完整短剧正文的产品事实、明确品牌约束和用户自定义结构，不评价创意题材。
本节点是分镜前的完整剧本，篇章不是固定时长镜头，精确动作/对白时长由后续分镜制作安排。不要要求篇章时长、按字速推算最低秒数或因缺少精确计时判ERROR；表达密度和节奏偏好可写简短WARNING，不能据此阻断剧本。
允许荒诞、夸张、幻想、拟人和不符合现实常识的戏剧设定，角色的误会或蠢话不自动当产品功能承诺；不要为了现实主义改掉创意。只在作品确实把未确认的性能、功效、认证、测试等当真实产品事实宣传，或违背明确品牌禁令时给具体ERROR。已知名称、规格、外观不写错，但不要求全展示。
结构要求只核对用户实际指定的R编号和正文，系统编排没有附加结构清单。ERROR给原文、来源/约束依据和实际beatIds，shotIds为空；普通可润色处只提醒，建议简短。无问题给实际核对结论，不为了严格而臆造缺陷。'''
