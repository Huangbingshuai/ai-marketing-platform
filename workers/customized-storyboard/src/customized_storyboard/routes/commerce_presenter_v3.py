"""Presenter recommendations establish actual operating premises before showing results."""
from .commerce_presenter_v2 import DEVELOPMENT as DEVELOPMENT, SELECT as SELECT, REVIEW as REVIEW, OBSERVATION as OBSERVATION
from .commerce_presenter_v2 import DEVELOP as PREVIOUS_DEVELOP, WRITE as PREVIOUS_WRITE

PREMISES = '''演示须先建立真实工作前提：明确所需能源、连接、输入材料或权限已具备，才出现相应结果。展示状态和工作状态分清；手持、放桌面展示不等于产品已在运行。正常剪辑可省略重复过程，但不能省掉全篇从未建立且决定因果的必要前提，不凭空增加未知能力。适用于所有产品，不套用某个品类示例。'''
DEVELOP = PREMISES + '\n' + PREVIOUS_DEVELOP.replace('、剧情带货或促销', '或剧情带货')
WRITE = PREMISES + '\n动笔前核对演示起点和结果之间的完整依赖，直接在相关画面交代必要前提，不靠事后长免责声明弥补。修订重读未改段落的前后状态，保留真实可执行的演示。\n' + PREVIOUS_WRITE
