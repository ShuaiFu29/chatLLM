from __future__ import annotations

from pathlib import Path

from converted_document import ConversionResult, DocumentConversionError
from converters.base import ConversionLimits, DocumentConverter
from converters.markdown import MarkdownConverter
from converters.plaintext import PlainTextConverter


def get_converter(
    source_file: str | Path,
    limits: ConversionLimits | None = None,
) -> DocumentConverter:
    suffix = Path(source_file).suffix.lower()
    if suffix in {".md", ".markdown"}:
        return MarkdownConverter(limits)
    if suffix == ".txt":
        return PlainTextConverter(limits)
    raise DocumentConversionError(
        "UNSUPPORTED_DOCUMENT_TYPE",
        "source file type is not supported by the local converter registry",
    )


def convert_document(
    source_file: str | Path,
    output_dir: str | Path,
    limits: ConversionLimits | None = None,
) -> ConversionResult:
    return get_converter(source_file, limits).convert(source_file, output_dir)
