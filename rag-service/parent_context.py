from __future__ import annotations

import re
from collections import defaultdict


_HEADING_LINE_RE = re.compile(r"^\s{0,3}#{1,6}\s+.+?\s*#*\s*$")


def _without_repeated_heading_prefix(content: str) -> str:
    lines = str(content or "").splitlines()
    index = 0
    saw_heading = False
    while index < len(lines):
        line = lines[index]
        if _HEADING_LINE_RE.match(line):
            saw_heading = True
            index += 1
            continue
        if saw_heading and not line.strip():
            index += 1
            continue
        break
    return "\n".join(lines[index:]).strip()


def _heading_prefix(metadata: dict) -> str:
    values = [str(value).strip() for value in metadata.get("heading_path") or [] if str(value).strip()]
    return "\n".join(f"{'#' * min(index, 6)} {title}" for index, title in enumerate(values, start=1))


def build_parent_section_documents(
    selected_children: list[dict],
    parent_rows: list[dict],
    max_parent_chars: int = 8000,
) -> list[dict]:
    """Expand ranked child hits into bounded, deduplicated Markdown parents."""
    rows_by_parent: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in parent_rows:
        metadata = row.get("metadata") or {}
        file_id = str(row.get("file_id") or metadata.get("file_id") or "")
        parent_id = str(row.get("parent_section_id") or metadata.get("parent_section_id") or "")
        if file_id and parent_id:
            rows_by_parent[(file_id, parent_id)].append(row)

    children_by_parent: dict[tuple[str, str], list[dict]] = defaultdict(list)
    order: list[tuple[str, str]] = []
    for child in selected_children:
        metadata = child.get("metadata") or {}
        key = (
            str(metadata.get("file_id") or child.get("file_id") or ""),
            str(metadata.get("parent_section_id") or ""),
        )
        if not all(key) or key not in rows_by_parent:
            continue
        if key not in children_by_parent:
            order.append(key)
        children_by_parent[key].append(child)

    expanded_by_key: dict[tuple[str, str], dict] = {}
    for key in order:
        children = children_by_parent[key]
        rows = sorted(rows_by_parent[key], key=lambda row: int(row.get("chunk_index") or 0))
        primary = dict(children[0])
        primary_metadata = dict(primary.get("metadata") or {})
        first_metadata = dict(rows[0].get("metadata") or {})
        metadata = {**first_metadata, **primary_metadata}

        heading = _heading_prefix(metadata)
        bodies: list[str] = []
        seen_bodies: set[str] = set()
        for row in rows:
            body = _without_repeated_heading_prefix(str(row.get("content") or ""))
            if not body or body in seen_bodies:
                continue
            seen_bodies.add(body)
            bodies.append(body)
        combined = "\n\n".join(part for part in (heading, *bodies) if part).strip()
        if len(combined) > max_parent_chars:
            combined = combined[:max_parent_chars].rstrip() + "\n\n[Parent section truncated]"

        child_ids = [str(child.get("id") or child.get("chunk_id") or "") for child in children]
        channels: list[str] = []
        for child in children:
            for channel in child.get("retrieval_channels") or (child.get("metadata") or {}).get("retrieval_channels") or []:
                if channel not in channels:
                    channels.append(channel)
        metadata.update({
            "file_id": key[0],
            "parent_section_id": key[1],
            "parent_child": True,
            "retrieval_mode": "parent_section",
            "matched_child_ids": child_ids,
            "matched_child_indices": [
                (child.get("metadata") or {}).get("chunk_index")
                for child in children
            ],
            "parent_chunk_count": len(rows),
            "chunk_index": int(rows[0].get("chunk_index") or 0),
            "chunk_end_index": int(rows[-1].get("chunk_index") or 0),
        })
        primary.update({
            "id": f"parent:{key[0]}:{key[1]}",
            "content": combined,
            "metadata": metadata,
            "retrieval_channels": channels,
            "parent_child": True,
        })
        expanded_by_key[key] = primary

    output: list[dict] = []
    emitted_parents: set[tuple[str, str]] = set()
    for child in selected_children:
        metadata = child.get("metadata") or {}
        key = (
            str(metadata.get("file_id") or child.get("file_id") or ""),
            str(metadata.get("parent_section_id") or ""),
        )
        if key in expanded_by_key:
            if key not in emitted_parents:
                emitted_parents.add(key)
                output.append(expanded_by_key[key])
            continue
        output.append(child)
    return output
