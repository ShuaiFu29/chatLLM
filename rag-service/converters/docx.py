from __future__ import annotations

import io
import re
import zipfile
from collections.abc import Iterable
from pathlib import Path, PurePosixPath
from typing import Any

from converted_document import ConversionResult, DocumentConversionError

from converters.base import DocumentConverter, LocatedTextBlock

_ZIP_SIGNATURES = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
_MAX_ARCHIVE_ENTRIES = 4096
_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
_MAX_COMPRESSION_RATIO = 200
_REQUIRED_PARTS = {
    "[content_types].xml",
    "_rels/.rels",
    "word/document.xml",
}
_DOCUMENT_CONTENT_TYPE = (
    b"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
)
_MACRO_MARKERS = (
    b"application/vnd.ms-word.document.macroenabled.main+xml",
    b"application/vnd.ms-office.vbaproject",
)


class DocxConverter(DocumentConverter):
    document_kind = "docx"
    conversion_profile = "docx-v1"
    converter_name = "python-docx-local"
    source_type = "docx"

    def convert(self, source_file: str | Path, output_dir: str | Path) -> ConversionResult:
        inspection = self._inspect_source(source_file)
        data = self._read_bounded_bytes(inspection)
        warnings = _validate_docx_archive(data, self.limits.max_source_bytes)

        Document, parse_errors = _load_python_docx()
        try:
            document = Document(io.BytesIO(data))
            blocks = list(_iter_document_blocks(document))
        except parse_errors as error:
            raise DocumentConversionError(
                "DOCX_INVALID_DOCUMENT",
                "DOCX document content could not be parsed",
            ) from error
        except (KeyError, TypeError, ValueError, OSError, zipfile.BadZipFile) as error:
            raise DocumentConversionError(
                "DOCX_INVALID_DOCUMENT",
                "DOCX document content could not be parsed",
            ) from error

        return self._convert_located_blocks(
            inspection,
            output_dir,
            blocks,
            "binary",
            warnings,
        )


def _load_python_docx() -> tuple[Any, tuple[type[BaseException], ...]]:
    try:
        from docx import Document
        from docx.opc.exceptions import PackageNotFoundError
        from lxml.etree import XMLSyntaxError
    except ImportError as error:
        raise DocumentConversionError(
            "CONVERTER_DEPENDENCY_MISSING",
            "local DOCX converter dependency is not installed",
        ) from error
    return Document, (PackageNotFoundError, XMLSyntaxError)


def _validate_docx_archive(data: bytes, max_source_bytes: int) -> tuple[str, ...]:
    if not data.startswith(_ZIP_SIGNATURES) or not zipfile.is_zipfile(io.BytesIO(data)):
        raise DocumentConversionError(
            "DOCX_INVALID_SIGNATURE",
            "DOCX source is not a valid ZIP-based OOXML container",
        )

    warnings: set[str] = set()
    try:
        with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
            entries = archive.infolist()
            if len(entries) > _MAX_ARCHIVE_ENTRIES:
                raise DocumentConversionError(
                    "DOCX_ZIP_TOO_MANY_ENTRIES",
                    "DOCX archive contains too many entries",
                )

            names: dict[str, zipfile.ZipInfo] = {}
            total_uncompressed = 0
            configured_uncompressed_limit = min(
                _MAX_UNCOMPRESSED_BYTES,
                max(8 * 1024 * 1024, max_source_bytes * 20),
            )
            for entry in entries:
                normalized_name = _validated_zip_name(entry.filename)
                folded_name = normalized_name.casefold()
                if folded_name in names:
                    raise DocumentConversionError(
                        "DOCX_DUPLICATE_ZIP_ENTRY",
                        "DOCX archive contains duplicate entry names",
                    )
                names[folded_name] = entry
                if entry.flag_bits & 0x1:
                    raise DocumentConversionError(
                        "DOCX_ENCRYPTED_ARCHIVE",
                        "encrypted DOCX archive entries are not supported",
                    )
                if entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    raise DocumentConversionError(
                        "DOCX_UNSUPPORTED_COMPRESSION",
                        "DOCX archive uses an unsupported compression method",
                    )
                if entry.file_size and (
                    entry.compress_size == 0
                    or entry.file_size / entry.compress_size > _MAX_COMPRESSION_RATIO
                ):
                    raise DocumentConversionError(
                        "DOCX_ZIP_COMPRESSION_RATIO_EXCEEDED",
                        "DOCX archive compression ratio exceeds the safety limit",
                    )
                total_uncompressed += entry.file_size
                if total_uncompressed > configured_uncompressed_limit:
                    raise DocumentConversionError(
                        "DOCX_ZIP_UNCOMPRESSED_TOO_LARGE",
                        "DOCX archive expands beyond the configured safety limit",
                    )

            if not _REQUIRED_PARTS.issubset(names):
                raise DocumentConversionError(
                    "DOCX_INVALID_OOXML",
                    "DOCX archive is missing required OOXML document parts",
                )
            if any(
                name.endswith(("vbaproject.bin", ".vba")) or "/vba" in name
                for name in names
            ):
                raise DocumentConversionError(
                    "DOCX_MACROS_NOT_ALLOWED",
                    "macro-enabled Office content is not supported",
                )
            if any(name.startswith("word/activex/") for name in names):
                raise DocumentConversionError(
                    "DOCX_ACTIVE_CONTENT_NOT_ALLOWED",
                    "active Office content is not supported",
                )
            if any(name.startswith("word/media/") for name in names):
                warnings.add("DOCX_IMAGES_IGNORED")

            content_types = archive.read(names["[content_types].xml"])
            lowered_content_types = content_types.lower()
            if any(marker in lowered_content_types for marker in _MACRO_MARKERS):
                raise DocumentConversionError(
                    "DOCX_MACROS_NOT_ALLOWED",
                    "macro-enabled Office content is not supported",
                )
            if _DOCUMENT_CONTENT_TYPE not in lowered_content_types:
                raise DocumentConversionError(
                    "DOCX_INVALID_OOXML",
                    "OOXML package is not a standard DOCX document",
                )

            for folded_name, entry in names.items():
                if not folded_name.endswith((".xml", ".rels")):
                    continue
                payload = archive.read(entry)
                lowered = payload.lower()
                if b"<!doctype" in lowered or b"<!entity" in lowered:
                    raise DocumentConversionError(
                        "DOCX_UNSAFE_XML",
                        "DOCX package contains unsafe XML declarations",
                    )
                if folded_name.endswith(".rels") and re.search(
                    rb"targetmode\s*=\s*['\"]external['\"]",
                    lowered,
                ):
                    warnings.add("DOCX_EXTERNAL_RELATIONSHIPS_IGNORED")
    except DocumentConversionError:
        raise
    except (zipfile.BadZipFile, RuntimeError, OSError, ValueError) as error:
        raise DocumentConversionError(
            "DOCX_INVALID_CONTAINER",
            "DOCX archive could not be safely inspected",
        ) from error
    return tuple(sorted(warnings))


def _validated_zip_name(name: str) -> str:
    if not name or "\\" in name or "\x00" in name:
        raise DocumentConversionError(
            "DOCX_UNSAFE_ZIP_ENTRY",
            "DOCX archive contains an unsafe entry path",
        )
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise DocumentConversionError(
            "DOCX_UNSAFE_ZIP_ENTRY",
            "DOCX archive contains an unsafe entry path",
        )
    if path.parts and re.fullmatch(r"[A-Za-z]:", path.parts[0]):
        raise DocumentConversionError(
            "DOCX_UNSAFE_ZIP_ENTRY",
            "DOCX archive contains an unsafe entry path",
        )
    return path.as_posix()


def _iter_document_blocks(document: Any) -> Iterable[LocatedTextBlock]:
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    paragraph_number = 0
    table_number = 0
    for element in document.element.body.iterchildren():
        if isinstance(element, CT_P):
            paragraph_number += 1
            paragraph = Paragraph(element, document)
            text = _normalize_docx_text(paragraph.text)
            if not text.strip():
                continue
            kind, markdown, heading_level = _paragraph_markdown(paragraph, text)
            source: dict[str, Any] = {
                "type": "docx",
                "paragraph": paragraph_number,
                "kind": kind,
            }
            if heading_level is not None:
                source["heading_level"] = heading_level
            yield LocatedTextBlock(text=markdown, source=source)
        elif isinstance(element, CT_Tbl):
            table_number += 1
            table = Table(element, document)
            markdown, row_count, column_count = _table_markdown(table)
            if markdown is None:
                continue
            yield LocatedTextBlock(
                text=markdown,
                source={
                    "type": "docx",
                    "table": table_number,
                    "row_start": 1,
                    "row_end": row_count,
                    "column_count": column_count,
                    "kind": "table",
                },
            )


def _normalize_docx_text(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "\ufffd").strip()


def _paragraph_markdown(paragraph: Any, text: str) -> tuple[str, str, int | None]:
    style_id = str(getattr(paragraph.style, "style_id", "") or "")
    style_name = str(getattr(paragraph.style, "name", "") or "")
    heading_match = re.search(r"heading\s*([1-9])", f"{style_id} {style_name}", re.IGNORECASE)
    if heading_match:
        level = min(6, int(heading_match.group(1)))
        return "heading", f"{'#' * level} {text}", level

    paragraph_properties = getattr(paragraph._p, "pPr", None)
    numbering = getattr(paragraph_properties, "numPr", None) if paragraph_properties is not None else None
    if numbering is not None or re.search(r"list|bullet|number", f"{style_id} {style_name}", re.IGNORECASE):
        return "list", f"- {text}", None
    return "paragraph", text, None


def _table_markdown(table: Any) -> tuple[str | None, int, int]:
    rows: list[list[str]] = []
    column_count = 0
    has_text = False
    for row in table.rows:
        values = [_escape_table_cell(_normalize_docx_text(cell.text)) for cell in row.cells]
        has_text = has_text or any(value for value in values)
        column_count = max(column_count, len(values))
        rows.append(values)
    if not rows or not column_count or not has_text:
        return None, len(rows), column_count
    for row in rows:
        row.extend([""] * (column_count - len(row)))
    header = rows[0]
    lines = [
        f"| {' | '.join(header)} |",
        f"| {' | '.join(['---'] * column_count)} |",
    ]
    lines.extend(f"| {' | '.join(row)} |" for row in rows[1:])
    return "\n".join(lines), len(rows), column_count


def _escape_table_cell(text: str) -> str:
    return text.replace("\\", "\\\\").replace("|", "\\|").replace("\n", "<br>")
