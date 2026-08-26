from __future__ import annotations

from effect_prompt_generation.prompt_loader import (
    load_prompt,
    load_prompt_version,
    render_prompt,
)


def test_quality_v4_templates_contain_six_specialized_system_prompts() -> None:
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

    assert (
        load_prompt_version("strategy_planning.prompt.txt")
        == "effect-prompt-strategy-v7"
    )
    assert (
        load_prompt_version("candidate_base.system.prompt.txt")
        == "effect-prompt-candidate-base-v8"
    )
    assert (
        load_prompt_version("candidate_task.user.prompt.txt")
        == "effect-prompt-candidate-task-v9"
    )
    assert "evidencePlans" in strategy and "relationshipBundles" in strategy
    assert "fragmentStrategyPools" in strategy
    assert all(
        field in strategy
        for field in (
            "openingStates",
            "actionArcs",
            "cameras",
            "emotions",
            "endingStates",
        )
    )
    assert "usedFactIds" in base
    assert "六类独立动作语法" in strategy and "提交前静默检查" in strategy
    assert "产品上下文是唯一事实来源" in base
    assert "纯净原始画面" in base
    assert "4～5 秒为 80～150" in base
    expected_versions = {
        "candidate_hook.system.prompt.txt": "effect-prompt-candidate-hook-v4",
        "candidate_pain.system.prompt.txt": "effect-prompt-candidate-pain-v3",
        "candidate_product_display.system.prompt.txt": "effect-prompt-candidate-product-display-v3",
        "candidate_selling_point.system.prompt.txt": "effect-prompt-candidate-selling-point-v4",
        "candidate_cta.system.prompt.txt": "effect-prompt-candidate-cta-v5",
        "candidate_outro.system.prompt.txt": "effect-prompt-candidate-outro-v4",
    }
    for template_name in specialized:
        template = load_prompt(template_name)
        assert template.count("合格示例") >= 2
        assert "职责冲突反例" in template
        assert "效果展示片段" not in template
        assert load_prompt_version(template_name) == expected_versions[template_name]


def test_candidate_template_renders_literal_example_json_and_product_context() -> None:
    rendered = render_prompt(
        "candidate_task.user.prompt.txt",
        delivery_channels="抖音",
        visual_style="明亮生活化",
        shared_prompt_json='{"compiledContent":"画面中不得出现促销贴纸"}',
        product_context_json='{"productName":"便携杯","coreSellingPoints":["单手开合"]}',
        combinations_json='[{"slotId":"slot-1"}]',
        regeneration_context_json='{"instruction":"产品更早出现"}',
    )

    assert '"productName":"便携杯"' in rendered
    assert '"slotId":"slot-1"' in rendered
    assert '"instruction":"产品更早出现"' in rendered
    assert "促销贴纸" in rendered
    assert "9:16" not in rendered
    assert "医疗暗示" not in rendered
