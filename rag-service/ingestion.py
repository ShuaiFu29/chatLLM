import logging
import hashlib
import codecs

from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter

from config import settings
from db import (
    bump_project_knowledge_version,
    complete_ingestion_job,
    delete_file_chunks,
    fail_ingestion_job,
    get_file,
    insert_file_chunk_batch,
    replace_file_chunks,
    start_ingestion_job,
    update_ingestion_job_checkpoint,
    update_file_progress,
    update_file_status,
)
from embeddings import get_embeddings
from graph_store import delete_file_graph, index_graph_chunks
from keyword_store import delete_file_keywords, index_chunks
from safe_errors import safe_error_fields
from storage import download_object, stream_object_bytes
from vector_store import delete_file_vectors, insert_vectors


logger = logging.getLogger(__name__)


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


def extract_text(file_bytes: bytes, file_type: str | None, object_key: str) -> tuple[str, bool]:
    normalized_key = object_key.lower()
    is_markdown = (
        file_type == "text/markdown"
        or normalized_key.endswith(".md")
        or normalized_key.endswith(".markdown")
    )

    if not is_markdown:
        raise ValueError("Only Markdown files (.md, .markdown) are supported")

    return file_bytes.decode("utf-8"), True


def split_text(text_content: str, is_markdown: bool) -> list[str]:
    separators = ["\n\n", "\n", "。", "！", "？", ".", " ", ""]

    if is_markdown:
        headers_to_split_on = [
            ("#", "Header 1"),
            ("##", "Header 2"),
            ("###", "Header 3"),
        ]
        markdown_splitter = MarkdownHeaderTextSplitter(headers_to_split_on=headers_to_split_on)
        md_header_splits = markdown_splitter.split_text(text_content)

        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=100,
            separators=separators,
        )
        return [doc.page_content for doc in text_splitter.split_documents(md_header_splits)]

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
    buffer = ""

    for byte_chunk in byte_chunks:
        if not byte_chunk:
            continue
        buffer += decoder.decode(byte_chunk)

        while len(buffer) >= chunk_size + chunk_overlap:
            boundary = find_streaming_split_boundary(buffer, chunk_size)
            chunk = buffer[:boundary].strip()
            if chunk:
                yield chunk
            overlap_start = max(0, boundary - chunk_overlap)
            buffer = buffer[overlap_start:]

    buffer += decoder.decode(b"", final=True)
    final = buffer.strip()
    if final:
        yield final


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


def index_chunk_batch(file_data: dict, chunk_rows: list[dict], project_space_id: str):
    if not chunk_rows:
        return {
            "indexed_chunks": 0,
            "keyword_batches": 0,
            "graph_batches": 0,
            "vector_batches": 0,
        }

    indexed_chunk_rows = enrich_chunk_rows(file_data, chunk_rows, project_space_id)
    index_chunks(indexed_chunk_rows)
    graph_batches = 0
    try:
        index_graph_chunks(file_data, indexed_chunk_rows)
        graph_batches = 1
    except Exception as graph_error:
        logger.warning(
            "Optional graph indexing failed: %s",
            safe_error_fields(graph_error),
        )

    batch_size = settings.rag_ingest_embedding_batch_size
    for i in range(0, len(chunk_rows), batch_size):
        batch_rows = chunk_rows[i: i + batch_size]
        batch_chunks = [row["content"] for row in batch_rows]
        embeddings = get_embeddings(batch_chunks)

        vector_rows = []
        for row, embedding in zip(batch_rows, embeddings):
            vector_rows.append({
                "chunk_id": str(row["id"]),
                "file_id": str(row["file_id"]),
                "user_id": str(row["user_id"]),
                "project_space_id": project_space_id,
                "filename": file_data["filename"],
                "chunk_index": int(row["chunk_index"]),
                "embedding": embedding,
            })

        insert_vectors(vector_rows)

    return {
        "indexed_chunks": len(chunk_rows),
        "keyword_batches": 1,
        "graph_batches": graph_batches,
        "vector_batches": max(1, (len(chunk_rows) + batch_size - 1) // batch_size),
    }


def reset_file_indexes(file_id: str):
    delete_file_vectors(file_id)
    delete_file_keywords(file_id)
    delete_file_graph(file_id)


def process_streaming_file(file_id: str, file_data: dict, user_id: str, project_space_id: str):
    object_key = file_data["object_key"]
    update_ingestion_job_checkpoint(
        file_id,
        stage="resetting_indexes",
        progress=8,
        checkpoint={"mode": "streaming", "object_key": object_key},
    )
    reset_file_indexes(file_id)
    delete_file_chunks(file_id)
    update_file_progress(file_id, 10)
    update_ingestion_job_checkpoint(
        file_id,
        stage="streaming_download",
        progress=10,
        checkpoint={"mode": "streaming", "object_key": object_key, "next_chunk_index": 0},
    )

    pending_chunks: list[str] = []
    next_chunk_index = 0
    processed_count = 0
    keyword_batches = 0
    graph_batches = 0
    vector_batches = 0
    batch_size = settings.rag_ingest_chunk_batch_size

    for chunk in iter_verified_streaming_chunks(object_key, file_data):
        pending_chunks.append(chunk)
        if len(pending_chunks) < batch_size:
            continue

        chunk_rows = insert_file_chunk_batch(file_id, user_id, next_chunk_index, pending_chunks, file_data)
        batch_stats = index_chunk_batch(file_data, chunk_rows, project_space_id)
        processed_count += len(chunk_rows)
        next_chunk_index += len(pending_chunks)
        keyword_batches += batch_stats["keyword_batches"]
        graph_batches += batch_stats["graph_batches"]
        vector_batches += batch_stats["vector_batches"]
        pending_chunks = []
        progress = min(95, 10 + processed_count)
        update_file_progress(file_id, progress)
        update_ingestion_job_checkpoint(
            file_id,
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
            },
        )

    if pending_chunks:
        chunk_rows = insert_file_chunk_batch(file_id, user_id, next_chunk_index, pending_chunks, file_data)
        batch_stats = index_chunk_batch(file_data, chunk_rows, project_space_id)
        processed_count += len(chunk_rows)
        next_chunk_index += len(pending_chunks)
        keyword_batches += batch_stats["keyword_batches"]
        graph_batches += batch_stats["graph_batches"]
        vector_batches += batch_stats["vector_batches"]
        update_ingestion_job_checkpoint(
            file_id,
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
            },
        )

    if processed_count == 0:
        raise ValueError("File produced no chunks")

    update_file_progress(file_id, 100)
    checkpoint = {
        "mode": "streaming",
        "next_chunk_index": next_chunk_index,
        "indexed_chunks": processed_count,
        "complete": True,
    }
    complete_ingestion_job(
        file_id,
        stage="completed",
        total_chunks=processed_count,
        indexed_chunks=processed_count,
        keyword_batches=keyword_batches,
        graph_batches=graph_batches,
        vector_batches=vector_batches,
        checkpoint=checkpoint,
    )
    return {"status": "success", "chunks": processed_count}


def process_file(file_id: str):
    indexes_reset = False
    last_checkpoint = {"file_id": file_id, "mode": "unknown"}
    try:
        update_file_status(file_id, "processing", progress=0)

        file_data = get_file(file_id)
        if not file_data:
            raise ValueError(f"File {file_id} not found")
        start_ingestion_job(
            file_data,
            stage="validating_uploaded_object",
            checkpoint={"file_id": file_id, "mode": "unknown"},
        )

        object_key = file_data.get("object_key")
        if not object_key:
            raise ValueError(f"File {file_id} has no object_key")

        file_type = file_data.get("file_type")
        user_id = str(file_data["user_id"])
        project_space_id = str(file_data.get("project_space_id")) if file_data.get("project_space_id") else ""

        if should_stream_ingestion(file_data):
            indexes_reset = True
            result = process_streaming_file(file_id, file_data, user_id, project_space_id)
            update_file_status(file_id, "completed", progress=100)
            bump_project_knowledge_version(user_id, project_space_id or None, "file_ingested")
            return result

        update_ingestion_job_checkpoint(
            file_id,
            stage="downloading_object",
            progress=5,
            checkpoint={"mode": "standard", "object_key": object_key},
        )
        file_bytes = download_object(object_key)
        update_ingestion_job_checkpoint(
            file_id,
            stage="validating_uploaded_object",
            progress=10,
            checkpoint={"mode": "standard", "object_key": object_key, "bytes": len(file_bytes)},
        )
        verify_uploaded_object(file_bytes, file_data)

        update_ingestion_job_checkpoint(
            file_id,
            stage="parsing_markdown",
            progress=15,
            checkpoint={"mode": "standard", "object_key": object_key, "bytes": len(file_bytes)},
        )
        text_content, is_markdown = extract_text(file_bytes, file_type, object_key)

        if not text_content.strip():
            raise ValueError("File content is empty")

        update_ingestion_job_checkpoint(
            file_id,
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
            stage="persisting_chunks",
            progress=35,
            total_chunks=total_chunks,
            checkpoint={"mode": "standard", "total_chunks": total_chunks},
        )

        update_ingestion_job_checkpoint(
            file_id,
            stage="resetting_indexes",
            progress=40,
            total_chunks=total_chunks,
            checkpoint={"mode": "standard", "total_chunks": total_chunks},
        )
        reset_file_indexes(file_id)
        indexes_reset = True
        chunk_rows = replace_file_chunks(file_id, user_id, chunks, file_data)
        processed_count = 0
        keyword_batches = 0
        graph_batches = 0
        vector_batches = 0
        batch_size = settings.rag_ingest_chunk_batch_size
        for i in range(0, total_chunks, batch_size):
            batch_rows = chunk_rows[i: i + batch_size]
            batch_stats = index_chunk_batch(file_data, batch_rows, project_space_id)
            processed_count += len(batch_rows)
            keyword_batches += batch_stats["keyword_batches"]
            graph_batches += batch_stats["graph_batches"]
            vector_batches += batch_stats["vector_batches"]
            progress = int((processed_count / total_chunks) * 100)
            update_file_progress(file_id, progress)
            last_checkpoint = {
                "mode": "standard",
                "next_chunk_index": processed_count,
                "indexed_chunks": processed_count,
                "total_chunks": total_chunks,
                "last_batch_size": len(batch_rows),
            }
            update_ingestion_job_checkpoint(
                file_id,
                stage="indexing_vectors",
                progress=progress,
                total_chunks=total_chunks,
                indexed_chunks=processed_count,
                keyword_batches=keyword_batches,
                graph_batches=graph_batches,
                vector_batches=vector_batches,
                checkpoint=last_checkpoint,
            )

        update_file_status(file_id, "completed", progress=100)
        complete_ingestion_job(
            file_id,
            stage="completed",
            total_chunks=total_chunks,
            indexed_chunks=processed_count,
            keyword_batches=keyword_batches,
            graph_batches=graph_batches,
            vector_batches=vector_batches,
            checkpoint={**last_checkpoint, "complete": True},
        )
        bump_project_knowledge_version(user_id, project_space_id or None, "file_ingested")

        return {"status": "success", "chunks": total_chunks}

    except Exception as e:
        if indexes_reset:
            try:
                reset_file_indexes(file_id)
                delete_file_chunks(file_id)
            except Exception as cleanup_error:
                logger.debug("Failed to cleanup partial ingestion: %s", safe_error_fields(cleanup_error))
        formatted_error = format_ingestion_error(e)
        fail_ingestion_job(file_id, formatted_error, checkpoint=last_checkpoint)
        update_file_status(file_id, "failed", error_message=formatted_error)
        raise
