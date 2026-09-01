from __future__ import annotations

from pathlib import Path

import pytest

from effect_prompt_generation.prompt_loader import (
    load_prompt,
    load_prompt_hash,
    render_prompt,
)

ACTIVE_PROMPT_FILES = {
    "creative_base.system.prompt.txt",
    "creative_task.user.prompt.txt",
    "creative_direction.system.prompt.txt",
    "creative_direction.user.prompt.txt",
    "evaluation_base.system.prompt.txt",
    "evaluation_task.user.prompt.txt",
    "fact_visual_strategy.system.prompt.txt",
    "fact_visual_strategy.user.prompt.txt",
}


def test_prompt_directory_only_contains_active_templates() -> None:
    prompt_dir = (
        Path(__file__).parents[1] / "src" / "effect_prompt_generation" / "prompts"
    )
    prompt_files = {path.name for path in prompt_dir.glob("*.prompt.txt")}

    assert prompt_files == ACTIVE_PROMPT_FILES


def test_creative_task_renders_literal_json_inputs() -> None:
    rendered = render_prompt(
        "creative_task.user.prompt.txt",
        task_briefs_json='[{"slotId":"slot-1","factApplications":[]}]',
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
            "creative_task.user.prompt.txt",
            task_briefs_json="[]",
        )


def test_templates_keep_creative_generation_and_evaluation_independent() -> None:
    creative = load_prompt("creative_base.system.prompt.txt")
    task = load_prompt("creative_task.user.prompt.txt")
    evaluation = load_prompt("evaluation_base.system.prompt.txt")

    assert len(load_prompt_hash("creative_base.system.prompt.txt")) == 64
    assert len(load_prompt_hash("evaluation_base.system.prompt.txt")) == 64
    assert "厂商无关" in creative
    assert "每个任务独立生成一个 creativeCore" in creative
    assert "declaredFactIds 必须完整返回" in creative
    assert "productSnapshot" in creative
    assert "factApplications" in creative
    assert "productRelation" in creative
    assert "一个主要地点" in creative
    assert "不能伪装成画面已经证明" in creative
    assert "逐条事实任务简报" in task
    assert "已确认的产品事实" not in task
    assert "{facts_json}" not in task
    assert "不要按六类用途分组" in task
    assert "只是软避重参考" in task
    assert "只评估候选，不改写正文" in evaluation
    assert "五个窄职责视角" in evaluation
    assert "GENERIC_STYLE_STACKING" in evaluation
    assert "只有事实错误、商品完全无关、结构破损或客观无法生成才能写入" in evaluation
    assert "一条素材可以有多个用途" in evaluation
    assert "evidenceText 必须逐字摘自正文、creativeCore 或六维字段" in evaluation
    assert "SEMANTIC_FULL" in evaluation
    assert "PARTIAL" in evaluation


def test_visual_strategy_templates_keep_direction_fact_applications_without_role_split() -> None:
    compiler = load_prompt("fact_visual_strategy.system.prompt.txt")
    creative = load_prompt("creative_base.system.prompt.txt")
    evaluation = load_prompt("evaluation_base.system.prompt.txt")

    assert len(load_prompt_hash("fact_visual_strategy.system.prompt.txt")) == 64
    assert len(load_prompt_hash("creative_base.system.prompt.txt")) == 64
    assert "FORBIDDEN_VISUAL_PROOF" in compiler
    assert "不能凭成品的颜色、光泽、切面、纹理" in compiler
    assert "最多 30 个汉字" in compiler
    assert "采用短语而不是完整解释" in compiler
    assert "factApplications" in creative
    assert "productSnapshot" in creative
    assert "factEvidence" in creative
    assert "productSnapshot 仅用于确认商品名称、品类、规格和外观边界" in creative
    assert "visualTask" not in creative
    assert "businessContext" not in creative
    assert "必须标记 FABRICATED_FACT" in evaluation
    assert "ABSTRACT_FACT_VISUAL_PROOF" in evaluation
    assert "abstractVisualProofFindings" in evaluation
    assert "Worker 只验证引用和原文是否存在" in evaluation
