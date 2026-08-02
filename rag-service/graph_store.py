import base64
import json
import random
import time
import urllib.request

from config import settings
from db import get_active_chunks_by_ids
from graph_fact_extractor import (
    _batched,
    _normalize_entity_name,
    _query_seed_candidates,
    extract_graph_facts,
)
from graph_extraction import (
    build_chunk_windows,
    extraction_cache_key,
    graph_extraction_fingerprint,
    window_content_hash,
)
from http_safety import validate_http_url


NEO4J_TRANSIENT_RETRY_ATTEMPTS = 3
NEO4J_TRANSIENT_RETRY_BASE_SECONDS = 0.05
NEO4J_TRANSIENT_RETRY_MAX_SECONDS = 0.5


class Neo4jQueryError(RuntimeError):
    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


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
        raise Neo4jQueryError(
            str(first_error.get("message") or "Neo4j query failed"),
            str(first_error.get("code") or ""),
        )
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

    for attempt in range(NEO4J_TRANSIENT_RETRY_ATTEMPTS):
        try:
            data = _neo4j_request(
                f"{settings.neo4j_url.rstrip('/')}/db/{settings.neo4j_database}/tx/commit",
                [_statement_payload(statement, parameters)],
            )
            return _rows_from_response(data)
        except Neo4jQueryError as error:
            retryable = error.code.startswith("Neo.TransientError.")
            if not retryable or attempt + 1 >= NEO4J_TRANSIENT_RETRY_ATTEMPTS:
                raise
            exponential_delay = min(
                NEO4J_TRANSIENT_RETRY_BASE_SECONDS * (2 ** attempt),
                NEO4J_TRANSIENT_RETRY_MAX_SECONDS,
            )
            time.sleep(
                exponential_delay
                + random.uniform(0, NEO4J_TRANSIENT_RETRY_BASE_SECONDS)
            )

    raise RuntimeError("Neo4j retry loop exhausted unexpectedly")


def _load_graph_extraction_cache(
    cache_keys: list[str],
    provider_fingerprint: str,
) -> dict[str, str]:
    keys = list(dict.fromkeys(str(key) for key in cache_keys if str(key).strip()))
    if not keys or not settings.neo4j_enabled:
        return {}
    rows = _run_cypher(
        """
        UNWIND $cache_keys AS cache_key
        MATCH (extraction:GraphExtraction {cache_key: cache_key})
        WHERE extraction.extractor_version = $extractor_version
          AND extraction.ontology_version = $ontology_version
          AND extraction.provider_fingerprint = $provider_fingerprint
          AND (extraction.expires_at IS NULL OR extraction.expires_at > datetime())
        RETURN {
          cache_key: extraction.cache_key,
          payload: extraction.payload
        } AS row
        """,
        {
            "cache_keys": keys,
            "extractor_version": settings.graph_extractor_version,
            "ontology_version": settings.graph_ontology_version,
            "provider_fingerprint": provider_fingerprint,
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
                "entity_id": target.get("entity_id") or entity.get("entity_id"),
                "entity_key": target.get("entity_key") or entity.get("entity_key"),
                "normalized_entity_key": target.get("normalized_entity_key") or entity.get("normalized_entity_key"),
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
            "entity_id": canonical.get("entity_id"),
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
                entity_id_field = f"{side}_entity_id" if side == "from" else "to_entity_id"
                if mapped.get("entity_id") and entity_id_field in rewritten:
                    rewritten[entity_id_field] = mapped["entity_id"]
        rewritten_relationships.append(rewritten)

    return {
        **facts,
        "entities": list(merged_by_normalized.values()),
        "relationships": rewritten_relationships,
    }


def check_graph_store_ready() -> dict:
    if not settings.neo4j_enabled:
        return {"ready": True, "runtime_quality": {"status": "disabled"}}
    _run_cypher("RETURN {ok: true} AS row")
    rows = _run_cypher(
        """
        MATCH (document:Document)
        WHERE document.graph_indexed_at IS NOT NULL
          AND document.graph_indexed_at >= datetime() - duration({hours: $window_hours})
        RETURN {
          document_count: count(document),
          attempted: sum(coalesce(document.graph_extraction_attempted, 0)),
          succeeded: sum(coalesce(document.graph_extraction_succeeded, 0)),
          fallbacks: sum(coalesce(document.graph_extraction_fallbacks, 0))
        } AS row
        """,
        {"window_hours": 24},
    )
    metrics = rows[0] if rows else {}
    attempted = int(metrics.get("attempted") or 0)
    succeeded = int(metrics.get("succeeded") or 0)
    fallbacks = int(metrics.get("fallbacks") or 0)
    success_rate = succeeded / attempted if attempted else None
    fallback_rate = fallbacks / attempted if attempted else None
    status = (
        "unknown"
        if not attempted
        else "degraded"
        if success_rate is None or success_rate < 0.5 or (fallback_rate or 0) > 0.5
        else "ok"
    )
    return {
        "ready": True,
        "runtime_quality": {
            "status": status,
            "window_hours": 24,
            "document_count": int(metrics.get("document_count") or 0),
            "attempted": attempted,
            "succeeded": succeeded,
            "fallbacks": fallbacks,
            "success_rate": success_rate,
            "fallback_rate": fallback_rate,
        },
    }


def ensure_graph_schema():
    if not settings.neo4j_enabled:
        return
    statements = [
        "CREATE CONSTRAINT chatllm_document_id IF NOT EXISTS FOR (d:Document) REQUIRE d.file_id IS UNIQUE",
        "CREATE CONSTRAINT chatllm_chunk_id IF NOT EXISTS FOR (c:Chunk) REQUIRE c.chunk_id IS UNIQUE",
        "CREATE CONSTRAINT chatllm_entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.entity_id IS UNIQUE",
        "CREATE CONSTRAINT chatllm_fact_id IF NOT EXISTS FOR (f:Fact) REQUIRE f.fact_id IS UNIQUE",
        "CREATE CONSTRAINT chatllm_graph_extraction_key IF NOT EXISTS FOR (x:GraphExtraction) REQUIRE x.cache_key IS UNIQUE",
        "CREATE CONSTRAINT chatllm_graph_ontology_version IF NOT EXISTS FOR (o:GraphOntology) REQUIRE o.version IS UNIQUE",
        "CREATE INDEX chatllm_entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)",
        "CREATE INDEX chatllm_entity_scope IF NOT EXISTS FOR (e:Entity) ON (e.user_id, e.scope_key, e.name)",
        "CREATE INDEX chatllm_entity_normalized_scope IF NOT EXISTS FOR (e:Entity) ON (e.user_id, e.scope_key, e.normalized_name)",
        "CREATE INDEX chatllm_fact_scope IF NOT EXISTS FOR (f:Fact) ON (f.user_id, f.scope_key, f.file_id)",
    ]
    for statement in statements:
        _run_cypher(statement)


_GRAPH_INDEX_STATEMENT = """
MERGE (d:Document {file_id: $document.file_id})
SET d += $document,
    d.graph_indexed_at = datetime()
MERGE (ontology:GraphOntology {version: $document.graph_ontology_version})
SET ontology.entity_types = $document.graph_entity_types,
    ontology.relation_types = $document.graph_relation_types
MERGE (d)-[:USES_GRAPH_ONTOLOGY]->(ontology)
WITH d
CALL {
  WITH d
  UNWIND $chunks AS chunk
    MERGE (c:Chunk {chunk_id: chunk.chunk_id})
    SET c += chunk
    MERGE (d)-[:HAS_CHUNK]->(c)
  RETURN count(*) AS indexed_chunks
}
CALL {
  WITH d
  UNWIND $entities AS entity
    MERGE (e:Entity {entity_id: entity.entity_id})
    ON CREATE SET e.name = entity.name
    SET e.normalized_name = entity.normalized_name,
        e.entity_key = entity.entity_key,
        e.normalized_entity_key = entity.normalized_entity_key,
        e.identity_scope = entity.identity_scope,
        e.user_id = entity.user_id,
        e.scope_key = entity.scope_key,
        e.project_space_id = entity.project_space_id,
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
  RETURN count(*) AS indexed_entities
}
CALL {
  WITH d
  UNWIND $relationships AS rel
    OPTIONAL MATCH (c:Chunk {chunk_id: rel.from})
    OPTIONAL MATCH (e:Entity {entity_id: rel.to_entity_id})
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
  RETURN count(*) AS indexed_mentions
}
CALL {
  WITH d
  UNWIND $relationships AS rel
    OPTIONAL MATCH (fromEntity:Entity {entity_id: rel.from_entity_id})
    OPTIONAL MATCH (toEntity:Entity {entity_id: rel.to_entity_id})
    FOREACH (_ IN CASE WHEN rel.fact_id IS NOT NULL AND fromEntity IS NOT NULL AND toEntity IS NOT NULL THEN [1] ELSE [] END |
      MERGE (fact:Fact {fact_id: rel.fact_id})
      SET fact.relation_type = rel.type,
          fact.relation_label = coalesce(rel.relation_label, rel.type),
          fact.file_id = rel.file_id,
          fact.chunk_id = rel.chunk_id,
          fact.evidence_chunk_ids = rel.evidence_chunk_ids,
          fact.evidence_spans = rel.evidence_spans,
          fact.evidence_refs_json = rel.evidence_refs_json,
          fact.polarity = coalesce(rel.polarity, 'affirmative'),
          fact.modality = coalesce(rel.modality, 'asserted'),
          fact.validation_status = rel.validation_status,
          fact.extraction_lane = coalesce(rel.extraction_lane, 'primary'),
          fact.extraction_method = rel.extraction_method,
          fact.extractor_version = rel.extractor_version,
          fact.ontology_version = rel.ontology_version,
          fact.user_id = rel.user_id,
          fact.project_space_id = rel.project_space_id,
          fact.scope_key = rel.scope_key,
          fact.updated_at = datetime()
      MERGE (d)-[:ASSERTS]->(fact)
      MERGE (fact)-[:SUBJECT]->(fromEntity)
      MERGE (fact)-[:OBJECT]->(toEntity)
      MERGE (fromEntity)-[typed:RELATED_TO {fact_id: rel.fact_id}]->(toEntity)
      SET typed.evidence = rel.evidence,
          typed.relation_type = rel.type,
          typed.chunk_id = rel.chunk_id,
          typed.file_id = rel.file_id,
          typed.relation_label = coalesce(rel.relation_label, rel.type),
          typed.polarity = coalesce(rel.polarity, 'affirmative'),
          typed.modality = coalesce(rel.modality, 'asserted'),
          typed.validation_status = rel.validation_status,
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
  RETURN count(*) AS indexed_facts
}
CALL {
  WITH d
  UNWIND $extractions AS extraction
    MERGE (cached:GraphExtraction {cache_key: extraction.cache_key})
    SET cached.content_hash = extraction.content_hash,
        cached.extractor_version = extraction.extractor_version,
        cached.ontology_version = extraction.ontology_version,
        cached.provider_fingerprint = extraction.provider_fingerprint,
        cached.payload = extraction.payload,
        cached.last_used_at = datetime(),
        cached.expires_at = datetime() + duration({days: $graph_cache_ttl_days})
    MERGE (d)-[usage:USED_GRAPH_EXTRACTION]->(cached)
    SET usage.source_chunk_ids = extraction.source_chunk_ids,
        usage.last_used_at = datetime()
  RETURN count(*) AS cached_extractions
}
RETURN {
  ok: true,
  indexed_chunks: indexed_chunks,
  indexed_entities: indexed_entities,
  indexed_mentions: indexed_mentions,
  indexed_facts: indexed_facts,
  cached_extractions: cached_extractions
} AS row
"""


class GraphFileTransaction:
    """Coordinate file graph publication without holding a cross-batch transaction.

    Extraction and each idempotent graph batch run outside a long-lived Neo4j
    transaction. PostgreSQL file/generation state remains the authority that
    publishes those staged Chunk IDs to readers. A failed in-process attempt is
    compensated by deleting its staged Chunk graph; a crashed converted attempt
    remains inactive and is removed by durable generation cleanup.
    """

    def __init__(self):
        self.enabled = settings.neo4j_enabled
        self.status = "skipped" if not self.enabled else "pending"
        self.pending_batches = 0
        self.committed_batches = 0
        self._schema_ready = False
        self._closed = False
        self._file_id: str | None = None
        self._chunk_ids: list[str] = []
        self._context_rows: list[dict] = []
        self._extraction_cache: dict[str, str] = {}
        self._entity_registry: list[dict] = []
        self._extraction_stats = {
            "attempted": 0,
            "succeeded": 0,
            "cache_hits": 0,
            "fallbacks": 0,
            "failure_reasons": {},
        }

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
        if not self.enabled:
            return {"status": self.status, "batches": self.committed_batches}
        if not settings.graph_extraction_enabled:
            extraction_status = "rules_only"
        elif self._extraction_stats["succeeded"] == 0:
            extraction_status = "rules_fallback"
        elif self._extraction_stats["fallbacks"]:
            extraction_status = "partial_llm_with_rule_fallback"
        else:
            extraction_status = "llm_primary"
        return {
            "status": self.status,
            "batches": self.committed_batches,
            "extraction_status": extraction_status,
            "extraction_stats": {
                **self._extraction_stats,
                "failure_reasons": dict(self._extraction_stats["failure_reasons"]),
            },
        }

    def index_chunks(self, file_data: dict, chunk_rows: list[dict]) -> dict:
        if not self.enabled:
            return self.result
        if self._closed:
            raise RuntimeError("Neo4j graph transaction is already closed")
        if not chunk_rows:
            return {"status": "pending", "batches": 0}
        file_id = str(file_data.get("id") or "").strip()
        if not file_id:
            raise ValueError("Graph file transaction requires a file id")
        if self._file_id is not None and self._file_id != file_id:
            raise ValueError("Graph file transaction cannot span multiple files")
        self._file_id = file_id
        if not self._schema_ready:
            ensure_graph_schema()
            self._schema_ready = True

        for batch in _batched(chunk_rows, settings.neo4j_batch_size):
            if settings.graph_extraction_enabled:
                provider_fingerprint = graph_extraction_fingerprint()
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
                        provider_fingerprint,
                    )
                    for window in windows
                ]
                missing_keys = [key for key in cache_keys if key not in self._extraction_cache]
                self._extraction_cache.update(_load_graph_extraction_cache(
                    missing_keys,
                    provider_fingerprint,
                ))

            facts = extract_graph_facts(
                file_data,
                batch,
                context_rows=self._context_rows,
                cached_extractions=self._extraction_cache,
            )
            batch_extraction_stats = facts.get("extraction_stats") or {}
            for field in ("attempted", "succeeded", "cache_hits", "fallbacks"):
                self._extraction_stats[field] += int(batch_extraction_stats.get(field) or 0)
            for reason, count in (batch_extraction_stats.get("failure_reasons") or {}).items():
                reasons = self._extraction_stats["failure_reasons"]
                reasons[str(reason)] = int(reasons.get(str(reason)) or 0) + int(count or 0)
            if not settings.graph_extraction_enabled:
                extraction_status = "rules_only"
            elif self._extraction_stats["succeeded"] == 0:
                extraction_status = "rules_fallback"
            elif self._extraction_stats["fallbacks"]:
                extraction_status = "partial_llm_with_rule_fallback"
            else:
                extraction_status = "llm_primary"
            facts["document"].update({
                "graph_extraction_status": extraction_status,
                "graph_extraction_attempted": self._extraction_stats["attempted"],
                "graph_extraction_succeeded": self._extraction_stats["succeeded"],
                "graph_extraction_cache_hits": self._extraction_stats["cache_hits"],
                "graph_extraction_fallbacks": self._extraction_stats["fallbacks"],
                "graph_extraction_failure_reasons": json.dumps(
                    self._extraction_stats["failure_reasons"],
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
            })
            # Enterprise-safe default: do not merge entities across evidence
            # windows from aliases alone. Stable document-scoped entity IDs
            # preserve recall by name while preventing same-name collisions.
            self._entity_registry.extend(dict(entity) for entity in facts.get("entities") or [])
            for extraction in facts.get("extractions") or []:
                self._extraction_cache[str(extraction["cache_key"])] = str(extraction["payload"])
            batch_chunk_ids = [
                str(chunk.get("chunk_id") or "").strip()
                for chunk in facts.get("chunks") or []
                if str(chunk.get("chunk_id") or "").strip()
            ]
            self._chunk_ids.extend(
                chunk_id for chunk_id in batch_chunk_ids
                if chunk_id not in self._chunk_ids
            )
            _run_cypher(_GRAPH_INDEX_STATEMENT, facts)
            self.pending_batches += 1
            self.committed_batches += 1
            self.status = "staging"
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
        self.committed_batches = self.pending_batches
        self.status = "indexed"
        self._entity_registry = []
        self._closed = True
        return self.result

    def rollback(self):
        if self._closed:
            return
        try:
            if self._file_id and self._chunk_ids:
                delete_chunk_graph(self._file_id, self._chunk_ids)
        finally:
            self.pending_batches = 0
            self.committed_batches = 0
            self._file_id = None
            self._chunk_ids = []
            self._context_rows = []
            self._extraction_cache = {}
            self._entity_registry = []
            self._extraction_stats = {
                "attempted": 0,
                "succeeded": 0,
                "cache_hits": 0,
                "fallbacks": 0,
                "failure_reasons": {},
            }
            self.status = "failed" if self.enabled else "skipped"
            self._closed = True

    def _rollback_without_masking(self):
        try:
            self.rollback()
        except Exception:
            self.pending_batches = 0
            self.committed_batches = 0
            self._file_id = None
            self._chunk_ids = []
            self._context_rows = []
            self._extraction_cache = {}
            self._entity_registry = []
            self._extraction_stats = {
                "attempted": 0,
                "succeeded": 0,
                "cache_hits": 0,
                "fallbacks": 0,
                "failure_reasons": {},
            }
            self.status = "failed" if self.enabled else "skipped"
            self._closed = True


def graph_file_transaction() -> GraphFileTransaction:
    return GraphFileTransaction()


def delete_file_graph(file_id: str):
    if not settings.neo4j_enabled:
        return
    _run_cypher(
        """
        OPTIONAL MATCH (fact:Fact {file_id: $file_id})
        DETACH DELETE fact
        WITH count(*) AS deleted_facts
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
    _run_cypher(
        """
        MATCH (cached:GraphExtraction)
        WHERE NOT (cached)<-[:USED_GRAPH_EXTRACTION]-()
        DETACH DELETE cached
        """,
    )


def delete_chunk_graph(file_id: str, chunk_ids: list[str]):
    if not settings.neo4j_enabled:
        return

    normalized_ids = list(
        dict.fromkeys(
            str(chunk_id).strip()
            for chunk_id in chunk_ids
            if str(chunk_id).strip()
        )
    )
    if not normalized_ids:
        return

    _run_cypher(
        """
        OPTIONAL MATCH (fact:Fact {file_id: $file_id})
        WHERE fact.chunk_id IN $chunk_ids
           OR any(chunk_id IN coalesce(fact.evidence_chunk_ids, []) WHERE chunk_id IN $chunk_ids)
        DETACH DELETE fact
        WITH count(*) AS deleted_facts
        MATCH (d:Document {file_id: $file_id})
        OPTIONAL MATCH (d)-[usage:USED_GRAPH_EXTRACTION]->(:GraphExtraction)
        WHERE any(chunk_id IN coalesce(usage.source_chunk_ids, []) WHERE chunk_id IN $chunk_ids)
        DELETE usage
        WITH DISTINCT d
        OPTIONAL MATCH ()-[r:RELATED_TO {file_id: $file_id}]-()
        WHERE r.chunk_id IN $chunk_ids
           OR any(chunk_id IN coalesce(r.evidence_chunk_ids, []) WHERE chunk_id IN $chunk_ids)
        WITH d, collect(r) AS stale_relationships
        FOREACH (relationship IN stale_relationships | DELETE relationship)
        WITH d
        MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
        WHERE c.chunk_id IN $chunk_ids
        WITH c,
             d.user_id AS owner_user_id,
             coalesce(d.scope_key, d.project_space_id, '__global__') AS owner_scope_key
        DETACH DELETE c
        WITH DISTINCT owner_user_id, owner_scope_key
        MATCH (e:Entity)
        WHERE NOT (e)--()
          AND e.user_id = owner_user_id
          AND coalesce(e.scope_key, e.project_space_id, '__global__') = owner_scope_key
        DELETE e
        """,
        {"file_id": file_id, "chunk_ids": normalized_ids},
    )
    _run_cypher(
        """
        MATCH (document:Document {file_id: $file_id})
        WHERE NOT (document)-[:HAS_CHUNK]->(:Chunk)
        DETACH DELETE document
        """,
        {"file_id": file_id},
    )
    _run_cypher(
        """
        MATCH (cached:GraphExtraction)
        WHERE NOT (cached)<-[:USED_GRAPH_EXTRACTION]-()
        DETACH DELETE cached
        """,
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
            OR (size(term) >= 2 AND coalesce(seed.normalized_name, toLower(seed.name)) CONTAINS term)
          ] AS matched_terms
        WHERE size(matched_terms) > 0
        RETURN {
          entity_id: seed.entity_id,
          normalized_name: coalesce(seed.normalized_name, toLower(seed.name)),
          scope_key: coalesce(seed.scope_key, seed.project_space_id, '__global__'),
          name: seed.name,
          entity_type: seed.entity_type,
          entity_type_label: coalesce(seed.entity_type_label, seed.entity_type),
          aliases: coalesce(seed.aliases, []),
          seed_match_score: CASE
            WHEN any(term IN matched_terms WHERE term = coalesce(seed.normalized_name, toLower(seed.name))) THEN 1.0
            WHEN any(term IN matched_terms WHERE any(alias IN coalesce(seed.aliases, []) WHERE toLower(alias) = term)) THEN 0.85
            ELSE 0.65
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
            "node_ids": [str(seed.get("entity_id") or "")],
            "node_details": [{
                "entity_id": str(seed.get("entity_id") or ""),
                "name": str(seed.get("name") or ""),
                "normalized_name": str(seed.get("normalized_name") or ""),
                "entity_type": str(seed.get("entity_type") or ""),
                "entity_type_label": str(seed.get("entity_type_label") or ""),
                "aliases": list(seed.get("aliases") or []),
                "scope_key": str(seed.get("scope_key") or "__global__"),
            }],
            "node_keys": [(
                str(seed.get("entity_id") or ""),
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
        edge_query = """
            UNWIND $frontier AS frontier
            MATCH (current:Entity)
            WHERE current.user_id = $user_id
              AND (
                (frontier.entity_id <> '' AND current.entity_id = frontier.entity_id)
                OR (
                  frontier.entity_id = ''
                  AND coalesce(current.scope_key, current.project_space_id, '__global__') = frontier.scope_key
                  AND coalesce(current.normalized_name, toLower(current.name)) = frontier.normalized_name
                )
              )
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
              SKIP $edge_offset
              LIMIT $max_branch_factor
              RETURN rel, neighbor
            }
            RETURN {
              current_entity_id: current.entity_id,
              current_normalized_name: coalesce(current.normalized_name, toLower(current.name)),
              scope_key: coalesce(current.scope_key, current.project_space_id, '__global__'),
              neighbor_entity_id: neighbor.entity_id,
              neighbor_normalized_name: coalesce(neighbor.normalized_name, toLower(neighbor.name)),
              neighbor_name: neighbor.name,
              neighbor_entity_type: neighbor.entity_type,
              neighbor_entity_type_label: coalesce(neighbor.entity_type_label, neighbor.entity_type),
              neighbor_aliases: coalesce(neighbor.aliases, []),
              neighbor_degree: size([(neighbor)-[:RELATED_TO]-() | 1]),
              relation: {
                fact_id: rel.fact_id,
                type: rel.relation_type,
                label: coalesce(rel.relation_label, rel.relation_type),
                from: startNode(rel).name,
                to: endNode(rel).name,
                from_entity_id: startNode(rel).entity_id,
                to_entity_id: endNode(rel).entity_id,
                from_entity_type: startNode(rel).entity_type,
                to_entity_type: endNode(rel).entity_type,
                evidence: rel.evidence,
                evidence_chunk_ids: coalesce(rel.evidence_chunk_ids, [rel.chunk_id]),
                evidence_spans: coalesce(rel.evidence_spans, [rel.evidence]),
                evidence_refs_json: rel.evidence_refs_json,
                extraction_method: coalesce(rel.extraction_method, 'legacy'),
                extraction_lane: coalesce(rel.extraction_lane, 'legacy'),
                extractor_version: rel.extractor_version,
                extractors: coalesce(rel.extractors, [coalesce(rel.extraction_method, 'legacy')]),
                ontology_version: rel.ontology_version,
                pattern_id: rel.pattern_id,
                polarity: coalesce(rel.polarity, 'affirmative'),
                modality: coalesce(rel.modality, 'asserted'),
                validation_status: rel.validation_status
              }
            } AS row
            """
        edges_by_frontier: dict[tuple[str, str, str], list[dict]] = {}
        pending_frontier = set(frontier)
        edge_offset = 0
        # PostgreSQL is the source of truth for the active conversion
        # generation. Page through every frontier until enough authorized
        # neighbors have been found; stale Neo4j edges must never occupy the
        # branch-factor budget ahead of current evidence.
        while pending_frontier:
            edge_rows = _run_cypher(
                edge_query,
                {
                    "frontier": [
                        {
                            "entity_id": entity_id,
                            "scope_key": scope_key,
                            "normalized_name": normalized_name,
                        }
                        for entity_id, scope_key, normalized_name in sorted(pending_frontier)
                    ],
                    "user_id": user_id,
                    "edge_offset": edge_offset,
                    "max_branch_factor": bounded_branch_factor,
                },
            )
            page_counts = {key: 0 for key in pending_frontier}
            evidence_ids = list(dict.fromkeys(
                str(chunk_id)
                for edge in edge_rows
                for chunk_id in (edge.get("relation") or {}).get("evidence_chunk_ids") or []
                if str(chunk_id).strip()
            ))
            active_evidence = get_active_chunks_by_ids(
                evidence_ids,
                user_id,
                project_space_id,
            ) if evidence_ids else []
            active_evidence_ids = {
                str(chunk.get("id")) for chunk in active_evidence if chunk.get("id")
            }
            for edge in edge_rows:
                key = (
                    str(edge.get("current_entity_id") or ""),
                    str(edge.get("scope_key") or "__global__"),
                    str(edge.get("current_normalized_name") or ""),
                )
                if key not in page_counts:
                    continue
                page_counts[key] += 1
                relation_evidence_ids = [
                    str(chunk_id)
                    for chunk_id in (edge.get("relation") or {}).get("evidence_chunk_ids") or []
                    if str(chunk_id).strip()
                ]
                if (
                    relation_evidence_ids
                    and all(chunk_id in active_evidence_ids for chunk_id in relation_evidence_ids)
                    and len(edges_by_frontier.setdefault(key, [])) < bounded_branch_factor
                ):
                    edges_by_frontier[key].append(edge)

            pending_frontier = {
                key for key in pending_frontier
                if len(edges_by_frontier.get(key, [])) < bounded_branch_factor
                and page_counts.get(key, 0) == bounded_branch_factor
            }
            edge_offset += bounded_branch_factor

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
                    str(edge.get("neighbor_entity_id") or ""),
                    str(edge.get("scope_key") or "__global__"),
                    str(edge.get("neighbor_normalized_name") or ""),
                )
                if (
                    not neighbor_key[2]
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
                    "node_ids": [*path["node_ids"], str(edge.get("neighbor_entity_id") or "")],
                    "node_details": [*path["node_details"], {
                        "entity_id": str(edge.get("neighbor_entity_id") or ""),
                        "name": str(edge.get("neighbor_name") or ""),
                        "normalized_name": str(edge.get("neighbor_normalized_name") or ""),
                        "entity_type": str(edge.get("neighbor_entity_type") or ""),
                        "entity_type_label": str(edge.get("neighbor_entity_type_label") or ""),
                        "aliases": list(edge.get("neighbor_aliases") or []),
                        "scope_key": str(edge.get("scope_key") or "__global__"),
                    }],
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
        qualifier_scores = [
            1.0
            if relation.get("polarity", "affirmative") == "affirmative"
            and relation.get("modality", "asserted") == "asserted"
            else 0.9
            if relation.get("polarity") == "negative"
            else 0.85
            if relation.get("modality") == "planned_or_obligatory"
            else 0.8
            for relation in path["relations"]
        ]
        qualifier_score = sum(qualifier_scores) / len(qualifier_scores) if qualifier_scores else 0.0
        features = {
            "seed_match_score": float(path["seed_match_score"]),
            "path_length": path_length,
            "evidence_count": len(evidence_chunk_ids),
            "extractor_evidence_count": extractor_evidence_count,
            "relation_evidence_coverage": evidence_edges / path_length if path_length else 0.0,
            "extraction_lane_score": extraction_lane_score,
            "qualifier_score": qualifier_score,
        }
        rank_score = extraction_lane_score * qualifier_score * (
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
    evidence_rows = get_active_chunks_by_ids(
        evidence_ids,
        user_id,
        project_space_id,
    )
    evidence_by_id = {
        str(row.get("id")): row
        for row in evidence_rows
        if row.get("id")
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
            "entity_details": path["node_details"],
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
        path_entity_details = [
            dict(entity) for entity in row.get("entity_details") or []
            if isinstance(entity, dict) and (entity.get("entity_id") or entity.get("name"))
        ]
        graph_path = {
            "entities": path_entities or [*seed_entities, *related_entities],
            "entity_details": path_entity_details,
            "relations": relations,
            "features": graph_features,
            "graph_rank_score": graph_rank_score,
        }
        for chunk in evidence_chunks:
            chunk_id = str(chunk.get("id") or chunk.get("chunk_id") or "")
            if not chunk_id:
                continue
            # A path may span several chunks. Attach a semantic relation only
            # to the chunk(s) explicitly named by that relation's evidence;
            # keep the full path separately for path-level reasoning.
            chunk_relations = [
                relation for relation in relations
                if chunk_id in {
                    str(evidence_chunk_id)
                    for evidence_chunk_id in relation.get("evidence_chunk_ids") or []
                    if str(evidence_chunk_id).strip()
                }
            ]
            chunk_entity_names = list(dict.fromkeys(
                str(name)
                for relation in chunk_relations
                for name in (relation.get("from"), relation.get("to"))
                if str(name or "").strip()
            ))
            chunk_entity_ids = {
                str(entity_id)
                for relation in chunk_relations
                for entity_id in (relation.get("from_entity_id"), relation.get("to_entity_id"))
                if str(entity_id or "").strip()
            }
            chunk_entity_details = [
                entity for entity in path_entity_details
                if (
                    str(entity.get("entity_id") or "") in chunk_entity_ids
                    or str(entity.get("name") or "") in chunk_entity_names
                )
            ]
            relation_lanes = {
                str(relation.get("extraction_lane") or "legacy")
                for relation in chunk_relations
            }
            chunk_extraction_status = (
                "llm_primary" if relation_lanes == {"primary"}
                else "rules_fallback" if relation_lanes == {"fallback"}
                else "mixed" if len(relation_lanes) > 1
                else "legacy"
            )
            existing = documents_by_chunk.get(chunk_id)
            if existing is None:
                canonical_metadata = dict(chunk.get("metadata") or {})
                canonical_metadata.update({
                    "filename": chunk.get("filename"),
                    "file_id": str(chunk.get("file_id") or ""),
                    "chunk_index": chunk.get("chunk_index"),
                    "project_space_id": (
                        str(chunk["project_space_id"])
                        if chunk.get("project_space_id")
                        else None
                    ),
                    "document_kind": chunk.get("document_kind"),
                    "conversion_generation_id": (
                        str(chunk["conversion_generation_id"])
                        if chunk.get("conversion_generation_id")
                        else None
                    ),
                    "source_unit_ids": list(chunk.get("source_unit_ids") or []),
                    "source_locator": dict(chunk.get("source_locator") or {}),
                })
                existing = {
                    "id": chunk_id,
                    "content": chunk.get("content") or "",
                    "metadata": {
                        **canonical_metadata,
                        "retrieval_mode": "graph",
                        "graph_entities": [],
                        "graph_entity_details": [],
                        "graph_seed_entities": [],
                        "graph_related_entities": [],
                        "graph_relations": [],
                        "graph_paths": [],
                        "graph_features": graph_features,
                        "graph_rank_score": graph_rank_score,
                        "graph_extraction": {"status": chunk_extraction_status},
                    },
                    "graph_rank_score": graph_rank_score,
                }
                documents_by_chunk[chunk_id] = existing
            metadata = existing["metadata"]
            for entity_detail in chunk_entity_details:
                entity_id = str(entity_detail.get("entity_id") or "")
                if not any(
                    str(existing_detail.get("entity_id") or "") == entity_id
                    for existing_detail in metadata["graph_entity_details"]
                ):
                    metadata["graph_entity_details"].append(entity_detail)
            for field, values in (
                ("graph_entities", chunk_entity_names),
                ("graph_seed_entities", seed_entities),
                ("graph_related_entities", related_entities),
                ("graph_relations", chunk_relations),
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

    bounded_limit = max(1, int(limit))
    candidate_limit = min(max(bounded_limit * 5, bounded_limit), 200)
    list_query = """
        MATCH (d:Document)-[:HAS_CHUNK]->(c:Chunk)-[:MENTIONS]->(e:Entity)
        WHERE e.user_id = $user_id
          AND ($project_space_id IS NULL OR e.project_space_id = $project_space_id)
        WITH d, c, collect(distinct {
          entity_id: e.entity_id,
          name: e.name,
          normalized_name: coalesce(e.normalized_name, toLower(e.name)),
          entity_type: e.entity_type,
          entity_type_label: coalesce(e.entity_type_label, e.entity_type),
          aliases: coalesce(e.aliases, []),
          scope_key: coalesce(e.scope_key, e.project_space_id, '__global__')
        }) AS entity_details, count(distinct e) AS entity_count
        WITH d, c, entity_details, [entity IN entity_details | entity.name] AS entities, entity_count
        OPTIONAL MATCH (fromEntity:Entity)-[rel:RELATED_TO {chunk_id: c.chunk_id}]->(toEntity:Entity)
        WITH d, c, entities, entity_details, entity_count, collect(distinct {
          fact_id: rel.fact_id,
          type: rel.relation_type,
          label: coalesce(rel.relation_label, rel.relation_type),
          from: fromEntity.name,
          to: toEntity.name,
          from_entity_id: fromEntity.entity_id,
          to_entity_id: toEntity.entity_id,
          from_entity_type: fromEntity.entity_type,
          to_entity_type: toEntity.entity_type,
          evidence: rel.evidence,
          evidence_chunk_ids: coalesce(rel.evidence_chunk_ids, [rel.chunk_id]),
          evidence_spans: coalesce(rel.evidence_spans, [rel.evidence]),
          evidence_refs_json: rel.evidence_refs_json,
          extraction_method: coalesce(rel.extraction_method, 'legacy'),
          extraction_lane: coalesce(rel.extraction_lane, 'legacy'),
          extractor_version: rel.extractor_version,
          ontology_version: rel.ontology_version,
          pattern_id: rel.pattern_id,
          polarity: coalesce(rel.polarity, 'affirmative'),
          modality: coalesce(rel.modality, 'asserted'),
          validation_status: rel.validation_status
        }) AS relations
        RETURN {
          chunk_id: c.chunk_id,
          entities: entities,
          entity_details: entity_details,
          relations: relations,
          graph_features: {entity_count: entity_count},
          graph_rank_score: toFloat(entity_count),
          graph_extraction: {
            status: coalesce(d.graph_extraction_status, 'legacy'),
            attempted: coalesce(d.graph_extraction_attempted, 0),
            succeeded: coalesce(d.graph_extraction_succeeded, 0),
            cache_hits: coalesce(d.graph_extraction_cache_hits, 0),
            fallbacks: coalesce(d.graph_extraction_fallbacks, 0),
            failure_reasons_json: coalesce(d.graph_extraction_failure_reasons, '{}'),
            extractor_version: d.graph_extractor_version,
            ontology_version: d.graph_ontology_version
          }
        } AS row
        ORDER BY row.graph_rank_score DESC, c.chunk_id ASC
        SKIP $offset
        LIMIT $limit
        """

    authorized_rows: list[tuple[dict, dict, dict[str, dict]]] = []
    seen_candidate_ids: set[str] = set()
    offset = 0
    while len(authorized_rows) < bounded_limit:
        rows = _run_cypher(
            list_query,
            {
                "user_id": user_id,
                "project_space_id": project_space_id,
                "offset": offset,
                "limit": candidate_limit,
            },
        )
        if not rows:
            break
        candidate_ids = [
            str(row.get("chunk_id") or "") for row in rows
            if str(row.get("chunk_id") or "").strip()
        ]
        relation_evidence_ids = [
            str(chunk_id)
            for row in rows
            for relation in row.get("relations") or []
            for chunk_id in relation.get("evidence_chunk_ids") or []
            if str(chunk_id).strip()
        ]
        active_chunks = get_active_chunks_by_ids(
            list(dict.fromkeys([*candidate_ids, *relation_evidence_ids])),
            user_id,
            project_space_id,
        )
        active_by_id = {str(chunk["id"]): chunk for chunk in active_chunks}
        new_candidate_seen = False
        for row in rows:
            chunk_id = str(row.get("chunk_id") or "")
            if not chunk_id or chunk_id in seen_candidate_ids:
                continue
            seen_candidate_ids.add(chunk_id)
            new_candidate_seen = True
            chunk = active_by_id.get(chunk_id)
            if chunk is not None:
                authorized_rows.append((row, chunk, active_by_id))
        if len(rows) < candidate_limit or not new_candidate_seen:
            break
        offset += len(rows)

    authorized_rows = authorized_rows[:bounded_limit]
    max_score = max([
        float(row.get("graph_rank_score") or row.get("graph_score") or 0)
        for row, _, _ in authorized_rows
    ] or [0])
    documents = []
    for row, chunk, active_by_id in authorized_rows:
        graph_rank_score = float(row.get("graph_rank_score") or row.get("graph_score") or 0)
        retrieval_score = graph_rank_score / max_score if max_score > 0 else 0.0
        relations = []
        for relation in row.get("relations") or []:
            evidence_chunk_ids = [
                str(chunk_id)
                for chunk_id in relation.get("evidence_chunk_ids") or []
                if str(chunk_id).strip()
            ]
            if (
                relation.get("type")
                and relation.get("from")
                and relation.get("to")
                and evidence_chunk_ids
                and all(chunk_id in active_by_id for chunk_id in evidence_chunk_ids)
            ):
                evidence_refs = []
                try:
                    parsed_refs = json.loads(str(relation.get("evidence_refs_json") or "[]"))
                except json.JSONDecodeError:
                    parsed_refs = []
                if isinstance(parsed_refs, list):
                    evidence_refs = [
                        {"chunk_id": str(item.get("chunk_id") or ""), "span": str(item.get("span") or "")}
                        for item in parsed_refs
                        if isinstance(item, dict)
                        and str(item.get("chunk_id") or "") in evidence_chunk_ids
                        and str(item.get("span") or "").strip()
                    ]
                relations.append({**relation, "evidence_refs": evidence_refs})
        metadata = dict(chunk.get("metadata") or {})
        metadata.update({
            "filename": chunk.get("filename"),
            "file_id": str(chunk.get("file_id") or ""),
            "chunk_index": chunk.get("chunk_index"),
            "project_space_id": (
                str(chunk["project_space_id"])
                if chunk.get("project_space_id")
                else None
            ),
            "document_kind": chunk.get("document_kind"),
            "conversion_generation_id": (
                str(chunk["conversion_generation_id"])
                if chunk.get("conversion_generation_id")
                else None
            ),
            "source_unit_ids": list(chunk.get("source_unit_ids") or []),
            "source_locator": dict(chunk.get("source_locator") or {}),
        })
        documents.append({
            "id": str(chunk["id"]),
            "content": chunk.get("content") or "",
            "metadata": {
                **metadata,
                "retrieval_mode": "graph_overview",
                "graph_entities": row.get("entities") or [],
                "graph_entity_details": row.get("entity_details") or [],
                "graph_features": row.get("graph_features") or {
                    "entity_count": len(row.get("entities") or []),
                },
                "graph_rank_score": graph_rank_score,
                "graph_relations": relations,
                "graph_extraction": row.get("graph_extraction") or {"status": "legacy"},
            },
            "similarity": retrieval_score,
            "retrieval_score": retrieval_score,
            "graph_rank_score": graph_rank_score,
        })
        if len(documents) >= bounded_limit:
            break

    return documents
