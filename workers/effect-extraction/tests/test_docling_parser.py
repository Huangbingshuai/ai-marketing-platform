from __future__ import annotations

import pytest

from effect_extraction.docling_parser import DocumentParseError, LocalDoclingParser


def parser() -> LocalDoclingParser:
    return LocalDoclingParser(
        artifacts_path=None,
        max_file_size=1024,
        max_num_pages=1,
    )


@pytest.mark.asyncio
async def test_plain_text_is_decoded_without_docling() -> None:
    content = "紫苏梅子酱\n酸甜梅香".encode("utf-8")

    markdown = await parser().parse(content, file_name="产品资料.txt")

    assert markdown == "紫苏梅子酱\n酸甜梅香"


@pytest.mark.asyncio
async def test_gb18030_plain_text_is_supported() -> None:
    content = "紫苏梅子酱\n适合蘸食".encode("gb18030")

    markdown = await parser().parse(content, file_name="产品资料.txt")

    assert markdown == "紫苏梅子酱\n适合蘸食"


@pytest.mark.asyncio
async def test_empty_plain_text_is_rejected() -> None:
    with pytest.raises(DocumentParseError, match="empty or undecodable"):
        await parser().parse(b"  \n", file_name="产品资料.md")
