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
    "core-v2": {
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
            "Role",
            "Contract",
            "Product",
            "Location",
            "Date",
            "Money",
            "Process",
            "Requirement",
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
            "RESPONSIBLE_FOR",
            "PROVIDES",
            "PAYS",
            "BELONGS_TO",
            "LOCATED_IN",
            "SIGNED_BY",
            "APPLIES_TO",
            "IS_A",
            "RELATED_TO",
        }),
    },
}

_REQUIRED_ROOT_FIELDS = {"entities", "mentions", "relations", "coreferences"}
_PRONOUNS = {
    "它", "其", "该服务", "该组件", "该系统", "前者", "后者", "这", "这些",
    "it", "its", "this service", "this component", "the former", "the latter",
}

_RELATION_CUES = {
    "DEPENDS_ON": ("依赖", "取决于", "依靠", "前提", "depends on", "requires", "prerequisite"),
    "CONFLICTS_WITH": ("冲突", "矛盾", "不一致", "contradict", "conflict", "inconsistent"),
    "CONNECTS_TO": ("连接", "接入", "关联到", "转发", "路由", "发送到", "connect", "link", "forward", "route", "send"),
    "IMPACTS": ("影响", "作用于", "导致", "造成", "impact", "affect", "cause"),
    "SUPPORTS": ("支持", "证明", "佐证", "依据", "support", "prove", "evidence"),
    "REPLACES": ("替代", "取代", "废止", "replac", "deprecat", "supersed"),
    "USES": ("使用", "采用", "利用", "use", "adopt", "utilize"),
    "PART_OF": ("属于", "组成", "隶属", "一部分", "part of", "belongs to"),
    "PRODUCES": ("生成", "产出", "生产", "produce", "generate", "emit"),
    "CONSUMES": ("消费", "读取", "订阅", "consume", "read", "subscribe"),
    "CONFIGURES": ("配置", "设定", "configure", "set up"),
    "IMPLEMENTS": ("实现", "落地", "implement", "realize"),
    "RESPONSIBLE_FOR": ("负责", "职责", "承担", "经办", "responsible for", "owns"),
    "PROVIDES": ("提供", "交付", "供应", "provide", "deliver", "supply"),
    "PAYS": ("支付", "付款", "结算", "pay", "settle"),
    "BELONGS_TO": ("属于", "隶属", "归属", "belongs to", "member of"),
    "LOCATED_IN": ("位于", "坐落", "所在地", "located in", "based in"),
    "SIGNED_BY": ("签署", "签订", "盖章", "signed by", "executed by"),
    "APPLIES_TO": ("适用于", "面向", "针对", "applies to"),
    "IS_A": ("是", "指", "定义为", "属于", "is a", "means", "defined as"),
}

_NEGATION_RE = re.compile(
    r"(?:并?不|未曾?|没有|无须|无需|不得|禁止|并非|"
    r"\b(?:not|never|no\s+longer|doesn['’]?t|do\s+not)\b)",
    re.I,
)
_CONDITIONAL_RE = re.compile(
    r"(?:如果|若|当.+?时|除非|在.+?情况下|"
    r"\b(?:if|when|unless|provided\s+that)\b)",
    re.I,
)
_PLANNED_RE = re.compile(
    r"(?:计划|拟|将要|预计|(?<!等)待|尚未|应当|应该|须|必须|"
    r"\b(?:will|shall|should|must|planned|proposed)\b)",
    re.I,
)
_HISTORICAL_RE = re.compile(
    r"(?:曾经?|过去|此前|原先|旧版|历史上|"
    r"\b(?:previously|formerly|used\s+to)\b)",
    re.I,
)

_NON_RELATIONAL_LABEL_TOKENS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
    "of", "on", "or", "that", "the", "to", "with", "以及", "并", "与", "于", "及", "向",
    "和", "在", "对", "或", "是", "有", "的",
})
_NON_RELATIONAL_LABELS = frozenset({
    "associated", "associated with", "co occurrence", "co-occurrence", "cooccurrence",
    "listed", "listed together", "mentioned", "mentioned together", "related", "related to",
    "together", "关联", "共现", "列出", "同时出现", "提及", "相关",
})


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
        "Every entity needs name, type, type_label, aliases, and a short entity_key. References in mentions, "
        "relations, and coreferences should use entity_key. entity_key is required to distinguish different "
        "real-world entities that share the same surface name. Type must be a controlled broad class; "
        "type_label preserves a concise domain class from the source. Every relation needs source, target, "
        "type, label, and a non-empty evidence array of "
        "{chunk_id, span}; copy every span verbatim. The label is a short predicate preserving the "
        "source's domain wording. Map it to the closest controlled relation type, or RELATED_TO when "
        "no narrower type applies. Resolve pronouns through coreferences, never make a pronoun an entity. "
        "Do not turn mere co-occurrence into a relation. Do not infer causal, responsibility, dependency, "
        "or identity facts that the cited wording does not state. Preserve negated, planned, conditional, "
        "and historical statements as written; never convert them into present affirmative facts. Use only entity types "
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


def _relation_is_semantically_supported(relation_type: str, relation_label: str, evidence_spans: list[str]) -> bool:
    """Require a textual predicate cue, not merely two endpoint strings.

    This is intentionally conservative. The model may map domain wording to a
    controlled type, but it cannot create an edge solely because both entities
    occur in the same span.
    """
    evidence = normalize_entity_name("\n".join(evidence_spans))

    def contains_cue(cue: str) -> bool:
        normalized_cue = normalize_entity_name(cue)
        if not normalized_cue:
            return False
        if re.fullmatch(r"[a-z0-9 ]+", normalized_cue):
            parts = normalized_cue.split()
            if len(parts) == 1 and parts[0] in {"replac", "deprecat", "supersed"}:
                phrase = rf"{re.escape(parts[0])}[a-z]*"
            elif len(parts) == 1 and len(parts[0]) >= 4:
                phrase = rf"{re.escape(parts[0])}(?:s|es|ed|ing|ion|ions)?"
            else:
                phrase = r"\s+".join(re.escape(part) for part in parts)
            return bool(re.search(rf"(?<![a-z0-9_]){phrase}(?![a-z0-9_])", evidence))
        return normalized_cue in evidence

    cues = _RELATION_CUES.get(relation_type, ())
    if any(contains_cue(cue) for cue in cues):
        return True
    label = normalize_entity_name(relation_label)
    if relation_type != "RELATED_TO" and label == normalize_entity_name(relation_type):
        return False
    if not label or label in _NON_RELATIONAL_LABELS:
        return False
    label_tokens = [
        token for token in re.split(r"[\s_\-/]+", label)
        if len(token) >= 2
        and token not in _NON_RELATIONAL_LABEL_TOKENS
        and token not in {"related", "relation", "关系", "关联"}
    ]
    return bool(label_tokens) and all(contains_cue(token) for token in label_tokens)


def infer_relation_qualifiers(evidence_spans: list[str]) -> tuple[str, str]:
    evidence = "\n".join(evidence_spans)
    polarity = "negative" if _NEGATION_RE.search(evidence) else "affirmative"
    if _CONDITIONAL_RE.search(evidence):
        modality = "conditional"
    elif _PLANNED_RE.search(evidence):
        modality = "planned_or_obligatory"
    elif _HISTORICAL_RE.search(evidence):
        modality = "historical"
    else:
        modality = "asserted"
    return polarity, modality


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
            or set(item) - {"name", "type", "type_label", "aliases", "entity_key"}
        ):
            raise GraphExtractionError("Graph extractor entity is malformed")
        name = re.sub(r"\s+", " ", str(item.get("name") or "")).strip()
        normalized_name = normalize_entity_name(name)
        entity_type = str(item.get("type") or "")
        entity_type_label = re.sub(r"\s+", " ", str(item.get("type_label") or entity_type)).strip()
        aliases_raw = item.get("aliases")
        entity_key = re.sub(r"\s+", " ", str(item.get("entity_key") or name)).strip()
        if (
            not name
            or len(name) > 80
            or normalized_name in {normalize_entity_name(term) for term in _PRONOUNS}
            or entity_type not in schema["entity_types"]
            or not entity_type_label
            or len(entity_type_label) > 80
            or not isinstance(aliases_raw, list)
            or len(aliases_raw) > 12
            or not entity_key
            or len(entity_key) > 120
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
        normalized_entity_key = normalize_entity_name(entity_key)
        if normalized_entity_key in entities_by_name:
            raise GraphExtractionError("Graph extractor returned duplicate entity keys")
        entity = {
            "entity_key": entity_key,
            "normalized_entity_key": normalized_entity_key,
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
        entities_by_name[normalized_entity_key] = entity
        for alias in aliases:
            alias_to_entity.setdefault(normalize_entity_name(alias), set()).add(normalized_entity_key)
        alias_to_entity.setdefault(normalized_name, set()).add(normalized_entity_key)

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
            "entity_key_normalized": entity["normalized_entity_key"],
            "surface": surface,
            "chunk_id": chunk_id,
            "evidence_span": span,
        })
        mentioned_entities.add(entity["normalized_entity_key"])

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
            "entity_key_normalized": entity["normalized_entity_key"],
            "chunk_id": chunk_id,
            "evidence_span": span,
        })
        coreference_mentions.setdefault(entity["normalized_entity_key"], set()).add(mention)

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
        if source["normalized_entity_key"] == target["normalized_entity_key"] or relation_type not in schema["relation_types"]:
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
            coreference_mentions.get(source["normalized_entity_key"], set()),
        ) or not _name_is_supported(
            target["name"],
            target["aliases"],
            evidence_spans,
            coreference_mentions.get(target["normalized_entity_key"], set()),
        ):
            raise GraphExtractionError("Graph extractor relation endpoints are not grounded in its evidence")
        if not _relation_is_semantically_supported(relation_type, relation_label, evidence_spans):
            raise GraphExtractionError("Graph extractor relation predicate is not supported by its evidence")
        polarity, modality = infer_relation_qualifiers(evidence_spans)
        relations.append({
            "type": relation_type,
            "relation_label": relation_label,
            "extraction_lane": "primary",
            "from": source["name"],
            "to": target["name"],
            "from_normalized": source["normalized_name"],
            "to_normalized": target["normalized_name"],
            "from_entity_key_normalized": source["normalized_entity_key"],
            "to_entity_key_normalized": target["normalized_entity_key"],
            "evidence": evidence[0]["span"],
            "evidence_items": evidence,
            "evidence_chunk_ids": list(dict.fromkeys(item["chunk_id"] for item in evidence)),
            "evidence_spans": list(dict.fromkeys(evidence_spans)),
            "chunk_id": evidence[0]["chunk_id"],
            "extraction_method": "llm_json",
            "extractor_version": extractor_version,
            "ontology_version": ontology_version,
            "polarity": polarity,
            "modality": modality,
            "validation_status": "evidence_supported",
        })

    canonical_payload = {
        "entities": [
            {
                "name": item["name"],
                "entity_key": item["entity_key"],
                "type": item["entity_type"],
                "type_label": item["entity_type_label"],
                "aliases": item["aliases"][1:],
            }
            for item in entities
        ],
        "mentions": [
            {
                "entity": next(
                    entity["entity_key"] for entity in entities
                    if entity["normalized_entity_key"] == item["entity_key_normalized"]
                ),
                "surface": item["surface"],
                "chunk_id": item["chunk_id"],
                "evidence_span": item["evidence_span"],
            }
            for item in mentions
        ],
        "relations": [
            {
                "source": next(
                    entity["entity_key"] for entity in entities
                    if entity["normalized_entity_key"] == item["from_entity_key_normalized"]
                ),
                "target": next(
                    entity["entity_key"] for entity in entities
                    if entity["normalized_entity_key"] == item["to_entity_key_normalized"]
                ),
                "type": item["type"],
                "label": item["relation_label"],
                "evidence": item["evidence_items"],
            }
            for item in relations
        ],
        "coreferences": [
            {
                "mention": item["mention"],
                "entity": next(
                    entity["entity_key"] for entity in entities
                    if entity["normalized_entity_key"] == item["entity_key_normalized"]
                ),
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
