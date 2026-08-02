import hashlib
import json
import re
import unicodedata

from config import settings
from graph_extraction import (
    GraphExtractionError,
    build_chunk_windows,
    extraction_cache_key,
    graph_extraction_fingerprint,
    infer_relation_qualifiers,
    ontology_schema,
    request_graph_extraction,
    validate_graph_extraction,
    window_content_hash,
)

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
    "什么",
    "谁",
    "哪些",
    "多少",
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

FALLBACK_EXTRACTOR_VERSION = "regex-v3"

RELATION_LABELS = {
    "DEPENDS_ON": "依赖",
    "CONFLICTS_WITH": "冲突",
    "CONNECTS_TO": "连接",
    "IMPACTS": "影响",
    "SUPPORTS": "支持",
    "REPLACES": "替代",
    "USES": "使用",
    "RESPONSIBLE_FOR": "负责",
    "PROVIDES": "提供",
    "PAYS": "支付",
    "BELONGS_TO": "属于",
    "IMPLEMENTS": "实现",
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
    (
        "USES",
        [
            (
                "uses_explicit",
                re.compile(r"(?P<left>[^。；;.!?？\n]{2,60}?)(?:使用|采用|利用|uses?|adopts?|utilizes?)(?P<right>[^。；;.!?？\n]{2,60})", re.I),
            ),
        ],
    ),
    (
        "RESPONSIBLE_FOR",
        [
            (
                "responsible_for_explicit",
                re.compile(r"(?P<left>[^。；;.!?？\n]{2,60}?)(?:负责|承担|经办|responsible for|owns?)(?P<right>[^。；;.!?？\n]{2,60})", re.I),
            ),
        ],
    ),
    (
        "PROVIDES",
        [
            (
                "provides_explicit",
                re.compile(r"(?P<left>[^。；;.!?？\n]{2,60}?)(?:提供|交付|供应|provides?|delivers?|supplies?)(?P<right>[^。；;.!?？\n]{2,60})", re.I),
            ),
        ],
    ),
    (
        "PAYS",
        [
            (
                "pays_explicit",
                re.compile(r"(?P<left>[^。；;.!?？\n]{2,60}?)(?:支付|付款|结算|pays?|settles?)(?P<right>[^。；;.!?？\n]{2,60})", re.I),
            ),
        ],
    ),
    (
        "BELONGS_TO",
        [
            (
                "belongs_to_explicit",
                re.compile(r"(?P<left>[^。；;.!?？\n]{2,60}?)(?:属于|隶属(?:于)?|归属(?:于)?|belongs? to|member of)(?P<right>[^。；;.!?？\n]{2,60})", re.I),
            ),
        ],
    ),
    (
        "IMPLEMENTS",
        [
            (
                "implements_explicit",
                re.compile(r"(?P<left>[^。；;.!?？\n]{2,60}?)(?:实现|落实|落地|implements?)(?P<right>[^。；;.!?？\n]{2,60})", re.I),
            ),
        ],
    ),
]

_RELATION_PREDICATE_RE = re.compile(
    r"(?:依赖|取决于|依靠|冲突于|冲突|矛盾|不一致|连接到?|关联到?|接入|影响|作用于|支持|证明|佐证|"
    r"替代|取代|废止|使用|采用|利用|负责|承担|经办|提供|交付|供应|支付|付款|结算|属于|隶属于?|"
    r"归属于?|实现|落实|落地|depends on|requires|conflicts? with|contradicts?|connects?(?:\s+to)?|"
    r"links?(?:\s+to)?|impacts?|affects?|supports?|proves?|replaces?|deprecates?|uses?|adopts?|"
    r"responsible for|owns?|provides?|delivers?|supplies?|pays?|settles?|belongs? to|member of|implements?)",
    re.I,
)


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
    if re.search(r"[。；;!?！？\n\r]", phrase):
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
        "entity_key": cleaned,
        "normalized_entity_key": _normalize_entity_name(cleaned),
        "extractor_version": FALLBACK_EXTRACTOR_VERSION,
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
    query_patterns = (
        r"^(?:请问|请说明|请分析|请介绍|请解释)?\s*(?P<entity>[^，,。；;!?？\n]{2,32}?)(?:负责|承担|经办)(?:什么|哪些|何种|哪项)",
        r"^(?:请问)?\s*(?:谁|哪个(?:人|部门|角色))\s*(?:负责|承担|经办)(?P<entity>[^，,。；;!?？\n]{2,32})",
        r"^(?:请问|请说明|请介绍|请解释)?\s*(?P<entity>[^，,。；;!?？\n]{2,32}?)(?:是什么|是谁|有哪些关系|的上下游|的依赖|的职责|相关信息)",
    )
    for pattern in query_patterns:
        match = re.search(pattern, query or "", re.I)
        if not match:
            continue
        phrase = _clean_entity_phrase(match.group("entity"))
        if _valid_entity_phrase(phrase):
            seeds.append(phrase)
    direct = re.sub(
        r"^(?:请问|请说明|请分析|请介绍|请解释)\s*|(?:是什么|是谁|怎么样|如何|有哪些|有什么|的关系|相关信息)[？?]?\s*$",
        "",
        query or "",
    ).strip()
    if _valid_entity_phrase(direct) and len(direct) <= 32:
        seeds.append(direct)
    return list(dict.fromkeys(seeds))[:16]


def _compact_text(value: str, limit: int = 220) -> str:
    compacted = re.sub(r"\s+", " ", value).strip()
    return compacted[:limit]


def _clean_entity_phrase(value: str, side: str | None = None) -> str:
    phrase = re.sub(r"[#>*`|()\[\]{}]", " ", value)
    clause_parts = [part for part in re.split(r"[,，：:]", phrase) if part.strip()]
    if clause_parts:
        phrase = clause_parts[-1] if side == "left" else clause_parts[0]
    predicate = _RELATION_PREDICATE_RE.search(phrase)
    should_cut_predicate = bool(
        predicate
        and predicate.start() >= 2
        and (
            side == "left"
            or re.search(r"(?:并且|同时|并|且|and)\s*$", phrase[:predicate.start()], re.I)
        )
    )
    if should_cut_predicate and predicate:
        # A compound clause such as “订单服务依赖 Redis 并连接 Kafka” must
        # keep the grammatical subject for the second predicate and stop the
        # first object before the next predicate.
        phrase = phrase[:predicate.start()]
    if side == "left":
        phrase = re.sub(r"^(.{2,24}?)(?:向|给|为)(?:[^。；;.!?！？]{2,24})$", r"\1", phrase)
    phrase = re.sub(r"\s+", " ", phrase).strip(" ：:，,。；;.!?！？、-")
    phrase = re.sub(r"^(?:请问|请说明|请分析|请介绍|请解释|请列出|请概述)\s*", "", phrase)
    phrase = re.sub(r"^(?:如何|怎么|怎样|为什么|为何)\s*", "", phrase)
    phrase = re.sub(r"\s*(?:如何|怎么|怎样|为什么|为何)$", "", phrase)
    phrase = re.sub(r"^(?:和|与|同)\s*", "", phrase)
    phrase = re.sub(r"(?:并且|同时|并|且|也|还)\s*$", "", phrase)
    phrase = re.sub(r"(?:应当|应该|应|须|必须|将|拟|计划|不得|未|不)\s*$", "", phrase)
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
    for sentence in re.split(r"(?<=[。；;.!?！？])|\n+", text):
        # Comma-separated contract and responsibility clauses frequently have
        # different subjects. Parse them independently so the first predicate
        # cannot consume all following clauses as one object.
        for clause in re.split(r"[,，]+", sentence):
            evidence = _compact_text(clause)
            if not evidence:
                continue
            for relation_type, patterns in RELATION_PATTERNS:
                for pattern_id, pattern in patterns:
                    for match in pattern.finditer(clause):
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
                                polarity, modality = infer_relation_qualifiers([evidence])
                                relations.append({
                                    "type": relation_type,
                                    "relation_label": RELATION_LABELS.get(relation_type, relation_type),
                                    "from": source,
                                    "to": target,
                                    "from_normalized": _normalize_entity_name(source),
                                    "to_normalized": _normalize_entity_name(target),
                                    "extraction_method": "regex_rule",
                                    "pattern_id": pattern_id,
                                    "evidence": evidence,
                                    "polarity": polarity,
                                    "modality": modality,
                                    "validation_status": "rule_supported",
                                })
    return relations[:24]


def _batched(rows: list[dict], batch_size: int):
    for index in range(0, len(rows), batch_size):
        yield rows[index: index + batch_size]


def _content_hash(value: str) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def _stable_graph_id(prefix: str, *parts: object) -> str:
    material = "\n".join(str(part or "") for part in parts)
    return f"{prefix}_{hashlib.sha256(material.encode('utf-8')).hexdigest()[:32]}"


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
        "failure_reasons": {},
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
        normalized_entity_key = str(candidate.get("normalized_entity_key") or normalized_name)
        local_identity = normalized_entity_key
        candidate = {
            **candidate,
            "entity_key": candidate.get("entity_key") or candidate.get("name"),
            "normalized_entity_key": normalized_entity_key,
            "entity_id": _stable_graph_id(
                "kgent",
                document["user_id"],
                document["scope_key"],
                document["file_id"],
                local_identity,
            ),
            "identity_scope": "document",
            "extraction_source_type": candidate.get("extraction_source_type") or "llm_entity",
            "user_id": document["user_id"],
            "project_space_id": document["project_space_id"],
            "scope_key": document["scope_key"],
        }
        existing = entities_by_name.get(local_identity)
        if existing is None:
            entities_by_name[local_identity] = candidate
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
        key = (str(chunk_id), entity["entity_id"])
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
            "to_entity_id": entity["entity_id"],
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
        from_entity_id = str(relation.get("from_entity_id") or "")
        to_entity_id = str(relation.get("to_entity_id") or "")
        if not from_entity_id or not to_entity_id:
            return
        key = (
            relation.get("type"),
            from_entity_id,
            to_entity_id,
            relation.get("polarity") or "affirmative",
            relation.get("modality") or "asserted",
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
        fact_id = _stable_graph_id(
            "kgfact",
            document["user_id"],
            document["scope_key"],
            document["file_id"],
            from_entity_id,
            relation.get("type"),
            relation.get("relation_label") or relation.get("type"),
            to_entity_id,
            relation.get("polarity") or "affirmative",
            relation.get("modality") or "asserted",
            json.dumps(evidence_refs, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        )
        typed_relation = {
            **relation,
            "fact_id": fact_id,
            "from_entity_id": from_entity_id,
            "to_entity_id": to_entity_id,
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
            except Exception as error:
                # LLM extraction is an optional enrichment lane. Transport, schema,
                # or provider failures must preserve deterministic rule indexing.
                extraction_stats["fallbacks"] += 1
                reason = (
                    str(error)
                    if isinstance(error, GraphExtractionError)
                    else f"{type(error).__name__}: provider_or_transport_failure"
                )
                reason = reason[:240]
                failure_reasons = extraction_stats["failure_reasons"]
                failure_reasons[reason] = int(failure_reasons.get(reason) or 0) + 1
                continue

            extraction_stats["succeeded"] += 1
            extraction_records.append({
                "cache_key": cache_key,
                "file_id": document["file_id"],
                "source_chunk_ids": [
                    str(chunk.get("source_chunk_id") or "")
                    for chunk in window.get("chunks") or []
                    if str(chunk.get("source_chunk_id") or "").strip()
                ],
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
                    llm_entities[entity["normalized_entity_key"]] = entity

            for mention in validated["mentions"]:
                add_mention(
                    source_chunk_ids.get(mention["chunk_id"], mention["chunk_id"]),
                    llm_entities.get(mention["entity_key_normalized"]),
                    evidence_span=mention["evidence_span"],
                    extraction_method="llm_json",
                    extractor_version=settings.graph_extractor_version,
                )
            for coreference in validated["coreferences"]:
                add_mention(
                    source_chunk_ids.get(coreference["chunk_id"], coreference["chunk_id"]),
                    llm_entities.get(coreference["entity_key_normalized"]),
                    evidence_span=coreference["evidence_span"],
                    extraction_method="llm_json_coreference",
                    extractor_version=settings.graph_extractor_version,
                    coreference=True,
                )
            for relation in validated["relations"]:
                source = llm_entities.get(relation["from_entity_key_normalized"])
                target = llm_entities.get(relation["to_entity_key_normalized"])
                if source is None or target is None:
                    continue
                add_typed_relation({
                    **relation,
                    "from_entity_id": source["entity_id"],
                    "to_entity_id": target["entity_id"],
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
            add_mention(chunk_id, entity, extractor_version=FALLBACK_EXTRACTOR_VERSION)

        for relation in _relation_candidates(content):
            if relation["type"] not in ontology["relation_types"]:
                continue
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
            add_mention(chunk_id, source, extractor_version=FALLBACK_EXTRACTOR_VERSION)
            add_mention(chunk_id, target, extractor_version=FALLBACK_EXTRACTOR_VERSION)
            add_typed_relation({
                **relation,
                "from_entity_id": source["entity_id"] if source else None,
                "to_entity_id": target["entity_id"] if target else None,
                "extraction_lane": "fallback",
                "chunk_id": chunk_id,
                "evidence_chunk_ids": [chunk_id],
                "evidence_spans": [relation["evidence"]],
                "evidence_refs": [{"chunk_id": chunk_id, "span": relation["evidence"]}],
                "extractor_version": FALLBACK_EXTRACTOR_VERSION,
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
        "graph_extraction_failure_reasons": json.dumps(
            extraction_stats["failure_reasons"],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
    })

    return {
        "document": document,
        "chunks": chunks,
        "entities": list(entities_by_name.values()),
        "relationships": relationships,
        "extractions": extraction_records,
        "extraction_stats": extraction_stats,
        "graph_cache_ttl_days": settings.graph_extraction_cache_ttl_days,
    }
