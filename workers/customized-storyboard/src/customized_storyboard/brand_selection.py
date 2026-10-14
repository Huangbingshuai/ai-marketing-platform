"""Select existing creative work without asking the judge to rewrite a second proposal."""
from typing import Annotated, Literal
from pydantic import Field
from .models import Model, Id
from .brand_development import BrandDevelopment, BrandSelection, BrandEvaluation, BrandCommitment, Short


class LeanBrandSelection(Model):
    status: Literal['READY', 'REWORK', 'NEEDS_INFORMATION']
    reason: Short
    missing: Annotated[list[Id], Field(max_length=20)]
    evaluations: Annotated[list[BrandEvaluation], Field(min_length=6, max_length=8)]
    commitments: Annotated[list[BrandCommitment], Field(max_length=5)]


def expand_selection(value: LeanBrandSelection, development: BrandDevelopment) -> BrandSelection:
    """Copy AI-authored fields into the public legacy projection; no semantic invention."""
    ideas = {i.id: i for i in development.ideas}
    concepts = []
    for choice in value.commitments:
        if choice.ideaId not in ideas:
            raise ValueError('unknown brand idea')
        idea = ideas[choice.ideaId]
        concepts.append({
            'scriptId': choice.scriptId, 'name': idea.name,
            'synopsis': '\n'.join(idea.keyImages), 'structure': '\n'.join(idea.keyImages),
            'productFocus': idea.productRole, 'difference': choice.reason,
            'coreIdea': idea.mechanism, 'openingHook': idea.viewingHook,
            'productRole': idea.productRole, 'memoryPoint': idea.memory,
            'plan': {'videoType': 'BRAND_AD', 'brandImpression': development.proposition.message,
                'visualConcept': idea.mechanism, 'visualProgression': '\n'.join(idea.keyImages),
                'productConnection': idea.productRole, 'ending': idea.memory},
        })
    return BrandSelection.model_validate({**value.model_dump(), 'concepts': concepts})

INSTRUCTION = """
本次仅输出评选结论、各候选评估和所选创意保留清单。Schema没有concepts，不重新写概述、标题、完整计划或其他策划字段；系统直接保留候选的原始关键画面、机制、产品作用与记忆点，交给正文创作展开。commitments只约定本来已成立的创意关键点，不附加新功能教学。保持原审校门槛，不因输出更短而放宽判断。每个reason以一至两句具体画面依据说明，避免重复复述简报。
"""
