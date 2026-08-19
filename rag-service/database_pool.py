from contextlib import contextmanager
from queue import Empty, LifoQueue
from threading import Lock

import psycopg
from config import settings
from psycopg.rows import dict_row


class _ConnectionPool:
    """Small bounded psycopg pool used by synchronous RAG workers."""

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
