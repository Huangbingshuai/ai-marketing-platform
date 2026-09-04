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
    "creative_fact_territory_assignment.system.prompt.txt",
    "creative_fact_territory_assignment.user.prompt.txt",
    "creative_landscape.system.prompt.txt",
    "creative_landscape.user.prompt.txt",
    "creative_landscape_audit.system.prompt.txt",
    "creative_landscape_audit.user.prompt.txt",
    "creative_direction_audit.system.prompt.txt",
    "creative_direction_audit.user.prompt.txt",
    "creative_direction_diversity_audit.system.prompt.txt",
    "creative_direction_diversity_audit.user.prompt.txt",
    "creative_direction_supplement.system.prompt.txt",
    "creative_direction_supplement.user.prompt.txt",
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
        task_briefs_json='[{"slotId":"slot-1","factApplications":[],"coverageFocusFactIds":[]}]',
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
    assert "不能成为画面中的口播、字幕、人物台词或动作说明" in creative
    assert "逐条事实任务简报" in task
    assert "已确认的产品事实" not in task
    assert "{facts_json}" not in task
    assert "不要按素材用途分组" in task
    assert "只是软避重参考" in task
    assert "同一创意方向下的兄弟变体" in task
    assert "coverageFocusFactIds 为空表示常规生成" in task
    assert "创意主线的中心" in task
    assert "不得只替换形容词" in task
    assert "不要把“当前画面不证明配方/工艺/功效”" in task
    assert "只评估候选，不改写正文" in evaluation
    assert "五个窄职责视角" in evaluation
    assert "GENERIC_STYLE_STACKING" in evaluation
    assert "只有事实编造、商品完全无关" in evaluation
    assert "一条素材可以有多个用途" in evaluation
    assert "HOOK、PRODUCT_DISPLAY、EFFECT、CTA" in evaluation
    assert "PAIN、" not in evaluation
    assert "SELLING_POINT_EXPLANATION" not in evaluation
    assert "OUTRO" not in evaluation
    assert "不要依赖原文字符重合" in evaluation
    assert "evidenceText 和 evidenceSource 可以省略" in evaluation
    assert "SEMANTIC_FULL" in evaluation
    assert "PARTIAL" in evaluation


def test_landscape_template_distinguishes_compatible_and_primary_facts() -> None:
    landscape = load_prompt("creative_landscape.system.prompt.txt")
    assignment = load_prompt("creative_fact_territory_assignment.system.prompt.txt")
    audit = load_prompt("creative_landscape_audit.system.prompt.txt")

    assert "requiredFactIds 本阶段保持为空" in landscape
    assert "下一次独立 AI 调用" in landscape
    assert "不要输出 targetSlots" in landscape
    assert "产品信息解释、原料理念、工艺故事或消费决策空间" in landscape
    assert "不得为了覆盖把配方挂到储存" in landscape
    assert "必须分配的业务事实" in assignment
    assert "必须且只能输出一次" in assignment
    assert "不修改空间，也不生成最终视频 Prompt" in assignment
    assert "max(1, ceil(事实数/4))" in assignment
    assert "不能因为“无法视觉证明”这一点单独判为问题" in audit
    assert "若被挂到储存、送礼、分享、采购等无关动作" in audit


def test_direction_and_landscape_templates_receive_density_rules() -> None:
    direction = render_prompt(
        "creative_direction.user.prompt.txt",
        target_count="50",
        target_direction_count="13",
        direction_output_instruction="首次输出完整方向",
        fact_density_instruction="每个方向必须自然使用 2～4 条业务事实",
        facts_json="[]",
        fact_visual_strategy_json="[]",
        shared_prompt_json='""',
        visual_style_baseline_json='"未设置"',
        delivery_channel_json='"抖音"',
        creative_landscape_json="[]",
        revision_context_json="{}",
    )
    landscape = render_prompt(
        "creative_landscape.user.prompt.txt",
        target_direction_count="13",
        territory_count_range="1～10",
        required_fact_ids_json="[]",
        facts_json="[]",
        fact_visual_strategy_json="[]",
        shared_prompt_json='""',
        visual_style_baseline_json='"未设置"',
        delivery_channel_json='"抖音"',
        revision_context_json="{}",
    )

    assert "本批事实密度要求" in direction
    assert "每个方向必须自然使用 2～4 条业务事实" in direction
    assert "本批创意空间容量范围：1～10" in landscape
    assert "空间数量必须位于 1～10 之间" in landscape
    assert "每 4 条事实增加一个方向槽位" in landscape


def test_territory_audit_template_receives_real_business_inputs() -> None:
    rendered = render_prompt(
        "creative_landscape_audit.user.prompt.txt",
        facts_json='[{"factId":"F1","value":"真实卖点"}]',
        fact_visual_strategy_json='[{"factId":"F1","visualUsage":"CONTEXT_ONLY"}]',
        creative_territory_json='{"territoryId":"T1","label":"家庭备餐"}',
    )

    assert '"factId":"F1"' in rendered
    assert '"territoryId":"T1"' in rendered
    assert "facts_json" not in rendered
    assert "creative_territory_json" not in rendered


def test_fact_territory_assignment_receives_required_and_supporting_facts() -> None:
    rendered = render_prompt(
        "creative_fact_territory_assignment.user.prompt.txt",
        target_direction_count="13",
        required_facts_json='[{"factId":"F1","value":"核心卖点"}]',
        supporting_facts_json='[{"factId":"F2","value":"产品外观"}]',
        fact_visual_strategy_json='[{"factId":"F1"}]',
        territories_json='[{"territoryId":"T1"}]',
        revision_context_json="{}",
    )

    assert '"factId":"F1"' in rendered
    assert '"factId":"F2"' in rendered
    assert "辅助理解事实" in rendered


def test_visual_strategy_templates_keep_direction_fact_applications_without_role_split() -> (
    None
):
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
    assert "factEvidence" not in creative
    assert "productSnapshot 仅用于确认商品名称、品类、规格和外观边界" in creative
    assert "visualTask" not in creative
    assert "businessContext" not in creative
    assert "必须标记 FABRICATED_FACT" in evaluation
    assert "ABSTRACT_FACT_VISUAL_PROOF" in evaluation
    assert "abstractVisualProofFindings" in evaluation
    assert "Worker 只校验 factId 与枚举合法" in evaluation
    assert "factEvidence 因为画面不能证明抽象事实而标记 PARTIAL/NONE" in evaluation
    assert "不得同时写入 ABSTRACT_FACT_VISUAL_PROOF" in evaluation
