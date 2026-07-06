import time
import uuid
from typing import Callable

from evaluation import evaluate_retrieval_quality
from query_planner import plan_queries
from db import list_files_for_inventory
from reranker import rerank_documents
from retrieval import retrieve_documents


RetrieveFn = Callable[[str, str, str | None, int, float], list[dict]]
RerankFn = Callable[[str, list[dict]], list[dict]]
InventoryFn = Callable[[str, str | None, int], list[dict]]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _trace_step(step_type: str, status: str, started_at_ms: int, input_data: dict, output_data: dict) -> dict:
    return {
        "step_type": step_type,
        "status": status,
        "duration_ms": max(0, _now_ms() - started_at_ms),
        "input": input_data,
        "output": output_data,
    }


def _document_key(document: dict) -> str:
    metadata = document.get("metadata") or {}
    return str(
        document.get("id")
        or f"{metadata.get('file_id', '')}:{metadata.get('chunk_index', '')}"
        or document.get("content", "")
    )


def _looks_like_inventory_query(query: str) -> bool:
    normalized = "".join(query.lower().split())
    if not normalized:
        return False

    scope_terms = ("知识库", "文档", "文件", "资料", "knowledgebase", "knowledge", "document", "documents", "file", "files")
    inventory_terms = (
        "上传了些什么",
        "上传了什么",
        "上传了哪些",
        "上传的内容",
        "上传的文档",
        "上传的文件",
        "有哪些",
        "有什么",
        "什么内容",
        "内容概览",
        "列出",
        "列表",
        "清单",
        "uploaded",
        "whatfiles",
        "whatdocuments",
        "whichfiles",
        "whichdocuments",
        "listfiles",
        "listdocuments",
    )

    return any(term in normalized for term in scope_terms) and any(term in normalized for term in inventory_terms)


def _format_file_size(size: object) -> str:
    try:
        value = int(size or 0)
    except (TypeError, ValueError):
        return "unknown"

    if value <= 0:
        return "unknown"
    if value < 1024:
        return f"{value} B"
    if value < 1024 * 1024:
        return f"{value / 1024:.1f} KB"
    return f"{value / (1024 * 1024):.1f} MB"


def _stringify_date(value: object) -> str:
    return str(value) if value else "unknown"


def _build_inventory_documents(files: list[dict]) -> list[dict]:
    documents: list[dict] = []
    for index, file_data in enumerate(files):
        file_id = str(file_data.get("id") or f"inventory-{index}")
        filename = str(file_data.get("filename") or "Untitled document")
        status = str(file_data.get("status") or "unknown")
        progress = file_data.get("progress")
        project_space_id = file_data.get("project_space_id")
        content = "\n".join([
            f"知识库文档名称: {filename}",
            f"文件状态: {status}",
            f"处理进度: {progress if progress is not None else 'unknown'}",
            f"文件大小: {_format_file_size(file_data.get('file_size'))}",
            f"上传时间: {_stringify_date(file_data.get('created_at'))}",
            f"更新时间: {_stringify_date(file_data.get('updated_at'))}",
        ])

        documents.append({
            "id": f"file:{file_id}",
            "content": content,
            "metadata": {
                "filename": filename,
                "file_id": file_id,
                "chunk_index": 0,
                "project_space_id": str(project_space_id) if project_space_id else None,
                "retrieval_mode": "metadata_inventory",
            },
            "similarity": 1.0,
            "retrieval_score": 1.0,
        })

    return documents


def _classify_question(query: str) -> dict:
    normalized = "".join(query.lower().split())
    relationship_terms = ("关系", "关联", "依赖", "影响", "链路", "为什么", "如何协作", "connect", "relate", "relationship", "depend")
    comparison_terms = ("对比", "区别", "差异", "compare", "difference")
    inventory = _looks_like_inventory_query(query)

    if inventory:
        intent_type = "inventory"
        complexity = "simple"
        routes = ["metadata"]
    elif any(term in normalized for term in relationship_terms):
        intent_type = "relationship"
        complexity = "multi_hop"
        routes = ["vector", "bm25", "graph"]
    elif any(term in normalized for term in comparison_terms):
        intent_type = "comparison"
        complexity = "multi_hop"
        routes = ["vector", "bm25", "graph"]
    else:
        intent_type = "knowledge_qa"
        complexity = "standard"
        routes = ["vector", "bm25"]

    return {
        "type": intent_type,
        "complexity": complexity,
        "routes": routes,
    }


def _build_retry_query(query: str, intent: dict) -> str:
    if intent.get("type") in {"relationship", "comparison"}:
        return f"{query} 相关实体 关系 链路 背景"
    return f"{query} 相关背景 具体说明 原文"


def _inventory_quality(document_count: int) -> dict:
    if document_count == 0:
        return {
            "retrieval_score": 0,
            "citation_score": 0,
            "evidence_score": 0,
            "overall_score": 0,
            "evidence_label": "weak",
        }

    return {
        "retrieval_score": 1,
        "citation_score": 1,
        "evidence_score": 1,
        "overall_score": 1,
        "evidence_label": "strong",
    }


def _query_overlap_score(query: str, content: str) -> float:
    query_terms = {term.lower() for term in query.replace("?", " ").replace(".", " ").split() if len(term) > 2}
    content_terms = {term.lower().strip(".,:;!?") for term in content.split() if len(term.strip(".,:;!?")) > 2}
    if not query_terms:
        return 0.0
    return len(query_terms & content_terms) / len(query_terms)


def default_rerank_documents(query: str, documents: list[dict]) -> list[dict]:
    return rerank_documents(query, documents)


def _build_answer_guidance(quality: dict) -> tuple[bool, str]:
    insufficient_evidence = (
        quality.get("evidence_label") == "weak"
        or float(quality.get("overall_score") or 0) < 0.35
    )

    if not insufficient_evidence:
        return False, ""

    return True, (
        "Retrieved evidence is weak. Answer cautiously, state what is unsupported, "
        "and ask for more source material if the answer cannot be grounded."
    )


def agentic_retrieve(
    query: str,
    user_id: str,
    project_space_id: str | None = None,
    limit: int = 5,
    threshold: float = 0.1,
    retrieve_fn: RetrieveFn = retrieve_documents,
    rerank_fn: RerankFn = default_rerank_documents,
    inventory_fn: InventoryFn = list_files_for_inventory,
) -> dict:
    run_id = str(uuid.uuid4())
    trace_steps: list[dict] = []

    if _looks_like_inventory_query(query):
        intent = _classify_question(query)
        started_at = _now_ms()
        inventory_limit = min(max(limit, 20), 100)
        trace_steps.append(_trace_step(
            "intent_route",
            "success",
            started_at,
            {"query": query},
            {"route": "metadata_inventory", "limit": inventory_limit},
        ))

        started_at = _now_ms()
        files = inventory_fn(user_id, project_space_id, inventory_limit)
        documents = _build_inventory_documents(files)
        trace_steps.append(_trace_step(
            "metadata_lookup",
            "success",
            started_at,
            {"user_id": user_id, "project_space_id": project_space_id, "limit": inventory_limit},
            {"file_count": len(files)},
        ))

        started_at = _now_ms()
        quality = _inventory_quality(len(documents))
        insufficient_evidence, answer_guidance = _build_answer_guidance(quality)
        if documents:
            answer_guidance = (
                "Use the document inventory context to answer. List the uploaded documents by filename "
                "and mention processing status if useful."
            )
        trace_steps.append(_trace_step(
            "evidence_check",
            "partial" if insufficient_evidence else "success",
            started_at,
            {"selected_count": len(documents)},
            {**quality, "insufficient_evidence": insufficient_evidence},
        ))

        return {
            "run_id": run_id,
            "mode": "metadata_inventory",
            "intent": intent,
            "planned_queries": [query],
            "results": documents,
            "trace_steps": trace_steps,
            "quality": quality,
            "insufficient_evidence": insufficient_evidence,
            "answer_guidance": answer_guidance,
        }

    started_at = _now_ms()
    intent = _classify_question(query)
    trace_steps.append(_trace_step(
        "question_classify",
        "success",
        started_at,
        {"query": query},
        intent,
    ))

    started_at = _now_ms()
    trace_steps.append(_trace_step(
        "retriever_route",
        "success",
        started_at,
        {"intent": intent["type"], "complexity": intent["complexity"]},
        {"routes": intent["routes"]},
    ))

    started_at = _now_ms()
    planned_queries = plan_queries(query, max_queries=3)
    trace_steps.append(_trace_step(
        "query_rewrite",
        "success",
        started_at,
        {"query": query, "max_queries": 3},
        {"planned_queries": planned_queries},
    ))

    merged_by_key: dict[str, dict] = {}
    retrieve_limit = min(max(limit * 2, limit), 20)
    for planned_query in planned_queries:
        started_at = _now_ms()
        documents = retrieve_fn(planned_query, user_id, project_space_id, retrieve_limit, threshold)
        trace_steps.append(_trace_step(
            "retrieve",
            "success",
            started_at,
            {"query": planned_query, "limit": retrieve_limit, "threshold": threshold},
            {
                "hit_count": len(documents),
                "top_similarity": max([float(doc.get("similarity") or 0) for doc in documents] or [0]),
            },
        ))

        for document in documents:
            key = _document_key(document)
            current = merged_by_key.get(key)
            if not current or float(document.get("similarity") or 0) > float(current.get("similarity") or 0):
                merged = dict(document)
                merged["matched_queries"] = sorted(set((current or {}).get("matched_queries", []) + [planned_query]))
                merged_by_key[key] = merged
            elif current:
                current["matched_queries"] = sorted(set(current.get("matched_queries", []) + [planned_query]))

    if not merged_by_key:
        retry_query = _build_retry_query(query, intent)
        planned_queries.append(retry_query)
        started_at = _now_ms()
        documents = retrieve_fn(retry_query, user_id, project_space_id, retrieve_limit, threshold)
        trace_steps.append(_trace_step(
            "retrieve_retry",
            "success" if documents else "partial",
            started_at,
            {"query": retry_query, "limit": retrieve_limit, "threshold": threshold},
            {
                "hit_count": len(documents),
                "top_similarity": max([float(doc.get("similarity") or 0) for doc in documents] or [0]),
            },
        ))
        for document in documents:
            key = _document_key(document)
            merged = dict(document)
            merged["matched_queries"] = [retry_query]
            merged_by_key[key] = merged

    started_at = _now_ms()
    reranker_name = "local-overlap" if rerank_fn is default_rerank_documents else "custom"
    ranked_documents = rerank_fn(query, list(merged_by_key.values()))
    selected_documents = ranked_documents[:limit]
    trace_steps.append(_trace_step(
        "rerank",
        "success",
        started_at,
        {"candidate_count": len(ranked_documents), "limit": limit},
        {
            "reranker": reranker_name,
            "selected_count": len(selected_documents),
            "selected_ids": [document.get("id") for document in selected_documents],
        },
    ))

    started_at = _now_ms()
    quality = evaluate_retrieval_quality(query, selected_documents)
    insufficient_evidence, answer_guidance = _build_answer_guidance(quality)
    trace_steps.append(_trace_step(
        "evidence_check",
        "partial" if insufficient_evidence else "success",
        started_at,
        {"selected_count": len(selected_documents)},
        {**quality, "insufficient_evidence": insufficient_evidence},
    ))

    return {
        "run_id": run_id,
        "mode": "agentic",
        "intent": intent,
        "planned_queries": planned_queries,
        "results": selected_documents,
        "trace_steps": trace_steps,
        "quality": quality,
        "insufficient_evidence": insufficient_evidence,
        "answer_guidance": answer_guidance,
    }
