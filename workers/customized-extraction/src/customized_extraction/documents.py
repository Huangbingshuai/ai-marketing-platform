from __future__ import annotations
import re
from typing import Any
from extraction_runtime.documents import _table_cells
from .models import Candidate, LABELS, Source, empty_brief, empty_sources


def template_candidate(text: str, document: dict[str, Any]) -> Candidate | None:
    """Only a recognised template's second column is authoritative. Examples never leak."""
    reverse = {label: key for key, label in LABELS.items()}
    rows = [_table_cells(line) for line in text.splitlines()]
    if not any(
        len(row) >= 2 and row[0] == "填写项" and row[1] == "填写内容" for row in rows
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
