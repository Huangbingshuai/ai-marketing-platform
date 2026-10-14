"""Persist a compact, genuinely alternative slate before expanding selected concepts."""
from typing import Annotated
from pydantic import Field, model_validator
from typing_extensions import Self
from .models import Model, Id


class CreativeOption(Model):
    name: Id
    openingEvent: Id
    development: Id
    endingEvent: Id
    productParticipation: Id
    weakness: Id


class CreativeSlate(Model):
    options: Annotated[list[CreativeOption], Field(min_length=3, max_length=7)]

    @model_validator(mode='after')
    def unique_names(self) -> Self:
        if len({x.name for x in self.options}) != len(self.options):
            raise ValueError('creative options require distinct identities')
        return self


INSTRUCTION = """先做创作开发，不写正式方案、规格说明或逐镜表。输出本次指定数量的简短候选方向，每份用可观察事件写openingEvent/development/endingEvent、实际productParticipation及最值得警惕的weakness。
先想到具体的人或物发生什么，再说明产品为什么参与。候选之间改变事件、关系或表达机制，不用换职业、场地、角色名、颜色或同义词充数。每份只抓必要事实，未选择的规格不是遗漏；明确的资料要求仍在最终成稿落实。
不要给候选写一遍全部参数/完整使用流程。品牌要有使用流程之外的画面关系变化；剧情要有选择、后果和未说破的关系，不能用人物讲道理、演示正确操作后被赞许做结局。
不强迫奇观、拟人、反转或喜剧。后续会再对照全部已有方案择优；当前existingTitles仅用于避免名称复用，不用历史故事作为创作模板。每份四个事件字段简洁但具体，不写推理过程。"""

DEVELOPMENT = """
创作开发门槛：简报中的规格为事实边界，不是镜头清单。先选一个值得观看的观察、矛盾或关系，确定观众如何在过程中发现新的含义，再让必要的产品事实进入其中。各候选要是不同的表达机制，不是同一使用流程换三处场景。
评估候选时剥去标题、品牌形容词和作者解释，只看实际事件。品牌的“没有用→开始用→用完收回”“脏→清洁→收好”“逐个功能接入/展示”本身都是常规使用，不能因为状态变化、前后闭环、音乐或好看的构图就升级成品牌概念。需要真实写出的另一层可见关系，例如视角揭示改变前面画面的理解，重复元素在不同情境产生新关联，或人物/环境的回应使同一动作有新的意义；这些只是判断例，不要求套用任何一种。
剧情比较人物的具体愿望、关键行为的代价与后果、对白在当下争取或回避什么。若靠反复总结主题、职业说理、参数科普和获得认可撑起转折，候选还不成熟。
择优不是必须从弱候选里选一个。若整组只是操作流程、换职业地点、给主题加标签，全部淘汰，直接在本次构思中发展新方向；最终只输出成熟且足量的方案，不把淘汰过程或内部思考写入结果。保留简报明确约束，不借创意虚构性能。不强制所有卖点上屏，不用产品功能教人生道理，不强迫奇观或反转。
"""
