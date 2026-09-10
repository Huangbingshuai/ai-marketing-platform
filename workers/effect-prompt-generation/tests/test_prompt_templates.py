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
    "creative_execution.system.prompt.txt",
    "execution_repair.system.prompt.txt",
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
    task = load_prompt("creative_task.user.prompt.txt")

    for template in (direction, supplement):
        assert "谁关心什么" in template
        assert "creativeDirection" in template
        assert "不增加输出字段或审核门槛" in template
    assert "不必每条都有痛点、反转或购买号召" in direction
    assert "不能依赖人物讲解、旁白或字幕完成产品表达" in direction
    assert "禁止人物口播、旁白、对镜讲解和字幕文案" in direction
    assert "相邻段落换观察面，明确切镜或连续路径" in creative
    assert "每个镜头段落统一确定相机与主体谁动" in creative
    assert "focus 单独写对焦对象与转移" in creative
    assert "不机械循环“中景—特写—推进”" in creative
    assert "不是当前商品事实，也不是固定脚本" in creative
    assert "不得成为其他任务的默认内容" in creative
    assert "静音状态下仍能被理解" in creative
    assert "节拍数量是软建议，不是配额" in creative
    assert "单一英雄事件" in creative
    assert "9～15 秒通常 1～2 个" in creative
    assert "不得为了观察内部而翻转已打开容器" in creative
    assert "不要求生成式视频精确保证" in creative
    assert "多人同框也可以承载关系" in creative
    assert "允许合理双手操作、跟拍和自然材料变化" in task
    assert "单一英雄事件" in direction
    assert "不要把多人轮流操作、多个工具接力" in direction
    assert "补充差异不能靠提高执行复杂度获得" in supplement
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
    assert "compatiblePurposes 只返回其他兼容用途" in evaluation
    assert "跨节拍核对同一主体的前后状态" in evaluation
    assert "不新增硬淘汰条件" in evaluation
    assert "HOOK、PRODUCT_DISPLAY、EFFECT、CTA" in evaluation
    assert "PAIN、" not in evaluation
    assert "SELLING_POINT_EXPLANATION" not in evaluation
    assert "OUTRO" not in evaluation
    assert "不要依赖原文字符重合" in evaluation
    assert "evidenceText 和 evidenceSource 可以省略" in evaluation
    assert (
        "CONTENT、CREATIVE_CORE、NARRATIVE、SCENE、PERSONA、PRODUCT_RELATION"
        in evaluation
    )
    assert "不要求重复同一问题码" in evaluation
    assert "相机与主体的相对运动" in evaluation
    assert "先固定再明确切换/移动也不误判" in evaluation
    assert "有初始推力不等于" in creative
    assert "SEMANTIC_FULL" in evaluation
    assert "PARTIAL" in evaluation


@pytest.mark.parametrize(
    "name",
    [
        "creative_landscape.system.prompt.txt",
        "creative_direction.system.prompt.txt",
        "creative_direction_supplement.system.prompt.txt",
        "creative_base.system.prompt.txt",
        "creative_task.user.prompt.txt",
        "execution_repair.system.prompt.txt",
    ],
)
def test_execution_guidance_handles_local_actions_and_material_evidence(name: str) -> None:
    template = load_prompt(name)
    assert "一次局部操作" in template
    assert "首帧" in template
    assert "浓稠、黏附或柔软" in template
    assert "拉丝" in template or "长丝" in template
    assert "相机" in template or "观察关系" in template
    assert len(load_prompt_hash(name)) == 64


def test_route_execution_suggestions_do_not_override_safe_creative_intent() -> None:
    creative = load_prompt("creative_base.system.prompt.txt")
    task = load_prompt("creative_task.user.prompt.txt")
    repair = load_prompt("execution_repair.system.prompt.txt")
    assert "输入优先级" in creative
    assert "具体拍法不是产品事实" in creative
    assert "必须以它为本条可见动作骨架" not in creative
    assert "风险路线允许等意图重设计" in creative
    assert "每条必须落实它自己的 executionRoute" not in task
    assert "必须逐项落实 creativeUsage" not in task
    assert "发生冲突时保留业务意图、改掉拍法" in task
    assert "双手支撑同一个物体是正常操作" in creative
    assert "多种用法是批次覆盖目标" in creative
    assert "task 中 executionRoute 的拍摄方法不是事实" in repair


def test_creative_guidance_is_compact_and_explains_support_and_observer_relationships() -> None:
    creative = load_prompt("creative_base.system.prompt.txt")
    assert len(creative) < 3500
    assert "factApplications.value" in creative
    assert "不能为自己推导的物性作证" in creative
    assert "已占用的手先放稳原物" in creative
    assert "焦点转移不会改变相机高度" in creative
    assert "不能正俯视不动却看清被遮住的底面" in creative
    assert "不把全批简化成夹起后悬停" in creative


def test_direction_ai_reviews_actual_routes_without_new_worker_semantic_gate() -> None:
    audit = load_prompt("creative_direction_audit.system.prompt.txt")
    assert "逐条看 executionRoutes 的实际事件" in audit
    assert "点名对应 revisionDirectionIds" in audit
    assert "不淘汰最终 Prompt" in audit
    assert "不能把路线自己的描述当证据" in audit
    assert "Worker 不做语义复判" in audit
    assert "固定相机与焦点转移" in audit
    assert "自然拉伸、滴落等不一律禁止" in audit
    assert "未写持握、支撑、机位和运动路径不构成问题" in audit


def test_intent_planning_does_not_lock_execution_and_editing_remains_sparse() -> None:
    for name in ["creative_landscape.system.prompt.txt", "creative_direction.system.prompt.txt",
                 "creative_direction_supplement.system.prompt.txt"]:
        prompt = load_prompt(name)
        assert "规划职责是“表达什么”" in prompt
        assert "正文模型" in prompt or "正文生成" in prompt
        assert "用固定观察位承接主动作" not in prompt
        assert "先采用固定观察位" not in prompt
    generation = load_prompt("creative_base.system.prompt.txt")
    assert "首帧状态→连续动作→结束状态" in generation
    assert "尤其工具从接触处撤离后才能闭合" in generation
    assert "每个镜头段落统一确定" in generation
    assert "固定并变焦、转焦" in generation
    editing = load_prompt("creative_execution.system.prompt.txt")
    assert "没有明确执行冲突时 decision=KEEP" in editing
    assert "未涉及的字段不要返回" in editing
    assert "多物体同时存在并不等于冲突" in editing
    assert "系统只按路径替换，不理解语义" in editing
    assert "不凭空添加机械臂" in editing
    for name in ["creative_base.system.prompt.txt", "creative_execution.system.prompt.txt"]:
        assert "紫苏梅子" not in load_prompt(name)
        assert "广式腊肠" not in load_prompt(name)


def test_landscape_template_distinguishes_compatible_and_primary_facts() -> None:
    landscape = load_prompt("creative_landscape.system.prompt.txt")
    assignment = load_prompt("creative_fact_territory_assignment.system.prompt.txt")
    audit = load_prompt("creative_landscape_audit.system.prompt.txt")

    assert "requiredFactIds 本阶段保持为空" in landscape
    assert "下一次独立 AI 调用" in landscape
    assert "不要输出 targetSlots" in landscape
    assert "当前输入只有产品基础与统一卖点列表" in landscape
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


def test_auto_style_adds_no_planning_constraint_while_fixed_style_is_preserved() -> (
    None
):
    auto = PromptBatchSettings(
        target_count=50,
        default_duration_seconds=15,
        style_mode="AI_AUTO",
        style_tone=None,
    )
    fixed = auto.model_copy(update={"style_mode": "FIXED", "style_tone": "清新田园"})

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
