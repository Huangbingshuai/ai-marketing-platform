from __future__ import annotations

import pytest

from effect_extraction.models import ExtractionCandidate, ExtractionResult
from effect_extraction.prompt_loader import load_prompt_template, load_prompt_version, render_prompt


def test_effect_extraction_prompts_load_independently_by_file_name() -> None:
    document = load_prompt_template("document_extraction.prompt.txt")
    image = load_prompt_template("image_analysis.prompt.txt")
    normalization = load_prompt_template("result_normalization.prompt.txt")

    assert load_prompt_version("document_extraction.prompt.txt") == "1.0.0"
    assert load_prompt_version("image_analysis.prompt.txt") == "1.1.0"
    assert load_prompt_version("result_normalization.prompt.txt") == "1.1.0"

    assert "产品文档信息抽取器" in document.template
    assert "产品图片" in image.template
    assert "营销信息标准化与策略补全器" in normalization.template

    for prompt in (document.template, image.template, normalization.template):
        assert "只输出一个 JSON 对象" in prompt
        assert "## 输出示例" in prompt
        assert "示例输出：" in prompt
        assert "## 输出前自检" in prompt
        assert '"productCategory"' in prompt
        assert '"coreSellingPoints"' in prompt
        assert '"disabledElements"' in prompt

    assert "无明确证据的字符串字段写 null" in document.template
    assert "价格、人群、营销目标、场景、品牌调性和创意卖点属于允许补全" in image.template
    assert "可补全的营销策略字段" in normalization.template
    assert "建议" in image.template and "需确认" in image.template
    assert "建议" in normalization.template and "需确认" in normalization.template
    assert '"priceRange": null' in document.template
    assert '"visualFeatures": "红褐色长条腊肠' in image.template
    assert '"priceRange": "建议零售价 35～59 元/500g' in normalization.template

    candidate_fields = ExtractionCandidate.model_json_schema(by_alias=True)["properties"]
    result_fields = ExtractionResult.model_json_schema(by_alias=True)["properties"]
    for field_name in candidate_fields:
        assert f'"{field_name}"' in document.template
        assert f'"{field_name}"' in image.template
    for field_name in result_fields:
        assert f'"{field_name}"' in normalization.template


def test_effect_extraction_prompts_render_business_inputs() -> None:
    document = render_prompt(
        "document_extraction.prompt.txt",
        source_name="产品说明.docx",
        document_markdown="# 广式腊肠\n规格：500g",
    )
    image = render_prompt(
        "image_analysis.prompt.txt",
        source_name="产品正面图.png",
        image_metadata_json='{"processedWidth":1080}',
    )
    normalization = render_prompt(
        "result_normalization.prompt.txt",
        fused_candidate_json='{"productName":"广式腊肠"}',
    )

    assert "资料文件名：产品说明.docx" in document
    assert "# 广式腊肠" in document
    assert "图片文件名：产品正面图.png" in image
    assert '本地图像元数据：{"processedWidth":1080}' in image
    assert '<fused_candidate_json>\n{"productName":"广式腊肠"}' in normalization
    assert "</fused_candidate_json>" in normalization


def test_effect_extraction_prompt_fails_fast_when_a_variable_is_missing() -> None:
    with pytest.raises(RuntimeError, match="document_markdown"):
        render_prompt("document_extraction.prompt.txt", source_name="产品说明.docx")


@pytest.mark.parametrize(
    "file_name",
    ["../document_extraction.prompt.txt", "prompts/document_extraction.prompt.txt", "note.txt"],
)
def test_effect_extraction_prompt_loader_rejects_unsafe_file_names(file_name: str) -> None:
    with pytest.raises(ValueError, match="Invalid effect extraction prompt file name"):
        load_prompt_template(file_name)
