from __future__ import annotations

import io
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import zstandard
from langchain_text_splitters import RecursiveCharacterTextSplitter

_UNIT_ID_RE = re.compile(r"u_[0-9a-f]{32}")
_MARKER_BYTES_RE = re.compile(
    rb"(?m)^[ \t]*<!-- source-unit:(u_[0-9a-f]{32}) -->[ \t]*\n?"
)
_MARKER_TEXT_RE = re.compile(
    r"(?m)^[ \t]*<!-- source-unit:(u_[0-9a-f]{32}) -->[ \t]*\n?"
)
_ANY_MARKER_TEXT_RE = re.compile(r"<!-- source-unit:u_[0-9a-f]{32} -->")
_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)\s*$")
_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_SUPPORTED_SOURCE_TYPES = frozenset(
    {"markdown", "plaintext", "pdf", "docx", "pptx", "xlsx", "csv"}
)
_DEFAULT_SEPARATORS = ("\n\n", "\n", "。", "！", "？", ".", " ", "")


class ConvertedIngestionError(ValueError):
    """A converted-artifact validation failure with a stable error code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ConvertedChunk:
    content: str
    source_unit_ids: tuple[str, ...]
    source_locator: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "content": self.content,
            "source_unit_ids": list(self.source_unit_ids),
            "source_locator": dict(self.source_locator),
        }


@dataclass(frozen=True)
class _ValidatedUnit:
    unit_id: str
    text: str
    locator: dict[str, Any]


@dataclass(frozen=True)
class _HeadingRef:
    level: int
    markdown: str
    unit_id: str
    locator: dict[str, Any]


@dataclass(frozen=True)
class _ChunkDraft:
    body: str
    headings: tuple[_HeadingRef, ...]
    source_unit_ids: tuple[str, ...]
    locators: tuple[dict[str, Any], ...]

    def render(self) -> str:
        prefix = "\n".join(heading.markdown for heading in self.headings)
        body = self.body.strip()
        if prefix and body:
            return f"{prefix}\n\n{body}"
        return prefix or body


def split_converted_document(
    document: bytes | str,
    source_map_zstd: bytes | bytearray | memoryview,
    *,
    chunk_size: int = 1000,
    chunk_overlap: int = 100,
    max_source_map_bytes: int = 64 * 1024 * 1024,
) -> list[ConvertedChunk]:
    """Validate converted artifacts and produce marker-free, source-aware chunks."""

    _validate_split_options(chunk_size, chunk_overlap, max_source_map_bytes)
    document_bytes, document_text = _normalize_document(document)
    map_records = _read_source_map(source_map_zstd, max_source_map_bytes)
    units = _validate_and_extract_units(document_bytes, document_text, map_records)

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=list(_DEFAULT_SEPARATORS),
    )
    drafts = _draft_chunks(units, splitter, chunk_size)
    merged = _merge_small_drafts(drafts, chunk_size)
    chunks = [
        ConvertedChunk(
            content=draft.render(),
            source_unit_ids=draft.source_unit_ids,
            source_locator=_aggregate_locators(draft.locators),
        )
        for draft in merged
        if draft.render().strip()
    ]
    if not chunks:
        raise ConvertedIngestionError(
            "CONVERTED_DOCUMENT_EMPTY",
            "converted document produced no source-aware chunks",
        )
    if any(_ANY_MARKER_TEXT_RE.search(chunk.content) for chunk in chunks):
        raise ConvertedIngestionError(
            "SOURCE_MARKER_LEAKED",
            "source-unit marker leaked into chunk content",
        )
    return chunks


def _validate_split_options(
    chunk_size: int, chunk_overlap: int, max_map_bytes: int
) -> None:
    if type(chunk_size) is not int or chunk_size <= 0:
        raise ValueError("chunk_size must be a positive integer")
    if (
        type(chunk_overlap) is not int
        or chunk_overlap < 0
        or chunk_overlap >= chunk_size
    ):
        raise ValueError(
            "chunk_overlap must be a non-negative integer smaller than chunk_size"
        )
    if type(max_map_bytes) is not int or max_map_bytes <= 0:
        raise ValueError("max_source_map_bytes must be a positive integer")


def _normalize_document(document: bytes | str) -> tuple[bytes, str]:
    if isinstance(document, bytes):
        raw = document
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise ConvertedIngestionError(
                "DOCUMENT_INVALID_UTF8",
                "converted Markdown must be valid UTF-8",
            ) from error
        return raw, text
    if isinstance(document, str):
        try:
            raw = document.encode("utf-8", errors="strict")
        except UnicodeEncodeError as error:
            raise ConvertedIngestionError(
                "DOCUMENT_INVALID_UTF8",
                "converted Markdown contains an invalid Unicode surrogate",
            ) from error
        return raw, document
    raise TypeError("document must be bytes or str")


def _read_source_map(
    source_map_zstd: bytes | bytearray | memoryview,
    max_output_bytes: int,
) -> list[dict[str, Any]]:
    if not isinstance(source_map_zstd, (bytes, bytearray, memoryview)):
        raise TypeError("source_map_zstd must be a bytes-like object")
    compressed = bytes(source_map_zstd)
    if not compressed:
        raise ConvertedIngestionError(
            "SOURCE_MAP_EMPTY", "compressed source map is empty"
        )
    if len(compressed) > max_output_bytes:
        raise ConvertedIngestionError(
            "SOURCE_MAP_TOO_LARGE",
            "compressed source map exceeds the configured limit",
        )

    output = bytearray()
    try:
        with zstandard.ZstdDecompressor().stream_reader(
            io.BytesIO(compressed)
        ) as reader:
            while chunk := reader.read(
                min(1024 * 1024, max_output_bytes + 1 - len(output))
            ):
                output.extend(chunk)
                if len(output) > max_output_bytes:
                    raise ConvertedIngestionError(
                        "SOURCE_MAP_TOO_LARGE",
                        "expanded source map exceeds the configured limit",
                    )
    except ConvertedIngestionError:
        raise
    except (OSError, zstandard.ZstdError) as error:
        raise ConvertedIngestionError(
            "SOURCE_MAP_DECOMPRESSION_FAILED",
            "source map is not a valid zstd stream",
        ) from error

    try:
        payload = bytes(output).decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ConvertedIngestionError(
            "SOURCE_MAP_INVALID_UTF8",
            "source map must contain UTF-8 JSON Lines",
        ) from error

    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(payload.splitlines(), start=1):
        if not line.strip():
            raise ConvertedIngestionError(
                "SOURCE_MAP_INVALID_JSONL",
                f"source map line {line_number} is empty",
            )
        try:
            record = json.loads(
                line,
                parse_constant=lambda value: _raise_invalid_json_constant(value),
            )
        except (json.JSONDecodeError, ValueError) as error:
            raise ConvertedIngestionError(
                "SOURCE_MAP_INVALID_JSONL",
                f"source map line {line_number} is invalid JSON",
            ) from error
        if not isinstance(record, dict):
            raise ConvertedIngestionError(
                "SOURCE_MAP_INVALID_RECORD",
                f"source map line {line_number} must be an object",
            )
        records.append(record)
    if not records:
        raise ConvertedIngestionError(
            "SOURCE_MAP_EMPTY", "source map contains no units"
        )
    return records


def _raise_invalid_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _validate_and_extract_units(
    document_bytes: bytes,
    document_text: str,
    records: Sequence[dict[str, Any]],
) -> list[_ValidatedUnit]:
    marker_matches = list(_MARKER_BYTES_RE.finditer(document_bytes))
    if len(marker_matches) != len(records):
        raise ConvertedIngestionError(
            "SOURCE_UNIT_COUNT_MISMATCH",
            "Markdown marker count does not match source map unit count",
        )
    if len(list(_MARKER_TEXT_RE.finditer(document_text))) != len(marker_matches):
        raise ConvertedIngestionError(
            "SOURCE_MARKER_INVALID_UTF8_BOUNDARY",
            "Markdown markers do not align with UTF-8 text boundaries",
        )

    units: list[_ValidatedUnit] = []
    seen_ids: set[str] = set()
    previous_end = 0
    for index, (marker, record) in enumerate(zip(marker_matches, records, strict=True)):
        unit_id, start, end, locator = _validate_map_record(record, index + 1)
        marker_id = marker.group(1).decode("ascii")
        if marker_id != unit_id:
            raise ConvertedIngestionError(
                "SOURCE_UNIT_ORDER_MISMATCH",
                "Markdown marker order does not match source map unit order",
            )
        if unit_id in seen_ids:
            raise ConvertedIngestionError(
                "SOURCE_UNIT_DUPLICATE",
                "source map contains a duplicate unit identifier",
            )
        seen_ids.add(unit_id)
        if start != marker.end():
            raise ConvertedIngestionError(
                "SOURCE_MAP_OFFSET_MISMATCH",
                "source map byte_start does not immediately follow its Markdown marker",
            )
        if start < previous_end or end > len(document_bytes):
            raise ConvertedIngestionError(
                "SOURCE_MAP_OFFSET_OUT_OF_RANGE",
                "source map byte range is overlapping or outside Markdown",
            )
        gap = document_bytes[previous_end : marker.start()]
        try:
            gap_text = gap.decode("utf-8", errors="strict")
            unit_text = document_bytes[start:end].decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise ConvertedIngestionError(
                "SOURCE_MAP_OFFSET_INVALID_UTF8",
                "source map byte range is not aligned to UTF-8 boundaries",
            ) from error
        if gap_text.strip():
            raise ConvertedIngestionError(
                "UNMAPPED_MARKDOWN_CONTENT",
                "converted Markdown contains non-whitespace text outside source units",
            )
        if not unit_text:
            raise ConvertedIngestionError(
                "SOURCE_MAP_EMPTY_UNIT",
                "source map points to an empty Markdown unit",
            )
        if _ANY_MARKER_TEXT_RE.search(unit_text):
            raise ConvertedIngestionError(
                "NESTED_SOURCE_MARKER",
                "source unit content contains a nested source marker",
            )
        units.append(_ValidatedUnit(unit_id=unit_id, text=unit_text, locator=locator))
        previous_end = end

    try:
        trailing = document_bytes[previous_end:].decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ConvertedIngestionError(
            "SOURCE_MAP_OFFSET_INVALID_UTF8",
            "trailing Markdown is not aligned to UTF-8 boundaries",
        ) from error
    if trailing.strip():
        raise ConvertedIngestionError(
            "UNMAPPED_MARKDOWN_CONTENT",
            "converted Markdown contains trailing text outside source units",
        )
    return units


def _validate_map_record(
    record: Mapping[str, Any],
    record_number: int,
) -> tuple[str, int, int, dict[str, Any]]:
    if record.get("schema_version") != "source-map-unit-v1":
        raise ConvertedIngestionError(
            "SOURCE_MAP_SCHEMA_UNSUPPORTED",
            f"source map record {record_number} has an unsupported schema",
        )
    unit_id = record.get("unit_id")
    if not isinstance(unit_id, str) or _UNIT_ID_RE.fullmatch(unit_id) is None:
        raise ConvertedIngestionError(
            "SOURCE_MAP_INVALID_UNIT_ID",
            f"source map record {record_number} has an invalid unit_id",
        )
    markdown = record.get("markdown")
    if not isinstance(markdown, dict):
        raise ConvertedIngestionError(
            "SOURCE_MAP_INVALID_OFFSET",
            f"source map record {record_number} has no Markdown byte range",
        )
    start = markdown.get("byte_start")
    end = markdown.get("byte_end")
    if type(start) is not int or type(end) is not int or start < 0 or end <= start:
        raise ConvertedIngestionError(
            "SOURCE_MAP_INVALID_OFFSET",
            f"source map record {record_number} has an invalid Markdown byte range",
        )
    source = record.get("source")
    if not isinstance(source, dict):
        raise ConvertedIngestionError(
            "SOURCE_LOCATOR_INVALID",
            f"source map record {record_number} has no source locator",
        )
    locator = dict(source)
    _validate_locator(locator, record_number)
    try:
        json.dumps(locator, ensure_ascii=False, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ConvertedIngestionError(
            "SOURCE_LOCATOR_NOT_SERIALIZABLE",
            f"source locator {record_number} is not JSON serializable",
        ) from error
    return unit_id, start, end, locator


def _validate_locator(locator: Mapping[str, Any], record_number: int) -> None:
    source_type = locator.get("type")
    if source_type not in _SUPPORTED_SOURCE_TYPES:
        raise ConvertedIngestionError(
            "SOURCE_LOCATOR_TYPE_UNSUPPORTED",
            f"source locator {record_number} has an unsupported type",
        )
    kind = locator.get("kind")
    if not isinstance(kind, str) or not kind.strip():
        raise ConvertedIngestionError(
            "SOURCE_LOCATOR_INVALID",
            f"source locator {record_number} has no kind",
        )

    if source_type in {"markdown", "plaintext"}:
        _require_ordered_range(locator, "line_start", "line_end", record_number)
    elif source_type == "pdf":
        _require_positive_int(locator, "page", record_number)
        if "block" in locator:
            _require_positive_int(locator, "block", record_number)
    elif source_type == "docx":
        if kind == "table":
            _require_positive_int(locator, "table", record_number)
            _require_ordered_range(locator, "row_start", "row_end", record_number)
        else:
            _require_positive_int(locator, "paragraph", record_number)
    elif source_type == "pptx":
        _require_positive_int(locator, "slide", record_number)
        if kind != "slide":
            _require_positive_int(locator, "shape", record_number)
        if kind == "table":
            _require_positive_int(locator, "table", record_number)
    elif source_type == "xlsx":
        if not isinstance(locator.get("sheet"), str) or not locator["sheet"].strip():
            _invalid_locator(record_number, "XLSX locator has no sheet name")
        _require_positive_int(locator, "sheet_index", record_number)
        if kind == "table":
            _require_ordered_range(locator, "row_start", "row_end", record_number)
    elif source_type == "csv":
        _require_ordered_range(locator, "row_start", "row_end", record_number)


def _require_positive_int(
    locator: Mapping[str, Any], key: str, record_number: int
) -> None:
    value = locator.get(key)
    if type(value) is not int or value <= 0:
        _invalid_locator(
            record_number, f"locator field {key} must be a positive integer"
        )


def _require_ordered_range(
    locator: Mapping[str, Any],
    start_key: str,
    end_key: str,
    record_number: int,
) -> None:
    _require_positive_int(locator, start_key, record_number)
    _require_positive_int(locator, end_key, record_number)
    if locator[start_key] > locator[end_key]:
        _invalid_locator(
            record_number, f"locator range {start_key}/{end_key} is reversed"
        )


def _invalid_locator(record_number: int, detail: str) -> None:
    raise ConvertedIngestionError(
        "SOURCE_LOCATOR_INVALID",
        f"source locator {record_number} is invalid: {detail}",
    )


def _draft_chunks(
    units: Sequence[_ValidatedUnit],
    splitter: RecursiveCharacterTextSplitter,
    chunk_size: int,
) -> list[_ChunkDraft]:
    heading_path: dict[int, _HeadingRef] = {}
    drafts: list[_ChunkDraft] = []
    headings_dirty = False

    for unit in units:
        for event_type, payload in _unit_markdown_events(unit.text):
            if event_type == "heading":
                level, markdown = payload
                heading_path[level] = _HeadingRef(
                    level=level,
                    markdown=markdown,
                    unit_id=unit.unit_id,
                    locator=unit.locator,
                )
                for nested_level in tuple(heading_path):
                    if nested_level > level:
                        del heading_path[nested_level]
                headings_dirty = True
                continue

            body = payload.strip()
            if not body:
                continue
            body_parts = splitter.split_text(body) if len(body) > chunk_size else [body]
            headings = tuple(heading_path[level] for level in sorted(heading_path))
            heading_ids = tuple(heading.unit_id for heading in headings)
            heading_locators = tuple(heading.locator for heading in headings)
            for body_part in body_parts:
                source_ids = _stable_unique((*heading_ids, unit.unit_id))
                locators = _stable_unique_locators((*heading_locators, unit.locator))
                drafts.append(
                    _ChunkDraft(
                        body=body_part,
                        headings=headings,
                        source_unit_ids=source_ids,
                        locators=locators,
                    )
                )
            headings_dirty = False

    if headings_dirty and heading_path:
        headings = tuple(heading_path[level] for level in sorted(heading_path))
        drafts.append(
            _ChunkDraft(
                body="",
                headings=headings,
                source_unit_ids=_stable_unique(heading.unit_id for heading in headings),
                locators=_stable_unique_locators(
                    heading.locator for heading in headings
                ),
            )
        )
    return drafts


def _unit_markdown_events(text: str) -> Iterable[tuple[str, Any]]:
    body_lines: list[str] = []
    fence_character: str | None = None
    fence_length = 0

    def flush_body() -> tuple[str, str] | None:
        if not body_lines:
            return None
        body = "".join(body_lines)
        body_lines.clear()
        return "body", body

    for line in text.splitlines(keepends=True):
        stripped_line = line.rstrip("\r\n")
        fence_match = _FENCE_RE.match(stripped_line)
        heading_match = None if fence_character else _HEADING_RE.match(stripped_line)
        if heading_match:
            body_event = flush_body()
            if body_event is not None:
                yield body_event
            level = len(heading_match.group(1))
            title = heading_match.group(2).strip()
            yield "heading", (level, f"{'#' * level} {title}")
            continue

        body_lines.append(line)
        if fence_match:
            token = fence_match.group(1)
            if fence_character is None:
                fence_character = token[0]
                fence_length = len(token)
            elif token[0] == fence_character and len(token) >= fence_length:
                fence_character = None
                fence_length = 0

    body_event = flush_body()
    if body_event is not None:
        yield body_event


def _merge_small_drafts(
    drafts: Sequence[_ChunkDraft], chunk_size: int
) -> list[_ChunkDraft]:
    merged: list[_ChunkDraft] = []
    for draft in drafts:
        if not merged:
            merged.append(draft)
            continue
        previous = merged[-1]
        if not _locators_compatible(previous.locators, draft.locators):
            merged.append(draft)
            continue
        candidate = _merge_drafts(previous, draft)
        if len(candidate.render()) > chunk_size:
            merged.append(draft)
        else:
            merged[-1] = candidate
    return merged


def _merge_drafts(left: _ChunkDraft, right: _ChunkDraft) -> _ChunkDraft:
    if _heading_signature(left.headings) == _heading_signature(right.headings):
        headings = left.headings
        body = "\n\n".join(
            part for part in (left.body.strip(), right.body.strip()) if part
        )
    else:
        headings = ()
        body = "\n\n".join(part for part in (left.render(), right.render()) if part)
    return _ChunkDraft(
        body=body,
        headings=headings,
        source_unit_ids=_stable_unique((*left.source_unit_ids, *right.source_unit_ids)),
        locators=_stable_unique_locators((*left.locators, *right.locators)),
    )


def _heading_signature(headings: Sequence[_HeadingRef]) -> tuple[tuple[int, str], ...]:
    return tuple((heading.level, heading.markdown) for heading in headings)


def _locators_compatible(
    left_locators: Sequence[Mapping[str, Any]],
    right_locators: Sequence[Mapping[str, Any]],
) -> bool:
    left_types = {locator["type"] for locator in left_locators}
    right_types = {locator["type"] for locator in right_locators}
    if len(left_types) != 1 or left_types != right_types:
        return False
    source_type = next(iter(left_types))
    if source_type == "xlsx":
        left_sheets = {
            (locator.get("sheet_index"), locator.get("sheet"))
            for locator in left_locators
        }
        right_sheets = {
            (locator.get("sheet_index"), locator.get("sheet"))
            for locator in right_locators
        }
        return len(left_sheets) == 1 and left_sheets == right_sheets
    return True


def _aggregate_locators(locators: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    unique = _stable_unique_locators(locators)
    types = sorted({str(locator["type"]) for locator in unique})
    serialized_locators = [dict(locator) for locator in unique]
    if len(types) != 1:
        return {"type": "mixed", "types": types, "locators": serialized_locators}

    source_type = types[0]
    envelope: dict[str, Any] = {"type": source_type}
    if source_type in {"markdown", "plaintext"}:
        envelope.update(
            line_start=min(locator["line_start"] for locator in unique),
            line_end=max(locator["line_end"] for locator in unique),
        )
    elif source_type == "pdf":
        pages = [locator["page"] for locator in unique]
        envelope.update(page_start=min(pages), page_end=max(pages))
    elif source_type == "docx":
        paragraphs = [
            locator["paragraph"] for locator in unique if "paragraph" in locator
        ]
        tables = [locator["table"] for locator in unique if "table" in locator]
        if paragraphs:
            envelope.update(
                paragraph_start=min(paragraphs), paragraph_end=max(paragraphs)
            )
        if tables:
            envelope.update(table_start=min(tables), table_end=max(tables))
    elif source_type == "pptx":
        slides = [locator["slide"] for locator in unique]
        envelope.update(slide_start=min(slides), slide_end=max(slides))
    elif source_type == "xlsx":
        sheet_pairs = {(locator["sheet_index"], locator["sheet"]) for locator in unique}
        if len(sheet_pairs) == 1:
            sheet_index, sheet = next(iter(sheet_pairs))
            envelope.update(sheet=sheet, sheet_index=sheet_index)
        else:
            envelope["sheets"] = [
                {"sheet_index": index, "sheet": sheet}
                for index, sheet in sorted(sheet_pairs)
            ]
        _add_optional_range(envelope, unique, "row_start", "row_end")
    elif source_type == "csv":
        _add_optional_range(envelope, unique, "row_start", "row_end")
    envelope["locators"] = serialized_locators
    return envelope


def _add_optional_range(
    envelope: dict[str, Any],
    locators: Sequence[Mapping[str, Any]],
    start_key: str,
    end_key: str,
) -> None:
    starts = [locator[start_key] for locator in locators if start_key in locator]
    ends = [locator[end_key] for locator in locators if end_key in locator]
    if starts and ends:
        envelope[start_key] = min(starts)
        envelope[end_key] = max(ends)


def _stable_unique(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(values))


def _stable_unique_locators(
    locators: Iterable[Mapping[str, Any]],
) -> tuple[dict[str, Any], ...]:
    unique: dict[str, dict[str, Any]] = {}
    for locator in locators:
        serialized = json.dumps(
            dict(locator),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        unique.setdefault(serialized, dict(locator))
    return tuple(unique.values())
