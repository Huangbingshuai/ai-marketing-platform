from __future__ import annotations

from effect_prompt_generation.prompt_loader import load_prompt, load_prompt_version, render_prompt


def test_v3_templates_contain_single_fragment_examples_and_self_checks() -> None:
    strategy = load_prompt("strategy_planning.prompt.txt")
    candidate = load_prompt("candidate_generation.prompt.txt")

    assert load_prompt_version("strategy_planning.prompt.txt") == "effect-prompt-strategy-v3"
    assert load_prompt_version("candidate_generation.prompt.txt") == "effect-prompt-candidate-v3"
    assert '"evidencePlans"' in strategy and '"actions"' in strategy
    assert "低质量反例" in strategy and "提交前逐项自检" in strategy
    for field in ('"slotId"', '"promptText"'):
        assert field in candidate
    for forbidden in ('"creativeCore"', '"shots"', '"negativeConstraints"'):
        assert forbidden not in candidate
    assert "产品上下文是唯一事实来源" in candidate
    assert "低质量反例" in candidate and "提交前逐条自检" in candidate


def test_candidate_template_renders_literal_example_json_and_product_context() -> None:
    rendered = render_prompt(
        "candidate_generation.prompt.txt",
        duration_seconds="5",
        aspect_ratio="9:16",
        delivery_channels="抖音",
        visual_style="明亮生活化",
        disabled_elements_json='["医疗暗示"]',
        product_context_json='{"productName":"便携杯","coreSellingPoints":["单手开合"]}',
        combinations_json='[{"slotId":"slot-1"}]',
    )

    assert '"slotId":"<原样返回slotId>"' in rendered
    assert '"productName":"便携杯"' in rendered
    assert '"slotId":"slot-1"' in rendered
