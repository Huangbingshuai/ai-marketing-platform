from effect_extraction.fusion import fuse
from effect_extraction.models import (
    BranchName,
    BranchOutput,
    BranchStatus,
    ExtractionCandidate,
)


def candidate(**values: object) -> ExtractionCandidate:
    result = ExtractionCandidate.empty()
    for key, value in values.items():
        setattr(result, key, value)
    return result


def branch(name: BranchName, value: ExtractionCandidate) -> BranchOutput:
    return BranchOutput(
        branch=name,
        status=BranchStatus.SUCCEEDED,
        source_fingerprint="fp",
        candidate=value,
    )


def test_fusion_applies_priority_and_stable_deduplication() -> None:
    result = fuse(
        [
            branch(
                BranchName.IMAGE,
                candidate(product_name="图片商品", core_selling_points=["便携", "高颜值"]),
            ),
            branch(
                BranchName.DOCUMENT,
                candidate(product_name="文档商品", core_selling_points=[" 便携 ", "耐用"]),
            ),
            branch(
                BranchName.FORM,
                candidate(product_name="人工商品", product_category="饮料"),
            ),
            BranchOutput(
                branch=BranchName.COMMERCE,
                status=BranchStatus.SKIPPED,
                source_fingerprint="fp",
            ),
        ]
    )
    assert result.candidate.product_name == "人工商品"
    assert result.provenance["product_name"] == "FORM"
    assert result.candidate.core_selling_points == ["便携", "耐用", "高颜值"]
    assert any("product_name conflict" in warning for warning in result.warnings)


def test_fusion_requires_form_branch() -> None:
    try:
        fuse([])
    except Exception as exc:
        assert "FORM" in str(exc)
    else:
        raise AssertionError("fusion should fail without FORM")
