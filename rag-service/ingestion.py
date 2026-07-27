import logging
import hashlib
import codecs
import re
import tempfile
from contextlib import contextmanager
from typing import BinaryIO

from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter

from config import settings
from db import (
    IngestionLeaseLostError,
    assert_ingestion_lease,
    bump_project_knowledge_version,
    complete_ingestion_job,
    delete_file_chunks,
    fail_ingestion_job,
    get_file,
    insert_file_chunk_batch,
    replace_file_chunks,
    start_ingestion_job,
    update_ingestion_job_checkpoint,
)
from embeddings import EmbeddingIntegrityError, get_embeddings
from graph_store import delete_file_graph, graph_file_transaction, index_graph_chunks
from keyword_store import delete_file_keywords, index_chunks
from safe_errors import safe_error_fields
from storage import download_object, stream_object_bytes
from vector_store import delete_file_vectors, insert_vectors


logger = logging.getLogger(__name__)

_MARKDOWN_HEADING_KEYS = tuple((level, f"Header {level}") for level in range(1, 7))
_MARKDOWN_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)\s*$")
_MARKDOWN_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")


def verify_uploaded_object(file_bytes: bytes, file_data: dict):
    expected_size = file_data.get("file_size")
    if expected_size is not None:
        try:
            normalized_size = int(expected_size)
        except (TypeError, ValueError):
            normalized_size = None

        if normalized_size is not None and len(file_bytes) != normalized_size:
            raise ValueError(
                f"Uploaded object size mismatch: expected {normalized_size}, got {len(file_bytes)}"
            )

    expected_hash = str(file_data.get("file_hash") or "").strip().lower()
    if expected_hash:
        actual_hash = hashlib.sha256(file_bytes).hexdigest()
        if actual_hash != expected_hash:
            raise ValueError(
                f"Uploaded object hash mismatch: expected {expected_hash}, got {actual_hash}"
            )


def format_ingestion_error(error: Exception) -> str:
    message = str(error)
    if "1113" in message or "余额不足或无可用资源包" in message:
        return "百炼 embedding 额度不足或无可用资源包，请充值或购买资源包后点击重试。"
    if "batch size is invalid" in message:
        return "Embedding 批量大小超过服务限制，请稍后重试。"
    if "Only Markdown files" in message:
        return "Only Markdown files (.md, .markdown) are supported"
    if "Uploaded object" in message and ("hash mismatch" in message or "size mismatch" in message):
        return "Uploaded object integrity check failed"
    return "Document ingestion failed"


def assert_markdown_input(file_type: str | None, object_key: str) -> None:
    normalized_key = str(object_key or "").strip().lower()
    normalized_type = str(file_type or "").split(";", 1)[0].strip().lower()
    if not (
        normalized_type == "text/markdown"
        or normalized_key.endswith(".md")
        or normalized_key.endswith(".markdown")
    ):
        raise ValueError("Only Markdown files (.md, .markdown) are supported")


def extract_text(file_bytes: bytes, file_type: str | None, object_key: str) -> tuple[str, bool]:
    assert_markdown_input(file_type, object_key)
    return file_bytes.decode("utf-8"), True


def _heading_prefix(metadata: dict) -> str:
    headings = []
    for level, metadata_key in _MARKDOWN_HEADING_KEYS:
        title = str(metadata.get(metadata_key) or "").strip()
        if title:
            headings.append(f"{'#' * level} {title}")
    return "\n".join(headings)


def _with_heading_context(content: str, metadata: dict) -> str:
    body = content.strip()
    prefix = _heading_prefix(metadata)
    if prefix and body:
        return f"{prefix}\n\n{body}"
    return prefix or body


def split_text(text_content: str, is_markdown: bool) -> list[str]:
    separators = ["\n\n", "\n", "。", "！", "？", ".", " ", ""]

    if is_markdown:
        headers_to_split_on = [
            ("#" * level, metadata_key)
            for level, metadata_key in _MARKDOWN_HEADING_KEYS
        ]
        markdown_splitter = MarkdownHeaderTextSplitter(
            headers_to_split_on=headers_to_split_on,
            strip_headers=True,
        )
        md_header_splits = markdown_splitter.split_text(text_content)

        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=100,
            separators=separators,
        )
        chunks = []
        for section in md_header_splits:
            for body_chunk in text_splitter.split_text(section.page_content):
                contextualized = _with_heading_context(body_chunk, section.metadata)
                if contextualized:
                    chunks.append(contextualized)
        return chunks

    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=100,
        separators=separators,
    )
    return text_splitter.split_text(text_content)


def find_streaming_split_boundary(text: str, chunk_size: int) -> int:
    window = text[:chunk_size]
    for separator in ["\n\n", "\n", "。", "！", "？", ".", " "]:
        index = window.rfind(separator)
        if index >= max(1, int(chunk_size * 0.45)):
            return index + len(separator)
    return chunk_size


def iter_streaming_markdown_chunks(
    byte_chunks,
    chunk_size: int = 1000,
    chunk_overlap: int = 100,
):
    decoder = codecs.getincrementaldecoder("utf-8")()
    line_buffer = ""
    body_buffer = ""
    heading_path: dict[int, str] = {}
    fence_marker = ""

    def metadata() -> dict:
        return {
            metadata_key: heading_path[level]
            for level, metadata_key in _MARKDOWN_HEADING_KEYS
            if level in heading_path
        }

    def flush_ready(force: bool = False):
        nonlocal body_buffer
        while body_buffer and (force or len(body_buffer) >= chunk_size + chunk_overlap):
            boundary = (
                len(body_buffer)
                if force and len(body_buffer) <= chunk_size
                else find_streaming_split_boundary(body_buffer, chunk_size)
            )
            body = body_buffer[:boundary].strip()
            if body:
                contextualized = _with_heading_context(body, metadata())
                if contextualized:
                    yield contextualized
            if boundary >= len(body_buffer):
                body_buffer = ""
                break
            overlap_start = max(0, boundary - chunk_overlap)
            body_buffer = body_buffer[overlap_start:]
            if force and len(body_buffer) <= chunk_size:
                continue

    def consume_line(line: str):
        nonlocal body_buffer, fence_marker
        fence_match = _MARKDOWN_FENCE_RE.match(line)
        if fence_match:
            marker = fence_match.group(1)[0]
            if not fence_marker:
                fence_marker = marker
            elif fence_marker == marker:
                fence_marker = ""

        heading_match = None if fence_marker else _MARKDOWN_HEADING_RE.match(line.rstrip("\r\n"))
        if heading_match:
            yield from flush_ready(force=True)
            level = len(heading_match.group(1))
            heading_path[level] = heading_match.group(2).strip()
            for nested_level in tuple(heading_path):
                if nested_level > level:
                    del heading_path[nested_level]
            return

        body_buffer += line
        yield from flush_ready(force=False)

    for byte_chunk in byte_chunks:
        if not byte_chunk:
            continue
        line_buffer += decoder.decode(byte_chunk)
        lines = line_buffer.splitlines(keepends=True)
        if lines and not lines[-1].endswith(("\n", "\r")):
            line_buffer = lines.pop()
        else:
            line_buffer = ""
        for line in lines:
            yield from consume_line(line)

    line_buffer += decoder.decode(b"", final=True)
    if line_buffer:
        yield from consume_line(line_buffer)
    yield from flush_ready(force=True)


def should_stream_ingestion(file_data: dict) -> bool:
    try:
        file_size = int(file_data.get("file_size") or 0)
    except (TypeError, ValueError):
        file_size = 0
    return file_size >= settings.rag_ingest_streaming_threshold_bytes


def verify_streamed_object(byte_count: int, actual_hash: str, file_data: dict):
    expected_size = file_data.get("file_size")
    if expected_size is not None:
        try:
            normalized_size = int(expected_size)
        except (TypeError, ValueError):
            normalized_size = None

        if normalized_size is not None and byte_count != normalized_size:
            raise ValueError(
                f"Uploaded object size mismatch: expected {normalized_size}, got {byte_count}"
            )

    expected_hash = str(file_data.get("file_hash") or "").strip().lower()
    if expected_hash and actual_hash != expected_hash:
        raise ValueError(
            f"Uploaded object hash mismatch: expected {expected_hash}, got {actual_hash}"
        )


def iter_verified_streaming_chunks(object_key: str, file_data: dict):
    hasher = hashlib.sha256()
    byte_count = 0

    def verified_byte_chunks():
        nonlocal byte_count
        for byte_chunk in stream_object_bytes(object_key):
            byte_count += len(byte_chunk)
            hasher.update(byte_chunk)
            yield byte_chunk

    for chunk in iter_streaming_markdown_chunks(verified_byte_chunks()):
        yield chunk

    verify_streamed_object(byte_count, hasher.hexdigest(), file_data)


@contextmanager
def stage_verified_streaming_object(object_key: str, file_data: dict):
    """Spool and verify a large object before replacing any active indexes."""
    hasher = hashlib.sha256()
    byte_count = 0
    with tempfile.TemporaryFile(mode="w+b") as staged_file:
        for byte_chunk in stream_object_bytes(object_key):
            if not byte_chunk:
                continue
            staged_file.write(byte_chunk)
            byte_count += len(byte_chunk)
            hasher.update(byte_chunk)

        verify_streamed_object(byte_count, hasher.hexdigest(), file_data)
        staged_file.seek(0)
        yield staged_file, byte_count


def iter_staged_file_bytes(staged_file: BinaryIO, chunk_size: int = 1024 * 1024):
    staged_file.seek(0)
    while True:
        chunk = staged_file.read(chunk_size)
        if not chunk:
            break
        yield chunk


def validate_staged_markdown(staged_file: BinaryIO) -> int:
    """Fully parse staged UTF-8 Markdown before deleting the active generation."""
    chunk_count = sum(1 for _ in iter_streaming_markdown_chunks(iter_staged_file_bytes(staged_file)))
    staged_file.seek(0)
    if chunk_count == 0:
        raise ValueError("File produced no chunks")
    return chunk_count


def enrich_chunk_rows(file_data: dict, chunk_rows: list[dict], project_space_id: str) -> list[dict]:
    indexed_chunk_rows = []
    for row in chunk_rows:
        indexed_row = dict(row)
        metadata = dict(indexed_row.get("metadata") or {})
        metadata.update({
            "filename": file_data["filename"],
            "file_type": file_data.get("file_type"),
            "user_id": str(indexed_row["user_id"]),
            "project_space_id": project_space_id or None,
            "source_file_id": str(indexed_row["file_id"]),
            "file_id": str(indexed_row["file_id"]),
            "chunk_index": int(indexed_row["chunk_index"]),
        })
        indexed_row["metadata"] = metadata
        indexed_chunk_rows.append(indexed_row)
    return indexed_chunk_rows


def build_embedding_text(row: dict) -> str:
    metadata = row.get("metadata") or {}
    heading = " / ".join(str(item) for item in (metadata.get("heading_path") or []) if str(item).strip())
    parts = [str(metadata.get("filename") or "").strip(), heading, str(row.get("content") or "").strip()]
    return "\n".join(part for part in parts if part)


def index_chunk_batch(
    file_data: dict,
    chunk_rows: list[dict],
    project_space_id: str,
    graph_transaction=None,
):
    if not chunk_rows:
        return {
            "indexed_chunks": 0,
            "keyword_batches": 0,
            "graph_batches": 0,
            "graph_status": "skipped",
            "vector_batches": 0,
        }

    indexed_chunk_rows = enrich_chunk_rows(file_data, chunk_rows, project_space_id)
    index_chunks(indexed_chunk_rows)
    if graph_transaction is None:
        graph_result = index_graph_chunks(file_data, indexed_chunk_rows)
    else:
        graph_result = index_graph_chunks(
            file_data,
            indexed_chunk_rows,
            transaction=graph_transaction,
        )

    batch_size = settings.rag_ingest_embedding_batch_size
    vector_rows = []
    for i in range(0, len(indexed_chunk_rows), batch_size):
        batch_rows = indexed_chunk_rows[i: i + batch_size]
        batch_chunks = [build_embedding_text(row) for row in batch_rows]
        batch_embeddings = get_embeddings(batch_chunks)
        if len(batch_embeddings) != len(batch_rows):
            raise EmbeddingIntegrityError("item count does not match the ingestion batch")

        for row, embedding in zip(batch_rows, batch_embeddings, strict=True):
            vector_rows.append({
                "chunk_id": str(row["id"]),
                "file_id": str(row["file_id"]),
                "user_id": str(row["user_id"]),
                "project_space_id": project_space_id,
                "filename": file_data["filename"],
                "chunk_index": int(row["chunk_index"]),
                "embedding": embedding,
            })

    inserted_count = insert_vectors(vector_rows)
    if type(inserted_count) is not int or inserted_count != len(vector_rows):
        raise EmbeddingIntegrityError("vector store insert count does not match the ingestion batch")

    return {
        "indexed_chunks": inserted_count,
        "keyword_batches": 1,
        "graph_batches": int(graph_result["batches"]),
        "graph_status": str(graph_result["status"]),
        "vector_batches": max(1, (len(chunk_rows) + batch_size - 1) // batch_size),
    }


def reset_file_indexes(file_id: str):
    delete_file_vectors(file_id)
    delete_file_keywords(file_id)
    delete_file_graph(file_id)


def process_streaming_file(
    file_id: str,
    attempt_id,
    lease_token,
    file_data: dict,
    user_id: str,
    project_space_id: str,
    staged_file: BinaryIO,
    staged_chunk_count: int,
):
    object_key = file_data["object_key"]
    update_ingestion_job_checkpoint(
        file_id,
        attempt_id,
        lease_token,
        stage="resetting_indexes",
        progress=8,
        checkpoint={"mode": "streaming", "object_key": object_key},
    )
    reset_file_indexes(file_id)
    delete_file_chunks(file_id)
    update_ingestion_job_checkpoint(
        file_id,
        attempt_id,
        lease_token,
        stage="publishing_staged_object",
        progress=10,
        checkpoint={
            "mode": "streaming",
            "object_key": object_key,
            "next_chunk_index": 0,
            "validated_chunks": staged_chunk_count,
        },
    )

    pending_chunks: list[str] = []
    next_chunk_index = 0
    processed_count = 0
    keyword_batches = 0
    graph_batches = 0
    graph_status = "pending"
    vector_batches = 0
    batch_size = settings.rag_ingest_chunk_batch_size

    with graph_file_transaction() as graph_transaction:
        for chunk in iter_streaming_markdown_chunks(iter_staged_file_bytes(staged_file)):
            pending_chunks.append(chunk)
            if len(pending_chunks) < batch_size:
                continue

            assert_ingestion_lease(file_id, attempt_id, lease_token)
            chunk_rows = insert_file_chunk_batch(file_id, user_id, next_chunk_index, pending_chunks, file_data)
            batch_stats = index_chunk_batch(
                file_data,
                chunk_rows,
                project_space_id,
                graph_transaction,
            )
            processed_count += batch_stats["indexed_chunks"]
            next_chunk_index += len(pending_chunks)
            keyword_batches += batch_stats["keyword_batches"]
            graph_status = batch_stats["graph_status"]
            vector_batches += batch_stats["vector_batches"]
            pending_chunks = []
            progress = min(95, 10 + int((processed_count / staged_chunk_count) * 85))
            update_ingestion_job_checkpoint(
                file_id,
                attempt_id,
                lease_token,
                stage="indexing_vectors",
                progress=progress,
                indexed_chunks=processed_count,
                keyword_batches=keyword_batches,
                graph_batches=graph_batches,
                vector_batches=vector_batches,
                checkpoint={
                    "mode": "streaming",
                    "next_chunk_index": next_chunk_index,
                    "indexed_chunks": processed_count,
                    "last_batch_size": len(chunk_rows),
                    "graph_status": graph_status,
                },
            )

        if pending_chunks:
            assert_ingestion_lease(file_id, attempt_id, lease_token)
            chunk_rows = insert_file_chunk_batch(file_id, user_id, next_chunk_index, pending_chunks, file_data)
            batch_stats = index_chunk_batch(
                file_data,
                chunk_rows,
                project_space_id,
                graph_transaction,
            )
            processed_count += batch_stats["indexed_chunks"]
            next_chunk_index += len(pending_chunks)
            keyword_batches += batch_stats["keyword_batches"]
            graph_status = batch_stats["graph_status"]
            vector_batches += batch_stats["vector_batches"]
            update_ingestion_job_checkpoint(
                file_id,
                attempt_id,
                lease_token,
                stage="indexing_vectors",
                progress=95,
                indexed_chunks=processed_count,
                keyword_batches=keyword_batches,
                graph_batches=graph_batches,
                vector_batches=vector_batches,
                checkpoint={
                    "mode": "streaming",
                    "next_chunk_index": next_chunk_index,
                    "indexed_chunks": processed_count,
                    "last_batch_size": len(chunk_rows),
                    "graph_status": graph_status,
                },
            )

        assert_ingestion_lease(file_id, attempt_id, lease_token)

    graph_batches = graph_transaction.committed_batches
    graph_status = graph_transaction.status

    if processed_count == 0:
        raise ValueError("File produced no chunks")

    checkpoint = {
        "mode": "streaming",
        "next_chunk_index": next_chunk_index,
        "indexed_chunks": processed_count,
        "graph_status": graph_status,
        "complete": True,
    }
    assert_ingestion_lease(file_id, attempt_id, lease_token)
    bump_project_knowledge_version(user_id, project_space_id or None, "file_ingested")
    complete_ingestion_job(
        file_id,
        attempt_id,
        lease_token,
        stage="completed",
        total_chunks=processed_count,
        indexed_chunks=processed_count,
        keyword_batches=keyword_batches,
        graph_batches=graph_batches,
        vector_batches=vector_batches,
        checkpoint=checkpoint,
    )
    return {"status": "success", "chunks": processed_count}


def process_file(file_id: str, attempt_id, lease_token):
    indexes_reset = False
    last_checkpoint = {"file_id": file_id, "mode": "unknown"}
    try:
        assert_ingestion_lease(file_id, attempt_id, lease_token)
        file_data = get_file(file_id)
        if not file_data:
            raise ValueError(f"File {file_id} not found")
        start_ingestion_job(
            file_data,
            attempt_id,
            lease_token,
            stage="validating_uploaded_object",
            checkpoint={"file_id": file_id, "mode": "unknown"},
        )

        object_key = file_data.get("object_key")
        if not object_key:
            raise ValueError(f"File {file_id} has no object_key")

        file_type = file_data.get("file_type")
        user_id = str(file_data["user_id"])
        project_space_id = str(file_data.get("project_space_id")) if file_data.get("project_space_id") else ""
        assert_markdown_input(file_type, object_key)

        if should_stream_ingestion(file_data):
            update_ingestion_job_checkpoint(
                file_id,
                attempt_id,
                lease_token,
                stage="staging_streaming_object",
                progress=5,
                checkpoint={"mode": "streaming", "object_key": object_key},
            )
            with stage_verified_streaming_object(object_key, file_data) as (staged_file, staged_bytes):
                assert_ingestion_lease(file_id, attempt_id, lease_token)
                staged_chunk_count = validate_staged_markdown(staged_file)
                update_ingestion_job_checkpoint(
                    file_id,
                    attempt_id,
                    lease_token,
                    stage="validated_staged_object",
                    progress=8,
                    total_chunks=staged_chunk_count,
                    checkpoint={
                        "mode": "streaming",
                        "object_key": object_key,
                        "bytes": staged_bytes,
                        "validated_chunks": staged_chunk_count,
                    },
                )
                indexes_reset = True
                return process_streaming_file(
                    file_id,
                    attempt_id,
                    lease_token,
                    file_data,
                    user_id,
                    project_space_id,
                    staged_file,
                    staged_chunk_count,
                )

        update_ingestion_job_checkpoint(
            file_id,
            attempt_id,
            lease_token,
            stage="downloading_object",
            progress=5,
            checkpoint={"mode": "standard", "object_key": object_key},
        )
        file_bytes = download_object(object_key)
        update_ingestion_job_checkpoint(
            file_id,
            attempt_id,
            lease_token,
            stage="validating_uploaded_object",
            progress=10,
            checkpoint={"mode": "standard", "object_key": object_key, "bytes": len(file_bytes)},
        )
        verify_uploaded_object(file_bytes, file_data)

        update_ingestion_job_checkpoint(
            file_id,
            attempt_id,
            lease_token,
            stage="parsing_markdown",
            progress=15,
            checkpoint={"mode": "standard", "object_key": object_key, "bytes": len(file_bytes)},
        )
        text_content, is_markdown = extract_text(file_bytes, file_type, object_key)

        if not text_content.strip():
            raise ValueError("File content is empty")

        update_ingestion_job_checkpoint(
            file_id,
            attempt_id,
            lease_token,
            stage="chunking",
            progress=25,
            checkpoint={"mode": "standard", "content_length": len(text_content)},
        )
        chunks = split_text(text_content, is_markdown)
        total_chunks = len(chunks)
        if total_chunks == 0:
            raise ValueError("File produced no chunks")
        update_ingestion_job_checkpoint(
            file_id,
            attempt_id,
            lease_token,
            stage="persisting_chunks",
            progress=35,
            total_chunks=total_chunks,
            checkpoint={"mode": "standard", "total_chunks": total_chunks},
        )

        update_ingestion_job_checkpoint(
            file_id,
            attempt_id,
            lease_token,
            stage="resetting_indexes",
            progress=40,
            total_chunks=total_chunks,
            checkpoint={"mode": "standard", "total_chunks": total_chunks},
        )
        reset_file_indexes(file_id)
        indexes_reset = True
        assert_ingestion_lease(file_id, attempt_id, lease_token)
        chunk_rows = replace_file_chunks(file_id, user_id, chunks, file_data)
        processed_count = 0
        keyword_batches = 0
        graph_batches = 0
        graph_status = "pending"
        vector_batches = 0
        batch_size = settings.rag_ingest_chunk_batch_size
        with graph_file_transaction() as graph_transaction:
            for i in range(0, total_chunks, batch_size):
                assert_ingestion_lease(file_id, attempt_id, lease_token)
                batch_rows = chunk_rows[i: i + batch_size]
                batch_stats = index_chunk_batch(
                    file_data,
                    batch_rows,
                    project_space_id,
                    graph_transaction,
                )
                processed_count += batch_stats["indexed_chunks"]
                keyword_batches += batch_stats["keyword_batches"]
                graph_status = batch_stats["graph_status"]
                vector_batches += batch_stats["vector_batches"]
                progress = int((processed_count / total_chunks) * 100)
                last_checkpoint = {
                    "mode": "standard",
                    "next_chunk_index": processed_count,
                    "indexed_chunks": processed_count,
                    "total_chunks": total_chunks,
                    "last_batch_size": len(batch_rows),
                    "graph_status": graph_status,
                }
                update_ingestion_job_checkpoint(
                    file_id,
                    attempt_id,
                    lease_token,
                    stage="indexing_vectors",
                    progress=progress,
                    total_chunks=total_chunks,
                    indexed_chunks=processed_count,
                    keyword_batches=keyword_batches,
                    graph_batches=graph_batches,
                    vector_batches=vector_batches,
                    checkpoint=last_checkpoint,
                )

            assert_ingestion_lease(file_id, attempt_id, lease_token)

        graph_batches = graph_transaction.committed_batches
        graph_status = graph_transaction.status
        last_checkpoint = {**last_checkpoint, "graph_status": graph_status}

        assert_ingestion_lease(file_id, attempt_id, lease_token)
        bump_project_knowledge_version(user_id, project_space_id or None, "file_ingested")
        complete_ingestion_job(
            file_id,
            attempt_id,
            lease_token,
            stage="completed",
            total_chunks=total_chunks,
            indexed_chunks=processed_count,
            keyword_batches=keyword_batches,
            graph_batches=graph_batches,
            vector_batches=vector_batches,
            checkpoint={**last_checkpoint, "complete": True},
        )

        return {"status": "success", "chunks": processed_count}

    except IngestionLeaseLostError:
        raise
    except Exception as e:
        assert_ingestion_lease(file_id, attempt_id, lease_token)
        if indexes_reset:
            try:
                reset_file_indexes(file_id)
                assert_ingestion_lease(file_id, attempt_id, lease_token)
                delete_file_chunks(file_id)
            except Exception as cleanup_error:
                logger.debug("Failed to cleanup partial ingestion: %s", safe_error_fields(cleanup_error))
        formatted_error = format_ingestion_error(e)
        fail_ingestion_job(
            file_id,
            attempt_id,
            lease_token,
            formatted_error,
            checkpoint=last_checkpoint,
        )
        raise
