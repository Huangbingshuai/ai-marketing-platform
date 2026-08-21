from __future__ import annotations

import os
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from effect_extraction.docling_parser import LocalDoclingParser


def _docx_bytes() -> bytes:
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>",
        )
        archive.writestr(
            "word/document.xml",
            '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>测试商品规格 500ml</w:t></w:r></w:p></w:body></w:document>",
        )
    return output.getvalue()


def _pdf_bytes() -> bytes:
    text_stream = b"BT /F1 12 Tf 72 720 Td (Product specification 500ml) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(text_stream)).encode() + b" >>\nstream\n"
        + text_stream
        + b"\nendstream",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{index} 0 obj\n".encode())
        pdf.extend(body)
        pdf.extend(b"\nendobj\n")
    xref_offset = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode()
    )
    return bytes(pdf)


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("RUN_DOCLING_INTEGRATION") != "1",
    reason="set RUN_DOCLING_INTEGRATION=1 after prefetching Docling models",
)
@pytest.mark.asyncio
async def test_docling_parses_local_docx() -> None:
    parser = LocalDoclingParser(
        artifacts_path=os.getenv("DOCLING_ARTIFACTS_PATH"),
        max_file_size=5 * 1024 * 1024,
        max_num_pages=10,
    )
    markdown = await parser.parse(_docx_bytes(), file_name="product.docx")
    assert "测试商品规格" in markdown


@pytest.mark.integration
@pytest.mark.skipif(
    os.getenv("RUN_DOCLING_INTEGRATION") != "1",
    reason="set RUN_DOCLING_INTEGRATION=1 after prefetching Docling models",
)
@pytest.mark.asyncio
async def test_docling_parses_text_pdf() -> None:
    parser = LocalDoclingParser(
        artifacts_path=os.getenv("DOCLING_ARTIFACTS_PATH"),
        max_file_size=5 * 1024 * 1024,
        max_num_pages=10,
    )
    markdown = await parser.parse(_pdf_bytes(), file_name="product.pdf")
    assert "Product specification 500ml" in markdown
