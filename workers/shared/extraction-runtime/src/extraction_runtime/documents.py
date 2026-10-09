from __future__ import annotations
import re

_MARKDOWN_DECORATION = re.compile(r"(?:\*\*|__|`)")
_TABLE_SEPARATOR = re.compile(r"^:?-{3,}:?$")
_HEADING = re.compile(r"^#{1,6}\s+(?P<title>.+?)\s*$")
_PARAGRAPH_SEPARATOR = re.compile(r"\n\s*\n+")
_SENTENCE_BOUNDARY = re.compile(r"(?<=[。！？!?；;])")


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


def _clean(value: str) -> str:
    return _MARKDOWN_DECORATION.sub("", value).replace("<br>", "\n").strip()
