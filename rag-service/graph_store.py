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

        for term in _term_candidates(row.get("content") or ""):
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
        MATCH (d:Document {file_id: $file_id})
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
        DETACH DELETE d, c
        """,
        {"file_id": file_id},
    )


def index_graph_chunks(file_data: dict, chunk_rows: list[dict]):
    if not settings.neo4j_enabled or not chunk_rows:
        return

    facts = extract_graph_facts(file_data, chunk_rows)
    ensure_graph_schema()
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
        RETURN {
          chunk_id: c.chunk_id,
          file_id: c.file_id,
          filename: c.filename,
          chunk_index: c.chunk_index,
          content: c.content,
          entities: entities,
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
            },
            "similarity": retrieval_score,
            "retrieval_score": retrieval_score,
            "graph_score": graph_score,
        })

    return documents
