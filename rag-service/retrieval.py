from db import get_chunks_by_ids, search_chunks_by_text
from embeddings import get_embedding
from vector_store import search_vectors


def _prepare_chunk_result(chunk: dict, similarity: float, lexical_score: float, retrieval_score: float, retrieval_mode: str):
    metadata = chunk.get("metadata") or {}
    chunk_project_space_id = chunk.get("project_space_id")
    metadata.update({
        "filename": chunk.get("filename") or metadata.get("filename"),
        "file_id": str(chunk.get("file_id") or metadata.get("file_id") or ""),
        "chunk_index": chunk.get("chunk_index"),
        "project_space_id": str(chunk_project_space_id) if chunk_project_space_id else None,
        "retrieval_mode": retrieval_mode,
        "vector_similarity": similarity,
        "lexical_score": lexical_score,
    })

    return {
        "id": str(chunk["id"]),
        "content": chunk["content"],
        "metadata": metadata,
        "similarity": retrieval_score,
        "vector_similarity": similarity,
        "lexical_score": lexical_score,
        "retrieval_score": retrieval_score,
    }


def retrieve_documents(
    query: str,
    user_id: str,
    project_space_id: str | None = None,
    limit: int = 5,
    threshold: float = 0.1,
    hybrid: bool = True,
):
    search_limit = min(max(limit * 5, limit), 50) if project_space_id else limit
    vector_hits = []
    vector_error: Exception | None = None

    try:
        embedding = get_embedding(query)
        vector_hits = search_vectors(
            user_id=user_id,
            embedding=embedding,
            limit=search_limit,
            threshold=threshold,
            project_space_id=project_space_id,
        )
    except Exception as error:
        vector_error = error
        if not hybrid:
            raise

    lexical_hits = search_chunks_by_text(
        query=query,
        user_id=user_id,
        project_space_id=project_space_id,
        limit=min(max(limit * 5, limit), 50),
    ) if hybrid else []

    if not vector_hits and not lexical_hits:
        if vector_error and not hybrid:
            raise vector_error
        return []

    chunks = get_chunks_by_ids([hit["chunk_id"] for hit in vector_hits])
    chunks_by_id = {str(chunk["id"]): chunk for chunk in chunks}
    max_lexical_score = max([float(hit.get("lexical_score") or 0) for hit in lexical_hits] or [0])
    merged_by_id: dict[str, dict] = {}

    for hit in vector_hits:
        chunk = chunks_by_id.get(str(hit["chunk_id"]))
        if not chunk:
            continue
        chunk_project_space_id = chunk.get("project_space_id")
        if project_space_id and str(chunk_project_space_id) != project_space_id:
            continue

        chunk = dict(chunk)
        chunk["filename"] = hit.get("filename") or (chunk.get("metadata") or {}).get("filename")
        metadata = dict(chunk.get("metadata") or {})
        chunk["metadata"] = metadata
        metadata.update({
            "filename": hit.get("filename") or metadata.get("filename"),
            "file_id": hit.get("file_id"),
            "chunk_index": hit.get("chunk_index"),
            "project_space_id": str(chunk_project_space_id) if chunk_project_space_id else None,
        })

        chunk_id = str(chunk["id"])
        merged_by_id[chunk_id] = {
            "chunk": chunk,
            "vector_similarity": float(hit.get("similarity") or 0),
            "lexical_score": 0.0,
        }

    for hit in lexical_hits:
        chunk_id = str(hit["id"])
        if project_space_id and str(hit.get("project_space_id")) != project_space_id:
            continue

        current = merged_by_id.get(chunk_id)
        if not current:
            current = {
                "chunk": dict(hit),
                "vector_similarity": 0.0,
                "lexical_score": 0.0,
            }
            merged_by_id[chunk_id] = current

        current["lexical_score"] = max(
            float(current.get("lexical_score") or 0),
            float(hit.get("lexical_score") or 0),
        )

    results = []
    for item in merged_by_id.values():
        vector_similarity = float(item.get("vector_similarity") or 0)
        lexical_score = float(item.get("lexical_score") or 0)
        normalized_lexical_score = lexical_score / max_lexical_score if max_lexical_score > 0 else 0
        retrieval_score = round(vector_similarity * 0.72 + normalized_lexical_score * 0.28, 4)
        if vector_similarity > 0 and lexical_score > 0:
            retrieval_mode = "hybrid"
        elif lexical_score > 0:
            retrieval_mode = "lexical"
        else:
            retrieval_mode = "vector"

        results.append(_prepare_chunk_result(
            item["chunk"],
            similarity=vector_similarity,
            lexical_score=round(lexical_score, 4),
            retrieval_score=retrieval_score,
            retrieval_mode=retrieval_mode,
        ))

    return sorted(results, key=lambda result: result["retrieval_score"], reverse=True)[:limit]
