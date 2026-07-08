import hashlib
import json
import re
import time
from typing import Any, Protocol


CACHE_TTL_SECONDS = 6 * 60 * 60
SIMILAR_QUERY_THRESHOLD = 0.55
CONVERSATION_EVIDENCE_THRESHOLD = 0.42
MIN_REUSE_OVERALL_SCORE = 0.38

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
    stable_scope = {
        "user_id": str(scope.get("user_id") or ""),
        "project_space_id": str(scope.get("project_space_id") or ""),
        "knowledge_version": int(scope.get("knowledge_version") or 1),
        "vector_version": int(scope.get("vector_version") or 1),
        "bm25_version": int(scope.get("bm25_version") or 1),
        "graph_version": int(scope.get("graph_version") or 1),
        "chunk_strategy_version": str(scope.get("chunk_strategy_version") or ""),
        "embedding_model": str(scope.get("embedding_model") or ""),
        "embedding_dimension": int(scope.get("embedding_dimension") or 0),
        "settings_fingerprint": str(scope.get("settings_fingerprint") or ""),
    }
    payload = json.dumps(stable_scope, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
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

        self.entries = [
            existing for existing in self.entries
            if not (
                existing["cache_kind"] == cache_kind
                and existing["user_id"] == user_id
                and existing.get("project_space_id") == project_space_id
                and existing.get("conversation_id") == conversation_id
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
        if entry.get("conversation_id") != conversation_id:
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
        for entry in reversed(self.entries):
            if not self._matches_scope(entry, user_id, project_space_id, conversation_id, scope_fingerprint, "query"):
                continue
            similarity = query_similarity(normalized, entry["normalized_query"])
            if similarity >= min_similarity and (best is None or similarity > best[0]):
                best = (similarity, entry)
        return self._copy_entry(best[1], best[0]) if best else None

    def find_subquery(
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
        for entry in reversed(self.entries):
            if not self._matches_scope(entry, user_id, project_space_id, conversation_id, scope_fingerprint, "subquery"):
                continue
            similarity = query_similarity(normalized, entry["normalized_query"])
            if similarity >= min_similarity and (best is None or similarity > best[0]):
                best = (similarity, entry)
        return self._copy_entry(best[1], best[0]) if best else None

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
        return self._copy_entry(best[1], best[0]) if best else None

    def upsert_query_cache(self, *args, **kwargs) -> None:
        self._upsert("query", *args, **kwargs)

    def upsert_subquery_cache(self, *args, **kwargs) -> None:
        self._upsert("subquery", *args, **kwargs)

    def upsert_conversation_evidence(self, *args, **kwargs) -> None:
        self._upsert("conversation_evidence", *args, **kwargs)

    def record_hit(self, entry: dict) -> None:
        entry_id = entry.get("id")
        for stored_entry in self.entries:
            if stored_entry.get("id") == entry_id:
                stored_entry["hit_count"] = int(stored_entry.get("hit_count") or 0) + 1
                break


class PostgresRetrievalCache:
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
                            conversation_id,
                            conversation_id,
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
                        conversation_id,
                        conversation_id,
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
        return self._entry_from_row(best[1], best[0]) if best else None

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
            exact=False,
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
        with get_conn() as conn:
            with conn.cursor() as cur:
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
                        conversation_id,
                        conversation_id,
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
                        conversation_id,
                        cache_kind,
                        scope_fingerprint,
                        normalized,
                        original_query,
                        query_hash(normalized),
                        sorted(query_terms(normalized)),
                        json.dumps(documents, ensure_ascii=False, default=_json_default),
                        json.dumps(quality or {}, ensure_ascii=False, default=_json_default),
                        CACHE_TTL_SECONDS,
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


_default_cache: PostgresRetrievalCache | None = None


def get_default_retrieval_cache() -> PostgresRetrievalCache:
    global _default_cache
    if _default_cache is None:
        _default_cache = PostgresRetrievalCache()
    return _default_cache
