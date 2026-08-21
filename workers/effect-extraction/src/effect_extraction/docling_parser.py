from __future__ import annotations

import asyncio
import os
from io import BytesIO
from typing import Any, Protocol, cast


class DocumentParseError(RuntimeError):
    pass


class DocumentParser(Protocol):
    async def parse(self, content: bytes, *, file_name: str) -> str: ...


class LocalDoclingParser:
    """In-process, local-only Docling converter with bounded inputs."""

    def __init__(
        self,
        *,
        artifacts_path: str | None,
        max_file_size: int,
        max_num_pages: int,
    ) -> None:
        self._artifacts_path = artifacts_path
        self._max_file_size = max_file_size
        self._max_num_pages = max_num_pages
        self._converter: Any | None = None

    async def parse(self, content: bytes, *, file_name: str) -> str:
        if len(content) > self._max_file_size:
            raise DocumentParseError(
                f"document exceeds configured size limit ({len(content)} bytes)"
            )
        return await asyncio.to_thread(self._parse_sync, content, file_name)

    def _build_converter(self) -> Any:
        if self._artifacts_path:
            os.environ.setdefault("DOCLING_ARTIFACTS_PATH", self._artifacts_path)
        from docling.document_converter import DocumentConverter

        return DocumentConverter()

    def _parse_sync(self, content: bytes, file_name: str) -> str:
        try:
            from docling.datamodel.base_models import DocumentStream

            if self._converter is None:
                self._converter = self._build_converter()
            source = DocumentStream(name=file_name, stream=BytesIO(content))
            result = self._converter.convert(
                source,
                max_file_size=self._max_file_size,
                max_num_pages=self._max_num_pages,
            )
            markdown = result.document.export_to_markdown().strip()
        except Exception as exc:
            raise DocumentParseError(f"Docling failed to parse {file_name}") from exc
        if not markdown:
            raise DocumentParseError(f"Docling produced empty Markdown for {file_name}")
        return cast(str, markdown)
