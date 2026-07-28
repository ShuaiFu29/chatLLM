import codecs
import hashlib
import logging
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO

from config import settings
from converted_document import DocumentConversionError
from converted_ingestion import ConvertedIngestionError, split_converted_document
from converters import ConversionLimits, get_converter
from converters.base import CONVERTER_VERSION
from db import (
    IngestionLeaseLostError,
    activate_conversion_generation_and_complete_ingestion_job,
    assert_ingestion_lease,
    bump_project_knowledge_version,
    complete_conversion_generation,
    complete_ingestion_job,
    create_or_reuse_conversion_generation,
    delete_file_chunks,
    fail_conversion_generation,
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
from langchain_text_splitters import (
    MarkdownHeaderTextSplitter,
    RecursiveCharacterTextSplitter,
)
from safe_errors import safe_error_fields
from storage import (
    StorageError,
    build_derived_artifact_key,
    cleanup_object_keys,
    download_object,
    download_object_to_file,
    stream_object_bytes,
    upload_derived_artifacts,
)
from vector_store import delete_file_vectors, insert_vectors

logger = logging.getLogger(__name__)

_MARKDOWN_HEADING_KEYS = tuple((level, f"Header {level}") for level in range(1, 7))
_MARKDOWN_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)\s*$")
_MARKDOWN_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_DOCUMENT_MAX_SOURCE_BYTES = {
    "markdown": 100 * 1024 * 1024,
    "plaintext": 32 * 1024 * 1024,
    "pdf": 50 * 1024 * 1024,
    "docx": 32 * 1024 * 1024,
    "pptx": 32 * 1024 * 1024,
    "xlsx": 32 * 1024 * 1024,
    "csv": 32 * 1024 * 1024,
}
_DOCUMENT_EXTENSIONS = {
    "markdown": ".md",
    "plaintext": ".txt",
    "pdf": ".pdf",
    "docx": ".docx",
    "pptx": ".pptx",
    "xlsx": ".xlsx",
    "csv": ".csv",
}
_DOCUMENT_MIME_TYPES = {
    "markdown": "text/markdown",
    "plaintext": "text/plain",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv",
}


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
    if isinstance(error, DocumentConversionError):
        if error.code == "PDF_HAS_NO_EXTRACTABLE_TEXT":
            return "PDF has no extractable text layer; OCR is not enabled"
        if error.code == "PDF_ENCRYPTED":
            return "Encrypted PDF documents are not supported"
        if error.code in {"MACRO_ENABLED_DOCUMENT_UNSUPPORTED", "DOCX_MACROS_NOT_ALLOWED"}:
            return "Macro-enabled Office documents are not supported"
        return "Document conversion failed"
    if isinstance(error, ConvertedIngestionError):
        return "Converted document provenance validation failed"
    if isinstance(error, StorageError):
        if error.code == "OBJECT_INTEGRITY_MISMATCH":
            return "Uploaded object integrity check failed"
        return "Document storage operation failed"
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
        or normalized_key.endswith((".md", ".markdown"))
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

    yield from iter_streaming_markdown_chunks(verified_byte_chunks())

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


def _conversion_error_code(error: Exception) -> str:
    if isinstance(error, (DocumentConversionError, ConvertedIngestionError, StorageError)):
        code = str(error.code or "").strip().upper()
        if re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", code):
            return code
    return "DOCUMENT_PROCESSING_FAILED"


def _conversion_profile(file_data: dict, document_kind: str) -> str:
    profile = str(file_data.get("conversion_profile") or "").strip()
    if profile:
        return profile
    return {
        "markdown": "markdown-v1",
        "plaintext": "plaintext-v1",
        "pdf": "pdf-text-v1",
        "docx": "docx-v1",
        "pptx": "pptx-v1",
        "xlsx": "xlsx-v1",
        "csv": "csv-v1",
    }[document_kind]


def _validate_conversion_result(result, file_data: dict, source_integrity, converter) -> None:
    manifest = result.manifest
    expected_kind = str(file_data["document_kind"])
    expected_profile = _conversion_profile(file_data, expected_kind)
    if manifest.document_kind != expected_kind:
        raise DocumentConversionError(
            "CONVERSION_KIND_MISMATCH",
            "converter output kind does not match the reserved document kind",
        )
    if manifest.conversion_profile != expected_profile:
        raise DocumentConversionError(
            "CONVERSION_PROFILE_MISMATCH",
            "converter output profile does not match the reserved conversion profile",
        )
    if manifest.converter_name != converter.converter_name:
        raise DocumentConversionError(
            "CONVERTER_IDENTITY_MISMATCH",
            "converter output identity does not match the selected converter",
        )
    if manifest.source_sha256 != source_integrity.sha256:
        raise DocumentConversionError(
            "CONVERSION_SOURCE_HASH_MISMATCH",
            "converter output source hash does not match the downloaded original",
        )


def process_converted_file(
    file_id: str,
    attempt_id,
    lease_token,
    file_data: dict,
):
    document_kind = str(file_data.get("document_kind") or "").strip()
    if document_kind not in _DOCUMENT_MAX_SOURCE_BYTES:
        raise DocumentConversionError(
            "UNSUPPORTED_DOCUMENT_TYPE",
            "reserved document kind is not supported by the local conversion pipeline",
        )
    object_key = str(file_data.get("object_key") or "").strip()
    if not object_key:
        raise ValueError(f"File {file_id} has no object_key")
    user_id = str(file_data["user_id"])
    project_space_id = (
        str(file_data.get("project_space_id")) if file_data.get("project_space_id") else ""
    )
    generation_id = str(attempt_id)
    conversion_profile = _conversion_profile(file_data, document_kind)
    expected_hash = str(file_data.get("file_hash") or "").strip().lower() or None
    expected_size = int(file_data["file_size"]) if file_data.get("file_size") is not None else None
    created_artifact_keys: list[str] = []
    generation_bound = False
    generation_completed = False
    generation_completion_attempted = False
    indexes_reset = False

    with tempfile.TemporaryDirectory(prefix="chatllm-conversion-") as temporary_directory:
        workspace = Path(temporary_directory)
        source_suffix = Path(str(file_data.get("filename") or "")).suffix.lower()
        if source_suffix not in {".md", ".markdown", ".txt", ".pdf", ".docx", ".pptx", ".xlsx", ".csv"}:
            source_suffix = _DOCUMENT_EXTENSIONS[document_kind]
        source_path = workspace / f"original{source_suffix}"
        output_path = workspace / "derived"

        update_ingestion_job_checkpoint(
            file_id,
            attempt_id,
            lease_token,
            stage="staging_original",
            progress=4,
            checkpoint={"mode": "converted", "document_kind": document_kind},
        )
        source_integrity = download_object_to_file(
            object_key,
            source_path,
            expected_sha256=expected_hash,
            expected_size=expected_size,
        )
        assert_ingestion_lease(file_id, attempt_id, lease_token)

        converter = get_converter(
            source_path,
            ConversionLimits(max_source_bytes=_DOCUMENT_MAX_SOURCE_BYTES[document_kind]),
        )
        if converter.document_kind != document_kind or converter.conversion_profile != conversion_profile:
            raise DocumentConversionError(
                "CONVERTER_ROUTING_MISMATCH",
                "selected converter does not match the reserved document interpretation",
            )
        artifact_keys = {
            role: build_derived_artifact_key(user_id, file_id, generation_id, role)
            for role in ("document", "source_map", "manifest")
        }
        create_or_reuse_conversion_generation(
            file_id,
            attempt_id,
            lease_token,
            generation_id=generation_id,
            document_kind=document_kind,
            source_object_key=object_key,
            markdown_object_key=artifact_keys["document"],
            source_map_object_key=artifact_keys["source_map"],
            manifest_object_key=artifact_keys["manifest"],
            converter_name=converter.converter_name,
            converter_version=CONVERTER_VERSION,
            conversion_profile=conversion_profile,
            source_hash=source_integrity.sha256,
        )
        generation_bound = True

        try:
            update_ingestion_job_checkpoint(
                file_id,
                attempt_id,
                lease_token,
                stage="converting_document",
                progress=10,
                checkpoint={
                    "mode": "converted",
                    "document_kind": document_kind,
                    "conversion_generation_id": generation_id,
                    "source_bytes": source_integrity.byte_size,
                },
            )
            conversion = converter.convert(source_path, output_path)
            _validate_conversion_result(conversion, file_data, source_integrity, converter)
            assert_ingestion_lease(file_id, attempt_id, lease_token)

            update_ingestion_job_checkpoint(
                file_id,
                attempt_id,
                lease_token,
                stage="publishing_conversion_artifacts",
                progress=18,
                checkpoint={
                    "mode": "converted",
                    "conversion_generation_id": generation_id,
                    "unit_count": conversion.manifest.unit_count,
                },
            )
            uploads = upload_derived_artifacts(
                {
                    "document": conversion.document.path,
                    "source_map": conversion.source_map.path,
                    "manifest": conversion.manifest_artifact.path,
                },
                user_id=user_id,
                file_id=file_id,
                generation_id=generation_id,
            )
            created_artifact_keys = [upload.key for upload in uploads.values() if upload.created]
            if (
                uploads["document"].integrity.sha256 != conversion.document.sha256
                or uploads["source_map"].integrity.sha256 != conversion.source_map.sha256
                or uploads["manifest"].integrity.sha256 != conversion.manifest_artifact.sha256
            ):
                raise StorageError(
                    "ARTIFACT_UPLOAD_MISMATCH",
                    "published conversion artifacts do not match local conversion output",
            )
            assert_ingestion_lease(file_id, attempt_id, lease_token)
            generation_completion_attempted = True
            complete_conversion_generation(
                file_id,
                generation_id,
                attempt_id,
                lease_token,
                markdown_hash=conversion.document.sha256,
                source_map_hash=conversion.source_map.sha256,
                manifest_hash=conversion.manifest_artifact.sha256,
                markdown_byte_size=conversion.document.byte_size,
                source_map_byte_size=conversion.source_map.byte_size,
                manifest_byte_size=conversion.manifest_artifact.byte_size,
                warning_count=len(conversion.manifest.warnings),
                unit_count=conversion.manifest.unit_count,
            )
            generation_completed = True
        except Exception as error:
            if not generation_completion_attempted:
                cleanup_object_keys(reversed(created_artifact_keys), suppress_errors=True)
            if generation_bound and not generation_completed:
                try:
                    fail_conversion_generation(
                        file_id,
                        generation_id,
                        attempt_id,
                        lease_token,
                        _conversion_error_code(error),
                    )
                except IngestionLeaseLostError:
                    raise
                except Exception as generation_error:  # noqa: BLE001 - failure recording is best effort
                    logger.debug(
                        "Failed to record conversion generation failure: %s",
                        safe_error_fields(generation_error),
                    )
            raise

        update_ingestion_job_checkpoint(
            file_id,
            attempt_id,
            lease_token,
            stage="validating_source_map",
            progress=24,
            checkpoint={
                "mode": "converted",
                "conversion_generation_id": generation_id,
            },
        )
        chunks = split_converted_document(
            conversion.document.path.read_bytes(),
            conversion.source_map.path.read_bytes(),
        )
        total_chunks = len(chunks)
        indexed_file_data = {
            **file_data,
            "conversion_generation_id": generation_id,
            "conversion_profile": conversion_profile,
        }

        try:
            update_ingestion_job_checkpoint(
                file_id,
                attempt_id,
                lease_token,
                stage="resetting_indexes",
                progress=30,
                total_chunks=total_chunks,
                checkpoint={
                    "mode": "converted",
                    "conversion_generation_id": generation_id,
                    "total_chunks": total_chunks,
                },
            )
            indexes_reset = True
            reset_file_indexes(file_id)
            assert_ingestion_lease(file_id, attempt_id, lease_token)
            chunk_rows = replace_file_chunks(
                file_id,
                user_id,
                chunks,
                indexed_file_data,
            )
            processed_count = 0
            keyword_batches = 0
            vector_batches = 0
            graph_status = "pending"
            batch_size = settings.rag_ingest_chunk_batch_size
            with graph_file_transaction() as graph_transaction:
                for index in range(0, total_chunks, batch_size):
                    assert_ingestion_lease(file_id, attempt_id, lease_token)
                    batch_rows = chunk_rows[index : index + batch_size]
                    batch_stats = index_chunk_batch(
                        indexed_file_data,
                        batch_rows,
                        project_space_id,
                        graph_transaction,
                    )
                    processed_count += batch_stats["indexed_chunks"]
                    keyword_batches += batch_stats["keyword_batches"]
                    vector_batches += batch_stats["vector_batches"]
                    graph_status = batch_stats["graph_status"]
                    update_ingestion_job_checkpoint(
                        file_id,
                        attempt_id,
                        lease_token,
                        stage="indexing_vectors",
                        progress=min(95, 30 + int((processed_count / total_chunks) * 65)),
                        total_chunks=total_chunks,
                        indexed_chunks=processed_count,
                        keyword_batches=keyword_batches,
                        graph_batches=graph_transaction.committed_batches,
                        vector_batches=vector_batches,
                        checkpoint={
                            "mode": "converted",
                            "conversion_generation_id": generation_id,
                            "indexed_chunks": processed_count,
                            "total_chunks": total_chunks,
                            "graph_status": graph_status,
                        },
                    )
                assert_ingestion_lease(file_id, attempt_id, lease_token)

            graph_batches = graph_transaction.committed_batches
            graph_status = graph_transaction.status
            assert_ingestion_lease(file_id, attempt_id, lease_token)
            activation = activate_conversion_generation_and_complete_ingestion_job(
                file_id,
                generation_id,
                attempt_id,
                lease_token,
                total_chunks=total_chunks,
                indexed_chunks=processed_count,
                keyword_batches=keyword_batches,
                graph_batches=graph_batches,
                vector_batches=vector_batches,
                checkpoint={
                    "mode": "converted",
                    "conversion_generation_id": generation_id,
                    "indexed_chunks": processed_count,
                    "total_chunks": total_chunks,
                    "graph_status": graph_status,
                    "complete": True,
                },
                detected_mime_type=_DOCUMENT_MIME_TYPES[document_kind],
            )
            return {
                "status": "success",
                "chunks": processed_count,
                "conversion_generation_id": activation["conversion_generation_id"],
            }
        except Exception:
            if indexes_reset:
                try:
                    reset_file_indexes(file_id)
                    assert_ingestion_lease(file_id, attempt_id, lease_token)
                    delete_file_chunks(file_id)
                except Exception as cleanup_error:  # noqa: BLE001 - cleanup spans independent backends
                    logger.debug(
                        "Failed to cleanup partial converted ingestion: %s",
                        safe_error_fields(cleanup_error),
                    )
            raise


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

        if file_data.get("document_kind"):
            return process_converted_file(
                file_id,
                attempt_id,
                lease_token,
                file_data,
            )

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
            except Exception as cleanup_error:  # noqa: BLE001 - cleanup spans independent backends
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
