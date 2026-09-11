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


def test_effect_extraction_prompts_use_the_current_unified_contract() -> None:
    expected_versions = {
        "document_extraction.prompt.txt": "6.2.0",
        "image_analysis.prompt.txt": "7.0.0",
        "commerce_extraction.prompt.txt": "2.0.0",
        "semantic_refinement.prompt.txt": "7.0.0",
        "semantic_image_suggestion_review.prompt.txt": "2.1.0",
        "result_normalization.prompt.txt": "4.0.0",
    }
    templates = {
        name: load_prompt_template(name).template for name in expected_versions
    }
    for name, version in expected_versions.items():
        assert load_prompt_version(name) == version

    for name in (
        "document_extraction.prompt.txt",
        "commerce_extraction.prompt.txt",
        "result_normalization.prompt.txt",
    ):
        template = templates[name]
        assert "只输出一个 JSON 对象" in template
        assert '"sellingPoints"' in template
        assert '"coreSellingPoints"' not in template
        assert '"marketingGoal"' not in template
        assert '"disabledElements"' not in template

    assert "不区分核心或次要" in templates["document_extraction.prompt.txt"]
    assert "营销目标、时长、画幅、分辨率" in templates["document_extraction.prompt.txt"]
    assert "产品介绍、评测文章、产品手册" in templates["document_extraction.prompt.txt"]
    assert "忽略网页导航、页眉页脚、相关推荐、广告" in templates[
        "document_extraction.prompt.txt"
    ]
    assert "医疗、保健、营养和成分功效推导" in templates[
        "document_extraction.prompt.txt"
    ]
    assert "40 是质量建议，不是截断上限" in templates["document_extraction.prompt.txt"]
    assert "则全部输出" in templates["document_extraction.prompt.txt"]
    assert "宁可少而有效" in templates["document_extraction.prompt.txt"]
    assert "竞品品牌" in templates["document_extraction.prompt.txt"]
    assert "所有竞品名称" in templates["document_extraction.prompt.txt"]
    assert "全部省略" in templates["document_extraction.prompt.txt"]
    assert "可见的产品视频素材" in templates["document_extraction.prompt.txt"]
    assert (
        "不得从图片推断配方、原料比例、工艺" in templates["image_analysis.prompt.txt"]
    )
    assert (
        "targetField` 必须为 `sellingPoints"
        in templates["semantic_image_suggestion_review.prompt.txt"]
    )
    assert "不是信息卡的总数上限" in templates[
        "semantic_image_suggestion_review.prompt.txt"
    ]
    assert "同一个 `sellingPoints` 字段" in templates["semantic_refinement.prompt.txt"]

    candidate_fields = ExtractionCandidate.model_json_schema(by_alias=True)[
        "properties"
    ]
    image_fields = ImageVisibleFacts.model_json_schema(by_alias=True)["properties"]
    result_fields = ExtractionResult.model_json_schema(by_alias=True)["properties"]
    for field_name in candidate_fields:
        assert f'"{field_name}"' in templates["document_extraction.prompt.txt"]
        assert f'"{field_name}"' in templates["commerce_extraction.prompt.txt"]
    for field_name in image_fields:
        assert f'"{field_name}"' in templates["image_analysis.prompt.txt"]
    for field_name in result_fields:
        assert f'"{field_name}"' in templates["result_normalization.prompt.txt"]


def test_effect_extraction_prompts_render_business_inputs() -> None:
    document = render_prompt(
        "document_extraction.prompt.txt",
        source_name="产品说明.docx",
        document_markdown="# 紫苏梅子酱\n适合刷制烤物",
    )
    image = render_prompt(
        "image_analysis.prompt.txt",
        source_name="产品正面图.png",
        image_metadata_json='{"processedWidth":1080}',
    )
    commerce = render_prompt(
        "commerce_extraction.prompt.txt",
        source_host="shop.example",
        structured_metadata_json='{"name":"紫苏梅子酱"}',
        commerce_markdown="# 商品页面",
    )
    normalization = render_prompt(
        "result_normalization.prompt.txt",
        fused_candidate_json='{"productName":"紫苏梅子酱"}',
        protected_user_input_json='{"sellingPoints":["适合刷制烤物"]}',
    )
    semantic = render_prompt(
        "semantic_refinement.prompt.txt",
        review_scope="统一卖点内部审查",
        user_facts_by_layer_json=(
            '{"SELLING_POINT":{"sellingPoints":'
            '[{"factId":"user-sellingPoints-01","value":"适合刷制烤物"}]}}'
        ),
        user_fact_pairs_json=(
            '[{"pairId":"pair-0001","field":"sellingPoints",'
            '"leftFact":{"factId":"user-sellingPoints-01","value":"适合刷制烤物"},'
            '"rightFact":{"factId":"user-sellingPoints-02","value":"适合腌制入味"}}]'
        ),
    )
    semantic_images = render_prompt(
        "semantic_image_suggestion_review.prompt.txt",
        user_facts_json='[{"factId":"user-sellingPoints-01","value":"真空包装"}]',
        image_suggestions_json=(
            '[{"factId":"image-sellingPoints-01","value":"可见果肉颗粒"}]'
        ),
        reference_facts_json=(
            '[{"factId":"reference-visualFeatures","value":"深红紫色酱体"}]'
        ),
        remaining_capacity_json='{"sellingPoints":99}',
    )

    assert "资料文件名：产品说明.docx" in document
    assert "适合刷制烤物" in document
    assert "图片文件名：产品正面图.png" in image
    assert "来源站点：shop.example" in commerce
    assert '"sellingPoints":["适合刷制烤物"]' in normalization
    assert '"pairId":"pair-0001"' in semantic
    assert '"image-sellingPoints-01"' in semantic_images
    assert '"sellingPoints":99' in semantic_images


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
