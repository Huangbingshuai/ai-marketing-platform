from __future__ import annotations
import re
from itertools import groupby
from io import BytesIO
from zipfile import ZipFile
from xml.etree import ElementTree
from typing import Any
from extraction_runtime.documents import _table_cells
from .models import Candidate, LABELS, Source, empty_brief, empty_sources

# Exact boilerplate from the shipped form. Any other prose must reach semantic extraction.
_FORM_BOILERPLATE = {
    "视频创作简报",
    "视频创作简报填写示例",
    "一 品牌基础信息",
    "二 产品核心信息",
    "以下品牌、产品与文件名均为虚构，仅用于说明如何填写。",
    "你希望做一支什么样的视频？把想法和已有资料填写在下表中即可。",
    "在“填写内容”一栏填写，右侧均为虚构填写示例，仅供参考。没想好的可写“待确认”或“请 AI 提方案”，不涉及的可以留空；现成的产品介绍、规格说明可作为附件上传，不用重复填写。",
    "产品形象由系统根据简报生成。在产品外观中写清已确定的特征和允许 AI 设计的部分；品牌 Logo 等已有素材可在页面单独上传，无需提供产品成品图片。",
    "涉及成分、性能、数据或效果时，提供相关说明资料即可；尚未确认的内容请注明“待确认”。",
}


def _blocks(text: str) -> list[tuple[bool, list[str]]]:
    return [
        (table, list(lines))
        for table, lines in groupby(
            text.splitlines(), key=lambda line: line.strip().startswith("|")
        )
    ]


def _form_table(lines: list[str]) -> bool:
    return any(_table_cells(line)[:2] == ["填写项", "填写内容"] for line in lines)


def restore_docx_form_linebreaks(markdown: str, content: bytes) -> str:
    """Restore explicit OOXML breaks that Docling flattens inside form cells.

    Only uniquely matched, unchanged form values qualify. No semantic splitting or
    modification of the shared effect parser is involved.
    """
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with ZipFile(BytesIO(content)) as archive:
        if archive.getinfo("word/document.xml").file_size > 100 * 1024 * 1024:
            raise ValueError("document XML exceeds the file limit")
        root = ElementTree.fromstring(archive.read("word/document.xml"))

    def cell_text(cell: ElementTree.Element) -> str:
        paragraphs = []
        for paragraph in cell.findall("w:p", namespace):
            paragraphs.append(
                "".join(
                    (item.text or "") if item.tag.endswith("}t") else "\n"
                    for item in paragraph.iter()
                    if item.tag.endswith("}t") or item.tag.endswith("}br")
                )
            )
        return "\n".join(paragraphs).strip()

    values: dict[tuple[str, str], set[str]] = {}
    for table in root.findall(".//w:tbl", namespace):
        rows = [
            [cell_text(cell) for cell in row.findall("w:tc", namespace)]
            for row in table.findall("w:tr", namespace)
        ]
        if not any(row[:2] == ["填写项", "填写内容"] for row in rows):
            continue
        for row in rows:
            if len(row) >= 2 and "\n" in row[1] and "|" not in row[1]:
                key = row[0], " ".join(row[1].split())
                values.setdefault(key, set()).add(row[1])
    lines = []
    for line in markdown.splitlines():
        row = _table_cells(line)
        matches = (
            values.get((row[0], " ".join(row[1].split()))) if len(row) >= 2 else None
        )
        if matches and len(matches) == 1:
            cells = line.strip()[1:-1].split("|")
            cells[1] = " " + next(iter(matches)).replace("\n", "<br>") + " "
            line = "|" + "|".join(cells) + "|"
        lines.append(line)
    return "\n".join(lines)


def filled_template_text(text: str) -> str:
    """Sanitize recognised form tables before semantic mapping of legacy labels.

    Keep row labels and entered values, never the optional example/reference columns.
    Free documents without a form header remain untouched.
    """
    output = []
    for table, lines in _blocks(text):
        if not table or not _form_table(lines):
            output.extend(lines)
            continue
        for line in lines:
            row = _table_cells(line)
            if len(row) >= 2:
                value = re.sub(r"<br\s*/?>", "\n", row[1], flags=re.I).strip()
                if row[0] != "填写项" and value and value not in {"—", "-", "待填写"}:
                    output.append(f"{row[0]}：{value}")
    return "\n".join(output)


def template_candidate(text: str, document: dict[str, Any]) -> Candidate | None:
    """Only a recognised template's second column is authoritative. Examples never leak."""
    reverse = {label: key for key, label in LABELS.items()}
    rows = [_table_cells(line) for line in text.splitlines()]
    if not any(
        len(row) >= 2 and row[0] == "填写项" and row[1] == "填写内容" for row in rows
    ):
        return None
    for table, lines in _blocks(text):
        if table and not _form_table(lines):
            return None
        if not table and any(
            line.strip().lstrip("#").strip()
            and line.strip().lstrip("#").strip() not in _FORM_BOILERPLATE
            for line in lines
        ):
            return None
    # A common header alone does not identify the current 12-field schema.
    # Any populated legacy/custom row requires semantic mapping, including known rows.
    if any(
        len(row) >= 2
        and row[0] != "填写项"
        and row[0] not in reverse
        and row[1].strip() not in {"", "—", "-", "待填写"}
        for row in rows
    ):
        return None
    fields, sources = empty_brief(), empty_sources()
    for row_index, row in enumerate(rows):
        if len(row) < 2 or row[0] not in reverse:
            continue
        field = reverse[row[0]]
        value = re.sub(r"<br\s*/?>", "\n", row[1], flags=re.I).strip()
        if not value or value in {"—", "-", "待填写"}:
            continue
        if field == "sellingPoints":
            points = [p.strip() for p in value.splitlines() if p.strip()]
            offset = len(fields.sellingPoints)
            fields.sellingPoints.extend(points)
            sources.sellingPoints.extend(
                Source(
                    assetId=document["assetId"],
                    assetVersion=document["assetVersion"],
                    location=f"表格第 {row_index + 1} 行填写内容",
                    itemIndex=offset + i,
                )
                for i in range(len(points))
            )
        else:
            previous = getattr(fields, field)
            setattr(fields, field, f"{previous}\n{value}".strip())
            getattr(sources, field).append(
                Source(
                    assetId=document["assetId"],
                    assetVersion=document["assetVersion"],
                    location=f"表格第 {row_index + 1} 行填写内容",
                    itemIndex=None,
                )
            )
    return Candidate(fields=fields, fieldSources=sources, issues=[])


def combine_chunks(candidates: list[Candidate]) -> Candidate:
    """Keep every chunk's evidence; differing scalar passages remain context, not guesses."""
    fields, sources = empty_brief(), empty_sources()
    issues = []
    for candidate in candidates:
        for field in LABELS:
            if field == "sellingPoints":
                offset = len(fields.sellingPoints)
                fields.sellingPoints.extend(candidate.fields.sellingPoints)
                sources.sellingPoints.extend(
                    s.model_copy(update={"itemIndex": offset + (s.itemIndex or 0)})
                    for s in candidate.fieldSources.sellingPoints
                )
            else:
                value = getattr(candidate.fields, field)
                previous = getattr(fields, field)
                if value and value != previous:
                    setattr(fields, field, f"{previous}\n{value}".strip())
                getattr(sources, field).extend(getattr(candidate.fieldSources, field))
        issues.extend(candidate.issues)
    return Candidate(fields=fields, fieldSources=sources, issues=issues)


def restore_selling_point_sources(
    fused: Candidate, inputs: list[Candidate]
) -> Candidate:
    """Reindex unchanged facts from verified inputs, never guess paraphrase identity.

    Each input starts at index zero; those local indexes cannot be copied directly
    into the fused array. Exact unchanged text proves identity mechanically.
    """
    sources: list[Source] = []
    for index, point in enumerate(fused.fields.sellingPoints):
        matched = [
            source
            for candidate in inputs
            for previous_index, previous in enumerate(candidate.fields.sellingPoints)
            if previous == point
            for source in candidate.fieldSources.sellingPoints
            if source.itemIndex == previous_index
        ]
        if matched:
            sources.extend(s.model_copy(update={"itemIndex": index}) for s in matched)
        else:
            sources.extend(
                s for s in fused.fieldSources.sellingPoints if s.itemIndex == index
            )
    fused.fieldSources.sellingPoints = sources
    return fused
