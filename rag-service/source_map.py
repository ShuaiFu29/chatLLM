from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping


SOURCE_MAP_SCHEMA_VERSION = "source-map-unit-v1"
SOURCE_UNIT_MARKER_RE = re.compile(
    r"(?m)^[ \t]*<!-- source-unit:(u_[0-9a-f]{32}) -->[ \t]*\n?"
)


@dataclass(frozen=True)
class SourceUnit:
    unit_id: str
    markdown_byte_start: int
    markdown_byte_end: int
    source: Mapping[str, Any]

    def __post_init__(self) -> None:
        if not re.fullmatch(r"u_[0-9a-f]{32}", self.unit_id):
            raise ValueError("unit_id must be a deterministic source-unit identifier")
        if self.markdown_byte_start < 0 or self.markdown_byte_end <= self.markdown_byte_start:
            raise ValueError("markdown byte range must be non-empty and ordered")

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": SOURCE_MAP_SCHEMA_VERSION,
            "unit_id": self.unit_id,
            "markdown": {
                "byte_start": self.markdown_byte_start,
                "byte_end": self.markdown_byte_end,
            },
            "source": dict(self.source),
        }

    def to_json_line(self) -> bytes:
        return (
            json.dumps(
                self.to_dict(),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            + b"\n"
        )


def source_unit_marker(unit_id: str) -> str:
    if not re.fullmatch(r"u_[0-9a-f]{32}", unit_id):
        raise ValueError("invalid source-unit identifier")
    return f"<!-- source-unit:{unit_id} -->\n"


def strip_source_unit_markers(markdown: str) -> str:
    """Return the text that is safe to pass to chunking or embedding."""

    return SOURCE_UNIT_MARKER_RE.sub("", markdown)


def iter_source_unit_ids(markdown: str) -> Iterable[str]:
    for match in SOURCE_UNIT_MARKER_RE.finditer(markdown):
        yield match.group(1)
