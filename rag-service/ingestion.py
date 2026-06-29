from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter

from db import get_file, replace_file_chunks, update_file_progress, update_file_status
from embeddings import get_embeddings
from storage import download_object
from vector_store import delete_file_vectors, insert_vectors


EMBEDDING_BATCH_SIZE = 10


def format_ingestion_error(error: Exception) -> str:
    message = str(error)
    if "1113" in message or "余额不足或无可用资源包" in message:
        return "百炼 embedding 额度不足或无可用资源包，请充值或购买资源包后点击重试。"
    if "batch size is invalid" in message:
        return "Embedding 批量大小超过服务限制，请稍后重试。"
    return message


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


def process_file(file_id: str):
    try:
        update_file_status(file_id, "processing", progress=0)

        file_data = get_file(file_id)
        if not file_data:
            raise ValueError(f"File {file_id} not found")

        object_key = file_data.get("object_key")
        if not object_key:
            raise ValueError(f"File {file_id} has no object_key")

        file_type = file_data.get("file_type")
        user_id = str(file_data["user_id"])
        project_space_id = str(file_data.get("project_space_id")) if file_data.get("project_space_id") else ""
        file_bytes = download_object(object_key)

        text_content, is_markdown = extract_text(file_bytes, file_type, object_key)

        if not text_content.strip():
            raise ValueError("File content is empty")

        chunks = split_text(text_content, is_markdown)
        total_chunks = len(chunks)
        if total_chunks == 0:
            raise ValueError("File produced no chunks")

        delete_file_vectors(file_id)
        chunk_rows = replace_file_chunks(file_id, user_id, chunks, file_data)

        batch_size = EMBEDDING_BATCH_SIZE
        processed_count = 0

        for i in range(0, total_chunks, batch_size):
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

            processed_count += len(batch_rows)
            progress = int((processed_count / total_chunks) * 100)
            update_file_progress(file_id, progress)

        update_file_status(file_id, "completed", progress=100)

        return {"status": "success", "chunks": total_chunks}

    except Exception as e:
        update_file_status(file_id, "failed", error_message=format_ingestion_error(e))
        raise
