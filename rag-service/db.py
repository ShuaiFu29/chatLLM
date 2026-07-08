import hashlib
import json
from contextlib import contextmanager
from queue import Empty, LifoQueue
from threading import Lock
from typing import Iterable

import psycopg
from psycopg.rows import dict_row
from config import settings


CHUNK_STRATEGY_VERSION = "markdown-v1:chunk1000-overlap100"


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
                  to_regclass('public.file_ingestion_jobs') is not null as has_file_ingestion_jobs
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
                }.items()
                if not ok
            ]
            if missing:
                raise RuntimeError(f"RAG database schema is not migrated: {', '.join(missing)}")
    return True


def _index_settings_fingerprint() -> str:
    payload = {
        "embedding_model": settings.embedding_model,
        "embedding_dimension": settings.embedding_dimension,
        "milvus_collection": settings.milvus_collection,
        "milvus_index_type": settings.milvus_index_type,
        "milvus_metric_type": settings.milvus_metric_type,
        "elasticsearch_enabled": settings.elasticsearch_enabled,
        "elasticsearch_index": settings.elasticsearch_index,
        "neo4j_enabled": settings.neo4j_enabled,
        "chunk_strategy_version": CHUNK_STRATEGY_VERSION,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _ensure_rag_index_version(cur, user_id: str, project_space_id: str, knowledge_version: int):
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
          knowledge_version = excluded.knowledge_version,
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
            CHUNK_STRATEGY_VERSION,
            settings.embedding_model,
            settings.embedding_dimension,
            _index_settings_fingerprint(),
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
                    "chunk_strategy_version": CHUNK_STRATEGY_VERSION,
                    "embedding_model": settings.embedding_model,
                    "embedding_dimension": settings.embedding_dimension,
                    "settings_fingerprint": _index_settings_fingerprint(),
                }

            cur.execute(
                """
                select coalesce(max(knowledge_version), 1) as knowledge_version
                from project_spaces
                where user_id::text = %s
                """,
                (user_id,),
            )
            row = cur.fetchone() or {}
            return {
                "user_id": user_id,
                "project_space_id": None,
                "knowledge_version": int(row.get("knowledge_version") or 1),
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
                    CHUNK_STRATEGY_VERSION,
                    settings.embedding_model,
                    settings.embedding_dimension,
                    _index_settings_fingerprint(),
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


def update_file_status(file_id: str, status: str, progress: int | None = None, error_message: str | None = None):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update files
                set status = %s,
                    progress = coalesce(%s, progress),
                    error_message = %s,
                    updated_at = now()
                where id = %s
                """,
                (status, progress, error_message, file_id),
            )
        conn.commit()


def update_file_progress(file_id: str, progress: int):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "update files set progress = %s, updated_at = now() where id = %s",
                (progress, file_id),
            )
        conn.commit()


def start_ingestion_job(file_data: dict, stage: str = "validating_uploaded_object", checkpoint: dict | None = None):
    file_id = str(file_data["id"])
    user_id = str(file_data["user_id"])
    project_space_id = str(file_data.get("project_space_id")) if file_data.get("project_space_id") else None

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into file_ingestion_jobs (
                  file_id,
                  user_id,
                  project_space_id,
                  status,
                  stage,
                  progress,
                  checkpoint,
                  error_message,
                  started_at,
                  completed_at,
                  heartbeat_at
                )
                values (%s, %s, %s, 'processing', %s, 0, %s::jsonb, null, now(), null, now())
                on conflict (file_id) do update set
                  user_id = excluded.user_id,
                  project_space_id = excluded.project_space_id,
                  status = 'processing',
                  stage = excluded.stage,
                  progress = 0,
                  checkpoint = excluded.checkpoint,
                  error_message = null,
                  started_at = coalesce(file_ingestion_jobs.started_at, now()),
                  completed_at = null,
                  heartbeat_at = now(),
                  updated_at = now()
                """,
                (file_id, user_id, project_space_id, stage, json.dumps(checkpoint or {})),
            )
        conn.commit()


def update_ingestion_job_checkpoint(
    file_id: str,
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
                ),
            )
        conn.commit()


def complete_ingestion_job(
    file_id: str,
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
                    updated_at = now()
                where file_id = %s
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
                ),
            )
        conn.commit()


def fail_ingestion_job(file_id: str, error_message: str, checkpoint: dict | None = None):
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
                    updated_at = now()
                where file_id = %s
                """,
                (json.dumps(checkpoint) if checkpoint is not None else None, error_message, file_id),
            )
        conn.commit()


def delete_file_chunks(file_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("delete from file_chunks where file_id = %s", (file_id,))
        conn.commit()


def _build_chunk_metadata(file_id: str, user_id: str, chunk_index: int, file_data: dict) -> dict:
    return {
        "filename": file_data["filename"],
        "file_type": file_data.get("file_type"),
        "user_id": user_id,
        "project_space_id": str(file_data.get("project_space_id")) if file_data.get("project_space_id") else None,
        "source_file_id": file_id,
        "file_id": file_id,
        "chunk_index": chunk_index,
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
                metadata = _build_chunk_metadata(file_id, user_id, chunk_index, file_data)
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
                metadata = _build_chunk_metadata(file_id, user_id, index, file_data)
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
