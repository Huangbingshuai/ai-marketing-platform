"""Offline smoke test: run with the shared /models volume; no model-provider calls."""

from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path
import os
from openpyxl import Workbook
from extraction_runtime.docling_parser import LocalDoclingParser
from customized_extraction.documents import (
    template_candidate,
    restore_docx_form_linebreaks,
)


def pdf_fixture() -> bytes:
    stream = b"BT /F1 16 Tf 50 700 Td (Brand Meijian - Green plum jam) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length "
        + str(len(stream)).encode()
        + b" >>\nstream\n"
        + stream
        + b"\nendstream",
    ]
    content = b"%PDF-1.4\n"
    offsets = []
    for index, obj in enumerate(objects, 1):
        offsets.append(len(content))
        content += str(index).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(content)
    content += b"xref\n0 6\n0000000000 65535 f \n" + b"".join(
        f"{offset:010d} 00000 n \n".encode() for offset in offsets
    )
    return (
        content
        + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )


async def main() -> None:
    root = Path(__file__).resolve().parents[3]
    parser = LocalDoclingParser(
        artifacts_path=os.getenv("DOCLING_ARTIFACTS_PATH"),
        max_file_size=5 * 1024 * 1024,
        max_num_pages=10,
    )
    example = root / "docs/workflows/customized/templates/视频创作简报填写示例.docx"
    docx = await parser.parse(example.read_bytes(), file_name=example.name)
    docx = restore_docx_form_linebreaks(docx, example.read_bytes())
    candidate = template_candidate(docx, {"assetId": "docx-fixture", "assetVersion": 1})
    assert candidate and candidate.fields.productName and candidate.fields.sellingPoints
    assert len(candidate.fields.sellingPoints) == 3
    blank_path = example.with_name("视频创作简报模板.docx")
    blank = await parser.parse(blank_path.read_bytes(), file_name=blank_path.name)
    empty = template_candidate(blank, {"assetId": "empty-fixture", "assetVersion": 1})
    assert empty and not any(empty.fields.model_dump().values()), (
        "example column leaked into facts"
    )
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.append(["填写项", "填写内容", "备注 / 示例"])
    sheet.append(["产品名称", "青梅酱", "不应提取示例"])
    sheet.append(["核心卖点", "清爽青梅香", "不应提取认证"])
    output = BytesIO()
    workbook.save(output)
    excel = await parser.parse(output.getvalue(), file_name="brief.xlsx")
    assert "青梅酱" in excel
    extracted = template_candidate(
        excel, {"assetId": "excel-fixture", "assetVersion": 1}
    )
    assert extracted and extracted.fields.productName == "青梅酱"
    assert extracted.fields.sellingPoints == ["清爽青梅香"]
    pdf = await parser.parse(pdf_fixture(), file_name="brief.pdf")
    assert "Green plum jam" in pdf
    print("Local Docling: DOCX template, blank-template exclusion, XLSX and PDF passed")


if __name__ == "__main__":
    asyncio.run(main())
