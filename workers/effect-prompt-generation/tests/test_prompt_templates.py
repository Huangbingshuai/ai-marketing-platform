from __future__ import annotations

from effect_prompt_generation.prompt_loader import (
    load_prompt,
    load_prompt_version,
    render_prompt,
)

import pytest


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
        == "effect-prompt-strategy-v8"
    )
    assert (
        load_prompt_version("candidate_base.system.prompt.txt")
        == "effect-prompt-candidate-base-v9"
    )
    assert (
        load_prompt_version("candidate_task.user.prompt.txt")
        == "effect-prompt-candidate-task-v9"
    )
    assert "relationshipBundles" in strategy
    assert "bundleId、fragmentType 和 factIds" in strategy
    assert "fragmentStrategyPools" not in strategy
    assert all(
        field not in strategy
        for field in (
            "openingStates",
            "actionArcs",
            "cameras",
            "emotions",
            "endingStates",
        )
    )
    assert "usedFactIds" in base
    assert "每类生成 1～4 个关系束" in strategy and "提交前静默检查" in strategy
    assert "产品上下文是唯一事实来源" in base
    assert "纯净原始画面" in base
    assert "4～5 秒为 80～150" in base
    expected_versions = {
        "candidate_hook.system.prompt.txt": "effect-prompt-candidate-hook-v5",
        "candidate_pain.system.prompt.txt": "effect-prompt-candidate-pain-v3",
        "candidate_product_display.system.prompt.txt": "effect-prompt-candidate-product-display-v4",
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


def test_v10_template_does_not_reparse_inserted_json_or_hash_as_variables() -> None:
    allocation_hash = "d2ed72ccd1c7367fe0fc8bcb9041653a74f6949dbfde30d3becf4f12734039c0"
    rendered = render_prompt(
        "v10_relationship_task.user.prompt.txt",
        fragment_type="PRODUCT_DISPLAY",
        target_count="12",
        bundle_target="4",
        mandatory_fact_ids_json='["fact-1"]',
        candidate_facts_json='[{"factId":"fact-1","value":"真空袋装"}]',
        shared_prompt="保持真实材质",
        allocation_hash=allocation_hash,
    )

    assert allocation_hash in rendered
    assert f"{{{allocation_hash}}}" not in rendered
    assert '"factId":"fact-1"' in rendered


def test_render_prompt_reports_a_template_variable_that_was_not_supplied() -> None:
    with pytest.raises(ValueError, match="missing prompt template variable: target_count"):
        render_prompt(
            "strategy_planning.prompt.txt",
            insight_json="{}",
        )
