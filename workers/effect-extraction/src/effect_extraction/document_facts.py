from __future__ import annotations

import re

from .models import ExtractionCandidate

_MARKDOWN_DECORATION = re.compile(r"(?:\*\*|__|`)")
_TABLE_SEPARATOR = re.compile(r"^:?-{3,}:?$")
_HEADING = re.compile(r"^#{1,6}\s+(?P<title>.+?)\s*$")
_LIST_MARKER = re.compile(r"^(?:[-*+]\s+|\d+[.)、]\s*)")
_NON_FACT_NOTE = re.compile(
    r"^(?:填写确认|用户确认|资料确认|确认说明|说明|备注|注)\s*[：:]"
)
_EMPTY_VALUES = {"", "-", "—", "无", "暂无", "未提供", "待补充", "不适用"}
_LIST_SEPARATOR = re.compile(r"[；;\n]+")

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
    "核心卖点": "core_selling_points",
    "主要卖点": "core_selling_points",
    "次要卖点": "secondary_selling_points",
    "补充卖点": "secondary_selling_points",
    "信任背书": "trust_backings",
    "信任证明": "trust_backings",
    "辅助信任背书": "trust_backings",
    "目标受众画像": "target_audience",
    "目标受众": "target_audience",
    "核心痛点": "core_pain_points",
    "用户痛点": "core_pain_points",
    "决策动因": "decision_drivers",
    "购买动因": "decision_drivers",
    "营销目标": "marketing_goal",
    "典型使用场景": "usage_scenarios",
    "核心使用场景": "usage_scenarios",
    "使用场景": "usage_scenarios",
    "购买场景": "purchase_scenarios",
    "情绪氛围场景": "emotional_scenarios",
    "情绪共鸣场景": "emotional_scenarios",
    "情绪场景": "emotional_scenarios",
}

_LIST_FIELDS = {
    "core_selling_points",
    "secondary_selling_points",
    "trust_backings",
    "core_pain_points",
    "decision_drivers",
    "usage_scenarios",
    "purchase_scenarios",
    "emotional_scenarios",
}


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
    content_fields = {
        "core_selling_points",
        "secondary_selling_points",
        "target_audience",
        "core_pain_points",
        "usage_scenarios",
    }
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


def _table_cells(line: str) -> list[str]:
    stripped = line.strip()
    if not stripped.startswith("|") or not stripped.endswith("|"):
        return []
    cells = [_clean(cell) for cell in stripped[1:-1].split("|")]
    if cells and all(_TABLE_SEPARATOR.fullmatch(cell.replace(" ", "")) for cell in cells):
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
            if field_name in _LIST_FIELDS | {"target_audience"}:
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

    if field_name == "target_audience":
        items = _list_items(value)
        normalized = "；".join(items)
        if normalized and field_name not in parsed:
            parsed[field_name] = normalized
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
        normalized = re.sub(r"\s+", "", item).casefold()
        if normalized in seen:
            continue
        seen.add(normalized)
        items.append(item)
    return items
