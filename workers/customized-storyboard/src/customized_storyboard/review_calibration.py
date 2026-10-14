"""Observable editorial decisions projected into the existing public review contract."""
from typing import Annotated, Literal
from pydantic import Field
from .models import Model, Text, Id
from .review_evidence import EvidenceReview, resolve_evidence
from .typed_creation import QualityCriterion, TypedFinding, TypedReviewV4


class ObservedDecision(Model):
    criterion: QualityCriterion
    evidenceId: Text
    observed: Text
    limitation: Text
    suggestion: Text
    defectScope: Literal['NONE', 'LOCAL_PREFERENCE', 'STRUCTURAL']
    assessment: Literal['DEMONSTRATED', 'CONTRADICTED', 'NOT_DEMONSTRATED', 'NOT_APPLICABLE']


class ObservedReview(Model):
    routeId: Literal['ECOMMERCE', 'LOCAL_STORE', 'BRAND_AD', 'DRAMA']
    qualityChecks: Annotated[list[ObservedDecision], Field(min_length=3, max_length=3)]
    findings: Annotated[list[TypedFinding], Field(max_length=1000)]
    summary: Text


class EditorialFinding(TypedFinding):
    shotIds: Annotated[list[Id], Field(max_length=0)]


class EditorialReview(ObservedReview):
    findings: Annotated[list[EditorialFinding], Field(max_length=1000)]  # type: ignore[assignment]


def resolve_observations(review: ObservedReview, sources: dict[str, tuple[str, str]]) -> TypedReviewV4:
    checks = []
    for item in review.qualityChecks:
        if not item.observed.strip():
            raise ValueError('quality observation is empty')
        failed = item.assessment in {'CONTRADICTED', 'NOT_DEMONSTRATED'} or item.defectScope == 'STRUCTURAL'
        if failed and (not item.limitation.strip() or not item.suggestion.strip()):
            raise ValueError('quality defect needs concrete limitation and correction')
        checks.append({
            'criterion': item.criterion, 'evidenceId': item.evidenceId,
            'reason': item.observed + ('\n不足：' + item.limitation if item.limitation.strip() else ''),
            'suggestion': item.suggestion,
            'verdict': 'FAIL' if failed else ('NOT_APPLICABLE' if item.assessment == 'NOT_APPLICABLE' else 'PASS'),
        })
    return resolve_evidence(EvidenceReview.model_validate({
        **review.model_dump(exclude={'qualityChecks'}), 'qualityChecks': checks,
    }), sources)


OBSERVATION_INSTRUCTION = """本次使用可观察结果审校，不直接填写verdict/reason。每个qualityChecks先选真实evidenceId，observed用一两句话描述该标准在正文实际如何体现（不是作者想表达什么），limitation简述反例、缺失或“无实质缺陷”，再给assessment。
DEMONSTRATED=全文确实体现该项标准；CONTRADICTED=正文存在实质反证；NOT_DEMONSTRATED=只有宣告/解释，实际没有体现；NOT_APPLICABLE仅用于真正没有对白的NATURAL_DIALOGUE。
找不到有力的正面证据时引用暴露缺口的真实段落，不编造、不默认通过。不因某一段看似成立就忽略主导全文的缺陷。存在反证/未体现将触发现有一次定向修订，须给具体建议；没有实质缺陷可通过，不强制挑错。
defectScope用于区分局部口味与整体缺陷：NONE没有实质不足；LOCAL_PREFERENCE只是一句/一个局部可以更好而不影响整体成立；STRUCTURAL是反复贯穿多个篇章、驱动关键转折或承担主要表达的缺陷。STRUCTURAL不能以其符合人物职业或产品事实正确为由降成偏好，会直接进入修订。如对白承担主题解释、以产品操作类比处世准则贯穿转折、再以认可收尾，应判NATURAL_DIALOGUE的STRUCTURAL；角色职业允许说这种话，并不解决全片在给观众上课的问题。
品牌片先用普通动词归纳实际动作顺序。若是辨认外观—展示特征—操作—反向操作收回，即使闭环、触感、识别色或连续运动拍得精美，也仍是操作演示。其VISIBLE_CONCEPT/VISUAL_PROGRESSION属STRUCTURAL缺陷；拿“从取出到收回”和“逐次接入/点击/涂抹”本身证明发展是错误的放行。需要正文中在演示之外建立并改变/揭示一个具体关系；可以很简单、写实，不必超现实。不能凭审校自己联想到的象征意义替作者补全。
校准标准不依赖产品类别：人物在使用护肤品后连续说“修复皮肤也修复关系”、对方复述同一道理，不能仅凭温柔语气判对白自然；预约软件依次点击功能再配“从容”的字幕，不能仅凭页面变化判品牌概念成立。反之，人物没有说教而通过行动回应误会、产品参与具体生活细节，可以成立；食物留下的形状在前后场景中形成可见关联并在片尾回收，也可以成立。例子只解释门槛，不得将其故事、产品或视觉形式植入当前正文。
每项判断必须针对完整实际正文。品牌的三项分别看表达关系、关系发展、结尾回收；剧情分别看人物选择及后果、对白的交往目的与潜台词、产品的可信实际参与。事实准确、标题好听和有动作不能代替这些标准。summary最后只总结实际审校结果，不为已经写出的总体好评辩护。输出短结论和正文依据，不输出内部思维过程。"""
