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


class ConversionGenerationStateError(RuntimeError):
    """Raised when an immutable conversion generation cannot make the requested transition."""


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


def _bump_project_knowledge_version(
    cur,
    user_id: str,
    project_space_id: str | None,
    reason: str,
) -> dict | None:
    if not project_space_id:
        return None

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

    return {
        "reason": reason,
        "user_id": user_id,
        "project_space_id": project_space_id,
        "knowledge_version": knowledge_version,
        "vector_version": int(index_version.get("vector_version") or 1),
        "bm25_version": int(index_version.get("bm25_version") or 1),
        "graph_version": int(index_version.get("graph_version") or 1),
    }


def bump_project_knowledge_version(user_id: str, project_space_id: str | None, reason: str) -> dict | None:
    if not project_space_id:
        return None

    with get_conn() as conn:
        with conn.cursor() as cur:
            result = _bump_project_knowledge_version(cur, user_id, project_space_id, reason)
        conn.commit()
        return result


def get_file(file_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select
                  target_file.id,
                  target_file.user_id,
                  target_file.filename,
                  target_file.file_hash,
                  target_file.file_size,
                  target_file.file_type,
                  target_file.document_kind,
                  target_file.declared_mime_type,
                  target_file.detected_mime_type,
                  target_file.active_conversion_generation_id,
                  coalesce(
                    claim.conversion_profile,
                    case target_file.document_kind
                      when 'markdown' then 'markdown-v1'
                      when 'plaintext' then 'plaintext-v1'
                      when 'pdf' then 'pdf-text-v1'
                      when 'docx' then 'docx-v1'
                      when 'pptx' then 'pptx-v1'
                      when 'xlsx' then 'xlsx-v1'
                      when 'csv' then 'csv-v1'
                    end
                  ) as conversion_profile,
                  target_file.object_key,
                  target_file.project_space_id,
                  target_file.status,
                  target_file.progress,
                  target_file.error_message,
                  target_file.created_at,
                  target_file.updated_at
                from files target_file
                left join file_content_claims claim on claim.file_id = target_file.id
                where target_file.id = %s
                """,
                (file_id,),
            )
            return cur.fetchone()


_CONVERSION_GENERATION_COLUMNS = """
  id,
  file_id,
  attempt_id,
  document_kind,
  source_object_key,
  markdown_object_key,
  source_map_object_key,
  manifest_object_key,
  converter_name,
  converter_version,
  conversion_profile,
  source_hash,
  markdown_hash,
  source_map_hash,
  manifest_hash,
  markdown_byte_size,
  source_map_byte_size,
  manifest_byte_size,
  status,
  warning_count,
  unit_count,
  error_code,
  created_at,
  completed_at,
  updated_at
"""


def _qualified_conversion_generation_columns(alias: str) -> str:
    return ",\n".join(
        f"{alias}.{column.strip()}"
        for column in _CONVERSION_GENERATION_COLUMNS.split(",")
        if column.strip()
    )


_IMMUTABLE_CONVERSION_FIELDS = (
    "file_id",
    "attempt_id",
    "document_kind",
    "source_object_key",
    "markdown_object_key",
    "source_map_object_key",
    "manifest_object_key",
    "converter_name",
    "converter_version",
    "conversion_profile",
    "source_hash",
)


def _require_sha256(value: str, field: str) -> str:
    normalized = str(value or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", normalized):
        raise ValueError(f"{field} must be a lowercase SHA-256 digest")
    return normalized


def _require_nonnegative_int(value: int, field: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def create_or_reuse_conversion_generation(
    file_id: str,
    attempt_id,
    lease_token,
    *,
    generation_id,
    document_kind: str,
    source_object_key: str,
    markdown_object_key: str,
    source_map_object_key: str,
    manifest_object_key: str,
    converter_name: str,
    converter_version: str,
    conversion_profile: str,
    source_hash: str,
) -> dict:
    """Create one immutable generation per ingestion attempt and bind it to the leased job."""

    normalized_source_hash = _require_sha256(source_hash, "source_hash")
    expected = {
        "file_id": str(file_id),
        "attempt_id": str(attempt_id),
        "document_kind": str(document_kind),
        "source_object_key": str(source_object_key),
        "markdown_object_key": str(markdown_object_key),
        "source_map_object_key": str(source_map_object_key),
        "manifest_object_key": str(manifest_object_key),
        "converter_name": str(converter_name),
        "converter_version": str(converter_version),
        "conversion_profile": str(conversion_profile),
        "source_hash": normalized_source_hash,
    }
    if any(not expected[field].strip() for field in _IMMUTABLE_CONVERSION_FIELDS):
        raise ValueError("conversion generation identity fields must be non-empty")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select job.file_id
                from file_ingestion_jobs job
                join files target_file on target_file.id = job.file_id
                where job.file_id = %s
                  and job.attempt_id = %s
                  and job.lease_token = %s
                  and job.status = 'processing'
                  and job.lease_expires_at > now()
                  and target_file.status = 'processing'
                for update of job, target_file
                """,
                (file_id, attempt_id, lease_token),
            )
            if not cur.fetchone():
                raise IngestionLeaseLostError(
                    f"Ingestion lease is no longer active for file {file_id}, attempt {attempt_id}"
                )

            cur.execute(
                f"""
                select {_CONVERSION_GENERATION_COLUMNS}
                from file_conversion_generations
                where attempt_id = %s
                for update
                """,
                (attempt_id,),
            )
            generation = cur.fetchone()
            if generation:
                mismatches = [
                    field
                    for field in _IMMUTABLE_CONVERSION_FIELDS
                    if str(generation.get(field) or "") != expected[field]
                ]
                if mismatches:
                    raise ConversionGenerationStateError(
                        "existing conversion generation does not match immutable fields: "
                        + ", ".join(mismatches)
                    )
            else:
                cur.execute(
                    f"""
                    insert into file_conversion_generations (
                      id,
                      file_id,
                      attempt_id,
                      document_kind,
                      source_object_key,
                      markdown_object_key,
                      source_map_object_key,
                      manifest_object_key,
                      converter_name,
                      converter_version,
                      conversion_profile,
                      source_hash
                    )
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    returning {_CONVERSION_GENERATION_COLUMNS}
                    """,
                    (
                        generation_id,
                        file_id,
                        attempt_id,
                        document_kind,
                        source_object_key,
                        markdown_object_key,
                        source_map_object_key,
                        manifest_object_key,
                        converter_name,
                        converter_version,
                        conversion_profile,
                        normalized_source_hash,
                    ),
                )
                generation = cur.fetchone()
                if not generation:
                    raise ConversionGenerationStateError("conversion generation was not created")

            cur.execute(
                """
                update file_ingestion_jobs
                set conversion_generation_id = %s,
                    updated_at = now()
                where file_id = %s
                  and attempt_id = %s
                  and lease_token = %s
                  and status = 'processing'
                  and lease_expires_at > now()
                returning file_id
                """,
                (generation["id"], file_id, attempt_id, lease_token),
            )
            if not cur.fetchone():
                raise IngestionLeaseLostError(
                    f"Ingestion lease is no longer active for file {file_id}, attempt {attempt_id}"
                )
        conn.commit()
        return generation


def complete_conversion_generation(
    file_id: str,
    generation_id,
    attempt_id,
    lease_token,
    *,
    markdown_hash: str,
    source_map_hash: str,
    manifest_hash: str,
    markdown_byte_size: int,
    source_map_byte_size: int,
    manifest_byte_size: int,
    warning_count: int,
    unit_count: int,
) -> dict:
    """Complete an immutable generation only while its bound ingestion lease is active."""

    normalized_markdown_hash = _require_sha256(markdown_hash, "markdown_hash")
    normalized_source_map_hash = _require_sha256(source_map_hash, "source_map_hash")
    normalized_manifest_hash = _require_sha256(manifest_hash, "manifest_hash")
    markdown_byte_size = _require_nonnegative_int(markdown_byte_size, "markdown_byte_size")
    source_map_byte_size = _require_nonnegative_int(source_map_byte_size, "source_map_byte_size")
    manifest_byte_size = _require_nonnegative_int(manifest_byte_size, "manifest_byte_size")
    warning_count = _require_nonnegative_int(warning_count, "warning_count")
    unit_count = _require_nonnegative_int(unit_count, "unit_count")
    completed_status = "completed_with_warnings" if warning_count else "completed"

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                update file_conversion_generations generation
                set markdown_hash = %s,
                    source_map_hash = %s,
                    manifest_hash = %s,
                    markdown_byte_size = %s,
                    source_map_byte_size = %s,
                    manifest_byte_size = %s,
                    status = %s,
                    warning_count = %s,
                    unit_count = %s,
                    error_code = null,
                    completed_at = now(),
                    updated_at = now()
                from file_ingestion_jobs job
                where generation.id = %s
                  and generation.file_id = %s
                  and generation.status = 'converting'
                  and job.file_id = generation.file_id
                  and job.conversion_generation_id = generation.id
                  and job.attempt_id = %s
                  and job.lease_token = %s
                  and job.status = 'processing'
                  and job.lease_expires_at > now()
                returning {_qualified_conversion_generation_columns('generation')}
                """,
                (
                    normalized_markdown_hash,
                    normalized_source_map_hash,
                    normalized_manifest_hash,
                    markdown_byte_size,
                    source_map_byte_size,
                    manifest_byte_size,
                    completed_status,
                    warning_count,
                    unit_count,
                    generation_id,
                    file_id,
                    attempt_id,
                    lease_token,
                ),
            )
            generation = cur.fetchone()
            if not generation:
                raise IngestionLeaseLostError(
                    f"Conversion generation is not completable for file {file_id}, attempt {attempt_id}"
                )
        conn.commit()
        return generation


def fail_conversion_generation(
    file_id: str,
    generation_id,
    attempt_id,
    lease_token,
    error_code: str,
) -> dict:
    """Record a stable conversion failure without persisting parser exception details."""

    normalized_error_code = str(error_code or "").strip().upper()
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", normalized_error_code):
        raise ValueError("error_code must be a stable uppercase identifier")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                update file_conversion_generations generation
                set status = 'failed',
                    error_code = %s,
                    completed_at = now(),
                    updated_at = now()
                from file_ingestion_jobs job
                where generation.id = %s
                  and generation.file_id = %s
                  and generation.status = 'converting'
                  and job.file_id = generation.file_id
                  and job.conversion_generation_id = generation.id
                  and job.attempt_id = %s
                  and job.lease_token = %s
                  and job.status = 'processing'
                  and job.lease_expires_at > now()
                returning {_qualified_conversion_generation_columns('generation')}
                """,
                (normalized_error_code, generation_id, file_id, attempt_id, lease_token),
            )
            generation = cur.fetchone()
            if not generation:
                raise IngestionLeaseLostError(
                    f"Conversion generation is not fail-able for file {file_id}, attempt {attempt_id}"
                )
        conn.commit()
        return generation


def activate_conversion_generation_and_complete_ingestion_job(
    file_id: str,
    generation_id,
    attempt_id,
    lease_token,
    *,
    total_chunks: int,
    indexed_chunks: int,
    keyword_batches: int = 0,
    graph_batches: int = 0,
    vector_batches: int = 0,
    checkpoint: dict | None = None,
    detected_mime_type: str | None = None,
) -> dict:
    """Atomically activate a fully indexed generation and complete its leased job."""

    total_chunks = _require_nonnegative_int(total_chunks, "total_chunks")
    indexed_chunks = _require_nonnegative_int(indexed_chunks, "indexed_chunks")
    keyword_batches = _require_nonnegative_int(keyword_batches, "keyword_batches")
    graph_batches = _require_nonnegative_int(graph_batches, "graph_batches")
    vector_batches = _require_nonnegative_int(vector_batches, "vector_batches")
    if total_chunks == 0 or indexed_chunks != total_chunks:
        raise ConversionGenerationStateError(
            "a conversion generation can only be activated after every non-empty chunk is indexed"
        )

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select
                  generation.id,
                  generation.warning_count,
                  target_file.user_id::text as user_id,
                  target_file.project_space_id::text as project_space_id,
                  target_file.active_conversion_generation_id,
                  (
                    select count(*)::bigint
                    from file_chunks chunk
                    where chunk.file_id = target_file.id
                      and chunk.conversion_generation_id = generation.id
                  ) as persisted_chunk_count
                from file_ingestion_jobs job
                join files target_file on target_file.id = job.file_id
                join file_conversion_generations generation
                  on generation.id = job.conversion_generation_id
                 and generation.file_id = job.file_id
                where job.file_id = %s
                  and generation.id = %s
                  and generation.status in ('completed', 'completed_with_warnings')
                  and job.attempt_id = %s
                  and job.lease_token = %s
                  and job.status = 'processing'
                  and job.lease_expires_at > now()
                  and target_file.status = 'processing'
                for update of job, target_file, generation
                """,
                (file_id, generation_id, attempt_id, lease_token),
            )
            state = cur.fetchone()
            if not state:
                raise IngestionLeaseLostError(
                    f"Conversion generation is not activatable for file {file_id}, attempt {attempt_id}"
                )
            if int(state.get("persisted_chunk_count") or 0) != total_chunks:
                raise ConversionGenerationStateError(
                    "persisted conversion generation chunk count does not match the completed job"
                )

            previous_generation_id = state.get("active_conversion_generation_id")
            if previous_generation_id and str(previous_generation_id) != str(generation_id):
                cur.execute(
                    """
                    update file_conversion_generations
                    set status = 'superseded',
                        updated_at = now()
                    where id = %s
                      and file_id = %s
                      and status in ('completed', 'completed_with_warnings')
                    """,
                    (previous_generation_id, file_id),
                )

            cur.execute(
                """
                update files
                set active_conversion_generation_id = %s,
                    detected_mime_type = coalesce(%s, detected_mime_type),
                    conversion_warning_count = %s,
                    updated_at = now()
                where id = %s
                  and status = 'processing'
                returning id
                """,
                (generation_id, detected_mime_type, int(state.get("warning_count") or 0), file_id),
            )
            if not cur.fetchone():
                raise ConversionGenerationStateError("file is not in an activatable processing state")

            publication = _bump_project_knowledge_version(
                cur,
                state["user_id"],
                state.get("project_space_id"),
                "file_ingested",
            )
            if state.get("project_space_id") and not publication:
                raise ConversionGenerationStateError(
                    "file project space disappeared during generation activation"
                )

            cur.execute(
                """
                update file_ingestion_jobs
                set status = 'completed',
                    stage = 'completed',
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
                  and conversion_generation_id = %s
                  and attempt_id = %s
                  and lease_token = %s
                  and status = 'processing'
                  and lease_expires_at > now()
                returning file_id
                """,
                (
                    total_chunks,
                    indexed_chunks,
                    keyword_batches,
                    graph_batches,
                    vector_batches,
                    json.dumps(checkpoint) if checkpoint is not None else None,
                    file_id,
                    generation_id,
                    attempt_id,
                    lease_token,
                ),
            )
            if not cur.fetchone():
                raise IngestionLeaseLostError(
                    f"Ingestion lease is no longer active for file {file_id}, attempt {attempt_id}"
                )
        conn.commit()
        return {
            "file_id": file_id,
            "conversion_generation_id": str(generation_id),
            "previous_conversion_generation_id": (
                str(previous_generation_id) if previous_generation_id else None
            ),
            "total_chunks": total_chunks,
            "indexed_chunks": indexed_chunks,
            "publication": publication,
        }


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
                    conversion_generation_id = null,
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
