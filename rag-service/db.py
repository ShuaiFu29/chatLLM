import json
import os
from contextlib import contextmanager
from typing import Iterable

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL")

if not DATABASE_URL:
    raise ValueError("DATABASE_URL must be set")


@contextmanager
def get_conn():
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        yield conn


def get_file(file_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select id, user_id, filename, file_hash, file_size, file_type,
                       object_key, status, progress, error_message, created_at, updated_at
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
                select id, file_id, user_id, chunk_index, content, metadata
                from file_chunks
                where id = any(%s::uuid[])
                """,
                (ids,),
            )
            rows = cur.fetchall()

    by_id = {str(row["id"]): row for row in rows}
    return [by_id[str(chunk_id)] for chunk_id in ids if str(chunk_id) in by_id]
