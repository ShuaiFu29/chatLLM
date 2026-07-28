from __future__ import annotations

import codecs
from pathlib import Path

from charset_normalizer import from_bytes

from converted_document import ConversionResult, DocumentConversionError
from converters.base import DocumentConverter


_BOMS = (
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)


class PlainTextConverter(DocumentConverter):
    document_kind = "plaintext"
    conversion_profile = "plaintext-v1"
    converter_name = "plaintext-local"
    source_type = "plaintext"

    def convert(self, source_file: str | Path, output_dir: str | Path) -> ConversionResult:
        inspection = self._inspect_source(source_file)
        data = self._read_bounded_bytes(inspection)

        encoding = _detect_encoding(data)
        try:
            text = data.decode(encoding, errors="strict")
        except UnicodeDecodeError as error:
            raise DocumentConversionError("TEXT_DECODE_FAILED", "text source could not be decoded") from error
        if _looks_binary(text):
            raise DocumentConversionError("TEXT_BINARY_CONTENT", "text source contains binary content")

        return self._convert_text(inspection, output_dir, text.splitlines(keepends=True), encoding)


def _detect_encoding(data: bytes) -> str:
    for bom, encoding in _BOMS:
        if data.startswith(bom):
            return encoding
    try:
        data.decode("utf-8", errors="strict")
        return "utf-8"
    except UnicodeDecodeError:
        pass

    match = from_bytes(data).best()
    if match is None or match.percent_chaos > 20:
        raise DocumentConversionError("TEXT_ENCODING_UNDETECTABLE", "text source encoding is not reliable")
    return match.encoding


def _looks_binary(text: str) -> bool:
    if "\x00" in text:
        return True
    if not text:
        return False
    control_count = sum(1 for char in text if ord(char) < 32 and char not in "\n\r\t\f")
    return control_count / len(text) > 0.02
