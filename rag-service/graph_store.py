import base64
import json
import re
import urllib.request

from config import settings


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
}

RELATION_PATTERNS = [
    (
        "DEPENDS_ON",
        [
            re.compile(r"(?P<left>[^。；;.!?\n]{2,40}?)(?:依赖|取决于|依靠|depends on|requires)(?P<right>[^。；;.!?\n]{2,40})", re.I),
        ],
        0.78,
    ),
    (
        "CONFLICTS_WITH",
        [
            re.compile(r"(?P<left>[^。；;.!?\n]{2,40}?)(?:与|和|同|versus|vs\.?)(?P<right>[^。；;.!?\n]{2,40}?)(?:冲突|矛盾|不一致|conflicts?|contradicts?)", re.I),
            re.compile(r"(?P<left>[^。；;.!?\n]{2,40}?)(?:冲突于|contradicts?|conflicts? with)(?P<right>[^。；;.!?\n]{2,40})", re.I),
        ],
        0.82,
    ),
    (
        "SUPPORTS",
        [
            re.compile(r"(?P<left>[^。；;.!?\n]{2,40}?)(?:支持|证明|佐证|evidences?|supports?|proves?)(?P<right>[^。；;.!?\n]{2,40})", re.I),
        ],
        0.74,
    ),
    (
        "REPLACES",
        [
            re.compile(r"(?P<left>[^。；;.!?\n]{2,40}?)(?:替代|取代|废止|replaces?|deprecates?)(?P<right>[^。；;.!?\n]{2,40})", re.I),
        ],
        0.72,
    ),
]


def _term_candidates(text: str) -> list[str]:
    terms = []
    seen = set()
    for match in re.finditer(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}", text):
        term = match.group(0).strip()
        normalized = term.lower()
        if normalized in STOP_TERMS or term in STOP_TERMS:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        terms.append(term)
    return terms[:16]


def _compact_text(value: str, limit: int = 220) -> str:
    compacted = re.sub(r"\s+", " ", value).strip()
    return compacted[:limit]


def _clean_entity_phrase(value: str) -> str:
    phrase = re.sub(r"[#>*`|()\[\]{}]", " ", value)
    phrase = re.sub(r"\s+", " ", phrase).strip(" ：:，,。；;.!?、-")
    phrase = re.sub(r"^(?:和|与|同|新版|旧版)\s*", "", phrase)
    phrase = phrase.strip(" ：:，,。；;.!?、-")
    if len(phrase) > 36:
        phrase = phrase[-36:]
    return phrase


def _relation_candidates(text: str) -> list[dict]:
    relations = []
    seen = set()
    for sentence in re.split(r"(?<=[。；;.!?])|\n+", text):
        evidence = _compact_text(sentence)
        if not evidence:
            continue
        for relation_type, patterns, confidence in RELATION_PATTERNS:
            for pattern in patterns:
                for match in pattern.finditer(sentence):
                    source = _clean_entity_phrase(match.group("left"))
                    target = _clean_entity_phrase(match.group("right"))
                    if not source or not target or source == target:
                        continue
                    key = (relation_type, source.lower(), target.lower(), evidence)
                    if key in seen:
                        continue
                    seen.add(key)
                    relations.append({
                        "type": relation_type,
                        "from": source,
                        "to": target,
                        "confidence": confidence,
                        "evidence": evidence,
                    })
    return relations[:24]


def _batched(rows: list[dict], batch_size: int):
    for index in range(0, len(rows), batch_size):
        yield rows[index: index + batch_size]


def extract_graph_facts(file_data: dict, chunk_rows: list[dict]) -> dict:
    document = {
        "file_id": str(file_data["id"]),
        "user_id": str(file_data["user_id"]),
        "project_space_id": str(file_data.get("project_space_id")) if file_data.get("project_space_id") else None,
        "filename": file_data["filename"],
    }
    chunks = []
    entities_by_name = {}
    relationships = []

    for row in chunk_rows:
        chunk = {
            "chunk_id": str(row["id"]),
            "file_id": document["file_id"],
            "user_id": document["user_id"],
            "project_space_id": document["project_space_id"],
            "filename": document["filename"],
            "chunk_index": int(row["chunk_index"]),
            "content": row["content"],
        }
        chunks.append(chunk)

        relationships.append({
            "type": "HAS_CHUNK",
            "from": document["file_id"],
            "to": chunk["chunk_id"],
        })

        content = row.get("content") or ""
        for term in _term_candidates(content):
            entities_by_name[term] = {
                "name": term,
                "user_id": document["user_id"],
                "project_space_id": document["project_space_id"],
            }
            relationships.append({
                "type": "MENTIONS",
                "from": chunk["chunk_id"],
                "to": term,
            })

        for relation in _relation_candidates(content):
            for entity_name in (relation["from"], relation["to"]):
                entities_by_name[entity_name] = {
                    "name": entity_name,
                    "user_id": document["user_id"],
                    "project_space_id": document["project_space_id"],
                }
            relationships.append({
                **relation,
                "chunk_id": chunk["chunk_id"],
                "file_id": document["file_id"],
                "user_id": document["user_id"],
                "project_space_id": document["project_space_id"],
            })

    return {
        "document": document,
        "chunks": chunks,
        "entities": list(entities_by_name.values()),
        "relationships": relationships,
    }


def _run_cypher(statement: str, parameters: dict | None = None) -> list[dict]:
    if not settings.neo4j_enabled:
        return []

    payload = {
        "statements": [{
            "statement": statement,
            "parameters": parameters or {},
            "resultDataContents": ["row"],
        }],
    }
    auth = base64.b64encode(f"{settings.neo4j_user}:{settings.neo4j_password}".encode("utf-8")).decode("ascii")
    request = urllib.request.Request(
        f"{settings.neo4j_url.rstrip('/')}/db/{settings.neo4j_database}/tx/commit",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=settings.neo4j_timeout_ms / 1000) as response:
        raw = response.read().decode("utf-8")
        data = json.loads(raw) if raw else {}

    errors = data.get("errors") or []
    if errors:
        raise RuntimeError(errors[0].get("message") or "Neo4j query failed")

    results = data.get("results") or []
    if not results:
        return []

    rows = []
    for item in results[0].get("data") or []:
        row = item.get("row")
        if isinstance(row, list) and len(row) == 1 and isinstance(row[0], dict):
            rows.append(row[0])
        elif isinstance(row, dict):
            rows.append(row)
    return rows


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
        "CREATE INDEX chatllm_entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)",
    ]
    for statement in statements:
        _run_cypher(statement)


def delete_file_graph(file_id: str):
    if not settings.neo4j_enabled:
        return
    _run_cypher(
        """
        MATCH ()-[r:RELATED_TO {file_id: $file_id}]-()
        DELETE r
        """,
        {"file_id": file_id},
    )
    _run_cypher(
        """
        MATCH (d:Document {file_id: $file_id})
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
        DETACH DELETE d, c
        """,
        {"file_id": file_id},
    )


def index_graph_chunks(file_data: dict, chunk_rows: list[dict]):
    if not settings.neo4j_enabled or not chunk_rows:
        return

    ensure_graph_schema()
    for batch in _batched(chunk_rows, settings.neo4j_batch_size):
        facts = extract_graph_facts(file_data, batch)
        _run_cypher(
            """
            MERGE (d:Document {file_id: $document.file_id})
            SET d += $document
            WITH d
            UNWIND $chunks AS chunk
              MERGE (c:Chunk {chunk_id: chunk.chunk_id})
              SET c += chunk
              MERGE (d)-[:HAS_CHUNK]->(c)
            WITH d
            UNWIND $entities AS entity
              MERGE (e:Entity {name: entity.name, user_id: entity.user_id, project_space_id: entity.project_space_id})
              SET e += entity
            WITH d
            UNWIND $relationships AS rel
              OPTIONAL MATCH (c:Chunk {chunk_id: rel.from})
              OPTIONAL MATCH (e:Entity {name: rel.to, user_id: $document.user_id, project_space_id: $document.project_space_id})
              FOREACH (_ IN CASE WHEN rel.type = 'MENTIONS' AND c IS NOT NULL AND e IS NOT NULL THEN [1] ELSE [] END |
                MERGE (c)-[:MENTIONS]->(e)
              )
            WITH d
            UNWIND $relationships AS rel
              OPTIONAL MATCH (fromEntity:Entity {name: rel.from, user_id: $document.user_id, project_space_id: $document.project_space_id})
              OPTIONAL MATCH (toEntity:Entity {name: rel.to, user_id: $document.user_id, project_space_id: $document.project_space_id})
              FOREACH (_ IN CASE WHEN rel.type <> 'MENTIONS' AND rel.type <> 'HAS_CHUNK' AND fromEntity IS NOT NULL AND toEntity IS NOT NULL THEN [1] ELSE [] END |
                MERGE (fromEntity)-[typed:RELATED_TO {relation_type: rel.type, chunk_id: rel.chunk_id, file_id: rel.file_id}]->(toEntity)
                SET typed.confidence = rel.confidence,
                    typed.evidence = rel.evidence,
                    typed.user_id = rel.user_id,
                    typed.project_space_id = rel.project_space_id
              )
            RETURN {ok: true} AS row
            """,
            facts,
        )


def search_graph(
    query: str,
    user_id: str,
    project_space_id: str | None = None,
    limit: int = 10,
) -> list[dict]:
    terms = _term_candidates(query)
    if not terms or not settings.neo4j_enabled:
        return []

    rows = _run_cypher(
        """
        MATCH (e:Entity)<-[:MENTIONS]-(c:Chunk)
        WHERE e.user_id = $user_id
          AND ($project_space_id IS NULL OR e.project_space_id = $project_space_id)
          AND any(term IN $terms WHERE toLower(e.name) CONTAINS toLower(term) OR toLower(term) CONTAINS toLower(e.name))
        WITH c, collect(distinct e.name) AS entities, count(distinct e) AS graph_score
        OPTIONAL MATCH (fromEntity:Entity)-[rel:RELATED_TO {chunk_id: c.chunk_id}]->(toEntity:Entity)
        WITH c, entities, graph_score, collect(distinct {
          type: rel.relation_type,
          from: fromEntity.name,
          to: toEntity.name,
          confidence: rel.confidence,
          evidence: rel.evidence
        }) AS relations
        RETURN {
          chunk_id: c.chunk_id,
          file_id: c.file_id,
          filename: c.filename,
          chunk_index: c.chunk_index,
          content: c.content,
          entities: entities,
          relations: relations,
          graph_score: graph_score
        } AS row
        ORDER BY graph_score DESC
        LIMIT $limit
        """,
        {
            "terms": terms,
            "user_id": user_id,
            "project_space_id": project_space_id,
            "limit": limit,
        },
    )

    max_score = max([float(row.get("graph_score") or 0) for row in rows] or [0])
    documents = []
    for row in rows:
        graph_score = float(row.get("graph_score") or 0)
        retrieval_score = graph_score / max_score if max_score > 0 else 0.0
        documents.append({
            "id": str(row.get("chunk_id")),
            "content": row.get("content") or "",
            "metadata": {
                "filename": row.get("filename"),
                "file_id": row.get("file_id"),
                "chunk_index": row.get("chunk_index"),
                "retrieval_mode": "graph",
                "graph_entities": row.get("entities") or [],
                "graph_relations": [
                    relation for relation in (row.get("relations") or [])
                    if relation.get("type") and relation.get("from") and relation.get("to")
                ],
            },
            "similarity": retrieval_score,
            "retrieval_score": retrieval_score,
            "graph_score": graph_score,
        })

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
        WITH c, collect(distinct e.name) AS entities, count(distinct e) AS graph_score
        OPTIONAL MATCH (fromEntity:Entity)-[rel:RELATED_TO {chunk_id: c.chunk_id}]->(toEntity:Entity)
        WITH c, entities, graph_score, collect(distinct {
          type: rel.relation_type,
          from: fromEntity.name,
          to: toEntity.name,
          confidence: rel.confidence,
          evidence: rel.evidence
        }) AS relations
        RETURN {
          chunk_id: c.chunk_id,
          file_id: c.file_id,
          filename: c.filename,
          chunk_index: c.chunk_index,
          content: c.content,
          entities: entities,
          relations: relations,
          graph_score: graph_score
        } AS row
        ORDER BY graph_score DESC, c.filename ASC, c.chunk_index ASC
        LIMIT $limit
        """,
        {
            "user_id": user_id,
            "project_space_id": project_space_id,
            "limit": limit,
        },
    )

    max_score = max([float(row.get("graph_score") or 0) for row in rows] or [0])
    documents = []
    for row in rows:
        graph_score = float(row.get("graph_score") or 0)
        retrieval_score = graph_score / max_score if max_score > 0 else 0.0
        documents.append({
            "id": str(row.get("chunk_id")),
            "content": row.get("content") or "",
            "metadata": {
                "filename": row.get("filename"),
                "file_id": row.get("file_id"),
                "chunk_index": row.get("chunk_index"),
                "retrieval_mode": "graph_overview",
                "graph_entities": row.get("entities") or [],
                "graph_relations": [
                    relation for relation in (row.get("relations") or [])
                    if relation.get("type") and relation.get("from") and relation.get("to")
                ],
            },
            "similarity": retrieval_score,
            "retrieval_score": retrieval_score,
            "graph_score": graph_score,
        })

    return documents
