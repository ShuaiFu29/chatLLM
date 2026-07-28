from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any

from converted_document import ConversionResult, DocumentConversionError

from converters.base import DocumentConverter, LocatedTextBlock

_PDF_SIGNATURE_RE = re.compile(rb"%PDF-[12]\.[0-9](?:\r|\n|\s|%)")
_COMPLEX_LAYOUT_WARNING = "PDF_COMPLEX_LAYOUT_MAY_BE_LOSSY"
_EMPTY_PAGES_WARNING = "PDF_SOME_PAGES_HAVE_NO_EXTRACTABLE_TEXT"
_CONTROL_CHARACTERS_WARNING = "PDF_CONTROL_CHARACTERS_NORMALIZED"


class PdfConverter(DocumentConverter):
    document_kind = "pdf"
    conversion_profile = "pdf-text-v1"
    converter_name = "pypdf-local"
    source_type = "pdf"

    def convert(self, source_file: str | Path, output_dir: str | Path) -> ConversionResult:
        inspection = self._inspect_source(source_file)
        data = self._read_bounded_bytes(inspection)
        if not _PDF_SIGNATURE_RE.match(data[:16]):
            raise DocumentConversionError(
                "PDF_INVALID_SIGNATURE",
                "PDF source does not have a valid PDF header",
            )

        PdfReader, pdf_errors = _load_pypdf()
        try:
            reader = PdfReader(io.BytesIO(data), strict=False)
            if reader.is_encrypted:
                raise DocumentConversionError(
                    "PDF_ENCRYPTED",
                    "encrypted PDF documents are not supported",
                )
            page_count = len(reader.pages)
            if page_count > self.limits.max_pdf_pages:
                raise DocumentConversionError(
                    "PDF_TOO_MANY_PAGES",
                    "PDF page count exceeds the configured conversion limit",
                )
        except DocumentConversionError:
            raise
        except pdf_errors as error:
            raise DocumentConversionError(
                "PDF_INVALID_DOCUMENT",
                "PDF source could not be parsed",
            ) from error
        except (KeyError, TypeError, ValueError, OSError) as error:
            raise DocumentConversionError(
                "PDF_INVALID_DOCUMENT",
                "PDF source could not be parsed",
            ) from error

        warnings: set[str] = set()
        blocks: list[LocatedTextBlock] = []
        empty_page_count = 0
        extracted_character_count = 0
        try:
            for page_number, page in enumerate(reader.pages, start=1):
                if _page_may_have_complex_layout(page):
                    warnings.add(_COMPLEX_LAYOUT_WARNING)
                extracted = page.extract_text() or ""
                extracted_character_count += len(extracted)
                if extracted_character_count > self.limits.max_pdf_extracted_chars:
                    raise DocumentConversionError(
                        "PDF_TEXT_TOO_LARGE",
                        "PDF extracted text exceeds the configured conversion limit",
                    )
                text, normalized_controls = _normalize_extracted_text(extracted)
                if normalized_controls:
                    warnings.add(_CONTROL_CHARACTERS_WARNING)
                if not text.strip():
                    empty_page_count += 1
                    continue
                blocks.extend(_page_blocks(text, page_number, self.limits.max_unit_chars))
        except DocumentConversionError:
            raise
        except pdf_errors as error:
            raise DocumentConversionError(
                "PDF_TEXT_EXTRACTION_FAILED",
                "PDF text layer could not be extracted",
            ) from error
        except (KeyError, TypeError, ValueError, OSError) as error:
            raise DocumentConversionError(
                "PDF_TEXT_EXTRACTION_FAILED",
                "PDF text layer could not be extracted",
            ) from error

        if not blocks:
            raise DocumentConversionError(
                "PDF_HAS_NO_EXTRACTABLE_TEXT",
                "PDF document has no extractable text layer",
            )
        if empty_page_count:
            warnings.add(_EMPTY_PAGES_WARNING)

        return self._convert_located_blocks(
            inspection,
            output_dir,
            blocks,
            "binary",
            tuple(sorted(warnings)),
        )


def _load_pypdf() -> tuple[Any, tuple[type[BaseException], ...]]:
    try:
        from pypdf import PdfReader
        from pypdf.errors import FileNotDecryptedError, PdfReadError
    except ImportError as error:
        raise DocumentConversionError(
            "CONVERTER_DEPENDENCY_MISSING",
            "local PDF converter dependency is not installed",
        ) from error
    return PdfReader, (PdfReadError, FileNotDecryptedError)


def _normalize_extracted_text(text: str) -> tuple[str, bool]:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\f", "\n")
    normalized = False
    characters: list[str] = []
    for character in text:
        if ord(character) < 32 and character not in "\n\t":
            characters.append("\ufffd")
            normalized = True
        else:
            characters.append(character)
    normalized_text = "".join(characters)
    lines = [line.rstrip() for line in normalized_text.split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines), normalized


def _page_blocks(text: str, page_number: int, max_unit_chars: int) -> list[LocatedTextBlock]:
    """Split only at line boundaries while retaining a precise page locator."""

    blocks: list[LocatedTextBlock] = []
    current: list[str] = []
    current_chars = 0
    block_number = 1

    def flush() -> None:
        nonlocal current, current_chars, block_number
        if not current:
            return
        content = "\n".join(current).strip("\n")
        if content.strip():
            blocks.append(
                LocatedTextBlock(
                    text=content,
                    source={
                        "type": "pdf",
                        "page": page_number,
                        "block": block_number,
                        "kind": "page_text",
                    },
                )
            )
            block_number += 1
        current = []
        current_chars = 0

    for line in text.split("\n"):
        required = len(line) + (1 if current else 0)
        if required > max_unit_chars:
            raise DocumentConversionError(
                "SOURCE_UNIT_TOO_LARGE",
                "a PDF text line exceeds the configured conversion unit limit",
            )
        if current and current_chars + required > max_unit_chars:
            flush()
            required = len(line)
        current.append(line)
        current_chars += required
    flush()
    return blocks


def _page_may_have_complex_layout(page: Any) -> bool:
    try:
        rotation = int(page.get("/Rotate", 0) or 0) % 360
        resources = page.get("/Resources")
        if hasattr(resources, "get_object"):
            resources = resources.get_object()
        xobjects = resources.get("/XObject") if resources else None
        if hasattr(xobjects, "get_object"):
            xobjects = xobjects.get_object()
        return bool(rotation or xobjects)
    except (AttributeError, KeyError, TypeError, ValueError):
        return True
