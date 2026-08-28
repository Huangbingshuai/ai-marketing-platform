from __future__ import annotations

from pathlib import Path

import pytest

from effect_prompt_generation.prompt_loader import (
    load_prompt,
    load_prompt_version,
    render_prompt,
)

ACTIVE_PROMPT_FILES = {
    "v11_creative_base.system.prompt.txt",
    "v11_creative_task.user.prompt.txt",
    "v11_creative_base_v4.system.prompt.txt",
    "v11_creative_task_v4.user.prompt.txt",
    "v11_evaluation_base.system.prompt.txt",
    "v11_evaluation_task.user.prompt.txt",
    "v11_fact_visual_strategy.system.prompt.txt",
    "v11_fact_visual_strategy.user.prompt.txt",
}


def test_prompt_directory_only_contains_active_v11_templates() -> None:
    prompt_dir = (
        Path(__file__).parents[1] / "src" / "effect_prompt_generation" / "prompts"
    )
    prompt_files = {path.name for path in prompt_dir.glob("*.prompt.txt")}

    assert prompt_files == ACTIVE_PROMPT_FILES


def test_v11_creative_task_renders_literal_json_inputs() -> None:
    rendered = render_prompt(
        "v11_creative_task.user.prompt.txt",
        task_briefs_json='[{"slotId":"slot-1","primaryFact":"广式腊肠"}]',
        shared_prompt_content_json='"画面中不得出现促销贴纸"',
        avoid_semantic_json="[]",
        avoid_visual_json="[]",
        rejection_reasons_json="[]",
        regeneration_context_json='{"instruction":"产品更早出现"}',
    )

    assert '"slotId":"slot-1"' in rendered
    assert '"instruction":"产品更早出现"' in rendered
    assert "促销贴纸" in rendered


def test_render_prompt_reports_a_template_variable_that_was_not_supplied() -> None:
    with pytest.raises(ValueError, match="missing prompt template variable"):
        render_prompt(
            "v11_creative_task.user.prompt.txt",
            task_briefs_json="[]",
        )


def test_v11_templates_keep_creative_generation_and_evaluation_independent() -> None:
    creative = load_prompt("v11_creative_base.system.prompt.txt")
    task = load_prompt("v11_creative_task.user.prompt.txt")
    evaluation = load_prompt("v11_evaluation_base.system.prompt.txt")

    assert (
        load_prompt_version("v11_creative_base.system.prompt.txt")
        == "effect-prompt-v11-coherent-creative-v3"
    )
    assert (
        load_prompt_version("v11_evaluation_base.system.prompt.txt")
        == "effect-prompt-v11-creative-evaluation-v4"
    )
    assert "Worker 已经为每条任务选好少量可信事实" in creative
    assert "厂商无关" in creative
    assert "每个任务都必须独立生成自己的一个 creativeCore" in creative
    assert "primaryFact 必须被正文真实表达" in creative
    assert "至少使用一个 productAnchorFact" in creative
    assert "supportFacts 只在有助于连贯表达时使用" in creative
    assert "productRelation" in creative
    assert "禁止给不同任务机械套用同一组" in creative
    assert "不是可拍画面" in creative
    assert "不能被写成肉眼已经证明" in creative
    assert "逐条创意事实简报" in task
    assert "已确认的产品事实" not in task
    assert "{facts_json}" not in task
    assert "不要按钩子、痛点、产品展示、卖点讲解、结尾转化或片尾品牌分组" in task
    assert "不要输出任何用途分类" in task
    assert "只是软避重参考" in task
    assert "只评估候选，不改写正文" in evaluation
    assert "五个窄职责视角" in evaluation
    assert "GENERIC_STYLE_STACKING" in evaluation
    assert "只有客观错误才能写入" in evaluation
    assert "一条素材可以有多个用途" in evaluation
    assert "evidenceText 必须逐字摘自正文" in evaluation


def test_visual_strategy_templates_separate_visual_task_from_business_context() -> None:
    compiler = load_prompt("v11_fact_visual_strategy.system.prompt.txt")
    creative = load_prompt("v11_creative_base_v4.system.prompt.txt")
    evaluation = load_prompt("v11_evaluation_base.system.prompt.txt")

    assert (
        load_prompt_version("v11_fact_visual_strategy.system.prompt.txt")
        == "effect-prompt-v11-fact-visual-strategy-v2"
    )
    assert (
        load_prompt_version("v11_creative_base_v4.system.prompt.txt")
        == "effect-prompt-v11-coherent-creative-v6"
    )
    assert "FORBIDDEN_VISUAL_PROOF" in compiler
    assert "不能凭成品的颜色、光泽、切面、纹理" in compiler
    assert "最多 30 个汉字" in compiler
    assert "采用短语而不是完整解释" in compiler
    assert "visualTask" in creative
    assert "businessContext" in creative
    assert "businessContext 未在正文中准确表达时不得声明" in creative
    assert "不是每条都必须拍出的卖点" in creative
    assert "不授权虚构品牌礼盒" in creative
    assert "必须标记 FABRICATED_FACT" in evaluation
    assert "ABSTRACT_FACT_VISUAL_PROOF" in evaluation
