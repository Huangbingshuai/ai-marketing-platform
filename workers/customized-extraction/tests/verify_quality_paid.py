"""Authorized paid omission probe; deliberately incomplete candidate, real audit/repair."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from time import perf_counter

from customized_extraction.documents import template_candidate
from customized_extraction.models import LABELS, AuditReport
from customized_extraction.pipeline import validate_provenance
from customized_extraction.provider import Provider
from customized_extraction.quality import (
    audit_document,
    repair_candidate,
    collect_repair_context,
    review_candidate,
    FINAL_REVIEW_INSTRUCTION,
    complete_conflict_alternatives,
)


async def main() -> None:
    if os.getenv("CUSTOMIZED_EXTRACTION_PAID_TEST") != "1":
        raise ValueError("Explicit paid test flag required")
    doc = {
        "assetId": "10441449-f2f9-4b05-91b7-91f707bcb397",
        "assetVersion": 1,
        "name": "虚构青梅酱审校探针.txt",
    }
    text = """| 填写项 | 填写内容 | 备注 / 示例 |
| --- | --- | --- |
| 品牌名称 | 清禾 | 示例品牌不采纳 |
| 产品名称 | 清禾青梅酱 | 示例产品不采纳 |
| 产品规格 | 净含量220g/瓶，保质期12个月 | 示例认证不采纳 |
| 核心卖点 | 含青梅果肉<br>瓶盖有防拆封环 | 示例卖点不采纳 |
"""
    baseline = template_candidate(text, doc)
    assert baseline is not None
    baseline.fields.productSpecifications = ""
    baseline.fieldSources.productSpecifications = []
    baseline.fields.sellingPoints.pop()
    baseline.fieldSources.sellingPoints = [
        s for s in baseline.fieldSources.sellingPoints if s.itemIndex == 0
    ]
    # The model receives only actual filled content, without template examples.
    raw = "品牌名称：清禾。产品名称：清禾青梅酱。产品规格：净含量220g/瓶，保质期12个月。核心卖点：含青梅果肉；瓶盖有防拆封环。"
    cross_chunk = "--cross-chunk" in sys.argv
    conflict = "--conflict" in sys.argv
    if cross_chunk:
        baseline.fields.brandTone = "真实自然、克制、轻盈"
        baseline.fieldSources.brandTone = [
            baseline.fieldSources.brandName[0].model_copy()
        ]
        raw = (
            "品牌表达真实自然。\n\n"
            + "\n\n".join("普通背景介绍。" * 30 for _ in range(4))
            + "\n\n品牌调性：克制、轻盈。"
        )
    if conflict:
        from customized_extraction.models import Issue

        baseline.issues = [
            Issue(
                id="weight",
                field="productSpecifications",
                message="同一产品净含量矛盾",
                sourceIds=[str(doc["assetId"])],
                alternatives=["净含量200g/瓶，保质期12个月", "净含量250g/瓶"],
                blocking=True,
            )
        ]
        raw = "清禾青梅酱。正式简报：净含量200g/瓶，保质期12个月。补充文档：同一产品净含量250g/瓶，没有确认修改保质期。两份资料的净含量冲突，尚未选定。"
    provider = Provider(
        os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        os.environ["ARK_API_KEY"],
        os.getenv("ARK_DOCUMENT_MODEL", "doubao-seed-2-1-pro-260628"),
        reasoning_effort=os.getenv("CUSTOMIZED_EXTRACTION_REASONING_EFFORT", "medium"),
        audit_reasoning_effort=os.getenv(
            "CUSTOMIZED_EXTRACTION_AUDIT_REASONING_EFFORT", "low"
        ),
    )
    started = perf_counter()
    try:
        if conflict:
            context = await collect_repair_context(
                provider,
                asyncio.Semaphore(2),
                [(doc, raw)],
                AuditReport(checkedFields=[], findings=[]),
                12000,
                ["productSpecifications"],
            )
            review = await review_candidate(
                provider,
                FINAL_REVIEW_INSTRUCTION,
                {
                    "candidate": baseline.model_dump(),
                    "documentCandidates": [baseline.model_dump()],
                    "verifiedRawFindings": [],
                    "supportingRawContext": context,
                },
                baseline,
            )
            baseline.issues = review.issues
            refined = await complete_conflict_alternatives(
                provider,
                asyncio.Semaphore(2),
                baseline,
                [baseline.model_dump()],
                context,
            )
            review.issues = refined.issues
            assert len(review.issues) == 1 and review.issues[0].id == "weight"
            assert review.issues[0].blocking and not review.dismissedIssueIds
            assert len(review.issues[0].alternatives) == 2
            assert all("12" in value for value in review.issues[0].alternatives)
            assert any("200" in value for value in review.issues[0].alternatives)
            assert any("250" in value for value in review.issues[0].alternatives)
            print(
                json.dumps(
                    {
                        "passed": True,
                        "scope": "controlled incomplete alternatives, real paid raw context/conflict review",
                        "elapsedSeconds": round(perf_counter() - started, 2),
                    }
                )
            )
            return
        if cross_chunk:
            # Deliberately wrong critic proposal; real models must retain evidence from the other chunk.
            report = AuditReport.model_validate(
                {
                    "checkedFields": list(LABELS),
                    "findings": [
                        {
                            "field": "brandTone",
                            "kind": "INCORRECT",
                            "description": "当前片段品牌表达仅为真实自然",
                            "proposedValue": "真实自然",
                            "itemIndex": None,
                            "evidence": {
                                **{k: doc[k] for k in ("assetId", "assetVersion")},
                                "location": "文档片段 1",
                                "quote": "品牌表达真实自然。",
                            },
                        }
                    ],
                }
            )
            chunks = 0
        else:
            report, chunks = await audit_document(
                provider, asyncio.Semaphore(1), doc, raw, baseline, baseline, 12000
            )
            assert set(report.checkedFields) == set(LABELS)
            assert {"productSpecifications", "sellingPoints"}.issubset(
                f.field for f in report.findings
            )
        context = await collect_repair_context(
            provider,
            asyncio.Semaphore(2),
            [(doc, raw)],
            report,
            350 if cross_chunk else 12000,
        )
        result = await repair_candidate(
            provider,
            asyncio.Semaphore(1),
            validate_provenance,
            baseline,
            report,
            [doc],
            context,
        )
        if cross_chunk:
            assert len(context) >= 3
            assert all(
                term in result.fields.brandTone for term in ["真实自然", "克制", "轻盈"]
            )
        else:
            assert (
                "220" in result.fields.productSpecifications
                and "12" in result.fields.productSpecifications
            )
            assert any("防拆封" in point for point in result.fields.sellingPoints)
        assert baseline.fields.sellingPoints[0] in result.fields.sellingPoints
        assert result.fields.brandName == baseline.fields.brandName
        assert result.fields.productName == baseline.fields.productName
        assert not result.issues
        print(
            json.dumps(
                {
                    "passed": True,
                    "scope": "controlled false critic, real paid cross-chunk context/repair"
                    if cross_chunk
                    else "synthetic omitted specification and selling point, real paid audit/context/repair",
                    "chunks": chunks,
                    "contextChunks": len(context),
                    "findings": len(report.findings),
                    "checkedFields": len(report.checkedFields),
                    "sellingPoints": len(result.fields.sellingPoints),
                    "elapsedSeconds": round(perf_counter() - started, 2),
                },
                ensure_ascii=False,
            )
        )
    finally:
        await provider.close()


if __name__ == "__main__":
    asyncio.run(main())
