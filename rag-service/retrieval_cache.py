import hashlib
import json
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Protocol


CACHE_TTL_SECONDS = 6 * 60 * 60
RETRIEVAL_PIPELINE_VERSION = "rag-v3:parallel-routed-rrf-exact-cache"
CACHE_SCHEMA_VERSION = "retrieval-cache-v3"
SIMILAR_QUERY_THRESHOLD = 0.55
CONVERSATION_EVIDENCE_THRESHOLD = 0.42
MIN_REUSE_OVERALL_SCORE = 0.38
DEFAULT_SINGLEFLIGHT_WAIT_MS = 800
DEFAULT_SINGLEFLIGHT_LOCK_SECONDS = 30


class _CacheMetrics:
    """Small in-process counters for cache decisions.

    These counters intentionally avoid adding an observability dependency. They
    are returned with agentic retrieval cache metadata and reset on process
    restart.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._counters: dict[str, int] = {}

    def record(self, name: str, value: int = 1) -> None:
        with self._lock:
            self._counters[name] = self._counters.get(name, 0) + int(value)

    def snapshot(self) -> dict[str, int | float]:
        with self._lock:
            counters = dict(self._counters)
        lookups = counters.get("exact_hit", 0) + counters.get("exact_miss", 0)
        counters["exact_lookup_count"] = lookups
        counters["effective_exact_hit_rate"] = round(
            counters.get("exact_hit", 0) / lookups,
            6,
        ) if lookups else 0.0
        return counters


_CACHE_METRICS = _CacheMetrics()


def record_cache_metric(name: str, value: int = 1) -> None:
    _CACHE_METRICS.record(name, value)


def cache_metrics_snapshot() -> dict[str, int | float]:
    return _CACHE_METRICS.snapshot()


_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "be",
    "by",
    "does",
    "for",
    "from",
    "how",
    "in",
    "is",
    "of",
    "on",
    "or",
    "the",
    "to",
    "what",
    "when",
    "where",
    "which",
    "why",
    "with",
}


def _json_default(value: Any):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def normalize_query(query: str) -> str:
    normalized = (query or "").strip().lower()
    normalized = re.sub(r"[_\-]+", " ", normalized)
    normalized = re.sub(r"[^\w\s\u4e00-\u9fff]+", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def _stem_latin_token(token: str) -> str:
    if len(token) > 4 and token.endswith("ies"):
        return f"{token[:-3]}y"
    if len(token) > 4 and token.endswith("ing"):
        return token[:-3]
    if len(token) > 4 and token.endswith("ed"):
        return token[:-2]
    if len(token) > 3 and token.endswith("s"):
        return token[:-1]
    return token


def query_terms(query: str) -> set[str]:
    normalized = normalize_query(query)
    terms: set[str] = set()

    for token in re.findall(r"[a-z][a-z0-9]+|\d{2,}|[\u4e00-\u9fff]{2,}", normalized):
        if re.search(r"[\u4e00-\u9fff]", token):
            terms.add(token)
            for size in (2, 3, 4):
                if len(token) >= size:
                    for index in range(0, len(token) - size + 1):
                        terms.add(token[index:index + size])
            continue

        stemmed = _stem_latin_token(token)
        if stemmed and stemmed not in _STOPWORDS:
            terms.add(stemmed)

    return terms


def query_similarity(query_a: str, query_b: str) -> float:
    normalized_a = normalize_query(query_a)
    normalized_b = normalize_query(query_b)
    if not normalized_a or not normalized_b:
        return 0.0
    if normalized_a == normalized_b:
        return 1.0

    terms_a = query_terms(normalized_a)
    terms_b = query_terms(normalized_b)
    if not terms_a or not terms_b:
        return 0.0

    overlap = len(terms_a & terms_b)
    jaccard = overlap / len(terms_a | terms_b)
    containment = max(overlap / len(terms_a), overlap / len(terms_b))
    return round(max(jaccard, containment * 0.72), 6)


def query_hash(normalized_query: str) -> str:
    return hashlib.sha256(normalize_query(normalized_query).encode("utf-8")).hexdigest()


def build_retrieval_scope_fingerprint(scope: dict) -> str:
    project_space_id = str(scope.get("project_space_id") or "")
    stable_scope = {
        "retrieval_pipeline_version": RETRIEVAL_PIPELINE_VERSION,
        "cache_schema_version": CACHE_SCHEMA_VERSION,
        "user_id": str(scope.get("user_id") or ""),
        "project_space_id": project_space_id,
        "knowledge_version": int(scope.get("knowledge_version") or 1),
        "vector_version": int(scope.get("vector_version") or 1),
        "bm25_version": int(scope.get("bm25_version") or 1),
        "graph_version": int(scope.get("graph_version") or 1),
        "chunk_strategy_version": str(scope.get("chunk_strategy_version") or ""),
        "embedding_model": str(scope.get("embedding_model") or ""),
        "embedding_dimension": int(scope.get("embedding_dimension") or 0),
        "settings_fingerprint": str(scope.get("settings_fingerprint") or ""),
    }
    if not project_space_id:
        project_versions = []
        for item in scope.get("project_versions") or []:
            if not isinstance(item, dict):
                continue
            project_versions.append({
                "project_space_id": str(item.get("project_space_id") or ""),
                "knowledge_version": int(item.get("knowledge_version") or 1),
                "vector_version": int(item.get("vector_version") or 1),
                "bm25_version": int(item.get("bm25_version") or 1),
                "graph_version": int(item.get("graph_version") or 1),
                "chunk_strategy_version": str(item.get("chunk_strategy_version") or ""),
                "embedding_model": str(item.get("embedding_model") or ""),
                "embedding_dimension": int(item.get("embedding_dimension") or 0),
                "settings_fingerprint": str(item.get("settings_fingerprint") or ""),
            })
        stable_scope["project_versions"] = sorted(
            project_versions,
            key=lambda item: (item["project_space_id"], item["knowledge_version"]),
        )
    payload = json.dumps(stable_scope, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_retrieval_request_fingerprint(
    scope_fingerprint: str,
    routes: list[str] | tuple[str, ...],
    limit: int,
    threshold: float,
    reranker_fingerprint: str,
    query_rewriter_fingerprint: str = "deterministic-query-rewrite-v1",
) -> str:
    """Bind exact-cache entries to settings that change returned evidence.

    Route ordering is normalized because retrieval fusion is deterministic and
    route membership, not caller ordering, determines the enabled backends.
    """

    stable_request = {
        "cache_schema_version": CACHE_SCHEMA_VERSION,
        "retrieval_pipeline_version": RETRIEVAL_PIPELINE_VERSION,
        "scope_fingerprint": str(scope_fingerprint or ""),
        "routes": sorted({str(route).strip().lower() for route in routes if str(route).strip()}),
        "limit": max(1, int(limit)),
        "threshold": round(float(threshold), 6),
        "reranker_fingerprint": str(reranker_fingerprint or "unknown"),
        "query_rewriter_fingerprint": str(query_rewriter_fingerprint or "unknown"),
    }
    payload = json.dumps(stable_request, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def cache_entry_is_reusable(entry: dict, quality: dict, similarity: float | None = None) -> bool:
    if not entry:
        return False
    if similarity is not None and similarity < SIMILAR_QUERY_THRESHOLD:
        return False

    stored_quality = entry.get("quality") or {}
    try:
        stored_score = float(stored_quality.get("overall_score") or 0)
    except (TypeError, ValueError):
        stored_score = 0.0
    stored_label = str(stored_quality.get("evidence_label") or "").lower()
    if stored_label == "weak" or stored_score < MIN_REUSE_OVERALL_SCORE:
        return False
    stored_support_label = str(stored_quality.get("support_label") or "supported").lower()
    if stored_support_label == "unsupported":
        return False

    try:
        current_score = float(quality.get("overall_score") or 0)
    except (TypeError, ValueError):
        current_score = 0.0
    current_label = str(quality.get("evidence_label") or "").lower()
    current_support_label = str(quality.get("support_label") or "supported").lower()
    return (
        current_label != "weak"
        and current_support_label != "unsupported"
        and current_score >= MIN_REUSE_OVERALL_SCORE
    )


class RetrievalCacheStore(Protocol):
    def get_scope(self, user_id: str, project_space_id: str | None) -> dict:
        ...

    def find_exact(
        self,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        scope_fingerprint: str,
        normalized_query: str,
    ) -> dict | None:
        ...

    def find_similar(
        self,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        scope_fingerprint: str,
        normalized_query: str,
        min_similarity: float = SIMILAR_QUERY_THRESHOLD,
    ) -> dict | None:
        ...

    def find_subquery(
        self,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        scope_fingerprint: str,
        normalized_query: str,
        min_similarity: float = SIMILAR_QUERY_THRESHOLD,
    ) -> dict | None:
        ...

    def find_conversation_evidence(
        self,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        scope_fingerprint: str,
        normalized_query: str,
        min_similarity: float = CONVERSATION_EVIDENCE_THRESHOLD,
    ) -> dict | None:
        ...

    def upsert_query_cache(
        self,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        normalized_query: str,
        original_query: str,
        scope_fingerprint: str,
        documents: list[dict],
        quality: dict,
    ) -> None:
        ...

    def upsert_subquery_cache(
        self,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        normalized_query: str,
        original_query: str,
        scope_fingerprint: str,
        documents: list[dict],
        quality: dict,
    ) -> None:
        ...

    def upsert_conversation_evidence(
        self,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        normalized_query: str,
        original_query: str,
        scope_fingerprint: str,
        documents: list[dict],
        quality: dict,
    ) -> None:
        ...

    def record_hit(self, entry: dict) -> None:
        ...

class InMemoryRetrievalCache:
    def __init__(self, scope_fingerprint: str = "memory-scope", scope: dict | None = None):
        self.scope_fingerprint = scope_fingerprint
        self.scope = scope or {
            "knowledge_version": 1,
            "vector_version": 1,
            "bm25_version": 1,
            "graph_version": 1,
            "chunk_strategy_version": "memory",
            "embedding_model": "memory",
            "embedding_dimension": 0,
            "settings_fingerprint": "memory",
        }
        self.entries: list[dict] = []
        self._lock = threading.RLock()
        self._singleflights: dict[str, threading.Event] = {}

    def get_scope(self, user_id: str, project_space_id: str | None) -> dict:
        scope = dict(self.scope)
        scope.update({
            "user_id": user_id,
            "project_space_id": project_space_id,
            "fingerprint": self.scope_fingerprint,
        })
        return scope

    def _upsert(
        self,
        cache_kind: str,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        normalized_query: str,
        original_query: str,
        scope_fingerprint: str,
        documents: list[dict],
        quality: dict,
    ):
        normalized = normalize_query(normalized_query or original_query)
        entry = {
            "id": f"memory-{len(self.entries) + 1}",
            "cache_kind": cache_kind,
            "user_id": user_id,
            "project_space_id": project_space_id,
            "conversation_id": conversation_id,
            "retrieval_scope_fingerprint": scope_fingerprint,
            "normalized_query": normalized,
            "query_hash": query_hash(normalized),
            "query_terms": sorted(query_terms(normalized)),
            "original_query": original_query,
            "documents": [dict(document) for document in documents],
            "quality": dict(quality or {}),
            "hit_count": 0,
            "created_at": time.time(),
            "expires_at": time.time() + CACHE_TTL_SECONDS,
        }

        scoped_conversation_id = conversation_id if cache_kind == "conversation_evidence" else None
        entry["conversation_id"] = scoped_conversation_id
        with self._lock:
            self.entries = [
                existing for existing in self.entries
                if not (
                    existing["cache_kind"] == cache_kind
                    and existing["user_id"] == user_id
                    and existing.get("project_space_id") == project_space_id
                    and existing.get("conversation_id") == scoped_conversation_id
                    and existing["retrieval_scope_fingerprint"] == scope_fingerprint
                    and existing["query_hash"] == entry["query_hash"]
                )
            ]
            self.entries.append(entry)

    def _matches_scope(
        self,
        entry: dict,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        scope_fingerprint: str,
        cache_kind: str,
    ) -> bool:
        if entry.get("expires_at", 0) <= time.time():
            return False
        if entry["cache_kind"] != cache_kind:
            return False
        if entry["user_id"] != user_id:
            return False
        if entry.get("project_space_id") != project_space_id:
            return False
        if entry["retrieval_scope_fingerprint"] != scope_fingerprint:
            return False
        expected_conversation_id = conversation_id if cache_kind == "conversation_evidence" else None
        if entry.get("conversation_id") != expected_conversation_id:
            return False
        return True

    def _copy_entry(self, entry: dict, similarity: float | None = None) -> dict:
        copied = dict(entry)
        copied["documents"] = [dict(document) for document in entry.get("documents", [])]
        copied["quality"] = dict(entry.get("quality") or {})
        if similarity is not None:
            copied["query_similarity"] = similarity
        return copied

    def find_exact(self, user_id, project_space_id, conversation_id, scope_fingerprint, normalized_query_value):
        normalized = normalize_query(normalized_query_value)
        hashed = query_hash(normalized)
        with self._lock:
            for entry in reversed(self.entries):
                if not self._matches_scope(entry, user_id, project_space_id, conversation_id, scope_fingerprint, "query"):
                    continue
                if entry["query_hash"] == hashed:
                    return self._copy_entry(entry, 1.0)
        return None

    def find_similar(
        self,
        user_id,
        project_space_id,
        conversation_id,
        scope_fingerprint,
        normalized_query_value,
        min_similarity=SIMILAR_QUERY_THRESHOLD,
    ):
        best: tuple[float, dict] | None = None
        normalized = normalize_query(normalized_query_value)
        with self._lock:
            for entry in reversed(self.entries):
                if not self._matches_scope(entry, user_id, project_space_id, conversation_id, scope_fingerprint, "query"):
                    continue
                similarity = query_similarity(normalized, entry["normalized_query"])
                if similarity >= min_similarity and (best is None or similarity > best[0]):
                    best = (similarity, entry)
            candidate = self._copy_entry(best[1], best[0]) if best else None
        if candidate:
            candidate["reuse_policy"] = "candidate_only"
        return candidate

    def find_subquery(
        self,
        user_id,
        project_space_id,
        conversation_id,
        scope_fingerprint,
        normalized_query_value,
        min_similarity=SIMILAR_QUERY_THRESHOLD,
    ):
        normalized = normalize_query(normalized_query_value)
        hashed = query_hash(normalized)
        with self._lock:
            for entry in reversed(self.entries):
                if not self._matches_scope(entry, user_id, project_space_id, conversation_id, scope_fingerprint, "subquery"):
                    continue
                if entry["query_hash"] == hashed:
                    return self._copy_entry(entry, 1.0)
        return None

    def find_conversation_evidence(
        self,
        user_id,
        project_space_id,
        conversation_id,
        scope_fingerprint,
        normalized_query_value,
        min_similarity=CONVERSATION_EVIDENCE_THRESHOLD,
    ):
        best: tuple[float, dict] | None = None
        normalized = normalize_query(normalized_query_value)
        with self._lock:
            for entry in reversed(self.entries):
                if not self._matches_scope(
                    entry,
                    user_id,
                    project_space_id,
                    conversation_id,
                    scope_fingerprint,
                    "conversation_evidence",
                ):
                    continue
                similarity = query_similarity(normalized, entry["normalized_query"])
                if similarity >= min_similarity and (best is None or similarity > best[0]):
                    best = (similarity, entry)
            candidate = self._copy_entry(best[1], best[0]) if best else None
        if candidate:
            candidate["reuse_policy"] = "candidate_only"
        return candidate

    def upsert_query_cache(self, *args, **kwargs) -> None:
        self._upsert("query", *args, **kwargs)

    def upsert_subquery_cache(self, *args, **kwargs) -> None:
        self._upsert("subquery", *args, **kwargs)

    def upsert_conversation_evidence(self, *args, **kwargs) -> None:
        self._upsert("conversation_evidence", *args, **kwargs)

    def record_hit(self, entry: dict) -> None:
        entry_id = entry.get("id")
        with self._lock:
            for stored_entry in self.entries:
                if stored_entry.get("id") == entry_id:
                    stored_entry["hit_count"] = int(stored_entry.get("hit_count") or 0) + 1
                    break

    @staticmethod
    def _singleflight_key(user_id, project_space_id, scope_fingerprint, normalized_query_value) -> str:
        return "\0".join((
            str(user_id or ""),
            str(project_space_id or ""),
            str(scope_fingerprint or ""),
            query_hash(normalize_query(normalized_query_value)),
        ))

    def acquire_singleflight(self, user_id, project_space_id, scope_fingerprint, normalized_query_value) -> dict:
        key = self._singleflight_key(user_id, project_space_id, scope_fingerprint, normalized_query_value)
        with self._lock:
            if key in self._singleflights:
                return {"role": "waiter", "key": key, "wait_ms": DEFAULT_SINGLEFLIGHT_WAIT_MS}
            event = threading.Event()
            self._singleflights[key] = event
        return {"role": "leader", "key": key, "token": str(uuid.uuid4()), "wait_ms": DEFAULT_SINGLEFLIGHT_WAIT_MS}

    def wait_for_singleflight(
        self,
        user_id,
        project_space_id,
        scope_fingerprint,
        normalized_query_value,
        wait_ms=None,
    ):
        key = self._singleflight_key(user_id, project_space_id, scope_fingerprint, normalized_query_value)
        with self._lock:
            event = self._singleflights.get(key)
        if event is not None:
            event.wait(max(0, int(wait_ms or DEFAULT_SINGLEFLIGHT_WAIT_MS)) / 1000)
        return self.find_exact(
            user_id,
            project_space_id,
            None,
            scope_fingerprint,
            normalized_query_value,
        )

    def release_singleflight(self, lease: dict) -> None:
        key = str((lease or {}).get("key") or "")
        if not key:
            return
        with self._lock:
            event = self._singleflights.pop(key, None)
        if event is not None:
            event.set()


class PostgresRetrievalCache:
    def __init__(self, ttl_seconds: int | None = None):
        self.ttl_seconds = max(1, int(ttl_seconds or CACHE_TTL_SECONDS))

    def get_scope(self, user_id: str, project_space_id: str | None) -> dict:
        from db import get_retrieval_scope

        scope = get_retrieval_scope(user_id, project_space_id)
        scope["fingerprint"] = build_retrieval_scope_fingerprint(scope)
        return scope

    def _entry_from_row(self, row: dict, similarity: float | None = None) -> dict:
        entry = dict(row)
        entry["documents"] = row.get("evidence") or []
        if similarity is not None:
            entry["query_similarity"] = similarity
        return entry

    def _find_by_kind(
        self,
        cache_kind: str,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        scope_fingerprint: str,
        normalized_query_value: str,
        exact: bool,
        min_similarity: float = SIMILAR_QUERY_THRESHOLD,
    ) -> dict | None:
        from db import get_conn

        normalized = normalize_query(normalized_query_value)
        scoped_conversation_id = conversation_id if cache_kind == "conversation_evidence" else None
        with get_conn() as conn:
            with conn.cursor() as cur:
                if exact:
                    cur.execute(
                        """
                        select *
                        from rag_retrieval_cache
                        where user_id::text = %s
                          and ((%s::text is null and project_space_id is null) or project_space_id::text = %s)
                          and ((%s::text is null and conversation_id is null) or conversation_id::text = %s)
                          and retrieval_scope_fingerprint = %s
                          and cache_kind = %s
                          and query_hash = %s
                          and expires_at > now()
                        order by updated_at desc
                        limit 1
                        """,
                        (
                            user_id,
                            project_space_id,
                            project_space_id,
                            scoped_conversation_id,
                            scoped_conversation_id,
                            scope_fingerprint,
                            cache_kind,
                            query_hash(normalized),
                        ),
                    )
                    row = cur.fetchone()
                    if not row:
                        return None
                    return self._entry_from_row(row, 1.0)

                cur.execute(
                    """
                    select *
                    from rag_retrieval_cache
                    where user_id::text = %s
                      and ((%s::text is null and project_space_id is null) or project_space_id::text = %s)
                      and ((%s::text is null and conversation_id is null) or conversation_id::text = %s)
                      and retrieval_scope_fingerprint = %s
                      and cache_kind = %s
                      and expires_at > now()
                    order by updated_at desc
                    limit 40
                    """,
                    (
                        user_id,
                        project_space_id,
                        project_space_id,
                        scoped_conversation_id,
                        scoped_conversation_id,
                        scope_fingerprint,
                        cache_kind,
                    ),
                )
                rows = cur.fetchall()

        best: tuple[float, dict] | None = None
        for row in rows:
            similarity = query_similarity(normalized, str(row.get("normalized_query") or ""))
            if similarity >= min_similarity and (best is None or similarity > best[0]):
                best = (similarity, row)
        candidate = self._entry_from_row(best[1], best[0]) if best else None
        if candidate:
            candidate["reuse_policy"] = "candidate_only"
        return candidate

    def find_exact(self, user_id, project_space_id, conversation_id, scope_fingerprint, normalized_query_value):
        return self._find_by_kind(
            "query",
            user_id,
            project_space_id,
            conversation_id,
            scope_fingerprint,
            normalized_query_value,
            exact=True,
        )

    def find_similar(
        self,
        user_id,
        project_space_id,
        conversation_id,
        scope_fingerprint,
        normalized_query_value,
        min_similarity=SIMILAR_QUERY_THRESHOLD,
    ):
        return self._find_by_kind(
            "query",
            user_id,
            project_space_id,
            conversation_id,
            scope_fingerprint,
            normalized_query_value,
            exact=False,
            min_similarity=min_similarity,
        )

    def find_subquery(
        self,
        user_id,
        project_space_id,
        conversation_id,
        scope_fingerprint,
        normalized_query_value,
        min_similarity=SIMILAR_QUERY_THRESHOLD,
    ):
        return self._find_by_kind(
            "subquery",
            user_id,
            project_space_id,
            conversation_id,
            scope_fingerprint,
            normalized_query_value,
            exact=True,
            min_similarity=min_similarity,
        )

    def find_conversation_evidence(
        self,
        user_id,
        project_space_id,
        conversation_id,
        scope_fingerprint,
        normalized_query_value,
        min_similarity=CONVERSATION_EVIDENCE_THRESHOLD,
    ):
        return self._find_by_kind(
            "conversation_evidence",
            user_id,
            project_space_id,
            conversation_id,
            scope_fingerprint,
            normalized_query_value,
            exact=False,
            min_similarity=min_similarity,
        )

    def _insert(
        self,
        cache_kind: str,
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        normalized_query: str,
        original_query: str,
        scope_fingerprint: str,
        documents: list[dict],
        quality: dict,
    ) -> None:
        from db import get_conn

        normalized = normalize_query(normalized_query or original_query)
        scoped_conversation_id = conversation_id if cache_kind == "conversation_evidence" else None
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    delete from rag_retrieval_cache
                    where user_id::text = %s
                      and ((%s::text is null and project_space_id is null) or project_space_id::text = %s)
                      and expires_at <= now()
                    """,
                    (user_id, project_space_id, project_space_id),
                )
                cur.execute(
                    """
                    delete from rag_retrieval_cache
                    where user_id::text = %s
                      and ((%s::text is null and project_space_id is null) or project_space_id::text = %s)
                      and ((%s::text is null and conversation_id is null) or conversation_id::text = %s)
                      and cache_kind = %s
                      and retrieval_scope_fingerprint = %s
                      and query_hash = %s
                    """,
                    (
                        user_id,
                        project_space_id,
                        project_space_id,
                        scoped_conversation_id,
                        scoped_conversation_id,
                        cache_kind,
                        scope_fingerprint,
                        query_hash(normalized),
                    ),
                )
                cur.execute(
                    """
                    insert into rag_retrieval_cache (
                      user_id,
                      project_space_id,
                      conversation_id,
                      cache_kind,
                      retrieval_scope_fingerprint,
                      normalized_query,
                      original_query,
                      query_hash,
                      query_terms,
                      evidence,
                      quality,
                      expires_at
                    )
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, now() + (%s::text || ' seconds')::interval)
                    """,
                    (
                        user_id,
                        project_space_id,
                        scoped_conversation_id,
                        cache_kind,
                        scope_fingerprint,
                        normalized,
                        original_query,
                        query_hash(normalized),
                        sorted(query_terms(normalized)),
                        json.dumps(documents, ensure_ascii=False, default=_json_default),
                        json.dumps(quality or {}, ensure_ascii=False, default=_json_default),
                        self.ttl_seconds,
                    ),
                )
            conn.commit()

    def upsert_query_cache(self, *args, **kwargs) -> None:
        self._insert("query", *args, **kwargs)

    def upsert_subquery_cache(self, *args, **kwargs) -> None:
        self._insert("subquery", *args, **kwargs)

    def upsert_conversation_evidence(self, *args, **kwargs) -> None:
        self._insert("conversation_evidence", *args, **kwargs)

    def record_hit(self, entry: dict) -> None:
        from db import get_conn

        entry_id = entry.get("id")
        if not entry_id:
            return
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update rag_retrieval_cache
                    set hit_count = hit_count + 1,
                        last_used_at = now(),
                        updated_at = now()
                    where id = %s
                    """,
                    (entry_id,),
                )
            conn.commit()


class RedisL1RetrievalCache:
    """Read-through exact-query cache with PostgreSQL as the source of truth.

    Queue Redis must be a different instance. This cache is disposable and
    Redis failures always fall back to PostgreSQL and normal retrieval.
    """

    def __init__(
        self,
        backend=None,
        redis_client=None,
        ttl_seconds: int | None = None,
        failure_cooldown_seconds: float = 10.0,
        singleflight_wait_ms: int | None = None,
        singleflight_lock_seconds: int | None = None,
    ):
        self.backend = backend or PostgresRetrievalCache()
        self.ttl_seconds = ttl_seconds or CACHE_TTL_SECONDS
        self.failure_cooldown_seconds = max(0.0, float(failure_cooldown_seconds))
        self.singleflight_wait_ms = max(1, int(singleflight_wait_ms or DEFAULT_SINGLEFLIGHT_WAIT_MS))
        self.singleflight_lock_seconds = max(
            1,
            int(singleflight_lock_seconds or DEFAULT_SINGLEFLIGHT_LOCK_SECONDS),
        )
        self._redis_unavailable_until = 0.0
        if redis_client is not None:
            self.redis = redis_client
        else:
            from redis import Redis
            from config import settings

            self.redis = Redis.from_url(
                settings.cache_redis_url,
                decode_responses=True,
                socket_connect_timeout=0.2,
                socket_timeout=0.2,
                retry_on_timeout=False,
            )

    @staticmethod
    def _key(
        user_id: str,
        project_space_id: str | None,
        conversation_id: str | None,
        scope_fingerprint: str,
        normalized_query_value: str,
    ) -> str:
        dimensions = "\0".join((
            str(user_id or ""),
            str(project_space_id or ""),
            str(scope_fingerprint or ""),
            query_hash(normalize_query(normalized_query_value)),
        ))
        digest = hashlib.sha256(dimensions.encode("utf-8")).hexdigest()
        return f"chatllm:rag:exact:{digest}"

    @staticmethod
    def _expires_at_timestamp(entry: dict) -> float | None:
        value = entry.get("expires_at")
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, datetime):
            normalized = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
            return normalized.timestamp()
        if isinstance(value, str) and value.strip():
            try:
                normalized = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
                if normalized.tzinfo is None:
                    normalized = normalized.replace(tzinfo=timezone.utc)
                return normalized.timestamp()
            except ValueError:
                return None
        return None

    def _redis_available(self) -> bool:
        return time.monotonic() >= self._redis_unavailable_until

    def _mark_redis_failure(self) -> None:
        self._redis_unavailable_until = time.monotonic() + self.failure_cooldown_seconds
        record_cache_metric("redis_error")

    def _get(self, key: str) -> dict | None:
        if not self._redis_available():
            return None
        try:
            payload = self.redis.get(key)
            if not payload:
                return None
            entry = json.loads(payload)
            if not isinstance(entry, dict):
                self.redis.delete(key)
                return None
            expires_at = self._expires_at_timestamp(entry)
            if expires_at is None or expires_at <= time.time():
                self.redis.delete(key)
                return None
            self._redis_unavailable_until = 0.0
            return entry
        except Exception:
            self._mark_redis_failure()
            return None

    def _set(self, key: str, entry: dict | None) -> None:
        if not entry or not self._redis_available():
            return
        try:
            expires_at = self._expires_at_timestamp(entry)
            if expires_at is None:
                return
            remaining_ttl = int(expires_at - time.time())
            ttl_seconds = min(self.ttl_seconds, remaining_ttl)
            if ttl_seconds <= 0:
                self.redis.delete(key)
                return
            payload = json.dumps(entry, ensure_ascii=False, default=_json_default)
            self.redis.setex(key, ttl_seconds, payload)
            self._redis_unavailable_until = 0.0
        except Exception:
            self._mark_redis_failure()
            return

    def get_scope(self, user_id: str, project_space_id: str | None) -> dict:
        return self.backend.get_scope(user_id, project_space_id)

    def find_exact(
        self,
        user_id,
        project_space_id,
        conversation_id,
        scope_fingerprint,
        normalized_query_value,
    ):
        key = self._key(
            user_id,
            project_space_id,
            conversation_id,
            scope_fingerprint,
            normalized_query_value,
        )
        cached = self._get(key)
        if cached:
            cached["query_similarity"] = 1.0
            cached["l1_cache_hit"] = True
            cached["cache_layer"] = "redis"
            return cached

        entry = self.backend.find_exact(
            user_id,
            project_space_id,
            conversation_id,
            scope_fingerprint,
            normalized_query_value,
        )
        self._set(key, entry)
        if entry:
            entry["cache_layer"] = "postgres"
        return entry

    def find_similar(self, *args, **kwargs):
        return self.backend.find_similar(*args, **kwargs)

    def find_subquery(self, *args, **kwargs):
        return self.backend.find_subquery(*args, **kwargs)

    def find_conversation_evidence(self, *args, **kwargs):
        return self.backend.find_conversation_evidence(*args, **kwargs)

    def upsert_query_cache(
        self,
        user_id,
        project_space_id,
        conversation_id,
        normalized_query,
        original_query,
        scope_fingerprint,
        documents,
        quality,
    ) -> None:
        self.backend.upsert_query_cache(
            user_id,
            project_space_id,
            conversation_id,
            normalized_query,
            original_query,
            scope_fingerprint,
            documents,
            quality,
        )
        entry = self.backend.find_exact(
            user_id,
            project_space_id,
            conversation_id,
            scope_fingerprint,
            normalized_query,
        )
        self._set(
            self._key(
                user_id,
                project_space_id,
                conversation_id,
                scope_fingerprint,
                normalized_query,
            ),
            entry,
        )

    def upsert_subquery_cache(self, *args, **kwargs) -> None:
        self.backend.upsert_subquery_cache(*args, **kwargs)

    def upsert_conversation_evidence(self, *args, **kwargs) -> None:
        self.backend.upsert_conversation_evidence(*args, **kwargs)

    def record_hit(self, entry: dict) -> None:
        self.backend.record_hit(entry)

    @staticmethod
    def _lock_key(exact_key: str) -> str:
        return f"{exact_key}:fill-lock"

    def acquire_singleflight(
        self,
        user_id,
        project_space_id,
        scope_fingerprint,
        normalized_query_value,
    ) -> dict:
        exact_key = self._key(
            user_id,
            project_space_id,
            None,
            scope_fingerprint,
            normalized_query_value,
        )
        if not self._redis_available():
            return {"role": "bypass", "reason": "redis_cooldown"}

        lock_key = self._lock_key(exact_key)
        token = str(uuid.uuid4())
        try:
            acquired = bool(self.redis.set(
                lock_key,
                token,
                nx=True,
                ex=self.singleflight_lock_seconds,
            ))
            self._redis_unavailable_until = 0.0
        except Exception:
            self._mark_redis_failure()
            return {"role": "bypass", "reason": "redis_unavailable"}

        if acquired:
            return {
                "role": "leader",
                "key": exact_key,
                "lock_key": lock_key,
                "token": token,
                "wait_ms": self.singleflight_wait_ms,
            }
        return {
            "role": "waiter",
            "key": exact_key,
            "lock_key": lock_key,
            "wait_ms": self.singleflight_wait_ms,
        }

    def wait_for_singleflight(
        self,
        user_id,
        project_space_id,
        scope_fingerprint,
        normalized_query_value,
        wait_ms=None,
    ):
        exact_key = self._key(
            user_id,
            project_space_id,
            None,
            scope_fingerprint,
            normalized_query_value,
        )
        lock_key = self._lock_key(exact_key)
        deadline = time.monotonic() + max(0, int(wait_ms or self.singleflight_wait_ms)) / 1000
        while time.monotonic() < deadline and self._redis_available():
            cached = self._get(exact_key)
            if cached:
                cached["query_similarity"] = 1.0
                cached["l1_cache_hit"] = True
                cached["cache_layer"] = "redis"
                return cached
            try:
                if not self.redis.exists(lock_key):
                    break
            except Exception:
                self._mark_redis_failure()
                break
            time.sleep(min(0.025, max(0.0, deadline - time.monotonic())))

        entry = self.backend.find_exact(
            user_id,
            project_space_id,
            None,
            scope_fingerprint,
            normalized_query_value,
        )
        self._set(exact_key, entry)
        return entry

    def release_singleflight(self, lease: dict) -> None:
        lock_key = str((lease or {}).get("lock_key") or "")
        token = str((lease or {}).get("token") or "")
        if not lock_key or not token or not self._redis_available():
            return
        try:
            self.redis.eval(
                """
                if redis.call('get', KEYS[1]) == ARGV[1] then
                  return redis.call('del', KEYS[1])
                end
                return 0
                """,
                1,
                lock_key,
                token,
            )
            self._redis_unavailable_until = 0.0
        except Exception:
            self._mark_redis_failure()


def check_cache_redis_ready() -> str:
    """Probe the optional disposable L1 without changing core RAG readiness."""
    from config import settings

    if not settings.redis_cache_enabled:
        return "disabled"

    from redis import Redis

    client = Redis.from_url(
        settings.cache_redis_url,
        decode_responses=True,
        socket_connect_timeout=0.5,
        socket_timeout=0.5,
        retry_on_timeout=False,
    )
    try:
        client.ping()
        return "ok"
    finally:
        client.close()


_default_cache: RetrievalCacheStore | None = None


def get_default_retrieval_cache() -> RetrievalCacheStore:
    global _default_cache
    if _default_cache is None:
        from config import settings

        backend = PostgresRetrievalCache(ttl_seconds=settings.redis_cache_ttl_seconds)
        _default_cache = (
            RedisL1RetrievalCache(
                backend=backend,
                ttl_seconds=settings.redis_cache_ttl_seconds,
                singleflight_wait_ms=settings.redis_cache_singleflight_wait_ms,
                singleflight_lock_seconds=settings.redis_cache_singleflight_lock_seconds,
            )
            if settings.redis_cache_enabled
            else backend
        )
    return _default_cache
