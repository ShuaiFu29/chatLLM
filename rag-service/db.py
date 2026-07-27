import hashlib
import json
import re
from contextlib import contextmanager
from queue import Empty, LifoQueue
from threading import Lock
from typing import Iterable

import psycopg
from psycopg.rows import dict_row
from config import settings


LEGACY_CHUNK_STRATEGY_VERSION = "markdown-v1:chunk1000-overlap100"
CHUNK_STRATEGY_VERSION = "markdown-v4:parent-child:metadata-embedding:chunk1000-overlap100"
MIXED_CHUNK_STRATEGY_VERSION = "markdown-mixed:v1-v4-reindex-required"


class IngestionLeaseLostError(RuntimeError):
    """Raised when an ingestion worker no longer owns the current attempt."""


class EvalLeaseLostError(RuntimeError):
    """Raised when an evaluation worker no longer owns the current run."""


class _ConnectionPool:
    def __init__(self, max_size: int, timeout_ms: int):
        self.max_size = max_size
        self.timeout_seconds = timeout_ms / 1000
        self._idle: LifoQueue = LifoQueue(maxsize=max_size)
        self._lock = Lock()
        self._created = 0

    def _create_connection(self):
        connect_timeout = max(1, int((settings.rag_db_pool_timeout_ms + 999) / 1000))
        return psycopg.connect(
            settings.database_url,
            row_factory=dict_row,
            connect_timeout=connect_timeout,
        )

    def acquire(self):
        try:
            conn = self._idle.get_nowait()
            if not getattr(conn, "closed", False):
                return conn
            with self._lock:
                self._created = max(0, self._created - 1)
        except Empty:
            pass

        with self._lock:
            if self._created < self.max_size:
                self._created += 1
                should_create = True
            else:
                should_create = False

        if should_create:
            try:
                return self._create_connection()
            except Exception:
                with self._lock:
                    self._created = max(0, self._created - 1)
                raise

        try:
            conn = self._idle.get(timeout=self.timeout_seconds)
        except Empty as exc:
            raise TimeoutError("Timed out waiting for a RAG database connection") from exc

        if getattr(conn, "closed", False):
            with self._lock:
                self._created = max(0, self._created - 1)
            return self.acquire()
        return conn

    def release(self, conn):
        if getattr(conn, "closed", False):
            with self._lock:
                self._created = max(0, self._created - 1)
            return

        try:
            self._idle.put_nowait(conn)
        except Exception:
            conn.close()
            with self._lock:
                self._created = max(0, self._created - 1)


_connection_pool = _ConnectionPool(
    max_size=settings.rag_db_pool_max,
    timeout_ms=settings.rag_db_pool_timeout_ms,
)


@contextmanager
def get_conn():
    conn = _connection_pool.acquire()
    try:
        yield conn
        conn.rollback()
    except Exception:
        conn.rollback()
        raise
    finally:
        _connection_pool.release(conn)


def check_database_ready() -> bool:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("select 1")
            cur.fetchone()
            cur.execute(
                """
                select
                  to_regclass('public.project_spaces') is not null as has_project_spaces,
                  exists (
                    select 1
                    from information_schema.columns
                    where table_schema = 'public'
                      and table_name = 'project_spaces'
                      and column_name = 'knowledge_version'
                  ) as has_knowledge_version,
                  to_regclass('public.rag_index_versions') is not null as has_rag_index_versions,
                  to_regclass('public.rag_retrieval_cache') is not null as has_rag_retrieval_cache,
                  to_regclass('public.file_ingestion_jobs') is not null as has_file_ingestion_jobs,
                  exists (
                    select 1
                    from information_schema.columns
                    where table_schema = 'public'
                      and table_name = 'file_ingestion_jobs'
                      and column_name = 'attempt_id'
                  ) as has_ingestion_attempt_id,
                  exists (
                    select 1
                    from information_schema.columns
                    where table_schema = 'public'
                      and table_name = 'file_ingestion_jobs'
                      and column_name = 'lease_token'
                  ) as has_ingestion_lease_token,
                  exists (
                    select 1
                    from information_schema.columns
                    where table_schema = 'public'
                      and table_name = 'file_ingestion_jobs'
                      and column_name = 'lease_expires_at'
                  ) as has_ingestion_lease_expiry,
                  to_regclass('public.rag_eval_runs') is not null as has_rag_eval_runs,
                  exists (
                    select 1
                    from information_schema.columns
                    where table_schema = 'public'
                      and table_name = 'rag_eval_runs'
                      and column_name = 'lease_token'
                  ) as has_eval_lease_token,
                  exists (
                    select 1
                    from information_schema.columns
                    where table_schema = 'public'
                      and table_name = 'rag_eval_runs'
                      and column_name = 'lease_expires_at'
                  ) as has_eval_lease_expiry,
                  exists (
                    select 1
                    from information_schema.columns
                    where table_schema = 'public'
                      and table_name = 'rag_eval_runs'
                      and column_name = 'deadline_at'
                  ) as has_eval_deadline
                """
            )
            schema = cur.fetchone() or {}
            missing = [
                label
                for label, ok in {
                    "project_spaces": schema.get("has_project_spaces"),
                    "project_spaces.knowledge_version": schema.get("has_knowledge_version"),
                    "rag_index_versions": schema.get("has_rag_index_versions"),
                    "rag_retrieval_cache": schema.get("has_rag_retrieval_cache"),
                    "file_ingestion_jobs": schema.get("has_file_ingestion_jobs"),
                    "file_ingestion_jobs.attempt_id": schema.get("has_ingestion_attempt_id"),
                    "file_ingestion_jobs.lease_token": schema.get("has_ingestion_lease_token"),
                    "file_ingestion_jobs.lease_expires_at": schema.get("has_ingestion_lease_expiry"),
                    "rag_eval_runs": schema.get("has_rag_eval_runs"),
                    "rag_eval_runs.lease_token": schema.get("has_eval_lease_token"),
                    "rag_eval_runs.lease_expires_at": schema.get("has_eval_lease_expiry"),
                    "rag_eval_runs.deadline_at": schema.get("has_eval_deadline"),
                }.items()
                if not ok
            ]
            if missing:
                raise RuntimeError(f"RAG database schema is not migrated: {', '.join(missing)}")
    return True


def get_markdown_index_status() -> dict:
    """Return an aggregate, read-only view of indexed Markdown strategy age."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                with markdown_chunks as (
                  select
                    files.id as file_id,
                    coalesce(file_chunks.metadata->>'chunk_strategy_version', '') <> %s as stale
                  from files
                  join file_chunks on file_chunks.file_id = files.id
                  where files.status = 'completed'
                    and (
                      lower(files.filename) like '%%.md'
                      or lower(files.filename) like '%%.markdown'
                    )
                )
                select
                  count(distinct file_id)::bigint as indexed_file_count,
                  count(distinct file_id) filter (where stale)::bigint as stale_file_count,
                  count(*) filter (where stale)::bigint as stale_chunk_count
                from markdown_chunks
                """,
                (CHUNK_STRATEGY_VERSION,),
            )
            row = cur.fetchone() or {}

    stale_file_count = int(row.get("stale_file_count") or 0)
    return {
        "status": "degraded" if stale_file_count else "ok",
        "current_chunk_strategy_version": CHUNK_STRATEGY_VERSION,
        "indexed_file_count": int(row.get("indexed_file_count") or 0),
        "stale_file_count": stale_file_count,
        "stale_chunk_count": int(row.get("stale_chunk_count") or 0),
        "reindex_required": stale_file_count > 0,
    }


def _index_settings_fingerprint(chunk_strategy_version: str = CHUNK_STRATEGY_VERSION) -> str:
    payload = {
        "embedding_model": settings.embedding_model,
        "embedding_dimension": settings.embedding_dimension,
        "milvus_collection": settings.milvus_collection,
        "milvus_index_type": settings.milvus_index_type,
        "milvus_metric_type": settings.milvus_metric_type,
        "elasticsearch_enabled": settings.elasticsearch_enabled,
        "elasticsearch_index": settings.elasticsearch_index,
        "elasticsearch_schema_version": settings.elasticsearch_schema_version,
        "neo4j_enabled": settings.neo4j_enabled,
        "graph_extraction_enabled": settings.graph_extraction_enabled,
        "graph_extraction_base_url": settings.graph_extraction_base_url,
        "graph_extraction_model": settings.graph_extraction_model,
        "graph_extractor_version": settings.graph_extractor_version,
        "graph_ontology_version": settings.graph_ontology_version,
        "chunk_strategy_version": chunk_strategy_version,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _ensure_rag_index_version(cur, user_id: str, project_space_id: str, knowledge_version: int):
    cur.execute(
        """
        select
          vector_version,
          bm25_version,
          graph_version,
          chunk_strategy_version,
          embedding_model,
          embedding_dimension,
          settings_fingerprint
        from rag_index_versions
        where user_id::text = %s and project_space_id::text = %s
        """,
        (user_id, project_space_id),
    )
    existing = cur.fetchone()
    if existing:
        cur.execute(
            """
            update rag_index_versions
            set knowledge_version = %s,
                updated_at = case when knowledge_version <> %s then now() else updated_at end
            where user_id::text = %s and project_space_id::text = %s
            """,
            (knowledge_version, knowledge_version, user_id, project_space_id),
        )
        return existing

    # A project may predate rag_index_versions. Do not label its existing
    # chunks as the current strategy until a real reingestion has rebuilt every backing index.
    cur.execute(
        """
        select exists (
          select 1
          from file_chunks
          join files on files.id = file_chunks.file_id
          where files.user_id::text = %s
            and files.project_space_id::text = %s
          limit 1
        ) as has_existing_chunks
        """,
        (user_id, project_space_id),
    )
    has_existing_chunks = bool((cur.fetchone() or {}).get("has_existing_chunks"))
    initial_chunk_strategy = (
        LEGACY_CHUNK_STRATEGY_VERSION if has_existing_chunks else CHUNK_STRATEGY_VERSION
    )
    cur.execute(
        """
        insert into rag_index_versions (
          user_id,
          project_space_id,
          knowledge_version,
          chunk_strategy_version,
          embedding_model,
          embedding_dimension,
          settings_fingerprint
        )
        values (%s, %s, %s, %s, %s, %s, %s)
        on conflict (user_id, project_space_id) do update set
          knowledge_version = excluded.knowledge_version
        returning
          vector_version,
          bm25_version,
          graph_version,
          chunk_strategy_version,
          embedding_model,
          embedding_dimension,
          settings_fingerprint
        """,
        (
            user_id,
            project_space_id,
            knowledge_version,
            initial_chunk_strategy,
            settings.embedding_model,
            settings.embedding_dimension,
            _index_settings_fingerprint(initial_chunk_strategy),
        ),
    )
    return cur.fetchone()


def get_retrieval_scope(user_id: str, project_space_id: str | None = None) -> dict:
    with get_conn() as conn:
        with conn.cursor() as cur:
            if project_space_id:
                cur.execute(
                    """
                    select id, user_id, knowledge_version
                    from project_spaces
                    where id::text = %s and user_id::text = %s
                    """,
                    (project_space_id, user_id),
                )
                space = cur.fetchone()
                if not space:
                    return {
                        "user_id": user_id,
                        "project_space_id": project_space_id,
                        "knowledge_version": 1,
                        "vector_version": 1,
                        "bm25_version": 1,
                        "graph_version": 1,
                        "chunk_strategy_version": CHUNK_STRATEGY_VERSION,
                        "embedding_model": settings.embedding_model,
                        "embedding_dimension": settings.embedding_dimension,
                        "settings_fingerprint": _index_settings_fingerprint(),
                    }

                knowledge_version = int(space.get("knowledge_version") or 1)
                index_version = _ensure_rag_index_version(cur, user_id, project_space_id, knowledge_version)
                conn.commit()
                return {
                    "user_id": user_id,
                    "project_space_id": project_space_id,
                    "knowledge_version": knowledge_version,
                    "vector_version": int((index_version or {}).get("vector_version") or 1),
                    "bm25_version": int((index_version or {}).get("bm25_version") or 1),
                    "graph_version": int((index_version or {}).get("graph_version") or 1),
                    "chunk_strategy_version": str((index_version or {}).get("chunk_strategy_version") or CHUNK_STRATEGY_VERSION),
                    "embedding_model": str((index_version or {}).get("embedding_model") or settings.embedding_model),
                    "embedding_dimension": int((index_version or {}).get("embedding_dimension") or settings.embedding_dimension),
                    "settings_fingerprint": str((index_version or {}).get("settings_fingerprint") or _index_settings_fingerprint()),
                }

            cur.execute(
                """
                select id::text as project_space_id, knowledge_version
                from project_spaces
                where user_id::text = %s
                order by id::text
                """,
                (user_id,),
            )
            project_versions = []
            for row in (cur.fetchall() or []):
                project_space_id = str(row["project_space_id"])
                knowledge_version = int(row.get("knowledge_version") or 1)
                index_version = _ensure_rag_index_version(
                    cur,
                    user_id,
                    project_space_id,
                    knowledge_version,
                ) or {}
                project_versions.append({
                    "project_space_id": project_space_id,
                    "knowledge_version": knowledge_version,
                    "vector_version": int(index_version.get("vector_version") or 1),
                    "bm25_version": int(index_version.get("bm25_version") or 1),
                    "graph_version": int(index_version.get("graph_version") or 1),
                    "chunk_strategy_version": str(index_version.get("chunk_strategy_version") or CHUNK_STRATEGY_VERSION),
                    "embedding_model": str(index_version.get("embedding_model") or settings.embedding_model),
                    "embedding_dimension": int(index_version.get("embedding_dimension") or settings.embedding_dimension),
                    "settings_fingerprint": str(index_version.get("settings_fingerprint") or _index_settings_fingerprint()),
                })
            conn.commit()
            return {
                "user_id": user_id,
                "project_space_id": None,
                "knowledge_version": max(
                    [item["knowledge_version"] for item in project_versions] or [1]
                ),
                "project_versions": project_versions,
                "vector_version": 1,
                "bm25_version": 1,
                "graph_version": 1,
                "chunk_strategy_version": CHUNK_STRATEGY_VERSION,
                "embedding_model": settings.embedding_model,
                "embedding_dimension": settings.embedding_dimension,
                "settings_fingerprint": _index_settings_fingerprint(),
            }


def bump_project_knowledge_version(user_id: str, project_space_id: str | None, reason: str) -> dict | None:
    if not project_space_id:
        return None

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update project_spaces
                set knowledge_version = knowledge_version + 1,
                    knowledge_version_updated_at = now(),
                    updated_at = now()
                where id::text = %s and user_id::text = %s
                returning id, user_id, knowledge_version
                """,
                (project_space_id, user_id),
            )
            space = cur.fetchone()
            if not space:
                conn.commit()
                return None

            knowledge_version = int(space.get("knowledge_version") or 1)
            cur.execute(
                """
                select exists (
                  select 1
                  from file_chunks
                  join files on files.id = file_chunks.file_id
                  where files.user_id::text = %s
                    and files.project_space_id::text = %s
                    and coalesce(file_chunks.metadata->>'chunk_strategy_version', '') <> %s
                  limit 1
                ) as has_legacy_chunks
                """,
                (user_id, project_space_id, CHUNK_STRATEGY_VERSION),
            )
            effective_chunk_strategy = (
                MIXED_CHUNK_STRATEGY_VERSION
                if bool((cur.fetchone() or {}).get("has_legacy_chunks"))
                else CHUNK_STRATEGY_VERSION
            )
            cur.execute(
                """
                insert into rag_index_versions (
                  user_id,
                  project_space_id,
                  knowledge_version,
                  vector_version,
                  bm25_version,
                  graph_version,
                  chunk_strategy_version,
                  embedding_model,
                  embedding_dimension,
                  settings_fingerprint
                )
                values (%s, %s, %s, 2, 2, 2, %s, %s, %s, %s)
                on conflict (user_id, project_space_id) do update set
                  knowledge_version = excluded.knowledge_version,
                  vector_version = rag_index_versions.vector_version + 1,
                  bm25_version = rag_index_versions.bm25_version + 1,
                  graph_version = rag_index_versions.graph_version + 1,
                  chunk_strategy_version = excluded.chunk_strategy_version,
                  embedding_model = excluded.embedding_model,
                  embedding_dimension = excluded.embedding_dimension,
                  settings_fingerprint = excluded.settings_fingerprint,
                  updated_at = now()
                returning vector_version, bm25_version, graph_version
                """,
                (
                    user_id,
                    project_space_id,
                    knowledge_version,
                    effective_chunk_strategy,
                    settings.embedding_model,
                    settings.embedding_dimension,
                    _index_settings_fingerprint(effective_chunk_strategy),
                ),
            )
            index_version = cur.fetchone() or {}
            cur.execute(
                """
                delete from rag_retrieval_cache
                where user_id::text = %s
                  and project_space_id::text = %s
                """,
                (user_id, project_space_id),
            )
        conn.commit()

    return {
        "reason": reason,
        "user_id": user_id,
        "project_space_id": project_space_id,
        "knowledge_version": knowledge_version,
        "vector_version": int(index_version.get("vector_version") or 1),
        "bm25_version": int(index_version.get("bm25_version") or 1),
        "graph_version": int(index_version.get("graph_version") or 1),
    }


def get_file(file_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select id, user_id, filename, file_hash, file_size, file_type,
                       object_key, project_space_id, status, progress, error_message, created_at, updated_at
                from files
                where id = %s
                """,
                (file_id,),
            )
            return cur.fetchone()


def _require_ingestion_update(cur, file_id: str, attempt_id, lease_token):
    if cur.rowcount == 0:
        raise IngestionLeaseLostError(
            f"Ingestion lease is no longer active for file {file_id}, attempt {attempt_id}"
        )


def assert_ingestion_lease(file_id: str, attempt_id, lease_token):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select 1
                from file_ingestion_jobs
                where file_id = %s
                  and attempt_id = %s
                  and lease_token = %s
                  and status = 'processing'
                  and lease_expires_at > now()
                """,
                (file_id, attempt_id, lease_token),
            )
            if not cur.fetchone():
                raise IngestionLeaseLostError(
                    f"Ingestion lease is no longer active for file {file_id}, attempt {attempt_id}"
                )


def assert_eval_lease_active(run_id, lease_token):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select 1
                from rag_eval_runs
                where id = %s
                  and lease_token = %s
                  and status = 'running'
                  and lease_expires_at > now()
                  and deadline_at > now()
                """,
                (run_id, lease_token),
            )
            if not cur.fetchone():
                raise EvalLeaseLostError(
                    f"Evaluation lease is no longer active for run {run_id}"
                )


def start_ingestion_job(
    file_data: dict,
    attempt_id,
    lease_token,
    stage: str = "validating_uploaded_object",
    checkpoint: dict | None = None,
):
    file_id = str(file_data["id"])

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update file_ingestion_jobs
                set stage = %s,
                    progress = 0,
                    checkpoint = %s::jsonb,
                    error_message = null,
                    heartbeat_at = now(),
                    updated_at = now()
                where file_id = %s
                  and attempt_id = %s
                  and lease_token = %s
                  and status = 'processing'
                  and lease_expires_at > now()
                """,
                (
                    stage,
                    json.dumps(checkpoint or {}),
                    file_id,
                    attempt_id,
                    lease_token,
                ),
            )
            _require_ingestion_update(cur, file_id, attempt_id, lease_token)
        conn.commit()


def update_ingestion_job_checkpoint(
    file_id: str,
    attempt_id,
    lease_token,
    *,
    stage: str,
    progress: int | None = None,
    total_chunks: int | None = None,
    indexed_chunks: int | None = None,
    keyword_batches: int | None = None,
    graph_batches: int | None = None,
    vector_batches: int | None = None,
    checkpoint: dict | None = None,
    error_message: str | None = None,
):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update file_ingestion_jobs
                set status = 'processing',
                    stage = %s,
                    progress = coalesce(%s, progress),
                    total_chunks = coalesce(%s, total_chunks),
                    indexed_chunks = coalesce(%s, indexed_chunks),
                    keyword_batches = coalesce(%s, keyword_batches),
                    graph_batches = coalesce(%s, graph_batches),
                    vector_batches = coalesce(%s, vector_batches),
                    checkpoint = coalesce(%s::jsonb, checkpoint),
                    error_message = %s,
                    heartbeat_at = now(),
                    updated_at = now()
                where file_id = %s
                  and attempt_id = %s
                  and lease_token = %s
                  and status = 'processing'
                  and lease_expires_at > now()
                """,
                (
                    stage,
                    progress,
                    total_chunks,
                    indexed_chunks,
                    keyword_batches,
                    graph_batches,
                    vector_batches,
                    json.dumps(checkpoint) if checkpoint is not None else None,
                    error_message,
                    file_id,
                    attempt_id,
                    lease_token,
                ),
            )
            _require_ingestion_update(cur, file_id, attempt_id, lease_token)
        conn.commit()


def complete_ingestion_job(
    file_id: str,
    attempt_id,
    lease_token,
    *,
    stage: str = "completed",
    total_chunks: int,
    indexed_chunks: int,
    keyword_batches: int = 0,
    graph_batches: int = 0,
    vector_batches: int = 0,
    checkpoint: dict | None = None,
):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update file_ingestion_jobs
                set status = 'completed',
                    stage = %s,
                    progress = 100,
                    total_chunks = %s,
                    indexed_chunks = %s,
                    keyword_batches = %s,
                    graph_batches = %s,
                    vector_batches = %s,
                    checkpoint = coalesce(%s::jsonb, checkpoint),
                    error_message = null,
                    completed_at = now(),
                    heartbeat_at = now(),
                    lease_expires_at = now(),
                    updated_at = now()
                where file_id = %s
                  and attempt_id = %s
                  and lease_token = %s
                  and status = 'processing'
                  and lease_expires_at > now()
                """,
                (
                    stage,
                    total_chunks,
                    indexed_chunks,
                    keyword_batches,
                    graph_batches,
                    vector_batches,
                    json.dumps(checkpoint) if checkpoint is not None else None,
                    file_id,
                    attempt_id,
                    lease_token,
                ),
            )
            _require_ingestion_update(cur, file_id, attempt_id, lease_token)
        conn.commit()


def fail_ingestion_job(
    file_id: str,
    attempt_id,
    lease_token,
    error_message: str,
    checkpoint: dict | None = None,
):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update file_ingestion_jobs
                set status = 'failed',
                    stage = 'failed',
                    progress = 0,
                    checkpoint = coalesce(%s::jsonb, checkpoint),
                    error_message = %s,
                    completed_at = now(),
                    heartbeat_at = now(),
                    lease_expires_at = now(),
                    updated_at = now()
                where file_id = %s
                  and attempt_id = %s
                  and lease_token = %s
                  and status = 'processing'
                  and lease_expires_at > now()
                """,
                (
                    json.dumps(checkpoint) if checkpoint is not None else None,
                    error_message,
                    file_id,
                    attempt_id,
                    lease_token,
                ),
            )
            _require_ingestion_update(cur, file_id, attempt_id, lease_token)
        conn.commit()


def delete_file_chunks(file_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("delete from file_chunks where file_id = %s", (file_id,))
        conn.commit()


def _chunk_heading_path(content: str) -> list[str]:
    headings: list[str] = []
    for line in str(content or "").splitlines():
        if not line.strip():
            if headings:
                break
            continue
        match = re.match(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if not match:
            break
        level = len(match.group(1))
        title = match.group(2).strip()
        while len(headings) >= level:
            headings.pop()
        while len(headings) < level - 1:
            headings.append("")
        headings.append(title)
    return [heading for heading in headings if heading]


def _build_chunk_metadata(
    file_id: str,
    user_id: str,
    chunk_index: int,
    file_data: dict,
    content: str,
) -> dict:
    heading_path = _chunk_heading_path(content)
    parent_identity = "\0".join((file_id, *heading_path)) if heading_path else f"{file_id}\0__root__"
    return {
        "filename": file_data["filename"],
        "file_type": file_data.get("file_type"),
        "user_id": user_id,
        "project_space_id": str(file_data.get("project_space_id")) if file_data.get("project_space_id") else None,
        "source_file_id": file_id,
        "file_id": file_id,
        "chunk_index": chunk_index,
        "chunk_strategy_version": CHUNK_STRATEGY_VERSION,
        "heading_path": heading_path,
        "heading_depth": len(heading_path),
        "parent_section_id": hashlib.sha256(parent_identity.encode("utf-8")).hexdigest()[:24],
    }


def insert_file_chunk_batch(
    file_id: str,
    user_id: str,
    start_index: int,
    chunks: list[str],
    file_data: dict,
) -> list[dict]:
    if not chunks:
        return []

    with get_conn() as conn:
        with conn.cursor() as cur:
            inserted: list[dict] = []
            for offset, chunk in enumerate(chunks):
                chunk_index = start_index + offset
                metadata = _build_chunk_metadata(file_id, user_id, chunk_index, file_data, chunk)
                cur.execute(
                    """
                    insert into file_chunks (file_id, user_id, chunk_index, content, metadata)
                    values (%s, %s, %s, %s, %s)
                    returning id, file_id, user_id, chunk_index, content, metadata
                    """,
                    (file_id, user_id, chunk_index, chunk, json.dumps(metadata)),
                )
                inserted.append(cur.fetchone())
        conn.commit()
        return inserted


def replace_file_chunks(file_id: str, user_id: str, chunks: list[str], file_data: dict) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("delete from file_chunks where file_id = %s", (file_id,))

            inserted: list[dict] = []
            for index, chunk in enumerate(chunks):
                metadata = _build_chunk_metadata(file_id, user_id, index, file_data, chunk)
                cur.execute(
                    """
                    insert into file_chunks (file_id, user_id, chunk_index, content, metadata)
                    values (%s, %s, %s, %s, %s)
                    returning id, file_id, user_id, chunk_index, content, metadata
                    """,
                    (file_id, user_id, index, chunk, json.dumps(metadata)),
                )
                inserted.append(cur.fetchone())

        conn.commit()
        return inserted


def get_chunks_by_ids(chunk_ids: Iterable[str]) -> list[dict]:
    ids = list(chunk_ids)
    if not ids:
        return []

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select id, file_id, user_id, chunk_index, content, metadata, project_space_id
                from (
                    select
                        file_chunks.id,
                        file_chunks.file_id,
                        file_chunks.user_id,
                        file_chunks.chunk_index,
                        file_chunks.content,
                        file_chunks.metadata,
                        files.project_space_id
                    from file_chunks
                    join files on files.id = file_chunks.file_id
                    where file_chunks.id = any(%s::uuid[])
                ) chunks
                """,
                (ids,),
            )
            rows = cur.fetchall()

    by_id = {str(row["id"]): row for row in rows}
    return [by_id[str(chunk_id)] for chunk_id in ids if str(chunk_id) in by_id]


def list_parent_chunks_for_matches(
    user_id: str,
    project_space_id: str | None,
    matches: Iterable[dict],
    max_parents: int = 8,
    max_chunks_per_parent: int = 6,
) -> list[dict]:
    """Load bounded Markdown parent sections for already-authorized child hits."""
    requested: list[tuple[str, str, int]] = []
    requested_parents: set[tuple[str, str]] = set()
    for document in matches:
        metadata = document.get("metadata") or {}
        file_id = str(metadata.get("file_id") or document.get("file_id") or "").strip()
        parent_section_id = str(metadata.get("parent_section_id") or "").strip()
        parent_key = (file_id, parent_section_id)
        if not all(parent_key) or parent_key in requested_parents:
            continue
        try:
            matched_chunk_index = int(metadata.get("chunk_index", document.get("chunk_index", 0)) or 0)
        except (TypeError, ValueError):
            matched_chunk_index = 0
        requested_parents.add(parent_key)
        requested.append((file_id, parent_section_id, matched_chunk_index))
        if len(requested) >= max(1, max_parents):
            break
    if not requested:
        return []

    file_ids = [file_id for file_id, _, _ in requested]
    parent_ids = [parent_id for _, parent_id, _ in requested]
    matched_indices = [chunk_index for _, _, chunk_index in requested]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                with requested(file_id, parent_section_id, matched_chunk_index, request_rank) as (
                  select *
                  from unnest(%s::uuid[], %s::text[], %s::integer[]) with ordinality
                ), ranked as (
                  select
                    file_chunks.id,
                    file_chunks.file_id,
                    file_chunks.user_id,
                    file_chunks.chunk_index,
                    file_chunks.content,
                    file_chunks.metadata,
                    files.project_space_id,
                    files.filename,
                    requested.parent_section_id,
                    requested.matched_chunk_index,
                    requested.request_rank,
                    row_number() over (
                      partition by requested.file_id, requested.parent_section_id
                      order by
                        abs(file_chunks.chunk_index - requested.matched_chunk_index) asc,
                        file_chunks.chunk_index asc
                    ) as parent_chunk_rank
                  from requested
                  join file_chunks
                    on file_chunks.file_id = requested.file_id
                   and file_chunks.metadata->>'parent_section_id' = requested.parent_section_id
                  join files on files.id = file_chunks.file_id
                  where file_chunks.user_id::text = %s
                    and (%s::text is null or files.project_space_id::text = %s)
                )
                select *
                from ranked
                where parent_chunk_rank <= %s
                order by request_rank asc, chunk_index asc
                """,
                (
                    file_ids,
                    parent_ids,
                    matched_indices,
                    user_id,
                    project_space_id,
                    project_space_id,
                    max(1, max_chunks_per_parent),
                ),
            )
            return cur.fetchall()


def search_chunks_by_text(query: str, user_id: str, project_space_id: str | None = None, limit: int = 20) -> list[dict]:
    if not query.strip():
        return []

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select
                  file_chunks.id,
                  file_chunks.file_id,
                  file_chunks.user_id,
                  file_chunks.chunk_index,
                  file_chunks.content,
                  file_chunks.metadata,
                  files.project_space_id,
                  files.filename,
                  ts_rank_cd(
                    to_tsvector('simple', file_chunks.content),
                    websearch_to_tsquery('simple', %s)
                  ) as lexical_score
                from file_chunks
                join files on files.id = file_chunks.file_id
                where file_chunks.user_id::text = %s
                  and (%s::text is null or files.project_space_id::text = %s)
                  and to_tsvector('simple', file_chunks.content) @@ websearch_to_tsquery('simple', %s)
                order by lexical_score desc, file_chunks.created_at desc
                limit %s
                """,
                (query, user_id, project_space_id, project_space_id, query, limit),
            )
            return cur.fetchall()


def list_files_for_inventory(user_id: str, project_space_id: str | None = None, limit: int = 50) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select id, user_id, project_space_id, filename, file_size, file_type,
                       status, progress, created_at, updated_at
                from files
                where user_id::text = %s
                  and (%s::text is null or project_space_id::text = %s)
                order by created_at desc
                limit %s
                """,
                (user_id, project_space_id, project_space_id, limit),
            )
            return cur.fetchall()


def count_files_for_inventory(user_id: str, project_space_id: str | None = None) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select count(*)::bigint as total
                from files
                where user_id::text = %s
                  and (%s::text is null or project_space_id::text = %s)
                """,
                (user_id, project_space_id, project_space_id),
            )
            row = cur.fetchone() or {}
            return int(row.get("total") or 0)
