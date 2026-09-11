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
                candidate(product_name="图片商品", selling_points=["便携", "高颜值"]),
            ),
            branch(
                BranchName.DOCUMENT,
                candidate(product_name="文档商品", selling_points=[" 便携 ", "耐用"]),
            ),
            BranchOutput(
                branch=BranchName.COMMERCE,
                status=BranchStatus.SKIPPED,
                source_fingerprint="fp",
            ),
        ]
    )
    assert result.candidate.product_name == "文档商品"
    assert result.provenance["product_name"] == "DOCUMENT"
    assert result.candidate.selling_points == ["便携", "耐用", "高颜值"]
    assert any("product_name conflict" in warning for warning in result.warnings)


def test_fusion_preserves_selling_points_across_all_sources() -> None:
    result = fuse(
        [
            branch(
                BranchName.DOCUMENT,
                candidate(
                    selling_points=[f"文档卖点 {index}" for index in range(1, 41)]
                ),
            ),
            branch(
                BranchName.IMAGE,
                candidate(selling_points=["图片补充卖点"]),
            ),
        ]
    )

    assert result.candidate.selling_points == [
        *[f"文档卖点 {index}" for index in range(1, 41)],
        "图片补充卖点",
    ]


def test_fusion_requires_at_least_one_usable_source() -> None:
    try:
        fuse([])
    except Exception as exc:
        assert "document, image, or commerce" in str(exc)
    else:
        raise AssertionError("fusion should fail without a usable source")
