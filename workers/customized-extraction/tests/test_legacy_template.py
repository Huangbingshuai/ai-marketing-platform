from typing import Any
from pathlib import Path

from customized_extraction.documents import (
    filled_template_text,
    template_candidate,
    restore_docx_form_linebreaks,
    restore_selling_point_sources,
)

DOC: dict[str, Any] = {"assetId": "document", "assetVersion": 1}


def test_legacy_and_mixed_labels_use_semantic_mapping_without_example_columns() -> None:
    text = (
        "# 已填写简报\n"
        "| 填写项 | 填写内容 | 备注 / 示例 |\n"
        "| --- | --- | --- |\n"
        "| 项目名称 | 青梅酱短片 | 示例项目 |\n"
        "| 品牌或产品介绍 | 青梅果肉、白砂糖；200g | 有机认证示例 |\n"
        "| 目标人群年龄 | 25–40岁 | 18岁示例 |\n"
        "| 主色调偏好 | 琥珀色<br>米白 | 荧光绿示例 |"
    )
    assert template_candidate(text, DOC) is None
    sanitized = filled_template_text(text)
    assert "青梅酱短片" in sanitized
    assert "青梅果肉、白砂糖；200g" in sanitized
    assert "25–40岁" in sanitized
    assert "琥珀色\n米白" in sanitized
    assert "示例" not in sanitized


def test_empty_legacy_rows_do_not_force_model_or_import_examples() -> None:
    text = "| 填写项 | 填写内容 | 示例 |\n| 品牌或产品名称 | | 示例品牌 |"
    candidate = template_candidate(text, DOC)
    assert candidate is not None
    assert not any(candidate.fields.model_dump().values())
    assert "示例品牌" not in filled_template_text(text)


def test_free_document_is_preserved() -> None:
    text = "产品：青梅酱。\n| 规格 | 200g | 每瓶 |"
    assert filled_template_text(text) == text
    assert template_candidate(text, DOC) is None


def test_standard_form_appendix_is_not_discarded() -> None:
    text = "| 填写项 | 填写内容 | 示例 |\n| 产品名称 | 折叠灯 | 陶瓷杯 |\n\n产品规格：2400mAh。"
    assert template_candidate(text, DOC) is None
    assert "2400mAh" in filled_template_text(text)
    assert "陶瓷杯" not in filled_template_text(text)


def test_only_form_tables_strip_example_columns() -> None:
    text = "| 填写项 | 填写内容 | 示例 |\n| 产品名称 | 折叠灯 | 陶瓷杯 |\n\n| 部件 | 材质 | 颜色 |\n| --- | --- | --- |\n| 灯罩 | 聚碳酸酯 | 暖白色 |"
    assert template_candidate(text, DOC) is None
    sanitized = filled_template_text(text)
    assert "| 灯罩 | 聚碳酸酯 | 暖白色 |" in sanitized
    assert "陶瓷杯" not in sanitized


def test_fusion_reindexes_unchanged_facts_using_verified_inputs_only() -> None:
    first = template_candidate("| 填写项 | 填写内容 |\n| 核心卖点 | 含青梅果肉 |", DOC)
    second = template_candidate(
        "| 填写项 | 填写内容 |\n| 核心卖点 | 瓶盖有防拆封环 |",
        {**DOC, "assetId": "second"},
    )
    assert first and second
    fused = first.model_copy(deep=True)
    fused.fields.sellingPoints.append(second.fields.sellingPoints[0])
    fused.fieldSources.sellingPoints.extend(second.fieldSources.sellingPoints)
    # Both inputs use local zero; the final two facts need indexes zero and one.
    assert [s.itemIndex for s in fused.fieldSources.sellingPoints] == [0, 0]
    restored = restore_selling_point_sources(fused, [first, second])
    assert [(s.assetId, s.itemIndex) for s in restored.fieldSources.sellingPoints] == [
        ("document", 0),
        ("second", 1),
    ]
    fused.fields.sellingPoints[1] = "改写后不确定对应关系的卖点"
    fused.fieldSources.sellingPoints = first.fieldSources.sellingPoints
    restored = restore_selling_point_sources(fused, [first, second])
    assert [s.itemIndex for s in restored.fieldSources.sellingPoints] == [0]


def test_docx_explicit_linebreaks_restore_three_independent_selling_points() -> None:
    path = (
        Path(__file__).parents[3]
        / "docs/workflows/customized/templates/视频创作简报填写示例.docx"
    )
    flattened = (
        "| 填写项 | 填写内容 | 备注 / 示例 |\n"
        "| 核心卖点 | 弧形把手，便于持握 300 mL 容量，适合日常盛放咖啡 米白色杯身，便于搭配简洁餐桌 | 不应提取 |"
    )
    restored = restore_docx_form_linebreaks(flattened, path.read_bytes())
    candidate = template_candidate(restored, DOC)
    assert candidate is not None
    assert candidate.fields.sellingPoints == [
        "弧形把手，便于持握",
        "300 mL 容量，适合日常盛放咖啡",
        "米白色杯身，便于搭配简洁餐桌",
    ]
    assert [s.itemIndex for s in candidate.fieldSources.sellingPoints] == [0, 1, 2]


def test_docx_linebreak_restore_does_not_replace_changed_or_free_values() -> None:
    path = (
        Path(__file__).parents[3]
        / "docs/workflows/customized/templates/视频创作简报填写示例.docx"
    )
    markdown = "# 普通正文\n| 核心卖点 | 修改后的内容 |"
    assert restore_docx_form_linebreaks(markdown, path.read_bytes()) == markdown
