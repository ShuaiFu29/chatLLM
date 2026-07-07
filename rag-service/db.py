import json
from contextlib import contextmanager
from queue import Empty, LifoQueue
from threading import Lock
from typing import Iterable

import psycopg
from psycopg.rows import dict_row
from config import settings


class _ConnectionPool:
    def __init__(self, max_size: int, timeout_ms: int):
        self.max_size = max_size
        self.timeout_seconds = timeout_ms / 1000
        self._idle: LifoQueue = LifoQueue(maxsize=max_size)
        self._lock = Lock()
        self._created = 0

    def _create_connection(self):
        return psycopg.connect(settings.database_url, row_factory=dict_row)

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
                return self._create_connection()

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
    return True


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


def replace_file_chunks(file_id: str, user_id: str, chunks: list[str], file_data: dict) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("delete from file_chunks where file_id = %s", (file_id,))

            inserted: list[dict] = []
            for index, chunk in enumerate(chunks):
                metadata = {
                    "filename": file_data["filename"],
                    "file_type": file_data.get("file_type"),
                    "user_id": user_id,
                    "project_space_id": str(file_data.get("project_space_id")) if file_data.get("project_space_id") else None,
                    "source_file_id": file_id,
                    "chunk_index": index,
                }
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
