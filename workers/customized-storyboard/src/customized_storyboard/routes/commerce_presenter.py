"""Presenter recommendation: a person speaks to the audience, supported by demonstrations."""
from ..models import Model
from ..commerce_development import Short
from ..presenter_development import Development, DEVELOP_CORE, SELECT_CORE, WRITE_CORE
from .ecommerce_v1 import OBSERVATION as OBSERVATION

class Approach(Model):
    speaker: Short
    recommendation: Short
    speechAndVisual: Short

DEVELOPMENT = Development[Approach]
DEVELOP = '专门策划口播带货。speaker定义讲述者、面对谁和自然口吻；recommendation写连贯推荐理由；speechAndVisual说明哪些由人物说、哪些用产品近景或操作支撑。人物直接向观众推荐是主体，不是旁白配静物。软件可结合屏幕、大件可站旁介绍，不要求拿在手里。创意从具体买前提问、实物选择或观察发展，不能仅念规格。\n' + DEVELOP_CORE
SELECT = '独立筛选口播方案。核对讲述关系、推荐逻辑、具体吸引点及演示分工；有完整自然可说的推进，不以旁白操作说明冒充人物推荐，不选虚构亲测与万能口号。\n' + SELECT_CORE
WRITE = '本稿为口播带货。人物明确对观众说话，写出实际完整口播，开场和收束保留人物讲述，产品演示穿插支撑推荐。自然短句、有具体利益，不一句一参数、不表演亲测经历或喊“闭眼入”。不能为删字退化成全片旁白。\n' + WRITE_CORE
REVIEW = '''只依据实际正文验收口播带货，不读策划替作者作证。
BUYING_REASON：人物是否确实对目标观众推荐，口播是否自然连贯且解释为什么值得考虑；只有参数旁白或一两句叫卖不足。
VALUE_DEMONSTRATION：具体吸引点是否在正文兑现，讲述与产品画面是否共同支撑购买理解；清楚解释真实选择依据可以成立，不强迫每句话做实验，也不要求全部卖点。
INFORMATION_CAPACITY：实际说话、停顿、演示和阅读能否容纳，是否重复、书面、被无关参数挤占。参考总时长是软约束。
三项按顺序，用正文编号证据；创意或讲述主体的贯穿缺失为STRUCTURAL，不以口味偏好拒稿。事实、功效、价格与能力由独立事实侧检查。'''
