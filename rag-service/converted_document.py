from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


CONVERSION_SCHEMA_VERSION = "converted-document-v1"


class DocumentConversionError(ValueError):
    """A conversion failure with a stable, safe-to-persist error code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ConversionArtifact:
    path: Path
    sha256: str
    byte_size: int


@dataclass(frozen=True)
class ConversionManifest:
    schema_version: str
    converter_name: str
    converter_version: str
    document_kind: str
    conversion_profile: str
    source_filename: str
    source_sha256: str
    source_byte_size: int
    source_encoding: str
    markdown_sha256: str
    markdown_byte_size: int
    source_map_sha256: str
    source_map_byte_size: int
    unit_count: int
    warnings: tuple[str, ...] = ()
    # Provenance that does not indicate a defect. Anything placed in `warnings`
    # flips the file to completed_with_warnings, so benign observations such as
    # "this CSV used semicolons as its delimiter" belong here instead.
    notes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "converter": {
                "name": self.converter_name,
                "version": self.converter_version,
            },
            "document_kind": self.document_kind,
            "conversion_profile": self.conversion_profile,
            "source": {
                "filename": self.source_filename,
                "sha256": self.source_sha256,
                "byte_size": self.source_byte_size,
                "encoding": self.source_encoding,
            },
            "outputs": {
                "markdown": {
                    "filename": "document.md",
                    "sha256": self.markdown_sha256,
                    "byte_size": self.markdown_byte_size,
                },
                "source_map": {
                    "filename": "source-map.jsonl.zst",
                    "sha256": self.source_map_sha256,
                    "byte_size": self.source_map_byte_size,
                    "compression": "zstd",
                },
            },
            "unit_count": self.unit_count,
            "warnings": list(self.warnings),
            "notes": list(self.notes),
        }


@dataclass(frozen=True)
class ConversionResult:
    document: ConversionArtifact
    source_map: ConversionArtifact
    manifest_artifact: ConversionArtifact
    manifest: ConversionManifest
