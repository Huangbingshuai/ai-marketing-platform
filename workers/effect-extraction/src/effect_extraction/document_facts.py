from __future__ import annotations

import re

from .models import ExtractionCandidate

_MARKDOWN_DECORATION = re.compile(r"(?:\*\*|__|`)")
_TABLE_SEPARATOR = re.compile(r"^:?-{3,}:?$")
_HEADING = re.compile(r"^#{1,6}\s+(?P<title>.+?)\s*$")
# A decimal product specification such as ``2.5L`` is data, not a Markdown
# numbered-list marker. ASCII list punctuation therefore requires whitespace;
# the Chinese enumeration mark keeps supporting the common ``1、内容`` form.
_LIST_MARKER = re.compile(r"^(?:[-*+]\s+|\d+(?:[.)]\s+|、\s*))")
_NON_FACT_NOTE = re.compile(
    r"^(?:填写确认|用户确认|资料确认|确认说明|说明|备注|注)\s*[：:]"
)
_EMPTY_VALUES = {"", "-", "—", "无", "暂无", "未提供", "待补充", "不适用"}
_LIST_SEPARATOR = re.compile(r"[；;\n]+")
_PARAGRAPH_SEPARATOR = re.compile(r"\n\s*\n+")
_SENTENCE_BOUNDARY = re.compile(r"(?<=[。！？!?；;])")

_DOCUMENT_SCALAR_FIELDS = (
    "product_category",
    "product_name",
    "core_specification",
    "price_range",
    "visual_features",
)

_FIELD_ALIASES = {
    "产品品类": "product_category",
    "商品品类": "product_category",
    "品类": "product_category",
    "产品名称": "product_name",
    "商品名称": "product_name",
    "产品品名": "product_name",
    "核心规格": "core_specification",
    "商品规格": "core_specification",
    "规格": "core_specification",
    "价格信息": "price_range",
    "价格区间": "price_range",
    "价格带": "price_range",
    "核心外观特征": "visual_features",
    "视觉特征": "visual_features",
    "卖点": "selling_points",
    "核心卖点": "selling_points",
    "主要卖点": "selling_points",
    "次要卖点": "selling_points",
    "补充卖点": "selling_points",
    "信任背书": "selling_points",
    "信任证明": "selling_points",
    "辅助信任背书": "selling_points",
    "目标受众画像": "selling_points",
    "目标受众": "selling_points",
    "核心痛点": "selling_points",
    "用户痛点": "selling_points",
    "决策动因": "selling_points",
    "购买动因": "selling_points",
    "典型使用场景": "selling_points",
    "核心使用场景": "selling_points",
    "使用场景": "selling_points",
    "购买场景": "selling_points",
    "情绪氛围场景": "selling_points",
    "情绪共鸣场景": "selling_points",
    "情绪场景": "selling_points",
}

_LIST_FIELDS = {"selling_points"}


def extract_structured_document_facts(markdown: str) -> ExtractionCandidate | None:
    """Parse the user-maintained information table without asking a model.

    A conservative recognition threshold keeps arbitrary Markdown on the existing
    AI fallback path. Only labels from the public information card are accepted;
    production settings are deliberately absent from the alias map.
    """

    parsed: dict[str, object] = {}
    recognized_rows = 0
    for raw_line in markdown.splitlines():
        cells = _table_cells(raw_line)
        if len(cells) < 2:
            continue
        label, value = _field_and_value(cells)
        field_name = _FIELD_ALIASES.get(label)
        if field_name is None:
            continue
        recognized_rows += 1
        _store_value(parsed, field_name, value)

    heading_values = _heading_values(markdown)
    for field_name, value in heading_values:
        recognized_rows += 1
        _store_value(parsed, field_name, value)

    identity_fields = {"product_category", "product_name", "core_specification"}
    content_fields = {"selling_points"}
    if (
        recognized_rows < 5
        or not identity_fields.intersection(parsed)
        or not content_fields.intersection(parsed)
    ):
        return None

    candidate = ExtractionCandidate.empty()
    for field_name, parsed_value in parsed.items():
        setattr(candidate, field_name, parsed_value)
    return candidate


def split_document_markdown(markdown: str, *, max_chars: int) -> list[str]:
    """Split prose documents without cutting ordinary headings and paragraphs.

    Docling output can contain a mixture of headings, prose and lists. Keeping
    those blocks intact gives the document model enough local context while
    avoiding one oversized request that compresses the whole article into a few
    generic claims.
    """

    if max_chars < 1:
        raise ValueError("max_chars must be positive")
    normalized = markdown.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []

    blocks = [block.strip() for block in _PARAGRAPH_SEPARATOR.split(normalized)]
    units: list[str] = []
    pending_heading: str | None = None
    for block in blocks:
        if not block:
            continue
        if _HEADING.fullmatch(block):
            if pending_heading is not None:
                units.append(pending_heading)
            pending_heading = block
            continue
        if pending_heading is not None:
            block = f"{pending_heading}\n\n{block}"
            pending_heading = None
        units.extend(_split_oversized_document_block(block, max_chars=max_chars))
    if pending_heading is not None:
        units.append(pending_heading)

    chunks: list[str] = []
    current = ""
    for unit in units:
        candidate = unit if not current else f"{current}\n\n{unit}"
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = unit
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def merge_document_candidates(
    candidates: list[ExtractionCandidate],
) -> ExtractionCandidate:
    """Merge chunk results in source order without semantic rewriting."""

    merged = ExtractionCandidate.empty()
    for field_name in _DOCUMENT_SCALAR_FIELDS:
        for candidate in candidates:
            value = getattr(candidate, field_name)
            if isinstance(value, str) and value.strip():
                setattr(merged, field_name, value.strip())
                break

    selling_points: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        for value in candidate.selling_points or []:
            cleaned = value.strip()
            canonical = re.sub(r"\s+", " ", cleaned).casefold()
            if not canonical or canonical in seen:
                continue
            seen.add(canonical)
            selling_points.append(cleaned)
    merged.selling_points = selling_points or None
    return merged


def _split_oversized_document_block(block: str, *, max_chars: int) -> list[str]:
    if len(block) <= max_chars:
        return [block]

    lines = [line.strip() for line in block.splitlines() if line.strip()]
    units: list[str] = []
    for line in lines:
        if len(line) <= max_chars:
            units.append(line)
            continue
        sentences = [part for part in _SENTENCE_BOUNDARY.split(line) if part]
        for sentence in sentences:
            if len(sentence) <= max_chars:
                units.append(sentence)
                continue
            units.extend(
                sentence[start : start + max_chars]
                for start in range(0, len(sentence), max_chars)
            )

    chunks: list[str] = []
    current = ""
    for unit in units:
        candidate = unit if not current else f"{current}\n{unit}"
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = unit
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def _table_cells(line: str) -> list[str]:
    stripped = line.strip()
    if not stripped.startswith("|") or not stripped.endswith("|"):
        return []
    cells = [_clean(cell) for cell in stripped[1:-1].split("|")]
    if cells and all(
        _TABLE_SEPARATOR.fullmatch(cell.replace(" ", "")) for cell in cells
    ):
        return []
    return cells


def _heading_values(markdown: str) -> list[tuple[str, str]]:
    """Read Docling's heading/paragraph representation of an information card."""

    lines = markdown.splitlines()
    result: list[tuple[str, str]] = []
    index = 0
    while index < len(lines):
        match = _HEADING.match(lines[index].strip())
        if match is None:
            index += 1
            continue

        title = _clean(match.group("title")).strip().rstrip("：:").strip()
        inline_value = ""
        for separator in ("：", ":"):
            if separator in title:
                possible_label, possible_value = title.split(separator, 1)
                if _FIELD_ALIASES.get(possible_label.strip()) is not None:
                    title = possible_label.strip()
                    inline_value = possible_value.strip()
                    break
        field_name = _FIELD_ALIASES.get(title)
        index += 1
        if field_name is None:
            continue

        values = [inline_value] if inline_value else []
        list_started = False
        while index < len(lines) and _HEADING.match(lines[index].strip()) is None:
            raw_value = lines[index].strip()
            if not raw_value:
                index += 1
                continue
            if _NON_FACT_NOTE.match(_clean(raw_value)):
                break
            has_list_marker = _LIST_MARKER.match(raw_value) is not None
            if field_name in _LIST_FIELDS:
                if list_started and not has_list_marker:
                    break
                list_started = list_started or has_list_marker
            value = _clean(_LIST_MARKER.sub("", raw_value))
            if value:
                values.append(value)
            index += 1
        if values:
            result.append((field_name, "\n".join(values)))
    return result


def _store_value(parsed: dict[str, object], field_name: str, value: str) -> None:
    if _is_empty(value):
        return
    if field_name in _LIST_FIELDS:
        items = _list_items(value)
        if not items:
            return
        existing = parsed.get(field_name)
        parsed[field_name] = _dedupe_items(
            [*(existing if isinstance(existing, list) else []), *items]
        )
        return

    if field_name not in parsed:
        parsed[field_name] = value.replace("\n", "；").strip()


def _field_and_value(cells: list[str]) -> tuple[str, str]:
    # Docling keeps the information layer in column one and the actual field in
    # column two. Two-column user tables are supported as well.
    if len(cells) >= 3:
        return cells[-2], cells[-1]
    return cells[0], cells[1]


def _clean(value: str) -> str:
    return _MARKDOWN_DECORATION.sub("", value).replace("<br>", "\n").strip()


def _is_empty(value: str) -> bool:
    return value.replace("。", "").strip() in _EMPTY_VALUES


def _list_items(value: str) -> list[str]:
    items: list[str] = []
    for raw_item in _LIST_SEPARATOR.split(value):
        item = _LIST_MARKER.sub("", raw_item.strip()).rstrip("。").strip()
        if not item or _is_empty(item):
            continue
        items.append(item)
    return _dedupe_items(items)


def _dedupe_items(values: list[str]) -> list[str]:
    seen: set[str] = set()
    items: list[str] = []
    for item in values:
        normalized = re.sub(r"\s+", " ", item).strip()
        if normalized in seen:
            continue
        seen.add(normalized)
        items.append(item)
    return items
