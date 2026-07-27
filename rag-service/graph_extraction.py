import hashlib
import json
import re
import unicodedata
from typing import Callable

from compatible_api import post_json
from config import settings


ONTOLOGY_REGISTRY = {
    "core-v1": {
        "entity_types": frozenset({
            "Service",
            "Component",
            "API",
            "Database",
            "Queue",
            "Policy",
            "Version",
            "Organization",
            "Person",
            "Concept",
            "Unknown",
        }),
        "relation_types": frozenset({
            "DEPENDS_ON",
            "CONFLICTS_WITH",
            "CONNECTS_TO",
            "IMPACTS",
            "SUPPORTS",
            "REPLACES",
            "USES",
            "PART_OF",
            "PRODUCES",
            "CONSUMES",
            "CONFIGURES",
            "IMPLEMENTS",
            "RELATED_TO",
        }),
    },
}

_REQUIRED_ROOT_FIELDS = {"entities", "mentions", "relations", "coreferences"}
_PRONOUNS = {
    "它", "其", "该服务", "该组件", "该系统", "前者", "后者", "这", "这些",
    "it", "its", "this service", "this component", "the former", "the latter",
}


class GraphExtractionError(ValueError):
    """The model response cannot be admitted into the evidence graph."""


def normalize_entity_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value or "")
    return re.sub(r"\s+", " ", normalized).strip().casefold()


def ontology_schema(version: str) -> dict[str, frozenset[str]]:
    schema = ONTOLOGY_REGISTRY.get(version)
    if schema is None:
        raise GraphExtractionError(f"Unsupported graph ontology version: {version}")
    return schema


def _heading_path(content: str) -> tuple[str, ...]:
    headings: list[str] = []
    for line in (content or "").splitlines():
        if not line.strip():
            if headings:
                continue
            continue
        match = re.match(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", line)
        if not match:
            break
        headings.append(re.sub(r"\s+", " ", match.group(1)).strip())
    return tuple(headings)


def _chunk_identity(row: dict) -> str:
    value = row.get("id") or row.get("chunk_id")
    if value in (None, ""):
        raise GraphExtractionError("Graph extraction chunk is missing an ID")
    return str(value)


def build_chunk_windows(
    chunk_rows: list[dict],
    *,
    context_rows: list[dict] | None = None,
    radius: int = 1,
) -> list[dict]:
    """Build bounded, same-section windows centered on each newly indexed chunk."""
    bounded_radius = max(0, min(int(radius), 2))
    target_ids = {_chunk_identity(row) for row in chunk_rows}
    rows_by_id: dict[str, dict] = {}
    for row in [*(context_rows or []), *chunk_rows]:
        rows_by_id[_chunk_identity(row)] = row

    ordered = sorted(
        rows_by_id.values(),
        key=lambda row: (int(row.get("chunk_index") or 0), _chunk_identity(row)),
    )
    windows: list[dict] = []
    for index, target in enumerate(ordered):
        target_id = _chunk_identity(target)
        if target_id not in target_ids:
            continue
        section = _heading_path(str(target.get("content") or ""))
        target_index = int(target.get("chunk_index") or 0)
        window_chunks = []
        for candidate in ordered[max(0, index - bounded_radius):index + bounded_radius + 1]:
            candidate_index = int(candidate.get("chunk_index") or 0)
            if abs(candidate_index - target_index) > bounded_radius:
                continue
            if _heading_path(str(candidate.get("content") or "")) != section:
                continue
            offset = candidate_index - target_index
            extraction_chunk_id = (
                "target"
                if offset == 0
                else f"previous_{abs(offset)}"
                if offset < 0
                else f"next_{offset}"
            )
            window_chunks.append({
                "chunk_id": extraction_chunk_id,
                "source_chunk_id": _chunk_identity(candidate),
                "chunk_index": candidate_index,
                "content": str(candidate.get("content") or ""),
            })
        windows.append({
            "target_chunk_id": "target",
            "target_source_chunk_id": target_id,
            "section_path": list(section),
            "chunks": window_chunks,
        })
    return windows


def window_content_hash(window: dict) -> str:
    canonical = json.dumps(
        {
            "target_chunk_id": "target",
            "section_path": window.get("section_path") or [],
            "chunks": [
                {
                    "chunk_id": str(chunk.get("chunk_id") or ""),
                    "content": str(chunk.get("content") or ""),
                }
                for chunk in window.get("chunks") or []
            ],
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _system_prompt(schema: dict[str, frozenset[str]]) -> str:
    return (
        "Extract a conservative evidence graph from the supplied adjacent Markdown chunks. "
        "Return one JSON object with exactly entities, mentions, relations, and coreferences arrays. "
        "Every mention/coreference needs chunk_id and evidence_span copied verbatim from that chunk. "
        "Every entity needs name, type, type_label, and aliases. Type must be a controlled broad class; "
        "type_label preserves a concise domain class from the source. Every relation needs source, target, "
        "type, label, and a non-empty evidence array of "
        "{chunk_id, span}; copy every span verbatim. The label is a short predicate preserving the "
        "source's domain wording. Map it to the closest controlled relation type, or RELATED_TO when "
        "no narrower type applies. Resolve pronouns through coreferences, never make a pronoun an entity. "
        "Do not infer facts that the spans do not support. Use only entity types "
        f"{sorted(schema['entity_types'])} and relation types {sorted(schema['relation_types'])}."
    )


def graph_extraction_fingerprint(provider=None) -> str:
    schema = ontology_schema(settings.graph_ontology_version)
    explicit = str(getattr(provider, "cache_fingerprint", "") or "").strip() if provider else ""
    payload = {
        "provider": explicit or ("custom-provider" if provider else "compatible-api"),
        "base_url": "" if provider else settings.graph_extraction_base_url.rstrip("/"),
        "model": "" if provider else settings.graph_extraction_model,
        "prompt": _system_prompt(schema),
        "root_fields": sorted(_REQUIRED_ROOT_FIELDS),
        "ontology_version": settings.graph_ontology_version,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def extraction_cache_key(
    content_hash: str,
    extractor_version: str,
    ontology_version: str,
    provider_fingerprint: str = "",
) -> str:
    material = f"{content_hash}\n{extractor_version}\n{ontology_version}\n{provider_fingerprint}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _raw_response_content(response: dict) -> str:
    choices = response.get("choices") if isinstance(response, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise GraphExtractionError("Graph extractor returned no choices")
    message = choices[0].get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        raise GraphExtractionError("Graph extractor returned no JSON content")
    return message["content"].strip()


def request_graph_extraction(window: dict) -> dict:
    schema = ontology_schema(settings.graph_ontology_version)
    public_window = {
        "target_chunk_id": "target",
        "section_path": window.get("section_path") or [],
        "chunks": [
            {
                "chunk_id": chunk.get("chunk_id"),
                "content": chunk.get("content"),
            }
            for chunk in window.get("chunks") or []
        ],
    }
    response = post_json(
        settings.graph_extraction_base_url,
        settings.graph_extraction_api_key,
        "/chat/completions",
        {
            "model": settings.graph_extraction_model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": _system_prompt(schema),
                },
                {
                    "role": "user",
                    "content": json.dumps(public_window, ensure_ascii=False),
                },
            ],
        },
        settings.graph_extraction_timeout_ms / 1000,
    )
    raw = _raw_response_content(response)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GraphExtractionError("Graph extractor did not return strict JSON") from exc
    if not isinstance(payload, dict):
        raise GraphExtractionError("Graph extractor JSON root must be an object")
    return payload


def _strict_array(payload: dict, field: str, maximum: int) -> list:
    value = payload.get(field)
    if not isinstance(value, list):
        raise GraphExtractionError(f"Graph extractor field {field} must be an array")
    if len(value) > maximum:
        raise GraphExtractionError(f"Graph extractor field {field} exceeds its limit")
    return value


def _evidence_span(chunks: dict[str, str], chunk_id: object, span: object) -> tuple[str, str]:
    normalized_chunk_id = str(chunk_id or "")
    normalized_span = str(span or "").strip()
    content = chunks.get(normalized_chunk_id)
    if content is None or not normalized_span or normalized_span not in content:
        raise GraphExtractionError("Graph extraction evidence span is not present in its chunk")
    return normalized_chunk_id, normalized_span


def _name_is_supported(name: str, aliases: list[str], evidence: list[str], coreference_mentions: set[str]) -> bool:
    normalized_evidence = normalize_entity_name("\n".join(evidence))

    def contains_phrase(value: str) -> bool:
        normalized = normalize_entity_name(value)
        if not normalized:
            return False
        if re.fullmatch(r"[a-z0-9_.+\-/ ]+", normalized):
            return bool(re.search(
                rf"(?<![a-z0-9_]){re.escape(normalized)}(?![a-z0-9_])",
                normalized_evidence,
            ))
        return normalized in normalized_evidence

    candidates = [name, *aliases]
    if any(contains_phrase(candidate) for candidate in candidates if candidate):
        return True
    return any(contains_phrase(mention) for mention in coreference_mentions)


def validate_graph_extraction(
    payload: dict,
    window: dict,
    *,
    extractor_version: str,
    ontology_version: str,
) -> dict:
    """Validate the whole model response; one invalid item rejects the model result."""
    if not isinstance(payload, dict) or set(payload) != _REQUIRED_ROOT_FIELDS:
        raise GraphExtractionError("Graph extractor JSON has an unexpected schema")
    schema = ontology_schema(ontology_version)
    chunks = {
        str(chunk.get("chunk_id") or ""): str(chunk.get("content") or "")
        for chunk in window.get("chunks") or []
    }
    if not chunks or str(window.get("target_chunk_id") or "") not in chunks:
        raise GraphExtractionError("Graph extraction window is invalid")

    raw_entities = _strict_array(payload, "entities", 48)
    raw_mentions = _strict_array(payload, "mentions", 96)
    raw_relations = _strict_array(payload, "relations", 32)
    raw_coreferences = _strict_array(payload, "coreferences", 32)

    entities: list[dict] = []
    entities_by_name: dict[str, dict] = {}
    alias_to_entity: dict[str, set[str]] = {}
    for item in raw_entities:
        if (
            not isinstance(item, dict)
            or not {"name", "type", "aliases"}.issubset(item)
            or set(item) - {"name", "type", "type_label", "aliases"}
        ):
            raise GraphExtractionError("Graph extractor entity is malformed")
        name = re.sub(r"\s+", " ", str(item.get("name") or "")).strip()
        normalized_name = normalize_entity_name(name)
        entity_type = str(item.get("type") or "")
        entity_type_label = re.sub(r"\s+", " ", str(item.get("type_label") or entity_type)).strip()
        aliases_raw = item.get("aliases")
        if (
            not name
            or len(name) > 80
            or normalized_name in {normalize_entity_name(term) for term in _PRONOUNS}
            or entity_type not in schema["entity_types"]
            or not entity_type_label
            or len(entity_type_label) > 80
            or not isinstance(aliases_raw, list)
            or len(aliases_raw) > 12
        ):
            raise GraphExtractionError("Graph extractor entity violates the ontology")
        aliases = []
        for alias_value in [name, *aliases_raw]:
            alias = re.sub(r"\s+", " ", str(alias_value or "")).strip()
            if not alias or len(alias) > 80 or normalize_entity_name(alias) in {
                normalize_entity_name(term) for term in _PRONOUNS
            }:
                raise GraphExtractionError("Graph extractor entity alias is invalid")
            if alias not in aliases:
                aliases.append(alias)
        if normalized_name in entities_by_name:
            raise GraphExtractionError("Graph extractor returned duplicate canonical entities")
        entity = {
            "name": name,
            "normalized_name": normalized_name,
            "aliases": aliases,
            "entity_type": entity_type,
            "entity_type_label": entity_type_label,
            "extraction_lane": "primary",
            "extraction_method": "llm_json",
            "extractor_version": extractor_version,
            "ontology_version": ontology_version,
        }
        entities.append(entity)
        entities_by_name[normalized_name] = entity
        for alias in aliases:
            alias_to_entity.setdefault(normalize_entity_name(alias), set()).add(normalized_name)

    def resolve_entity(value: object) -> dict:
        normalized = normalize_entity_name(str(value or ""))
        direct = entities_by_name.get(normalized)
        if direct is not None:
            return direct
        candidates = alias_to_entity.get(normalized) or set()
        if len(candidates) != 1:
            raise GraphExtractionError("Graph extractor entity reference is missing or ambiguous")
        return entities_by_name[next(iter(candidates))]

    mentions: list[dict] = []
    mentioned_entities: set[str] = set()
    for item in raw_mentions:
        if not isinstance(item, dict) or set(item) != {"entity", "surface", "chunk_id", "evidence_span"}:
            raise GraphExtractionError("Graph extractor mention is malformed")
        entity = resolve_entity(item.get("entity"))
        chunk_id, span = _evidence_span(chunks, item.get("chunk_id"), item.get("evidence_span"))
        surface = str(item.get("surface") or "").strip()
        if not surface or surface not in span:
            raise GraphExtractionError("Graph extractor mention surface is not supported by its evidence")
        mentions.append({
            "entity": entity["name"],
            "entity_normalized": entity["normalized_name"],
            "surface": surface,
            "chunk_id": chunk_id,
            "evidence_span": span,
        })
        mentioned_entities.add(entity["normalized_name"])

    coreferences: list[dict] = []
    coreference_mentions: dict[str, set[str]] = {}
    for item in raw_coreferences:
        if not isinstance(item, dict) or set(item) != {"mention", "entity", "chunk_id", "evidence_span"}:
            raise GraphExtractionError("Graph extractor coreference is malformed")
        entity = resolve_entity(item.get("entity"))
        chunk_id, span = _evidence_span(chunks, item.get("chunk_id"), item.get("evidence_span"))
        mention = str(item.get("mention") or "").strip()
        if not mention or mention not in span or normalize_entity_name(mention) not in {
            normalize_entity_name(term) for term in _PRONOUNS
        }:
            raise GraphExtractionError("Graph extractor coreference is not a supported pronoun mention")
        coreferences.append({
            "mention": mention,
            "entity": entity["name"],
            "entity_normalized": entity["normalized_name"],
            "chunk_id": chunk_id,
            "evidence_span": span,
        })
        coreference_mentions.setdefault(entity["normalized_name"], set()).add(mention)

    if set(entities_by_name) - mentioned_entities:
        raise GraphExtractionError("Every extracted entity must have a verbatim mention")

    relations: list[dict] = []
    for item in raw_relations:
        if (
            not isinstance(item, dict)
            or not {"source", "target", "type", "evidence"}.issubset(item)
            or set(item) - {"source", "target", "type", "label", "evidence"}
        ):
            raise GraphExtractionError("Graph extractor relation is malformed")
        source = resolve_entity(item.get("source"))
        target = resolve_entity(item.get("target"))
        relation_type = str(item.get("type") or "").strip().upper()
        relation_label = re.sub(r"\s+", " ", str(item.get("label") or relation_type)).strip()
        if source["normalized_name"] == target["normalized_name"] or relation_type not in schema["relation_types"]:
            raise GraphExtractionError("Graph extractor relation violates the ontology")
        if not relation_label or len(relation_label) > 80:
            raise GraphExtractionError("Graph extractor relation label is invalid")
        evidence_items = item.get("evidence")
        if not isinstance(evidence_items, list) or not evidence_items or len(evidence_items) > 4:
            raise GraphExtractionError("Graph extractor relation requires bounded evidence")
        evidence: list[dict] = []
        for evidence_item in evidence_items:
            if not isinstance(evidence_item, dict) or set(evidence_item) != {"chunk_id", "span"}:
                raise GraphExtractionError("Graph extractor relation evidence is malformed")
            chunk_id, span = _evidence_span(chunks, evidence_item.get("chunk_id"), evidence_item.get("span"))
            evidence.append({"chunk_id": chunk_id, "span": span})
        evidence_spans = [item["span"] for item in evidence]
        if not _name_is_supported(
            source["name"],
            source["aliases"],
            evidence_spans,
            coreference_mentions.get(source["normalized_name"], set()),
        ) or not _name_is_supported(
            target["name"],
            target["aliases"],
            evidence_spans,
            coreference_mentions.get(target["normalized_name"], set()),
        ):
            raise GraphExtractionError("Graph extractor relation endpoints are not grounded in its evidence")
        relations.append({
            "type": relation_type,
            "relation_label": relation_label,
            "extraction_lane": "primary",
            "from": source["name"],
            "to": target["name"],
            "from_normalized": source["normalized_name"],
            "to_normalized": target["normalized_name"],
            "evidence": evidence[0]["span"],
            "evidence_items": evidence,
            "evidence_chunk_ids": list(dict.fromkeys(item["chunk_id"] for item in evidence)),
            "evidence_spans": list(dict.fromkeys(evidence_spans)),
            "chunk_id": evidence[0]["chunk_id"],
            "extraction_method": "llm_json",
            "extractor_version": extractor_version,
            "ontology_version": ontology_version,
        })

    canonical_payload = {
        "entities": [
            {
                "name": item["name"],
                "type": item["entity_type"],
                "type_label": item["entity_type_label"],
                "aliases": item["aliases"][1:],
            }
            for item in entities
        ],
        "mentions": [
            {
                "entity": item["entity"],
                "surface": item["surface"],
                "chunk_id": item["chunk_id"],
                "evidence_span": item["evidence_span"],
            }
            for item in mentions
        ],
        "relations": [
            {
                "source": item["from"],
                "target": item["to"],
                "type": item["type"],
                "label": item["relation_label"],
                "evidence": item["evidence_items"],
            }
            for item in relations
        ],
        "coreferences": [
            {
                "mention": item["mention"],
                "entity": item["entity"],
                "chunk_id": item["chunk_id"],
                "evidence_span": item["evidence_span"],
            }
            for item in coreferences
        ],
    }
    covered_chunk_ids = list(dict.fromkeys([
        *(item["chunk_id"] for item in mentions),
        *(item["chunk_id"] for item in coreferences),
        *(
            chunk_id
            for relation in relations
            for chunk_id in relation["evidence_chunk_ids"]
        ),
    ]))
    return {
        "entities": entities,
        "mentions": mentions,
        "relations": relations,
        "coreferences": coreferences,
        "covered_chunk_ids": covered_chunk_ids,
        "cache_payload": canonical_payload,
    }


GraphExtractionProvider = Callable[[dict], dict]
