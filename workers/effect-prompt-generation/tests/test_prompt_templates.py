from __future__ import annotations

from effect_prompt_generation.prompt_loader import load_prompt, load_prompt_version, render_prompt


def test_v3_templates_contain_six_specialized_system_prompts() -> None:
    strategy = load_prompt("strategy_planning.prompt.txt")
    base = load_prompt("candidate_base.system.prompt.txt")
    specialized = [
        "candidate_hook.system.prompt.txt",
        "candidate_pain.system.prompt.txt",
        "candidate_product_display.system.prompt.txt",
        "candidate_selling_point.system.prompt.txt",
        "candidate_cta.system.prompt.txt",
        "candidate_outro.system.prompt.txt",
    ]

    assert load_prompt_version("strategy_planning.prompt.txt") == "effect-prompt-strategy-v3"
    assert load_prompt_version("candidate_base.system.prompt.txt") == "effect-prompt-candidate-base-v1"
    assert '"evidencePlans"' in strategy and '"actions"' in strategy
    assert "低质量反例" in strategy and "提交前逐项自检" in strategy
    assert "产品上下文是唯一事实来源" in base
    for template_name in specialized:
        template = load_prompt(template_name)
        assert template.count("合格示例") >= 2
        assert "职责冲突反例" in template
        assert "效果展示片段" not in template


def test_candidate_template_renders_literal_example_json_and_product_context() -> None:
    rendered = render_prompt(
        "candidate_task.user.prompt.txt",
        aspect_ratio="9:16",
        delivery_channels="抖音",
        visual_style="明亮生活化",
        disabled_elements_json='["医疗暗示"]',
        product_context_json='{"productName":"便携杯","coreSellingPoints":["单手开合"]}',
        combinations_json='[{"slotId":"slot-1"}]',
    )

    assert '"productName":"便携杯"' in rendered
    assert '"slotId":"slot-1"' in rendered
