from __future__ import annotations

from pathlib import Path

import pytest

from effect_prompt_generation.models import PromptBatchSettings
from effect_prompt_generation.pipeline import _style_instruction
from effect_prompt_generation.prompt_loader import (
    load_prompt,
    load_prompt_hash,
    render_prompt,
)
from effect_prompt_generation.providers import _visual_style_baseline_section

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
    "creative_landscape_batch_audit.system.prompt.txt",
    "creative_landscape_batch_audit.user.prompt.txt",
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


def test_director_guidance_uses_existing_fields_without_fixed_ad_formula() -> None:
    creative = load_prompt("creative_base.system.prompt.txt")
    direction = load_prompt("creative_direction.system.prompt.txt")
    supplement = load_prompt("creative_direction_supplement.system.prompt.txt")

    for template in (direction, supplement):
        assert "谁关心什么" in template
        assert "creativeDirection" in template
        assert "不增加输出字段或审核门槛" in template
    assert "不必每条都有痛点、反转或购买号召" in direction
    assert "不能依赖人物讲解、旁白或字幕完成产品表达" in direction
    assert "禁止人物口播、旁白、对镜讲解和字幕文案" in direction
    assert "同一连续事件允许合理切镜" in creative
    assert "固定机位与一镜到底同样可以有力" in creative
    assert "焦点落在哪里" in creative
    assert "不机械循环“中景—特写—推进”" in creative
    assert "不是当前商品事实，也不是固定脚本" in creative
    assert "不得成为其他任务的默认内容" in creative
    assert "静音状态下仍能被理解" in creative
    assert "节拍数量是软建议，不是配额" in creative
    assert "不输出 content" in creative


def test_templates_keep_creative_generation_and_evaluation_independent() -> None:
    creative = load_prompt("creative_base.system.prompt.txt")
    direction = load_prompt("creative_direction.system.prompt.txt")
    task = load_prompt("creative_task.user.prompt.txt")
    evaluation = load_prompt("evaluation_base.system.prompt.txt")

    assert len(load_prompt_hash("creative_base.system.prompt.txt")) == 64
    assert len(load_prompt_hash("evaluation_base.system.prompt.txt")) == 64
    assert "厂商无关" in creative
    assert "一次性生成同一创意下的 creativeCore、六维信息和结构化 shotPlan" in creative
    assert "declaredFactIds 必须完整返回" in creative
    assert "productSnapshot" in creative
    assert "factApplications" in creative
    assert "productRelation" in creative
    assert "一个主要地点" in creative
    assert "不能伪装成画面已经证明" in creative
    assert "shotPlan 必须能直接交给视频模型执行" in creative
    assert "禁止人物讲话、对镜讲解、逐字台词" in creative
    assert "开始构思前先做真实性预检" in creative
    assert "使用字面、具体、可拍的描述" in creative
    assert "首帧" in creative
    assert "节拍数量是软建议，不是配额" in creative
    assert "禁止补造包装透明度、开启结构、取用剂量、使用频率" in creative
    assert "只有 factApplications 明确支持未成年人时才能出现未成年人" in creative
    assert "不输出 content" in creative
    assert "不得让滴管、吸管、刀具或手指穿过未打开的封口" in direction
    assert "不得从规格、包装或受众偏好延伸出未确认的用量" in direction
    assert "逐条事实任务简报" in task
    assert "已确认的产品事实" not in task
    assert "{facts_json}" not in task
    assert "软避重" in task
    assert "同一方向下的兄弟变体" in task
    assert "coverageFocusFactIds 非空时" in task
    assert "焦点事实放入创意主线" in task
    assert "不能复用同一画面骨架后只换措辞" in task
    assert "最终只返回 JSON Schema 要求的字段" in task
    assert "TEXT_ONLY 事实只保留为后续成片文案依据" in task
    assert "SPEECH_DEPENDENT_MATERIAL" in evaluation
    assert "不要通过关键词机械判断" in evaluation
    assert "只评估候选，不改写正文" in evaluation
    assert "五个窄职责视角" in evaluation
    assert "GENERIC_STYLE_STACKING" in evaluation
    assert "只有事实编造、商品完全无关" in evaluation
    assert "先做真实性预检，再评分" in evaluation
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
    assert "产品信息、消费决策、使用、购买、情绪和人物需求" in landscape
    assert "消费决策或品牌语境" in landscape
    assert "TEXT_ONLY" in landscape
    assert "后续成片文案" in landscape
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
        execution_route_count="4",
        direction_output_instruction="首次输出完整方向",
        fact_density_instruction="每个方向必须自然使用 2～4 条业务事实",
        facts_json="[]",
        fact_visual_strategy_json="[]",
        shared_prompt_json='""',
        visual_style_baseline_section="",
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
        visual_style_baseline_section="",
        delivery_channel_json='"抖音"',
        output_scope_instruction="本次是首次规划，输出完整创意版图。",
        revision_context_json="{}",
    )

    assert "本批事实密度要求" in direction
    assert "每个方向必须自然使用 2～4 条业务事实" in direction
    assert "本批创意空间容量范围：1～10" in landscape
    assert "空间数量必须位于 1～10 之间" in landscape
    assert "局部修订时，只返回“输出范围”点名的空间" in landscape
    assert "每 4 条事实增加一个方向槽位" in landscape


def test_auto_style_adds_no_planning_constraint_while_fixed_style_is_preserved() -> None:
    auto = PromptBatchSettings(
        target_count=50,
        default_duration_seconds=15,
        style_mode="AI_AUTO",
        style_tone=None,
    )
    fixed = auto.model_copy(
        update={"style_mode": "FIXED", "style_tone": "清新田园"}
    )

    assert _style_instruction(auto) == ""
    assert _visual_style_baseline_section(_style_instruction(auto)) == ""

    fixed_section = _visual_style_baseline_section(_style_instruction(fixed))
    assert "整批采用清新田园作为共享视觉基调" in fixed_section
    assert "只影响光线、色彩、材质和镜头质感" in fixed_section


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
    assert "productSnapshot 只用于确认商品名称、品类、规格、外观和包装边界" in creative
    assert "不能把一般体验、常识或创作推断说成该商品的事实" in creative
    assert "审核解释，都不得出现在字幕或画面中" in creative
    assert "visualTask" not in creative
    assert "businessContext" not in creative
    assert "必须标记 FABRICATED_FACT" in evaluation
    assert "ABSTRACT_FACT_VISUAL_PROOF" in evaluation
    assert "abstractVisualProofFindings" in evaluation
    assert "Worker 只校验 factId 与枚举合法" in evaluation
    assert "factEvidence 因为画面不能证明抽象事实而标记 PARTIAL/NONE" in evaluation
    assert "不得同时写入 ABSTRACT_FACT_VISUAL_PROOF" in evaluation
    assert "上述具体信息未被事实直接支持时属于 FABRICATED_FACT" in evaluation
    assert "容量可用时长" in evaluation
    assert "未成年人只有在该候选分配事实明确支持时才可出现" in evaluation
    assert "内部审核说明" in evaluation
