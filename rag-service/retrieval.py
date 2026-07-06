from db import get_chunks_by_ids, search_chunks_by_text
from embeddings import get_embedding
from fusion import reciprocal_rank_fuse
from graph_store import search_graph
from keyword_store import search_keyword_chunks
from vector_store import search_vectors


def _prepare_chunk_result(
    chunk: dict,
    similarity: float,
    lexical_score: float,
    retrieval_score: float,
    retrieval_mode: str,
    rrf_score: float = 0.0,
    retrieval_channels: list[str] | None = None,
    channel_ranks: dict | None = None,
    channel_scores: dict | None = None,
):
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
        "rrf_score": rrf_score,
        "retrieval_channels": retrieval_channels or [],
        "channel_ranks": channel_ranks or {},
        "channel_scores": channel_scores or {},
    })

    return {
        "id": str(chunk["id"]),
        "content": chunk["content"],
        "metadata": metadata,
        "similarity": retrieval_score,
        "vector_similarity": similarity,
        "lexical_score": lexical_score,
        "retrieval_score": retrieval_score,
        "rrf_score": rrf_score,
        "retrieval_channels": retrieval_channels or [],
        "channel_ranks": channel_ranks or {},
        "channel_scores": channel_scores or {},
    }


def _vector_documents_from_hits(vector_hits: list[dict], project_space_id: str | None) -> list[dict]:
    chunks = get_chunks_by_ids([hit["chunk_id"] for hit in vector_hits])
    chunks_by_id = {str(chunk["id"]): chunk for chunk in chunks}
    documents = []

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
        chunk["similarity"] = float(hit.get("similarity") or 0)
        chunk["retrieval_score"] = chunk["similarity"]
        documents.append(chunk)

    return documents


def _keyword_documents(query: str, user_id: str, project_space_id: str | None, limit: int) -> list[dict]:
    keyword_hits = search_keyword_chunks(
        query=query,
        user_id=user_id,
        project_space_id=project_space_id,
        limit=limit,
    )

    if not keyword_hits:
        keyword_hits = search_chunks_by_text(
            query=query,
            user_id=user_id,
            project_space_id=project_space_id,
            limit=limit,
        )

    max_lexical_score = max([float(hit.get("lexical_score") or 0) for hit in keyword_hits] or [0])
    documents = []
    for hit in keyword_hits:
        if project_space_id and str(hit.get("project_space_id")) != project_space_id:
            continue

        document = dict(hit)
        lexical_score = float(hit.get("lexical_score") or 0)
        document["similarity"] = 0.0
        document["retrieval_score"] = lexical_score / max_lexical_score if max_lexical_score > 0 else 0.0
        documents.append(document)

    return documents


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

    vector_documents = _vector_documents_from_hits(vector_hits, project_space_id)
    keyword_documents = _keyword_documents(
        query=query,
        user_id=user_id,
        project_space_id=project_space_id,
        limit=min(max(limit * 5, limit), 50),
    ) if hybrid else []
    try:
        graph_documents = search_graph(
            query=query,
            user_id=user_id,
            project_space_id=project_space_id,
            limit=min(max(limit * 3, limit), 30),
        ) if hybrid else []
    except Exception:
        graph_documents = []

    if not vector_documents and not keyword_documents and not graph_documents:
        if vector_error and not hybrid:
            raise vector_error
        return []

    fused_documents = reciprocal_rank_fuse([
        ("vector", vector_documents),
        ("bm25", keyword_documents),
        ("graph", graph_documents),
    ])
    active_retriever_count = sum(1 for documents in (vector_documents, keyword_documents, graph_documents) if documents)

    results = []
    for document in fused_documents:
        vector_similarity = float((document.get("channel_scores") or {}).get("vector") or document.get("similarity") or 0)
        lexical_score = float((document.get("channel_scores") or {}).get("bm25") or document.get("lexical_score") or 0)
        rrf_score = float(document.get("rrf_score") or 0)
        retrieval_score = round(rrf_score, 6)
        channels = document.get("retrieval_channels") or []
        if active_retriever_count > 1:
            retrieval_mode = "hybrid_rrf"
        elif "graph" in channels:
            retrieval_mode = "graph"
        elif "bm25" in channels:
            retrieval_mode = "lexical"
        else:
            retrieval_mode = "vector"

        results.append(_prepare_chunk_result(
            document,
            similarity=vector_similarity,
            lexical_score=round(lexical_score, 4),
            retrieval_score=retrieval_score,
            retrieval_mode=retrieval_mode,
            rrf_score=rrf_score,
            retrieval_channels=channels,
            channel_ranks=document.get("channel_ranks") or {},
            channel_scores=document.get("channel_scores") or {},
        ))

    return sorted(results, key=lambda result: result["retrieval_score"], reverse=True)[:limit]
