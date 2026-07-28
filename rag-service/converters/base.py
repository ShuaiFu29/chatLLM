from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from abc import ABC, abstractmethod
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import zstandard
from converted_document import (
    CONVERSION_SCHEMA_VERSION,
    ConversionArtifact,
    ConversionManifest,
    ConversionResult,
    DocumentConversionError,
)
from source_map import SourceUnit, source_unit_marker

CONVERTER_VERSION = "1.0.0"
_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_RESERVED_MARKER_RE = re.compile(r"^[ \t]*<!-- source-unit:u_[0-9a-f]{32} -->[ \t]*(?:\n)?$")


@dataclass(frozen=True)
class ConversionLimits:
    max_source_bytes: int = 32 * 1024 * 1024
    max_unit_chars: int = 1024 * 1024
    max_pdf_pages: int = 2_000
    max_pdf_extracted_chars: int = 16 * 1024 * 1024

    def __post_init__(self) -> None:
        if (
            self.max_source_bytes <= 0
            or self.max_unit_chars <= 0
            or self.max_pdf_pages <= 0
            or self.max_pdf_extracted_chars <= 0
        ):
            raise ValueError("conversion limits must be positive")


@dataclass(frozen=True)
class SourceInspection:
    path: Path
    sha256: str
    byte_size: int


@dataclass(frozen=True)
class TextBlock:
    text: str
    line_start: int
    line_end: int


@dataclass(frozen=True)
class LocatedTextBlock:
    """A generated Markdown unit with an exact original-document locator."""

    text: str
    source: Mapping[str, Any]


class DocumentConverter(ABC):
    document_kind: str
    conversion_profile: str
    converter_name: str
    source_type: str

    def __init__(self, limits: ConversionLimits | None = None):
        self.limits = limits or ConversionLimits()

    @abstractmethod
    def convert(self, source_file: str | Path, output_dir: str | Path) -> ConversionResult:
        raise NotImplementedError

    def _inspect_source(self, source_file: str | Path) -> SourceInspection:
        source = Path(source_file)
        if source.is_symlink():
            raise DocumentConversionError("SOURCE_NOT_FILE", "source path must be a regular file")
        try:
            resolved = source.resolve(strict=True)
        except (FileNotFoundError, OSError) as error:
            raise DocumentConversionError("SOURCE_NOT_FOUND", "source file does not exist") from error
        if not resolved.is_file():
            raise DocumentConversionError("SOURCE_NOT_FILE", "source path must be a regular file")

        digest = hashlib.sha256()
        size = 0
        try:
            with resolved.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    size += len(chunk)
                    if size > self.limits.max_source_bytes:
                        raise DocumentConversionError(
                            "SOURCE_TOO_LARGE",
                            "source file exceeds the configured conversion limit",
                        )
                    digest.update(chunk)
        except DocumentConversionError:
            raise
        except OSError as error:
            raise DocumentConversionError("SOURCE_READ_FAILED", "source file could not be read") from error

        return SourceInspection(resolved, digest.hexdigest(), size)

    def _read_bounded_bytes(self, inspection: SourceInspection) -> bytes:
        chunks: list[bytes] = []
        size = 0
        digest = hashlib.sha256()
        try:
            with inspection.path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    size += len(chunk)
                    if size > self.limits.max_source_bytes:
                        raise DocumentConversionError(
                            "SOURCE_TOO_LARGE",
                            "source file exceeds the configured conversion limit",
                        )
                    chunks.append(chunk)
                    digest.update(chunk)
        except DocumentConversionError:
            raise
        except OSError as error:
            raise DocumentConversionError("SOURCE_READ_FAILED", "source file could not be read") from error
        if size != inspection.byte_size or digest.hexdigest() != inspection.sha256:
            raise DocumentConversionError("SOURCE_CHANGED", "source file changed during conversion")
        return b"".join(chunks)

    def _verify_source_unchanged(self, inspection: SourceInspection) -> None:
        current = self._inspect_source(inspection.path)
        if current.byte_size != inspection.byte_size or current.sha256 != inspection.sha256:
            raise DocumentConversionError("SOURCE_CHANGED", "source file changed during conversion")

    def _convert_text(
        self,
        inspection: SourceInspection,
        output_dir: str | Path,
        lines: Iterable[str],
        source_encoding: str,
        warnings: tuple[str, ...] = (),
    ) -> ConversionResult:
        return self._convert_items(
            inspection,
            output_dir,
            _iter_text_items(
                lines,
                self.limits.max_unit_chars,
                self.limits.max_source_bytes + 1,
            ),
            source_encoding,
            warnings,
        )

    def _convert_located_blocks(
        self,
        inspection: SourceInspection,
        output_dir: str | Path,
        blocks: Iterable[LocatedTextBlock],
        source_encoding: str,
        warnings: tuple[str, ...] = (),
    ) -> ConversionResult:
        """Persist generated Markdown while retaining caller-provided locators."""

        return self._convert_items(
            inspection,
            output_dir,
            _iter_located_items(
                blocks,
                self.limits.max_unit_chars,
                self.limits.max_source_bytes + 1,
            ),
            source_encoding,
            warnings,
        )

    def _convert_items(
        self,
        inspection: SourceInspection,
        output_dir: str | Path,
        items: Iterable[str | TextBlock | LocatedTextBlock],
        source_encoding: str,
        warnings: tuple[str, ...],
    ) -> ConversionResult:
        output_root, final_paths = _prepare_output_paths(inspection.path, output_dir)
        temporary_paths: list[Path] = []
        published_paths: list[Path] = []
        conversion_succeeded = False
        try:
            markdown_temp = _temporary_path(output_root, "document.md")
            source_map_temp = _temporary_path(output_root, "source-map.jsonl.zst")
            manifest_temp = _temporary_path(output_root, "manifest.json")
            temporary_paths.extend((markdown_temp, source_map_temp, manifest_temp))

            markdown_hash = hashlib.sha256()
            unit_count = 0
            byte_offset = 0
            has_embeddable_text = False
            with markdown_temp.open("wb") as markdown_stream, source_map_temp.open("wb") as map_raw:
                compressor = zstandard.ZstdCompressor(level=3, write_checksum=True)
                with compressor.stream_writer(map_raw, closefd=False) as map_stream:
                    for item in items:
                        if isinstance(item, str):
                            encoded = item.encode("utf-8")
                            markdown_stream.write(encoded)
                            markdown_hash.update(encoded)
                            byte_offset += len(encoded)
                            continue

                        if isinstance(item, LocatedTextBlock):
                            source = dict(item.source)
                            unit_id = _located_source_unit_id(self.document_kind, item)
                        else:
                            source = {
                                "type": self.source_type,
                                "line_start": item.line_start,
                                "line_end": item.line_end,
                                "kind": self._block_kind(item.text),
                            }
                            unit_id = _source_unit_id(self.document_kind, item)
                        marker = source_unit_marker(unit_id).encode("utf-8")
                        markdown_stream.write(marker)
                        markdown_hash.update(marker)
                        byte_offset += len(marker)

                        content = item.text.encode("utf-8")
                        start = byte_offset
                        markdown_stream.write(content)
                        markdown_hash.update(content)
                        byte_offset += len(content)
                        has_embeddable_text = has_embeddable_text or bool(item.text.strip())

                        unit = SourceUnit(
                            unit_id=unit_id,
                            markdown_byte_start=start,
                            markdown_byte_end=byte_offset,
                            source=source,
                        )
                        map_stream.write(unit.to_json_line())
                        unit_count += 1

            if not has_embeddable_text:
                raise DocumentConversionError("EMPTY_DOCUMENT", "source document has no embeddable text")

            self._verify_source_unchanged(inspection)

            markdown_size = markdown_temp.stat().st_size
            map_size = source_map_temp.stat().st_size
            map_hash = _hash_file(source_map_temp)
            manifest = ConversionManifest(
                schema_version=CONVERSION_SCHEMA_VERSION,
                converter_name=self.converter_name,
                converter_version=CONVERTER_VERSION,
                document_kind=self.document_kind,
                conversion_profile=self.conversion_profile,
                source_filename=inspection.path.name,
                source_sha256=inspection.sha256,
                source_byte_size=inspection.byte_size,
                source_encoding=source_encoding,
                markdown_sha256=markdown_hash.hexdigest(),
                markdown_byte_size=markdown_size,
                source_map_sha256=map_hash,
                source_map_byte_size=map_size,
                unit_count=unit_count,
                warnings=warnings,
            )
            manifest_bytes = (
                json.dumps(
                    manifest.to_dict(),
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            manifest_temp.write_bytes(manifest_bytes)

            for key, temporary in (
                ("document", markdown_temp),
                ("source_map", source_map_temp),
                ("manifest", manifest_temp),
            ):
                os.replace(temporary, final_paths[key])
                published_paths.append(final_paths[key])
            temporary_paths.clear()

            result = ConversionResult(
                document=_artifact(final_paths["document"]),
                source_map=_artifact(final_paths["source_map"]),
                manifest_artifact=_artifact(final_paths["manifest"]),
                manifest=manifest,
            )
            conversion_succeeded = True
            return result
        except (DocumentConversionError, UnicodeError):
            raise
        except zstandard.ZstdError as error:
            raise DocumentConversionError(
                "SOURCE_MAP_WRITE_FAILED",
                "compressed source map could not be written",
            ) from error
        except OSError as error:
            raise DocumentConversionError("OUTPUT_WRITE_FAILED", "conversion output could not be written") from error
        finally:
            for temporary in temporary_paths:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
            if not conversion_succeeded:
                for published in published_paths:
                    try:
                        published.unlink(missing_ok=True)
                    except OSError:
                        pass

    def _block_kind(self, text: str) -> str:
        return "paragraph"


def _prepare_output_paths(source: Path, output_dir: str | Path) -> tuple[Path, dict[str, Path]]:
    root_candidate = Path(output_dir)
    if root_candidate.is_symlink():
        raise DocumentConversionError("UNSAFE_OUTPUT_PATH", "output directory cannot be a symbolic link")
    try:
        root_candidate.mkdir(parents=True, exist_ok=True)
        root = root_candidate.resolve(strict=True)
    except OSError as error:
        raise DocumentConversionError("OUTPUT_WRITE_FAILED", "output directory could not be created") from error
    if not root.is_dir():
        raise DocumentConversionError("UNSAFE_OUTPUT_PATH", "output path must be a directory")

    names = {
        "document": "document.md",
        "source_map": "source-map.jsonl.zst",
        "manifest": "manifest.json",
    }
    paths = {key: root / name for key, name in names.items()}
    for path in paths.values():
        if path.is_symlink() or path.resolve(strict=False).parent != root:
            raise DocumentConversionError("UNSAFE_OUTPUT_PATH", "conversion output path is unsafe")
        if path == source:
            raise DocumentConversionError("UNSAFE_OUTPUT_PATH", "source file cannot be overwritten")
        if path.exists():
            raise DocumentConversionError(
                "OUTPUT_ALREADY_EXISTS",
                "conversion generation output already exists",
            )
    return root, paths


def _temporary_path(root: Path, final_name: str) -> Path:
    descriptor, raw_path = tempfile.mkstemp(prefix=f".{final_name}.", suffix=".tmp", dir=root)
    os.close(descriptor)
    return Path(raw_path)


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact(path: Path) -> ConversionArtifact:
    return ConversionArtifact(path=path, sha256=_hash_file(path), byte_size=path.stat().st_size)


def _source_unit_id(document_kind: str, block: TextBlock) -> str:
    digest = hashlib.sha256()
    digest.update(document_kind.encode("ascii"))
    digest.update(b"\0")
    digest.update(str(block.line_start).encode("ascii"))
    digest.update(b":")
    digest.update(str(block.line_end).encode("ascii"))
    digest.update(b"\0")
    digest.update(block.text.encode("utf-8"))
    return f"u_{digest.hexdigest()[:32]}"


def _located_source_unit_id(document_kind: str, block: LocatedTextBlock) -> str:
    try:
        source = json.dumps(
            dict(block.source),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise DocumentConversionError(
            "INVALID_SOURCE_LOCATOR",
            "source locator must be JSON serializable",
        ) from error
    digest = hashlib.sha256()
    digest.update(document_kind.encode("ascii"))
    digest.update(b"\0")
    digest.update(source)
    digest.update(b"\0")
    digest.update(block.text.encode("utf-8"))
    return f"u_{digest.hexdigest()[:32]}"


def _iter_located_items(
    blocks: Iterable[LocatedTextBlock],
    max_unit_chars: int,
    max_document_chars: int,
) -> Iterator[str | LocatedTextBlock]:
    document_chars = 0
    emitted = False
    for block in blocks:
        text = block.text.replace("\r\n", "\n").replace("\r", "\n")
        if not text.strip():
            continue
        if not text.endswith("\n"):
            text += "\n"
        if len(text) > max_unit_chars:
            raise DocumentConversionError(
                "SOURCE_UNIT_TOO_LARGE",
                "a source text unit exceeds the configured conversion limit",
            )
        if any(_RESERVED_MARKER_RE.fullmatch(line) for line in text.splitlines(keepends=True)):
            raise DocumentConversionError(
                "RESERVED_SOURCE_MARKER",
                "source document contains a reserved source-unit marker",
            )
        separator_size = 1 if emitted else 0
        document_chars += len(text) + separator_size
        if document_chars > max_document_chars:
            raise DocumentConversionError(
                "SOURCE_TOO_LARGE",
                "converted document exceeds the configured conversion limit",
            )
        if emitted:
            yield "\n"
        yield LocatedTextBlock(text=text, source=dict(block.source))
        emitted = True


def _iter_text_items(
    lines: Iterable[str],
    max_unit_chars: int,
    max_document_chars: int,
) -> Iterator[str | TextBlock]:
    block_lines: list[str] = []
    block_chars = 0
    block_start = 0
    fence_character: str | None = None
    fence_length = 0
    document_chars = 0

    def flush(line_end: int) -> TextBlock | None:
        nonlocal block_lines, block_chars, block_start
        if not block_lines:
            return None
        item = TextBlock("".join(block_lines), block_start, line_end)
        block_lines = []
        block_chars = 0
        block_start = 0
        return item

    line_number = 0
    for line_number, original_line in enumerate(lines, start=1):
        line = original_line.replace("\r\n", "\n").replace("\r", "\n")
        if not line.endswith("\n"):
            line += "\n"
        document_chars += len(line)
        if document_chars > max_document_chars:
            raise DocumentConversionError(
                "SOURCE_TOO_LARGE",
                "source file exceeds the configured conversion limit",
            )
        if _RESERVED_MARKER_RE.fullmatch(line):
            raise DocumentConversionError(
                "RESERVED_SOURCE_MARKER",
                "source document contains a reserved source-unit marker",
            )
        fence_match = _FENCE_RE.match(line)

        if fence_character is None and not line.strip():
            item = flush(line_number - 1)
            if item is not None:
                yield item
            yield line
            continue

        if not block_lines:
            block_start = line_number
        if block_chars + len(line) > max_unit_chars:
            raise DocumentConversionError(
                "SOURCE_UNIT_TOO_LARGE",
                "a source text unit exceeds the configured conversion limit",
            )
        block_lines.append(line)
        block_chars += len(line)

        if fence_match:
            token = fence_match.group(1)
            if fence_character is None:
                fence_character = token[0]
                fence_length = len(token)
            elif token[0] == fence_character and len(token) >= fence_length:
                fence_character = None
                fence_length = 0

    item = flush(line_number)
    if item is not None:
        yield item
