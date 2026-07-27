import base64
import hashlib
import json
import re
import unicodedata
import urllib.request
from urllib.parse import urlparse

from config import settings
from graph_extraction import (
    build_chunk_windows,
    extraction_cache_key,
    graph_extraction_fingerprint,
    ontology_schema,
    request_graph_extraction,
    validate_graph_extraction,
    window_content_hash,
)
from http_safety import validate_http_url


STOP_TERMS = {
    "the",
    "and",
    "with",
    "for",
    "from",
    "this",
    "that",
    "原理",
    "关系",
    "内容",
    "文档",
    "系统",
    "服务",
    "数据",
    "规则",
    "策略",
    "说明",
    "问题",
}

PRONOUN_TERMS = {
    "它", "其", "该", "这", "这些", "上述", "前者", "后者", "本文", "本文件",
    "it", "its", "this", "that", "these", "those", "they", "them",
}

ENTITY_TYPE_PRIORITY = {
    "named_phrase": 1,
    "markdown_heading": 2,
    "identifier": 3,
    "relation_endpoint": 1,
    "llm_entity": 4,
}

ENTITY_ONTOLOGY_TYPES = {
    "named_phrase": "Concept",
    "markdown_heading": "Concept",
    "identifier": "Component",
    "relation_endpoint": "Unknown",
}

IDENTIFIER_PATTERNS = (
    re.compile(r"\b[A-Z]{2,}(?:[-_.][A-Za-z0-9]+)*\b"),
    re.compile(r"\b(?=[A-Za-z0-9]*[a-z])(?=(?:[A-Za-z0-9]*[A-Z]){2})[A-Za-z][A-Za-z0-9]+\b"),
    re.compile(r"\b[A-Za-z]+\d+[A-Za-z0-9]*(?:[-_.+][A-Za-z0-9]+)*\b"),
    re.compile(r"\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b"),
    re.compile(r"\b[A-Za-z][A-Za-z0-9]*(?:[-_.+][A-Za-z0-9]+){1,}\b"),
)

RELATION_PATTERNS = [
    (
        "DEPENDS_ON",
        [
            (
                "depends_on_explicit",
                re.compile(r"(?P<left>[^。；;.!?\n]{2,60}?)(?:依赖|取决于|依靠|depends on|requires)(?P<right>[^。；;.!?\n]{2,60})", re.I),
            ),
        ],
    ),
    (
        "CONFLICTS_WITH",
        [
            (
                "conflicts_with_between",
                re.compile(r"(?P<left>[^。；;.!?\n]{2,60}?)(?:与|和|同|versus|vs\.?)(?P<right>[^。；;.!?\n]{2,60}?)(?:冲突|矛盾|不一致|conflicts?|contradicts?)", re.I),
            ),
            (
                "conflicts_with_explicit",
                re.compile(r"(?P<left>[^。；;.!?\n]{2,60}?)(?:冲突于|contradicts?|conflicts? with)(?P<right>[^。；;.!?\n]{2,60})", re.I),
            ),
        ],
    ),
    (
        "CONNECTS_TO",
        [
            (
                "connects_to_explicit",
                re.compile(r"(?P<left>[^。；;.!?\n]{2,60}?)(?:连接到?|关联到?|接入|connects?(?:\s+to)?|links?(?:\s+to)?)(?P<right>[^。；;.!?\n]{2,60})", re.I),
            ),
        ],
    ),
    (
        "IMPACTS",
        [
            (
                "impacts_explicit",
                re.compile(r"(?P<left>[^。；;.!?\n]{2,60}?)(?:影响|作用于|impacts?|affects?)(?P<right>[^。；;.!?\n]{2,60})", re.I),
            ),
            (
                "impacts_between",
                re.compile(r"(?P<left>[^。；;.!?\n]{2,60}?)对(?P<right>[^。；;.!?\n]{2,60}?)(?:有|产生|造成)(?:直接|间接|显著)?影响", re.I),
            ),
        ],
    ),
    (
        "SUPPORTS",
        [
            (
                "supports_explicit",
                re.compile(r"(?P<left>[^。；;.!?\n]{2,60}?)(?:支持|证明|佐证|evidences?|supports?|proves?)(?P<right>[^。；;.!?\n]{2,60})", re.I),
            ),
        ],
    ),
    (
        "REPLACES",
        [
            (
                "replaces_explicit",
                re.compile(r"(?P<left>[^。；;.!?\n]{2,60}?)(?:替代|取代|废止|replaces?|deprecates?)(?P<right>[^。；;.!?\n]{2,60})", re.I),
            ),
        ],
    ),
]


def _normalize_entity_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value or "")
    normalized = re.sub(r"\s+", " ", normalized).strip().casefold()
    return normalized


def _valid_entity_phrase(value: str) -> bool:
    phrase = re.sub(r"\s+", " ", value or "").strip()
    normalized = _normalize_entity_name(phrase)
    if not phrase or normalized in STOP_TERMS or normalized in PRONOUN_TERMS:
        return False
    if len(phrase) < 2 or len(phrase) > 48:
        return False
    if re.search(r"[。；;!?\n\r]", phrase):
        return False
    if re.search(r"[,，：:]", phrase):
        return False
    if phrase.count(" ") > 5:
        return False
    if re.match(r"^(?:和|与|同|及|以及|或者|或|的|了|在|对|由|通过)", phrase):
        return False
    if re.search(r"(?:和|与|同|及|以及|或者|或|的|了|在|对|由|通过)$", phrase):
        return False
    if re.fullmatch(r"[\W_]+", phrase):
        return False
    return True


def _entity_candidate(name: str, entity_type: str, extraction_method: str) -> dict | None:
    cleaned = _clean_entity_phrase(name)
    if not _valid_entity_phrase(cleaned):
        return None
    return {
        "name": cleaned,
        "normalized_name": _normalize_entity_name(cleaned),
        "aliases": [cleaned],
        "entity_type": ENTITY_ONTOLOGY_TYPES.get(entity_type, "Unknown"),
        "extraction_source_type": entity_type,
        "extraction_method": extraction_method,
        "extractor_version": "regex-v2",
        "ontology_version": settings.graph_ontology_version,
    }


def _entity_candidates(text: str, include_relations: bool = True) -> list[dict]:
    candidates: list[dict] = []
    by_normalized_name: dict[str, dict] = {}

    def add(name: str, entity_type: str, extraction_method: str):
        candidate = _entity_candidate(name, entity_type, extraction_method)
        if not candidate:
            return
        existing = by_normalized_name.get(candidate["normalized_name"])
        if existing:
            for alias in candidate["aliases"]:
                if alias not in existing["aliases"]:
                    existing["aliases"].append(alias)
            if ENTITY_TYPE_PRIORITY.get(entity_type, 0) > ENTITY_TYPE_PRIORITY.get(existing["extraction_source_type"], 0):
                existing["entity_type"] = candidate["entity_type"]
                existing["extraction_source_type"] = entity_type
                existing["extraction_method"] = extraction_method
            return
        by_normalized_name[candidate["normalized_name"]] = candidate
        candidates.append(candidate)

    for match in re.finditer(r"(?m)^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", text or ""):
        add(match.group(1), "markdown_heading", "markdown_heading")

    for match in re.finditer(r"`([^`\n]{1,64})`", text or ""):
        add(match.group(1), "identifier", "inline_code")

    for pattern in IDENTIFIER_PATTERNS:
        for match in pattern.finditer(text or ""):
            add(match.group(0), "identifier", "identifier_pattern")

    if include_relations:
        for relation in _relation_candidates(text):
            add(relation["from"], "relation_endpoint", relation["extraction_method"])
            add(relation["to"], "relation_endpoint", relation["extraction_method"])

    return candidates[:32]


def _term_candidates(text: str) -> list[str]:
    """Return conservative graph seed names; kept for the public search path."""
    return [candidate["name"] for candidate in _entity_candidates(text)]


def _query_seed_candidates(query: str) -> list[str]:
    seeds = _term_candidates(query)
    for match in re.finditer(
        r"(?P<left>[^，,。；;!?？\n]{2,24}?)(?:和|与)(?P<right>[^，,。；;!?？\n]{2,24}?)(?:有什么关系|有何关系|的关系|如何关联|如何协作)",
        query or "",
    ):
        for side in ("left", "right"):
            phrase = _clean_entity_phrase(match.group(side), side=side)
            phrase = re.sub(r"^(?:请问|请说明|请分析|分析|说明)", "", phrase).strip()
            if _valid_entity_phrase(phrase):
                seeds.append(phrase)
    return list(dict.fromkeys(seeds))[:16]


def _compact_text(value: str, limit: int = 220) -> str:
    compacted = re.sub(r"\s+", " ", value).strip()
    return compacted[:limit]


def _clean_entity_phrase(value: str, side: str | None = None) -> str:
    phrase = re.sub(r"[#>*`|()\[\]{}]", " ", value)
    clause_parts = [part for part in re.split(r"[,，：:]", phrase) if part.strip()]
    if clause_parts:
        phrase = clause_parts[-1] if side == "left" else clause_parts[0]
    phrase = re.sub(r"\s+", " ", phrase).strip(" ：:，,。；;.!?！？、-")
    phrase = re.sub(r"^(?:请问|请说明|请分析|请介绍|请解释|请列出|请概述)\s*", "", phrase)
    phrase = re.sub(r"^(?:如何|怎么|怎样|为什么|为何)\s*", "", phrase)
    phrase = re.sub(r"\s*(?:如何|怎么|怎样|为什么|为何)$", "", phrase)
    phrase = re.sub(r"^(?:和|与|同)\s*", "", phrase)
    phrase = phrase.strip(" ：:，,。；;.!?！？、-")
    return phrase


def _split_relation_endpoints(value: str, side: str) -> list[str]:
    endpoints = []
    for part in re.split(r"\s+(?:and|or)\s+|(?:以及|或者|和|与|及|或)", value, flags=re.I):
        endpoint = _clean_entity_phrase(part, side=side)
        if _valid_entity_phrase(endpoint) and endpoint not in endpoints:
            endpoints.append(endpoint)
    return endpoints[:4]


def _relation_candidates(text: str) -> list[dict]:
    relations = []
    seen = set()
    for sentence in re.split(r"(?<=[。；;.!?])|\n+", text):
        evidence = _compact_text(sentence)
        if not evidence:
            continue
        for relation_type, patterns in RELATION_PATTERNS:
            for pattern_id, pattern in patterns:
                for match in pattern.finditer(sentence):
                    sources = _split_relation_endpoints(match.group("left"), side="left")
                    targets = _split_relation_endpoints(match.group("right"), side="right")
                    for source in sources:
                        for target in targets:
                            if _normalize_entity_name(source) == _normalize_entity_name(target):
                                continue
                            key = (
                                relation_type,
                                _normalize_entity_name(source),
                                _normalize_entity_name(target),
                                evidence,
                            )
                            if key in seen:
                                continue
                            seen.add(key)
                            relations.append({
                                "type": relation_type,
                                "from": source,
                                "to": target,
                                "from_normalized": _normalize_entity_name(source),
                                "to_normalized": _normalize_entity_name(target),
                                "extraction_method": "regex_rule",
                                "pattern_id": pattern_id,
                                "evidence": evidence,
                            })
    return relations[:24]


def _batched(rows: list[dict], batch_size: int):
    for index in range(0, len(rows), batch_size):
        yield rows[index: index + batch_size]


def _content_hash(value: str) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def extract_graph_facts(
    file_data: dict,
    chunk_rows: list[dict],
    *,
    context_rows: list[dict] | None = None,
    cached_extractions: dict[str, dict | str] | None = None,
    extraction_provider=None,
) -> dict:
    project_space_id = str(file_data.get("project_space_id")) if file_data.get("project_space_id") else None
    scope_key = project_space_id or "__global__"
    ontology = ontology_schema(settings.graph_ontology_version)
    document = {
        "file_id": str(file_data["id"]),
        "user_id": str(file_data["user_id"]),
        "project_space_id": project_space_id,
        "scope_key": scope_key,
        "filename": file_data["filename"],
        "graph_extractor_version": settings.graph_extractor_version,
        "graph_ontology_version": settings.graph_ontology_version,
        "graph_entity_types": sorted(ontology["entity_types"]),
        "graph_relation_types": sorted(ontology["relation_types"]),
    }
    chunks = []
    entities_by_name: dict[str, dict] = {}
    relationships: list[dict] = []
    relationship_keys: set[tuple] = set()
    typed_relations_by_key: dict[tuple, dict] = {}
    mentions_by_key: dict[tuple[str, str], dict] = {}
    extraction_records: list[dict] = []
    extraction_stats = {
        "enabled": bool(settings.graph_extraction_enabled or extraction_provider is not None),
        "attempted": 0,
        "succeeded": 0,
        "cache_hits": 0,
        "fallbacks": 0,
    }
    # A source chunk belongs to the primary lane only when a validated model
    # result actually grounds a mention, coreference, or relation evidence in
    # that chunk. Window success alone is not ownership: a successful adjacent
    # window can cover its neighbour, while leaving its own target uncovered.
    llm_owned_chunk_ids: set[str] = set()

    def register_entity(candidate: dict | None) -> dict | None:
        if not candidate:
            return None
        normalized_name = candidate["normalized_name"]
        candidate = {
            **candidate,
            "extraction_source_type": candidate.get("extraction_source_type") or "llm_entity",
            "user_id": document["user_id"],
            "project_space_id": document["project_space_id"],
            "scope_key": document["scope_key"],
        }
        existing = entities_by_name.get(normalized_name)
        if existing is None:
            entities_by_name[normalized_name] = candidate
            return candidate

        aliases = list(existing.get("aliases") or [])
        for alias in candidate.get("aliases") or []:
            if alias not in aliases:
                aliases.append(alias)
        existing["aliases"] = aliases
        existing_source = str(existing.get("extraction_source_type") or "")
        candidate_source = str(candidate.get("extraction_source_type") or "")
        candidate_is_more_specific = (
            str(existing.get("entity_type") or "Unknown") == "Unknown"
            and str(candidate.get("entity_type") or "Unknown") != "Unknown"
        )
        candidate_has_higher_priority = (
            ENTITY_TYPE_PRIORITY.get(candidate_source, 0)
            > ENTITY_TYPE_PRIORITY.get(existing_source, 0)
            and str(candidate.get("entity_type") or "Unknown") != "Unknown"
        )
        if candidate_is_more_specific or candidate_has_higher_priority:
            existing["entity_type"] = candidate["entity_type"]
            existing["extraction_source_type"] = candidate_source
            existing["extraction_method"] = candidate["extraction_method"]
            existing["extractor_version"] = candidate.get("extractor_version")
            existing["ontology_version"] = candidate.get("ontology_version")
        if candidate.get("entity_type_label") and not existing.get("entity_type_label"):
            existing["entity_type_label"] = candidate["entity_type_label"]
        return existing

    def add_mention(
        chunk_id: str,
        entity: dict | None,
        *,
        evidence_span: str | None = None,
        extraction_method: str | None = None,
        extractor_version: str | None = None,
        coreference: bool = False,
    ):
        if entity is None:
            return
        key = (str(chunk_id), entity["normalized_name"])
        existing_mention = mentions_by_key.get(key)
        if existing_mention is not None:
            if evidence_span and evidence_span not in existing_mention["evidence_spans"]:
                existing_mention["evidence_spans"].append(evidence_span)
            existing_mention["coreference"] = bool(existing_mention.get("coreference") or coreference)
            if extraction_method and extraction_method.startswith("llm_"):
                existing_mention["extraction_method"] = extraction_method
                existing_mention["extractor_version"] = extractor_version
            return
        mention = {
            "type": "MENTIONS",
            "from": str(chunk_id),
            "to": entity["name"],
            "to_normalized": entity["normalized_name"],
            "evidence_spans": [evidence_span] if evidence_span else [],
            "extraction_method": extraction_method or entity.get("extraction_method") or "unknown",
            "extractor_version": extractor_version or entity.get("extractor_version"),
            "ontology_version": settings.graph_ontology_version,
            "coreference": bool(coreference),
            "user_id": document["user_id"],
            "project_space_id": document["project_space_id"],
            "scope_key": document["scope_key"],
        }
        mentions_by_key[key] = mention
        relationships.append(mention)

    def add_typed_relation(relation: dict, *, content_hash: str):
        evidence_chunk_ids = list(dict.fromkeys(
            str(value) for value in (relation.get("evidence_chunk_ids") or [relation.get("chunk_id")])
            if value not in (None, "")
        ))
        evidence_spans = list(dict.fromkeys(
            str(value) for value in (relation.get("evidence_spans") or [relation.get("evidence")])
            if str(value or "").strip()
        ))
        raw_evidence_refs = relation.get("evidence_refs") or []
        evidence_refs = []
        for item in raw_evidence_refs:
            if not isinstance(item, dict):
                continue
            chunk_id = str(item.get("chunk_id") or "")
            span = str(item.get("span") or "").strip()
            if chunk_id in evidence_chunk_ids and span in evidence_spans:
                evidence_ref = {"chunk_id": chunk_id, "span": span}
                if evidence_ref not in evidence_refs:
                    evidence_refs.append(evidence_ref)
        if not evidence_refs and len(evidence_chunk_ids) == 1:
            evidence_refs = [
                {"chunk_id": evidence_chunk_ids[0], "span": span}
                for span in evidence_spans
            ]
        if not evidence_chunk_ids or not evidence_spans or not evidence_refs:
            return
        extraction_method = str(relation.get("extraction_method") or "unknown")
        extractor_version = str(relation.get("extractor_version") or "unknown")
        key = (
            relation.get("type"),
            relation.get("from_normalized"),
            relation.get("to_normalized"),
            tuple((item["chunk_id"], item["span"]) for item in evidence_refs),
        )
        if key in relationship_keys:
            existing_relation = typed_relations_by_key[key]
            extractor_identity = f"{extraction_method}:{extractor_version}"
            if extractor_identity not in existing_relation["extractors"]:
                existing_relation["extractors"].append(extractor_identity)
            if extractor_version not in existing_relation["extractor_versions"]:
                existing_relation["extractor_versions"].append(extractor_version)
            if content_hash not in existing_relation["content_hashes"]:
                existing_relation["content_hashes"].append(content_hash)
            if existing_relation.get("extraction_method") != extraction_method:
                existing_relation["extraction_method"] = "multiple"
            return
        relationship_keys.add(key)
        typed_relation = {
            **relation,
            "chunk_id": str(relation.get("chunk_id") or evidence_chunk_ids[0]),
            "file_id": document["file_id"],
            "evidence_chunk_ids": evidence_chunk_ids,
            "evidence_spans": evidence_spans,
            "evidence_refs_json": json.dumps(evidence_refs, ensure_ascii=False, separators=(",", ":")),
            "content_hash": content_hash,
            "content_hashes": [content_hash],
            "extractors": [f"{extraction_method}:{extractor_version}"],
            "extractor_versions": [extractor_version],
            "user_id": document["user_id"],
            "project_space_id": document["project_space_id"],
            "scope_key": document["scope_key"],
        }
        typed_relations_by_key[key] = typed_relation
        relationships.append(typed_relation)

    for row in chunk_rows:
        chunk_id = str(row["id"])
        content = str(row.get("content") or "")
        chunk = {
            "chunk_id": chunk_id,
            "file_id": document["file_id"],
            "user_id": document["user_id"],
            "project_space_id": document["project_space_id"],
            "scope_key": document["scope_key"],
            "filename": document["filename"],
            "chunk_index": int(row["chunk_index"]),
            "content": content,
            "content_hash": _content_hash(content),
            "graph_extractor_version": settings.graph_extractor_version,
            "graph_ontology_version": settings.graph_ontology_version,
        }
        chunks.append(chunk)

        relationships.append({
            "type": "HAS_CHUNK",
            "from": document["file_id"],
            "to": chunk["chunk_id"],
            "user_id": document["user_id"],
            "project_space_id": document["project_space_id"],
            "scope_key": document["scope_key"],
        })

    use_llm_extraction = bool(settings.graph_extraction_enabled or extraction_provider is not None)
    if use_llm_extraction:
        provider = extraction_provider or request_graph_extraction
        provider_fingerprint = graph_extraction_fingerprint(extraction_provider)
        windows = build_chunk_windows(
            chunk_rows,
            context_rows=context_rows,
            radius=settings.graph_context_window_chunks,
        )
        for window in windows:
            content_hash = window_content_hash(window)
            cache_key = extraction_cache_key(
                content_hash,
                settings.graph_extractor_version,
                settings.graph_ontology_version,
                provider_fingerprint,
            )
            extraction_stats["attempted"] += 1
            cached_payload = (cached_extractions or {}).get(cache_key)
            try:
                if cached_payload is not None:
                    if isinstance(cached_payload, str):
                        cached_payload = json.loads(cached_payload)
                    payload = cached_payload
                    extraction_stats["cache_hits"] += 1
                else:
                    payload = provider(window)
                validated = validate_graph_extraction(
                    payload,
                    window,
                    extractor_version=settings.graph_extractor_version,
                    ontology_version=settings.graph_ontology_version,
                )
            except Exception:
                # LLM extraction is an optional enrichment lane. Transport, schema,
                # or provider failures must preserve deterministic rule indexing.
                extraction_stats["fallbacks"] += 1
                continue

            extraction_stats["succeeded"] += 1
            extraction_records.append({
                "cache_key": cache_key,
                "content_hash": content_hash,
                "extractor_version": settings.graph_extractor_version,
                "ontology_version": settings.graph_ontology_version,
                "provider_fingerprint": provider_fingerprint,
                "payload": json.dumps(validated["cache_payload"], ensure_ascii=False, separators=(",", ":")),
            })
            source_chunk_ids = {
                str(chunk.get("chunk_id") or ""): str(chunk.get("source_chunk_id") or "")
                for chunk in window.get("chunks") or []
            }
            llm_owned_chunk_ids.update(
                source_chunk_id
                for extraction_chunk_id in validated["covered_chunk_ids"]
                if (source_chunk_id := source_chunk_ids.get(extraction_chunk_id))
            )

            llm_entities: dict[str, dict] = {}
            for candidate in validated["entities"]:
                entity = register_entity({
                    **candidate,
                    "extraction_source_type": "llm_entity",
                })
                if entity is not None:
                    llm_entities[entity["normalized_name"]] = entity

            for mention in validated["mentions"]:
                add_mention(
                    source_chunk_ids.get(mention["chunk_id"], mention["chunk_id"]),
                    llm_entities.get(mention["entity_normalized"]),
                    evidence_span=mention["evidence_span"],
                    extraction_method="llm_json",
                    extractor_version=settings.graph_extractor_version,
                )
            for coreference in validated["coreferences"]:
                add_mention(
                    source_chunk_ids.get(coreference["chunk_id"], coreference["chunk_id"]),
                    llm_entities.get(coreference["entity_normalized"]),
                    evidence_span=coreference["evidence_span"],
                    extraction_method="llm_json_coreference",
                    extractor_version=settings.graph_extractor_version,
                    coreference=True,
                )
            for relation in validated["relations"]:
                add_typed_relation({
                    **relation,
                    "chunk_id": source_chunk_ids.get(relation["chunk_id"], relation["chunk_id"]),
                    "evidence_chunk_ids": [
                        source_chunk_ids.get(chunk_id, chunk_id)
                        for chunk_id in relation["evidence_chunk_ids"]
                    ],
                    "evidence_refs": [
                        {
                            "chunk_id": source_chunk_ids.get(item["chunk_id"], item["chunk_id"]),
                            "span": item["span"],
                        }
                        for item in relation["evidence_items"]
                    ],
                }, content_hash=content_hash)

    # Rules are a failure fallback, not a permanent lane mixed into successful
    # LLM output. Ownership follows the source chunks actually covered by
    # validated evidence, including evidence from adjacent-window relations.
    # An uncovered target remains eligible for deterministic fallback even if
    # its window returned a valid but unrelated/empty extraction.
    for row in chunk_rows:
        chunk_id = str(row["id"])
        if chunk_id in llm_owned_chunk_ids:
            continue
        content = str(row.get("content") or "")
        content_hash = _content_hash(content)
        for candidate in _entity_candidates(content, include_relations=False):
            entity = register_entity({
                **candidate,
                "extraction_lane": "fallback",
            })
            add_mention(chunk_id, entity, extractor_version="regex-v2")

        for relation in _relation_candidates(content):
            source = register_entity(_entity_candidate(
                relation["from"],
                "relation_endpoint",
                relation["extraction_method"],
            ))
            target = register_entity(_entity_candidate(
                relation["to"],
                "relation_endpoint",
                relation["extraction_method"],
            ))
            add_mention(chunk_id, source, extractor_version="regex-v2")
            add_mention(chunk_id, target, extractor_version="regex-v2")
            add_typed_relation({
                **relation,
                "extraction_lane": "fallback",
                "chunk_id": chunk_id,
                "evidence_chunk_ids": [chunk_id],
                "evidence_spans": [relation["evidence"]],
                "evidence_refs": [{"chunk_id": chunk_id, "span": relation["evidence"]}],
                "extractor_version": "regex-v2",
                "ontology_version": settings.graph_ontology_version,
            }, content_hash=content_hash)

    if not extraction_stats["enabled"]:
        extraction_status = "rules_only"
    elif extraction_stats["succeeded"] == 0:
        extraction_status = "rules_fallback"
    elif extraction_stats["fallbacks"]:
        extraction_status = "partial_llm_with_rule_fallback"
    else:
        extraction_status = "llm_primary"
    document.update({
        "graph_extraction_status": extraction_status,
        "graph_extraction_attempted": extraction_stats["attempted"],
        "graph_extraction_succeeded": extraction_stats["succeeded"],
        "graph_extraction_cache_hits": extraction_stats["cache_hits"],
        "graph_extraction_fallbacks": extraction_stats["fallbacks"],
    })

    return {
        "document": document,
        "chunks": chunks,
        "entities": list(entities_by_name.values()),
        "relationships": relationships,
        "extractions": extraction_records,
        "extraction_stats": extraction_stats,
    }


def _statement_payload(statement: str, parameters: dict | None = None) -> dict:
    return {
        "statement": statement,
        "parameters": parameters or {},
        "resultDataContents": ["row"],
    }


def _neo4j_request(url: str, statements: list[dict] | None = None, method: str = "POST") -> dict:
    url = validate_http_url(url, "NEO4J_URL")
    auth = base64.b64encode(f"{settings.neo4j_user}:{settings.neo4j_password}".encode("utf-8")).decode("ascii")
    request_data = None
    if method != "DELETE":
        request_data = json.dumps({"statements": statements or []}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=request_data,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    # validate_http_url restricts the request to HTTP(S) before transport.
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with urllib.request.urlopen(request, timeout=settings.neo4j_timeout_ms / 1000) as response:  # nosec B310
        raw = response.read().decode("utf-8")
        data = json.loads(raw) if raw else {}

    if not isinstance(data, dict):
        raise RuntimeError("Neo4j returned an invalid response")
    errors = data.get("errors") or []
    if errors:
        first_error = errors[0] if isinstance(errors[0], dict) else {}
        raise RuntimeError(first_error.get("message") or "Neo4j query failed")
    return data


def _rows_from_response(data: dict) -> list[dict]:
    results = data.get("results") or []
    if not results or not isinstance(results[0], dict):
        return []

    rows: list[dict] = []
    for item in results[0].get("data") or []:
        if not isinstance(item, dict):
            continue
        row = item.get("row")
        if isinstance(row, list) and len(row) == 1 and isinstance(row[0], dict):
            rows.append(row[0])
        elif isinstance(row, dict):
            rows.append(row)
    return rows


def _run_cypher(statement: str, parameters: dict | None = None) -> list[dict]:
    if not settings.neo4j_enabled:
        return []

    data = _neo4j_request(
        f"{settings.neo4j_url.rstrip('/')}/db/{settings.neo4j_database}/tx/commit",
        [_statement_payload(statement, parameters)],
    )
    return _rows_from_response(data)


def _load_graph_extraction_cache(cache_keys: list[str]) -> dict[str, str]:
    keys = list(dict.fromkeys(str(key) for key in cache_keys if str(key).strip()))
    if not keys or not settings.neo4j_enabled:
        return {}
    rows = _run_cypher(
        """
        UNWIND $cache_keys AS cache_key
        MATCH (extraction:GraphExtraction {cache_key: cache_key})
        WHERE extraction.extractor_version = $extractor_version
          AND extraction.ontology_version = $ontology_version
        RETURN {
          cache_key: extraction.cache_key,
          payload: extraction.payload
        } AS row
        """,
        {
            "cache_keys": keys,
            "extractor_version": settings.graph_extractor_version,
            "ontology_version": settings.graph_ontology_version,
        },
    )
    return {
        str(row["cache_key"]): str(row["payload"])
        for row in rows
        if row.get("cache_key") and row.get("payload")
    }


def _entity_alias_keys(entity: dict) -> set[str]:
    return {
        _normalize_entity_name(str(value or ""))
        for value in [entity.get("name"), *(entity.get("aliases") or [])]
        if _normalize_entity_name(str(value or ""))
    }


def _load_existing_entity_aliases(
    user_id: str,
    scope_key: str,
    alias_keys: list[str],
) -> list[dict]:
    keys = list(dict.fromkeys(key for key in alias_keys if key))
    if not keys or not settings.neo4j_enabled:
        return []
    return _run_cypher(
        """
        MATCH (entity:Entity)
        WHERE entity.user_id = $user_id
          AND coalesce(entity.scope_key, entity.project_space_id, '__global__') = $scope_key
        WITH entity,
             coalesce(entity.normalized_name, toLower(entity.name)) AS normalized_name,
             [alias IN coalesce(entity.aliases, []) | toLower(alias)] AS normalized_aliases
        WHERE normalized_name IN $alias_keys
           OR any(alias IN normalized_aliases WHERE alias IN $alias_keys)
        RETURN {
          name: entity.name,
          normalized_name: normalized_name,
          aliases: coalesce(entity.aliases, [entity.name]),
          entity_type: coalesce(entity.entity_type, 'Unknown'),
          extraction_source_type: coalesce(entity.extraction_source_type, 'existing_graph'),
          extraction_method: coalesce(entity.extraction_method, 'existing_graph'),
          extractor_version: entity.extractor_version,
          ontology_version: entity.ontology_version
        } AS row
        """,
        {
            "user_id": user_id,
            "scope_key": scope_key,
            "alias_keys": keys,
        },
    )


def _canonicalize_entities_with_registry(facts: dict, registry_rows: list[dict]) -> dict:
    """Merge only unambiguous canonical/alias identities and rewrite edges.

    A loose shared alias is not enough. The current canonical name must match an
    existing alias, or an existing canonical name must match a current alias.
    If more than one existing entity satisfies that condition, no alias merge
    occurs. This avoids collapsing genuinely ambiguous abbreviations.
    """
    entities = [dict(entity) for entity in facts.get("entities") or []]
    working_registry = [dict(row) for row in registry_rows if row.get("normalized_name")]
    endpoint_map: dict[str, dict[str, str]] = {}
    merged_by_normalized: dict[str, dict] = {}

    for entity in entities:
        original_normalized = str(entity.get("normalized_name") or "")
        current_aliases = _entity_alias_keys(entity)
        direct_matches = [
            row for row in working_registry
            if str(row.get("normalized_name") or "") == original_normalized
        ]
        if direct_matches:
            candidates = direct_matches[:1]
        else:
            candidates = []
            for row in working_registry:
                row_normalized = str(row.get("normalized_name") or "")
                row_aliases = _entity_alias_keys(row)
                if original_normalized in row_aliases or row_normalized in current_aliases:
                    candidates.append(row)

        target = candidates[0] if len({str(row.get("normalized_name")) for row in candidates}) == 1 and candidates else None
        canonical_normalized = str(target.get("normalized_name")) if target else original_normalized
        canonical_name = str(target.get("name") or entity.get("name") or "") if target else str(entity.get("name") or "")
        aliases: list[str] = []
        for value in [
            canonical_name,
            *((target.get("aliases") or []) if target else []),
            entity.get("name"),
            *(entity.get("aliases") or []),
        ]:
            alias = str(value or "").strip()
            if alias and alias not in aliases:
                aliases.append(alias)

        canonical = {
            **entity,
            **({
                "entity_type": target.get("entity_type") or entity.get("entity_type"),
                "extraction_source_type": target.get("extraction_source_type") or entity.get("extraction_source_type"),
            } if target else {}),
            "name": canonical_name,
            "normalized_name": canonical_normalized,
            "aliases": aliases,
        }
        existing = merged_by_normalized.get(canonical_normalized)
        if existing is not None:
            for alias in canonical["aliases"]:
                if alias not in existing["aliases"]:
                    existing["aliases"].append(alias)
            canonical = existing
        else:
            merged_by_normalized[canonical_normalized] = canonical
            working_registry.append(canonical)
        endpoint_map[original_normalized] = {
            "normalized_name": canonical_normalized,
            "name": canonical_name,
        }

    rewritten_relationships = []
    for relationship in facts.get("relationships") or []:
        rewritten = dict(relationship)
        for side in ("from", "to"):
            normalized_field = f"{side}_normalized"
            mapped = endpoint_map.get(str(rewritten.get(normalized_field) or ""))
            if mapped:
                rewritten[normalized_field] = mapped["normalized_name"]
                rewritten[side] = mapped["name"]
        rewritten_relationships.append(rewritten)

    return {
        **facts,
        "entities": list(merged_by_normalized.values()),
        "relationships": rewritten_relationships,
    }


def _transaction_urls(commit_url: object) -> tuple[str, str]:
    if not isinstance(commit_url, str):
        raise RuntimeError("Neo4j transaction response did not include a commit URL")
    path = urlparse(commit_url).path
    expected_prefix = f"/db/{settings.neo4j_database}/tx/"
    if not path.startswith(expected_prefix) or not path.endswith("/commit"):
        raise RuntimeError("Neo4j transaction response included an invalid commit URL")
    transaction_id = path[len(expected_prefix):-len("/commit")]
    if not transaction_id or "/" in transaction_id:
        raise RuntimeError("Neo4j transaction response included an invalid transaction ID")

    transaction_url = (
        f"{settings.neo4j_url.rstrip('/')}/db/{settings.neo4j_database}/tx/{transaction_id}"
    )
    return transaction_url, f"{transaction_url}/commit"


def check_graph_store_ready() -> bool:
    if not settings.neo4j_enabled:
        return True
    _run_cypher("RETURN {ok: true} AS row")
    return True


def ensure_graph_schema():
    if not settings.neo4j_enabled:
        return
    statements = [
        "CREATE CONSTRAINT chatllm_document_id IF NOT EXISTS FOR (d:Document) REQUIRE d.file_id IS UNIQUE",
        "CREATE CONSTRAINT chatllm_chunk_id IF NOT EXISTS FOR (c:Chunk) REQUIRE c.chunk_id IS UNIQUE",
        "CREATE CONSTRAINT chatllm_graph_extraction_key IF NOT EXISTS FOR (x:GraphExtraction) REQUIRE x.cache_key IS UNIQUE",
        "CREATE CONSTRAINT chatllm_graph_ontology_version IF NOT EXISTS FOR (o:GraphOntology) REQUIRE o.version IS UNIQUE",
        "CREATE INDEX chatllm_entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)",
        "CREATE INDEX chatllm_entity_scope IF NOT EXISTS FOR (e:Entity) ON (e.user_id, e.scope_key, e.name)",
        "CREATE INDEX chatllm_entity_normalized_scope IF NOT EXISTS FOR (e:Entity) ON (e.user_id, e.scope_key, e.normalized_name)",
    ]
    for statement in statements:
        _run_cypher(statement)


_GRAPH_INDEX_STATEMENT = """
MERGE (d:Document {file_id: $document.file_id})
SET d += $document
MERGE (ontology:GraphOntology {version: $document.graph_ontology_version})
SET ontology.entity_types = $document.graph_entity_types,
    ontology.relation_types = $document.graph_relation_types
MERGE (d)-[:USES_GRAPH_ONTOLOGY]->(ontology)
WITH d
UNWIND $chunks AS chunk
  MERGE (c:Chunk {chunk_id: chunk.chunk_id})
  SET c += chunk
  MERGE (d)-[:HAS_CHUNK]->(c)
WITH DISTINCT d
UNWIND $entities AS entity
  MERGE (e:Entity {normalized_name: entity.normalized_name, user_id: entity.user_id, scope_key: entity.scope_key})
  ON CREATE SET e.name = entity.name
  SET e.project_space_id = entity.project_space_id,
      e.entity_type = entity.entity_type,
      e.entity_type_label = coalesce(entity.entity_type_label, entity.entity_type),
      e.extraction_source_type = entity.extraction_source_type,
      e.extraction_method = entity.extraction_method,
      e.extractor_version = entity.extractor_version,
      e.ontology_version = entity.ontology_version,
      e.aliases = reduce(
        aliases = coalesce(e.aliases, []),
        alias IN entity.aliases |
        CASE WHEN alias IN aliases THEN aliases ELSE aliases + alias END
      )
WITH DISTINCT d
UNWIND $relationships AS rel
  OPTIONAL MATCH (c:Chunk {chunk_id: rel.from})
  OPTIONAL MATCH (e:Entity {normalized_name: rel.to_normalized, user_id: $document.user_id, scope_key: $document.scope_key})
  FOREACH (_ IN CASE WHEN rel.type = 'MENTIONS' AND c IS NOT NULL AND e IS NOT NULL THEN [1] ELSE [] END |
    MERGE (c)-[mention:MENTIONS]->(e)
    SET mention.evidence_spans = reduce(
          spans = coalesce(mention.evidence_spans, []),
          span IN coalesce(rel.evidence_spans, []) |
          CASE WHEN span IN spans THEN spans ELSE spans + span END
        ),
        mention.extraction_method = rel.extraction_method,
        mention.extractor_version = rel.extractor_version,
        mention.ontology_version = rel.ontology_version,
        mention.coreference = coalesce(mention.coreference, false) OR coalesce(rel.coreference, false)
  )
WITH DISTINCT d
UNWIND $relationships AS rel
  OPTIONAL MATCH (fromEntity:Entity {normalized_name: rel.from_normalized, user_id: $document.user_id, scope_key: $document.scope_key})
  OPTIONAL MATCH (toEntity:Entity {normalized_name: rel.to_normalized, user_id: $document.user_id, scope_key: $document.scope_key})
  FOREACH (_ IN CASE WHEN rel.type <> 'MENTIONS' AND rel.type <> 'HAS_CHUNK' AND fromEntity IS NOT NULL AND toEntity IS NOT NULL THEN [1] ELSE [] END |
    MERGE (fromEntity)-[typed:RELATED_TO {relation_type: rel.type, chunk_id: rel.chunk_id, file_id: rel.file_id}]->(toEntity)
    SET typed.evidence = rel.evidence,
        typed.relation_label = coalesce(rel.relation_label, rel.type),
        typed.extraction_lane = coalesce(rel.extraction_lane, 'primary'),
        typed.evidence_chunk_ids = rel.evidence_chunk_ids,
        typed.evidence_spans = rel.evidence_spans,
        typed.evidence_refs_json = rel.evidence_refs_json,
        typed.extraction_method = rel.extraction_method,
        typed.extractor_version = rel.extractor_version,
        typed.extractor_versions = reduce(
          versions = coalesce(typed.extractor_versions, []),
          version IN coalesce(rel.extractor_versions, []) |
          CASE WHEN version IN versions THEN versions ELSE versions + version END
        ),
        typed.extractors = reduce(
          extractors = coalesce(typed.extractors, []),
          extractor IN coalesce(rel.extractors, []) |
          CASE WHEN extractor IN extractors THEN extractors ELSE extractors + extractor END
        ),
        typed.ontology_version = rel.ontology_version,
        typed.content_hash = rel.content_hash,
        typed.content_hashes = reduce(
          hashes = coalesce(typed.content_hashes, []),
          hash IN coalesce(rel.content_hashes, []) |
          CASE WHEN hash IN hashes THEN hashes ELSE hashes + hash END
        ),
        typed.pattern_id = rel.pattern_id,
        typed.user_id = rel.user_id,
        typed.project_space_id = rel.project_space_id,
        typed.scope_key = rel.scope_key
  )
WITH DISTINCT d
CALL {
  WITH d
  UNWIND $extractions AS extraction
    MERGE (cached:GraphExtraction {cache_key: extraction.cache_key})
    SET cached.content_hash = extraction.content_hash,
        cached.extractor_version = extraction.extractor_version,
        cached.ontology_version = extraction.ontology_version,
        cached.provider_fingerprint = extraction.provider_fingerprint,
        cached.payload = extraction.payload
  RETURN count(*) AS cached_extractions
}
RETURN {ok: true, cached_extractions: cached_extractions} AS row
"""


class GraphFileTransaction:
    def __init__(self):
        self.enabled = settings.neo4j_enabled
        self.status = "skipped" if not self.enabled else "pending"
        self.pending_batches = 0
        self.committed_batches = 0
        self._transaction_url: str | None = None
        self._commit_url: str | None = None
        self._schema_ready = False
        self._closed = False
        self._context_rows: list[dict] = []
        self._extraction_cache: dict[str, str] = {}
        self._entity_registry: list[dict] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, _exc, _traceback):
        if exc_type is not None:
            self._rollback_without_masking()
            return False
        try:
            self.commit()
        except Exception:
            self._rollback_without_masking()
            raise
        return False

    @property
    def result(self) -> dict:
        return {
            "status": self.status,
            "batches": self.committed_batches,
        }

    def index_chunks(self, file_data: dict, chunk_rows: list[dict]) -> dict:
        if not self.enabled:
            return self.result
        if self._closed:
            raise RuntimeError("Neo4j graph transaction is already closed")
        if not chunk_rows:
            return {"status": "pending", "batches": 0}
        if not self._schema_ready:
            ensure_graph_schema()
            self._schema_ready = True

        for batch in _batched(chunk_rows, settings.neo4j_batch_size):
            if settings.graph_extraction_enabled:
                windows = build_chunk_windows(
                    batch,
                    context_rows=self._context_rows,
                    radius=settings.graph_context_window_chunks,
                )
                cache_keys = [
                    extraction_cache_key(
                        window_content_hash(window),
                        settings.graph_extractor_version,
                        settings.graph_ontology_version,
                    )
                    for window in windows
                ]
                missing_keys = [key for key in cache_keys if key not in self._extraction_cache]
                self._extraction_cache.update(_load_graph_extraction_cache(missing_keys))

            facts = extract_graph_facts(
                file_data,
                batch,
                context_rows=self._context_rows,
                cached_extractions=self._extraction_cache,
            )
            alias_keys = sorted({
                alias
                for entity in facts.get("entities") or []
                for alias in _entity_alias_keys(entity)
            })
            has_alias_enrichment = any(
                len(_entity_alias_keys(entity)) > 1
                for entity in facts.get("entities") or []
            )
            if has_alias_enrichment:
                existing_entities = _load_existing_entity_aliases(
                    str(file_data["user_id"]),
                    str(file_data.get("project_space_id") or "__global__"),
                    alias_keys,
                )
                facts = _canonicalize_entities_with_registry(
                    facts,
                    [*existing_entities, *self._entity_registry],
                )
            self._entity_registry.extend(dict(entity) for entity in facts.get("entities") or [])
            for extraction in facts.get("extractions") or []:
                self._extraction_cache[str(extraction["cache_key"])] = str(extraction["payload"])
            statement = _statement_payload(_GRAPH_INDEX_STATEMENT, facts)
            if self._transaction_url is None:
                response = _neo4j_request(
                    f"{settings.neo4j_url.rstrip('/')}/db/{settings.neo4j_database}/tx",
                    [statement],
                )
                self._transaction_url, self._commit_url = _transaction_urls(response.get("commit"))
            else:
                _neo4j_request(self._transaction_url, [statement])
            self.pending_batches += 1
            combined_context = [*self._context_rows, *batch]
            self._context_rows = combined_context[-settings.graph_context_window_chunks:]

        return {"status": "pending", "batches": 0}

    def commit(self) -> dict:
        if self._closed:
            return self.result
        if not self.enabled:
            self.status = "skipped"
            self._closed = True
            return self.result
        if self._commit_url is not None:
            _neo4j_request(self._commit_url, [])
        self.committed_batches = self.pending_batches
        self.status = "indexed"
        self._entity_registry = []
        self._closed = True
        return self.result

    def rollback(self):
        if self._closed:
            return
        try:
            if self._transaction_url is not None:
                _neo4j_request(self._transaction_url, method="DELETE")
        finally:
            self.pending_batches = 0
            self.committed_batches = 0
            self._context_rows = []
            self._extraction_cache = {}
            self._entity_registry = []
            self.status = "failed" if self.enabled else "skipped"
            self._closed = True

    def _rollback_without_masking(self):
        try:
            self.rollback()
        except Exception:
            self.pending_batches = 0
            self.committed_batches = 0
            self._context_rows = []
            self._extraction_cache = {}
            self._entity_registry = []
            self.status = "failed" if self.enabled else "skipped"
            self._closed = True


def graph_file_transaction() -> GraphFileTransaction:
    return GraphFileTransaction()


def delete_file_graph(file_id: str):
    if not settings.neo4j_enabled:
        return
    _run_cypher(
        """
        MATCH (d:Document {file_id: $file_id})
        WITH d,
             d.user_id AS owner_user_id,
             coalesce(d.scope_key, d.project_space_id, '__global__') AS owner_scope_key
        OPTIONAL MATCH ()-[r:RELATED_TO {file_id: $file_id}]-()
        DELETE r
        WITH DISTINCT d, owner_user_id, owner_scope_key
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
        DETACH DELETE d, c
        WITH DISTINCT owner_user_id, owner_scope_key
        MATCH (e:Entity)
        WHERE NOT (e)--()
          AND e.user_id = owner_user_id
          AND coalesce(e.scope_key, e.project_space_id, '__global__') = owner_scope_key
        DELETE e
        """,
        {"file_id": file_id},
    )


def index_graph_chunks(
    file_data: dict,
    chunk_rows: list[dict],
    *,
    transaction: GraphFileTransaction | None = None,
) -> dict:
    if transaction is not None:
        return transaction.index_chunks(file_data, chunk_rows)

    with graph_file_transaction() as file_transaction:
        file_transaction.index_chunks(file_data, chunk_rows)
    return file_transaction.result


def search_graph(
    query: str,
    user_id: str,
    project_space_id: str | None = None,
    limit: int = 10,
    *,
    max_hops: int | None = None,
    max_branch_factor: int | None = None,
    max_paths: int | None = None,
) -> list[dict]:
    terms = sorted({_normalize_entity_name(term) for term in _query_seed_candidates(query) if term})
    if not terms or not settings.neo4j_enabled:
        return []

    bounded_hops = max(1, min(int(max_hops or settings.graph_search_max_hops), 3))
    bounded_branch_factor = max(
        1,
        min(int(max_branch_factor or settings.graph_search_max_branch_factor), 32),
    )
    bounded_paths = max(1, min(int(max_paths or settings.graph_search_max_paths), 100))
    bounded_limit = max(1, min(int(limit), 100))

    seed_rows = _run_cypher(
        """
        MATCH (seed:Entity)
        WHERE seed.user_id = $user_id
          AND ($project_space_id IS NULL OR seed.project_space_id = $project_space_id)
        WITH seed, [term IN $terms WHERE
            coalesce(seed.normalized_name, toLower(seed.name)) = term
            OR any(alias IN coalesce(seed.aliases, []) WHERE toLower(alias) = term)
          ] AS matched_terms
        WHERE size(matched_terms) > 0
        RETURN {
          normalized_name: coalesce(seed.normalized_name, toLower(seed.name)),
          scope_key: coalesce(seed.scope_key, seed.project_space_id, '__global__'),
          name: seed.name,
          seed_match_score: CASE
            WHEN any(term IN matched_terms WHERE term = coalesce(seed.normalized_name, toLower(seed.name))) THEN 1.0
            ELSE 0.85
          END
        } AS row
        ORDER BY row.seed_match_score DESC, row.normalized_name ASC
        LIMIT $seed_limit
        """,
        {
            "terms": terms,
            "user_id": user_id,
            "project_space_id": project_space_id,
            "seed_limit": min(8, bounded_branch_factor),
        },
    )

    frontier_paths = [
        {
            "seed_entity": str(seed.get("name") or ""),
            "seed_match_score": float(seed.get("seed_match_score") or 0.85),
            "nodes": [str(seed.get("name") or "")],
            "node_keys": [(
                str(seed.get("scope_key") or "__global__"),
                str(seed.get("normalized_name") or ""),
            )],
            "relations": [],
        }
        for seed in seed_rows
        if seed.get("name") and seed.get("normalized_name")
    ]
    discovered_paths: list[dict] = []
    for hop in range(1, bounded_hops + 1):
        frontier = list(dict.fromkeys(
            path["node_keys"][-1]
            for path in frontier_paths
        ))
        if not frontier:
            break
        edge_rows = _run_cypher(
            """
            UNWIND $frontier AS frontier
            MATCH (current:Entity)
            WHERE current.user_id = $user_id
              AND coalesce(current.scope_key, current.project_space_id, '__global__') = frontier.scope_key
              AND coalesce(current.normalized_name, toLower(current.name)) = frontier.normalized_name
            CALL {
              WITH current
              MATCH (current)-[rel:RELATED_TO]-(neighbor:Entity)
              WHERE neighbor.user_id = $user_id
                AND coalesce(neighbor.scope_key, neighbor.project_space_id, '__global__') =
                    coalesce(current.scope_key, current.project_space_id, '__global__')
                AND rel.chunk_id IS NOT NULL
                AND size(coalesce(rel.evidence_chunk_ids, [rel.chunk_id])) > 0
                AND size(coalesce(rel.evidence_spans, [rel.evidence])) > 0
              WITH current, rel, neighbor
              ORDER BY
                size(coalesce(rel.extractors, [coalesce(rel.extraction_method, 'legacy')])) DESC,
                size(coalesce(rel.evidence_chunk_ids, [rel.chunk_id])) DESC,
                coalesce(neighbor.normalized_name, toLower(neighbor.name)) ASC
              LIMIT $max_branch_factor
              RETURN rel, neighbor
            }
            RETURN {
              current_normalized_name: coalesce(current.normalized_name, toLower(current.name)),
              scope_key: coalesce(current.scope_key, current.project_space_id, '__global__'),
              neighbor_normalized_name: coalesce(neighbor.normalized_name, toLower(neighbor.name)),
              neighbor_name: neighbor.name,
              neighbor_degree: size([(neighbor)-[:RELATED_TO]-() | 1]),
              relation: {
                type: rel.relation_type,
                label: coalesce(rel.relation_label, rel.relation_type),
                from: startNode(rel).name,
                to: endNode(rel).name,
                evidence: rel.evidence,
                evidence_chunk_ids: coalesce(rel.evidence_chunk_ids, [rel.chunk_id]),
                evidence_spans: coalesce(rel.evidence_spans, [rel.evidence]),
                evidence_refs_json: rel.evidence_refs_json,
                extraction_method: coalesce(rel.extraction_method, 'legacy'),
                extraction_lane: coalesce(rel.extraction_lane, 'legacy'),
                extractor_version: rel.extractor_version,
                extractors: coalesce(rel.extractors, [coalesce(rel.extraction_method, 'legacy')]),
                ontology_version: rel.ontology_version,
                pattern_id: rel.pattern_id
              }
            } AS row
            """,
            {
                "frontier": [
                    {"scope_key": scope_key, "normalized_name": normalized_name}
                    for scope_key, normalized_name in frontier
                ],
                "user_id": user_id,
                "max_branch_factor": bounded_branch_factor,
            },
        )
        edges_by_frontier: dict[tuple[str, str], list[dict]] = {}
        for edge in edge_rows:
            key = (
                str(edge.get("scope_key") or "__global__"),
                str(edge.get("current_normalized_name") or ""),
            )
            edges_by_frontier.setdefault(key, []).append(edge)

        next_frontier_paths: list[dict] = []
        for path in frontier_paths:
            for edge in edges_by_frontier.get(path["node_keys"][-1], [])[:bounded_branch_factor]:
                relation = edge.get("relation") or {}
                evidence_chunk_ids = [
                    str(value) for value in relation.get("evidence_chunk_ids") or []
                    if str(value).strip()
                ]
                evidence_spans = [
                    str(value) for value in relation.get("evidence_spans") or []
                    if str(value).strip()
                ]
                evidence_refs = []
                try:
                    parsed_refs = json.loads(str(relation.get("evidence_refs_json") or "[]"))
                except json.JSONDecodeError:
                    parsed_refs = []
                if isinstance(parsed_refs, list):
                    for item in parsed_refs:
                        if not isinstance(item, dict):
                            continue
                        chunk_id = str(item.get("chunk_id") or "")
                        span = str(item.get("span") or "").strip()
                        if chunk_id in evidence_chunk_ids and span in evidence_spans:
                            evidence_refs.append({"chunk_id": chunk_id, "span": span})
                if not evidence_refs and len(evidence_chunk_ids) == 1:
                    evidence_refs = [
                        {"chunk_id": evidence_chunk_ids[0], "span": span}
                        for span in evidence_spans
                    ]
                elif not evidence_refs and len(evidence_chunk_ids) == len(evidence_spans):
                    evidence_refs = [
                        {"chunk_id": chunk_id, "span": span}
                        for chunk_id, span in zip(evidence_chunk_ids, evidence_spans, strict=True)
                    ]
                neighbor_key = (
                    str(edge.get("scope_key") or "__global__"),
                    str(edge.get("neighbor_normalized_name") or ""),
                )
                if (
                    not neighbor_key[1]
                    or neighbor_key in path["node_keys"]
                    or not relation.get("type")
                    or not relation.get("from")
                    or not relation.get("to")
                    or not relation.get("evidence")
                    or not evidence_chunk_ids
                    or not evidence_spans
                    or not evidence_refs
                ):
                    continue
                relation = {
                    **relation,
                    "evidence_refs": evidence_refs,
                }
                expanded = {
                    **path,
                    "nodes": [*path["nodes"], str(edge.get("neighbor_name") or "")],
                    "node_keys": [*path["node_keys"], neighbor_key],
                    "relations": [*path["relations"], relation],
                }
                discovered_paths.append(expanded)
                if (
                    hop < bounded_hops
                    and int(edge.get("neighbor_degree") or 0) <= settings.graph_search_hub_degree_limit
                ):
                    next_frontier_paths.append(expanded)

        next_frontier_paths.sort(key=lambda path: (
            len(path["relations"]),
            tuple(path["node_keys"]),
        ))
        frontier_paths = next_frontier_paths[:bounded_paths]

    def path_rank_features(path: dict) -> tuple[float, dict]:
        evidence_chunk_ids = list(dict.fromkeys(
            str(chunk_id)
            for relation in path["relations"]
            for chunk_id in relation.get("evidence_chunk_ids") or []
        ))
        extractor_evidence_count = sum(
            len(set(relation.get("extractors") or [relation.get("extraction_method") or "legacy"]))
            for relation in path["relations"]
        )
        path_length = len(path["relations"])
        evidence_edges = sum(1 for relation in path["relations"] if relation.get("evidence_spans"))
        lane_scores = [
            1.0 if relation.get("extraction_lane") == "primary"
            else 0.6 if relation.get("extraction_lane") == "fallback"
            else 0.75
            for relation in path["relations"]
        ]
        extraction_lane_score = sum(lane_scores) / len(lane_scores) if lane_scores else 0.0
        features = {
            "seed_match_score": float(path["seed_match_score"]),
            "path_length": path_length,
            "evidence_count": len(evidence_chunk_ids),
            "extractor_evidence_count": extractor_evidence_count,
            "relation_evidence_coverage": evidence_edges / path_length if path_length else 0.0,
            "extraction_lane_score": extraction_lane_score,
        }
        rank_score = extraction_lane_score * (
            features["seed_match_score"] * 2.0
            + features["evidence_count"] * 0.4
            + features["extractor_evidence_count"] * 0.15
            - (features["path_length"] - 1) * 0.65
        )
        return rank_score, features

    ranked_paths = []
    for path in discovered_paths:
        rank_score, features = path_rank_features(path)
        ranked_paths.append((rank_score, features, path))
    ranked_paths.sort(key=lambda item: (
        -item[0],
        int(item[1]["path_length"]),
        tuple(item[2]["node_keys"]),
    ))
    ranked_paths = ranked_paths[:bounded_paths]

    evidence_ids = list(dict.fromkeys(
        str(chunk_id)
        for _, _, path in ranked_paths
        for relation in path["relations"]
        for chunk_id in relation.get("evidence_chunk_ids") or []
    ))
    evidence_rows = _run_cypher(
        """
        UNWIND $chunk_ids AS chunk_id
        MATCH (c:Chunk {chunk_id: chunk_id})
        WHERE c.user_id = $user_id
          AND ($project_space_id IS NULL OR c.project_space_id = $project_space_id)
        RETURN {
          chunk_id: c.chunk_id,
          file_id: c.file_id,
          filename: c.filename,
          chunk_index: c.chunk_index,
          content: c.content
        } AS row
        """,
        {
            "chunk_ids": evidence_ids,
            "user_id": user_id,
            "project_space_id": project_space_id,
        },
    ) if evidence_ids else []
    evidence_by_id = {
        str(row.get("chunk_id")): row
        for row in evidence_rows
        if row.get("chunk_id")
    }
    rows = []
    for graph_rank_score, graph_features, path in ranked_paths:
        path_evidence_ids = list(dict.fromkeys(
            str(chunk_id)
            for relation in path["relations"]
            for chunk_id in relation.get("evidence_chunk_ids") or []
        ))
        if not path_evidence_ids or any(chunk_id not in evidence_by_id for chunk_id in path_evidence_ids):
            continue
        rows.append({
            "seed_entity": path["seed_entity"],
            "related_entity": path["nodes"][-1],
            "path_entities": path["nodes"],
            "relations": path["relations"],
            "evidence_chunks": [evidence_by_id[chunk_id] for chunk_id in path_evidence_ids],
            "graph_features": graph_features,
            "graph_rank_score": graph_rank_score,
        })

    documents_by_chunk: dict[str, dict] = {}
    for row in rows:
        graph_rank_score = float(row.get("graph_rank_score") or row.get("graph_score") or 0)
        relations = [
            relation for relation in (row.get("relations") or [])
            if relation.get("type") and relation.get("from") and relation.get("to")
            and relation.get("evidence")
        ]
        graph_features = dict(row.get("graph_features") or {
            "seed_match_score": 1.0,
            "path_length": 1,
            "evidence_count": 1,
            "extractor_evidence_count": 1,
            "relation_evidence_coverage": 1.0,
        })
        evidence_chunks = row.get("evidence_chunks")
        if not isinstance(evidence_chunks, list):
            evidence_chunks = [{
                "chunk_id": row.get("chunk_id"),
                "file_id": row.get("file_id"),
                "filename": row.get("filename"),
                "chunk_index": row.get("chunk_index"),
                "content": row.get("content"),
            }]
        seed_entities = list(dict.fromkeys(
            [str(row.get("seed_entity") or ""), *(row.get("seed_entities") or [])]
        ))
        seed_entities = [entity for entity in seed_entities if entity]
        related_entities = list(dict.fromkeys(
            [str(row.get("related_entity") or ""), *(row.get("related_entities") or [])]
        ))
        related_entities = [entity for entity in related_entities if entity]
        path_entities = [
            str(entity) for entity in (row.get("path_entities") or row.get("entities") or [])
            if str(entity).strip()
        ]
        graph_path = {
            "entities": path_entities or [*seed_entities, *related_entities],
            "relations": relations,
            "features": graph_features,
            "graph_rank_score": graph_rank_score,
        }
        for chunk in evidence_chunks:
            chunk_id = str(chunk.get("chunk_id") or "")
            if not chunk_id:
                continue
            existing = documents_by_chunk.get(chunk_id)
            if existing is None:
                existing = {
                    "id": chunk_id,
                    "content": chunk.get("content") or "",
                    "metadata": {
                        "filename": chunk.get("filename"),
                        "file_id": chunk.get("file_id"),
                        "chunk_index": chunk.get("chunk_index"),
                        "retrieval_mode": "graph",
                        "graph_entities": [],
                        "graph_seed_entities": [],
                        "graph_related_entities": [],
                        "graph_relations": [],
                        "graph_paths": [],
                        "graph_features": graph_features,
                        "graph_rank_score": graph_rank_score,
                    },
                    "graph_rank_score": graph_rank_score,
                }
                documents_by_chunk[chunk_id] = existing
            metadata = existing["metadata"]
            for field, values in (
                ("graph_entities", path_entities or [*seed_entities, *related_entities]),
                ("graph_seed_entities", seed_entities),
                ("graph_related_entities", related_entities),
                ("graph_relations", relations),
                ("graph_paths", [graph_path]),
            ):
                for value in values:
                    if value not in metadata[field]:
                        metadata[field].append(value)
            if graph_rank_score > float(existing["graph_rank_score"]):
                existing["graph_rank_score"] = graph_rank_score
                metadata["graph_rank_score"] = graph_rank_score
                metadata["graph_features"] = graph_features

    documents = sorted(
        documents_by_chunk.values(),
        key=lambda document: (-float(document["graph_rank_score"]), str(document["id"])),
    )[:bounded_limit]
    max_rank_score = max([float(document["graph_rank_score"]) for document in documents] or [0.0])
    for document in documents:
        normalized_rank = (
            float(document["graph_rank_score"]) / max_rank_score
            if max_rank_score > 0
            else 0.0
        )
        lane_score = float((document.get("metadata") or {}).get("graph_features", {}).get("extraction_lane_score") or 0.75)
        document["similarity"] = normalized_rank * lane_score
        document["retrieval_score"] = normalized_rank * lane_score
    return documents


def list_graph(
    user_id: str,
    project_space_id: str | None = None,
    limit: int = 30,
) -> list[dict]:
    if not settings.neo4j_enabled:
        return []

    rows = _run_cypher(
        """
        MATCH (e:Entity)<-[:MENTIONS]-(c:Chunk)
        WHERE e.user_id = $user_id
          AND ($project_space_id IS NULL OR e.project_space_id = $project_space_id)
        WITH c, collect(distinct e.name) AS entities, count(distinct e) AS entity_count
        OPTIONAL MATCH (fromEntity:Entity)-[rel:RELATED_TO {chunk_id: c.chunk_id}]->(toEntity:Entity)
        WITH c, entities, entity_count, collect(distinct {
          type: rel.relation_type,
          label: coalesce(rel.relation_label, rel.relation_type),
          from: fromEntity.name,
          to: toEntity.name,
          evidence: rel.evidence,
          evidence_chunk_ids: coalesce(rel.evidence_chunk_ids, [rel.chunk_id]),
          evidence_spans: coalesce(rel.evidence_spans, [rel.evidence]),
          evidence_refs_json: rel.evidence_refs_json,
          extraction_method: coalesce(rel.extraction_method, 'legacy'),
          extraction_lane: coalesce(rel.extraction_lane, 'legacy'),
          extractor_version: rel.extractor_version,
          ontology_version: rel.ontology_version,
          pattern_id: rel.pattern_id
        }) AS relations
        RETURN {
          chunk_id: c.chunk_id,
          file_id: c.file_id,
          filename: c.filename,
          chunk_index: c.chunk_index,
          content: c.content,
          entities: entities,
          relations: relations,
          graph_features: {entity_count: entity_count},
          graph_rank_score: toFloat(entity_count)
        } AS row
        ORDER BY row.graph_rank_score DESC, c.filename ASC, c.chunk_index ASC
        LIMIT $limit
        """,
        {
            "user_id": user_id,
            "project_space_id": project_space_id,
            "limit": limit,
        },
    )

    max_score = max([
        float(row.get("graph_rank_score") or row.get("graph_score") or 0)
        for row in rows
    ] or [0])
    documents = []
    for row in rows:
        graph_rank_score = float(row.get("graph_rank_score") or row.get("graph_score") or 0)
        retrieval_score = graph_rank_score / max_score if max_score > 0 else 0.0
        documents.append({
            "id": str(row.get("chunk_id")),
            "content": row.get("content") or "",
            "metadata": {
                "filename": row.get("filename"),
                "file_id": row.get("file_id"),
                "chunk_index": row.get("chunk_index"),
                "retrieval_mode": "graph_overview",
                "graph_entities": row.get("entities") or [],
                "graph_features": row.get("graph_features") or {
                    "entity_count": len(row.get("entities") or []),
                },
                "graph_rank_score": graph_rank_score,
                "graph_relations": [
                    relation for relation in (row.get("relations") or [])
                    if relation.get("type") and relation.get("from") and relation.get("to")
                ],
            },
            "similarity": retrieval_score,
            "retrieval_score": retrieval_score,
            "graph_rank_score": graph_rank_score,
        })

    return documents
