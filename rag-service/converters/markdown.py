from __future__ import annotations

import re
from pathlib import Path

from converted_document import ConversionResult, DocumentConversionError

from converters.base import DocumentConverter


class MarkdownConverter(DocumentConverter):
    document_kind = "markdown"
    conversion_profile = "markdown-v1"
    converter_name = "markdown-local"
    source_type = "markdown"

    def convert(self, source_file: str | Path, output_dir: str | Path) -> ConversionResult:
        inspection = self._inspect_source(source_file)
        try:
            stream = inspection.path.open("r", encoding="utf-8-sig", errors="strict", newline=None)
            with stream:
                return self._convert_text(inspection, output_dir, stream, "utf-8")
        except UnicodeDecodeError as error:
            raise DocumentConversionError(
                "MARKDOWN_INVALID_UTF8",
                "Markdown source must be valid UTF-8",
            ) from error

    def _block_kind(self, text: str) -> str:
        first_line = text.lstrip().split("\n", 1)[0]
        if re.match(r"^#{1,6}(?:\s|$)", first_line):
            return "heading"
        if re.match(r"^(`{3,}|~{3,})", first_line):
            return "code"
        if re.match(r"^(?:[-+*]|\d+[.)])\s+", first_line):
            return "list"
        if first_line.startswith("|"):
            return "table"
        if first_line.startswith(">"):
            return "quote"
        return "paragraph"
