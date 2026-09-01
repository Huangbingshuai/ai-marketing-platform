from __future__ import annotations

import pytest

from effect_extraction.models import (
    ExtractionCandidate,
    ExtractionResult,
    ImageVisibleFacts,
)
from effect_extraction.prompt_loader import (
    load_prompt_template,
    load_prompt_version,
    render_prompt,
)


def test_effect_extraction_prompts_load_independently_by_file_name() -> None:
    document = load_prompt_template("document_extraction.prompt.txt")
    image = load_prompt_template("image_analysis.prompt.txt")
    commerce = load_prompt_template("commerce_extraction.prompt.txt")
    semantic = load_prompt_template("semantic_refinement.prompt.txt")
    normalization = load_prompt_template("result_normalization.prompt.txt")

    assert load_prompt_version("document_extraction.prompt.txt") == "3.0.0"
    assert load_prompt_version("image_analysis.prompt.txt") == "6.3.0"
    assert load_prompt_version("commerce_extraction.prompt.txt") == "1.0.0"
    assert load_prompt_version("semantic_refinement.prompt.txt") == "4.0.0"
    assert load_prompt_version("result_normalization.prompt.txt") == "3.0.0"

    assert "产品文档事实抽取器" in document.template
    assert "产品图片" in image.template
    assert "公开商品页面信息抽取器" in commerce.template
    assert "只能选择已有 factId" in semantic.template
    assert "SAME_FAMILY" in semantic.template
    assert "语义整理与字段归类" in semantic.template
    assert "整根腊肠清晰展示" in semantic.template
    assert "sourceType=USER_FACT" in semantic.template
    assert "placements" in semantic.template
    assert "selections" in semantic.template
    assert "Worker" not in semantic.template
    assert "产品素材制作信息卡标准化器" in normalization.template

    for prompt in (document.template, commerce.template, normalization.template):
        assert "只输出一个 JSON 对象" in prompt
        assert "## 示例" in prompt
        assert "示例输出：" in prompt
        assert "## 输出前自检" in prompt
        assert '"productCategory"' in prompt
        assert '"coreSellingPoints"' in prompt
        assert '"disabledElements"' in prompt

    assert "无证据的字符串、数字或数组均为 null" in document.template
    assert "基于明确画面证据给出少量、保守的营销建议" in image.template
    assert "价格和视频配置不属于本节点" in image.template
    assert "highDetailRecommended" in image.template
    assert '"corePainPoints"' in image.template
    assert '"decisionDrivers"' in image.template
    assert '"purchaseScenarios"' in image.template
    assert "属于 AI 图片建议" in image.template
    assert "不得仅凭产品外观写“判断品质”" in image.template
    assert "先按信息卡字段归类" in image.template
    assert "香料、餐具、竹篮、蒸笼" in image.template
    assert "场景道具是否没有被写成产品卖点" in image.template
    assert "纯产品外观、食用场景或文字已经清晰可读时为 false" in image.template
    assert "只做格式整理，不新增事实或营销策略" in normalization.template
    assert "价格缺失时写“待补充”" in normalization.template
    assert "不得新增输入中不存在的年龄、性别、职业或地域属性" in normalization.template
    assert '"priceRange": null' in document.template
    assert '"visualFeatures": "红褐色长条腊肠' in image.template
    assert '"priceRange": "20 元/袋"' in normalization.template
    assert "六个全局视频配置字段是否全部为 null" in document.template

    candidate_fields = ExtractionCandidate.model_json_schema(by_alias=True)[
        "properties"
    ]
    image_fields = ImageVisibleFacts.model_json_schema(by_alias=True)["properties"]
    result_fields = ExtractionResult.model_json_schema(by_alias=True)["properties"]
    for field_name in candidate_fields:
        assert f'"{field_name}"' in document.template
        assert f'"{field_name}"' in commerce.template
    for field_name in image_fields:
        assert f'"{field_name}"' in image.template
    assert '"disabledElements"' not in image.template
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
    commerce = render_prompt(
        "commerce_extraction.prompt.txt",
        source_host="shop.example",
        structured_metadata_json='{"name":"广式腊肠"}',
        commerce_markdown="# 商品页面",
    )
    normalization = render_prompt(
        "result_normalization.prompt.txt",
        fused_candidate_json='{"productName":"广式腊肠"}',
        protected_user_input_json='{"marketingGoal":"人工目标"}',
    )
    semantic = render_prompt(
        "semantic_refinement.prompt.txt",
        facts_json='[{"factId":"usageScenarios-01","value":"煲仔饭烹饪"}]',
    )

    assert "资料文件名：产品说明.docx" in document
    assert "# 广式腊肠" in document
    assert "图片文件名：产品正面图.png" in image
    assert '本地图像元数据：{"processedWidth":1080}' in image
    assert "来源站点：shop.example" in commerce
    assert '<structured_metadata_json>\n{"name":"广式腊肠"}' in commerce
    assert "<commerce_markdown>\n# 商品页面" in commerce
    assert '<fused_candidate_json>\n{"productName":"广式腊肠"}' in normalization
    assert "</fused_candidate_json>" in normalization
    assert '<protected_user_input_json>\n{"marketingGoal":"人工目标"}' in normalization
    assert '"factId":"usageScenarios-01"' in semantic
    assert "向量召回" not in semantic


def test_effect_extraction_prompt_fails_fast_when_a_variable_is_missing() -> None:
    with pytest.raises(RuntimeError, match="document_markdown"):
        render_prompt("document_extraction.prompt.txt", source_name="产品说明.docx")


@pytest.mark.parametrize(
    "file_name",
    [
        "../document_extraction.prompt.txt",
        "prompts/document_extraction.prompt.txt",
        "note.txt",
    ],
)
def test_effect_extraction_prompt_loader_rejects_unsafe_file_names(
    file_name: str,
) -> None:
    with pytest.raises(ValueError, match="Invalid effect extraction prompt file name"):
        load_prompt_template(file_name)
