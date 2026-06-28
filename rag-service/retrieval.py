from db import get_chunks_by_ids
from embeddings import get_embedding
from vector_store import search_vectors


def retrieve_documents(query: str, user_id: str, limit: int = 5, threshold: float = 0.1):
    embedding = get_embedding(query)
    hits = search_vectors(user_id=user_id, embedding=embedding, limit=limit, threshold=threshold)

    if not hits:
        return []

    chunks = get_chunks_by_ids([hit["chunk_id"] for hit in hits])
    chunks_by_id = {str(chunk["id"]): chunk for chunk in chunks}

    results = []
    for hit in hits:
        chunk = chunks_by_id.get(str(hit["chunk_id"]))
        if not chunk:
            continue

        metadata = chunk.get("metadata") or {}
        metadata.update({
            "filename": hit.get("filename") or metadata.get("filename"),
            "file_id": hit.get("file_id"),
            "chunk_index": hit.get("chunk_index"),
        })

        results.append({
            "id": str(chunk["id"]),
            "content": chunk["content"],
            "metadata": metadata,
            "similarity": hit["similarity"],
        })

    return results
