import base64
import json
import re
import urllib.request
from urllib.parse import urlparse

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
    project_space_id = str(file_data.get("project_space_id")) if file_data.get("project_space_id") else None
    scope_key = project_space_id or "__global__"
    document = {
        "file_id": str(file_data["id"]),
        "user_id": str(file_data["user_id"]),
        "project_space_id": project_space_id,
        "scope_key": scope_key,
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
            "scope_key": document["scope_key"],
            "filename": document["filename"],
            "chunk_index": int(row["chunk_index"]),
            "content": row["content"],
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

        content = row.get("content") or ""
        for term in _term_candidates(content):
            entities_by_name[term] = {
                "name": term,
                "user_id": document["user_id"],
                "project_space_id": document["project_space_id"],
                "scope_key": document["scope_key"],
            }
            relationships.append({
                "type": "MENTIONS",
                "from": chunk["chunk_id"],
                "to": term,
                "user_id": document["user_id"],
                "project_space_id": document["project_space_id"],
                "scope_key": document["scope_key"],
            })

        for relation in _relation_candidates(content):
            for entity_name in (relation["from"], relation["to"]):
                entities_by_name[entity_name] = {
                    "name": entity_name,
                    "user_id": document["user_id"],
                    "project_space_id": document["project_space_id"],
                    "scope_key": document["scope_key"],
                }
            relationships.append({
                **relation,
                "chunk_id": chunk["chunk_id"],
                "file_id": document["file_id"],
                "user_id": document["user_id"],
                "project_space_id": document["project_space_id"],
                "scope_key": document["scope_key"],
            })

    return {
        "document": document,
        "chunks": chunks,
        "entities": list(entities_by_name.values()),
        "relationships": relationships,
    }


def _statement_payload(statement: str, parameters: dict | None = None) -> dict:
    return {
        "statement": statement,
        "parameters": parameters or {},
        "resultDataContents": ["row"],
    }


def _neo4j_request(url: str, statements: list[dict] | None = None, method: str = "POST") -> dict:
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
    with urllib.request.urlopen(request, timeout=settings.neo4j_timeout_ms / 1000) as response:
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
        "CREATE INDEX chatllm_entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)",
        "CREATE INDEX chatllm_entity_scope IF NOT EXISTS FOR (e:Entity) ON (e.user_id, e.scope_key, e.name)",
    ]
    for statement in statements:
        _run_cypher(statement)


_GRAPH_INDEX_STATEMENT = """
MERGE (d:Document {file_id: $document.file_id})
SET d += $document
WITH d
UNWIND $chunks AS chunk
  MERGE (c:Chunk {chunk_id: chunk.chunk_id})
  SET c += chunk
  MERGE (d)-[:HAS_CHUNK]->(c)
WITH DISTINCT d
UNWIND $entities AS entity
  MERGE (e:Entity {name: entity.name, user_id: entity.user_id, scope_key: entity.scope_key})
  SET e += entity
WITH DISTINCT d
UNWIND $relationships AS rel
  OPTIONAL MATCH (c:Chunk {chunk_id: rel.from})
  OPTIONAL MATCH (e:Entity {name: rel.to, user_id: $document.user_id, scope_key: $document.scope_key})
  FOREACH (_ IN CASE WHEN rel.type = 'MENTIONS' AND c IS NOT NULL AND e IS NOT NULL THEN [1] ELSE [] END |
    MERGE (c)-[:MENTIONS]->(e)
  )
WITH DISTINCT d
UNWIND $relationships AS rel
  OPTIONAL MATCH (fromEntity:Entity {name: rel.from, user_id: $document.user_id, scope_key: $document.scope_key})
  OPTIONAL MATCH (toEntity:Entity {name: rel.to, user_id: $document.user_id, scope_key: $document.scope_key})
  FOREACH (_ IN CASE WHEN rel.type <> 'MENTIONS' AND rel.type <> 'HAS_CHUNK' AND fromEntity IS NOT NULL AND toEntity IS NOT NULL THEN [1] ELSE [] END |
    MERGE (fromEntity)-[typed:RELATED_TO {relation_type: rel.type, chunk_id: rel.chunk_id, file_id: rel.file_id}]->(toEntity)
    SET typed.confidence = rel.confidence,
        typed.evidence = rel.evidence,
        typed.user_id = rel.user_id,
        typed.project_space_id = rel.project_space_id,
        typed.scope_key = rel.scope_key
  )
RETURN {ok: true} AS row
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
            facts = extract_graph_facts(file_data, batch)
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
            self.status = "failed" if self.enabled else "skipped"
            self._closed = True

    def _rollback_without_masking(self):
        try:
            self.rollback()
        except Exception:
            self.pending_batches = 0
            self.committed_batches = 0
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
