import re
import time
import uuid
from typing import Callable

from evaluation import evaluate_retrieval_quality
from evidence_verifier import assess_query_risk, verify_evidence_support
from query_planner import plan_queries
from db import list_files_for_inventory
from reranker import classify_source_role, query_requests_evaluation_guide, rerank_documents
from retrieval import retrieve_documents
from retrieval_cache import (
    CONVERSATION_EVIDENCE_THRESHOLD,
    SIMILAR_QUERY_THRESHOLD,
    RetrievalCacheStore,
    cache_entry_is_reusable,
    normalize_query,
)


RetrieveFn = Callable[[str, str, str | None, int, float], list[dict]]
RerankFn = Callable[[str, list[dict]], list[dict]]
InventoryFn = Callable[[str, str | None, int], list[dict]]

INVENTORY_RESULT_LIMIT = 500


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


def _source_key(document: dict) -> str:
    metadata = document.get("metadata") or {}
    return str(metadata.get("file_id") or metadata.get("filename") or document.get("id") or "")


def _retrieval_channel_summary(documents: list[dict]) -> dict:
    channel_counts: dict[str, int] = {}
    mode_counts: dict[str, int] = {}
    source_ids: set[str] = set()

    for document in documents:
        metadata = document.get("metadata") or {}
        channels = document.get("retrieval_channels") or metadata.get("retrieval_channels") or []
        if isinstance(channels, str):
            channels = [channels]
        for channel in channels:
            channel_key = str(channel or "").strip()
            if channel_key:
                channel_counts[channel_key] = channel_counts.get(channel_key, 0) + 1

        mode = str(metadata.get("retrieval_mode") or document.get("retrieval_mode") or "").strip()
        if mode:
            mode_counts[mode] = mode_counts.get(mode, 0) + 1

        source_key = _source_key(document)
        if source_key:
            source_ids.add(source_key)

    return {
        "channel_counts": dict(sorted(channel_counts.items())),
        "mode_counts": dict(sorted(mode_counts.items())),
        "unique_source_count": len(source_ids),
    }


def _document_facet(document: dict) -> str:
    metadata = document.get("metadata") or {}
    explicit_domain = str(metadata.get("source_domain") or "").strip().lower()
    if explicit_domain:
        return explicit_domain

    filename = str(metadata.get("filename") or document.get("filename") or "").lower()
    content = str(document.get("content") or "").lower()

    filename_markers = [
        ("model", ("model", "triage", "change", "feature", "模型", "特征")),
        ("privacy", ("patient", "consent", "privacy", "cn-er", "eu-hds", "cross-border", "患者", "授权", "跨境")),
        ("payment", ("payment", "insurance", "claim", "clinical", "lab", "quality", "医保", "支付", "临床", "检验", "质控")),
        ("operations", ("sre", "incident", "observability", "cyber", "redteam", "事故", "安全", "观测")),
        ("governance", ("governance", "audit", "retention", "board", "deprecation", "conflict", "vendor", "审计", "董事会", "法律保全", "废止")),
        ("regional", ("regional", "appendix", "asia", "eu", "us-state", "区域", "附件", "欧盟", "亚洲")),
    ]
    for facet, markers in filename_markers:
        if any(marker in filename for marker in markers):
            return facet

    content_markers = [
        ("model", ("model", "模型", "triage", "change", "feature", "drift", "特征")),
        ("privacy", ("patient", "consent", "privacy", "cn-er", "eu-hds", "cross-border", "患者", "授权", "跨境", "假名化")),
        ("payment", ("payment", "insurance", "claim", "clinical", "lab", "quality", "医保", "支付", "临床", "检验", "质控")),
        ("operations", ("sre", "incident", "observability", "cyber", "redteam", "事故", "扩容", "取证", "安全", "观测")),
        ("governance", ("governance", "audit", "retention", "board", "deprecation", "conflict", "vendor", "审计", "董事会", "法律保全", "废止")),
        ("regional", ("regional", "appendix", "asia", "eu", "us-state", "区域", "附件", "欧盟", "亚洲")),
    ]

    for facet, markers in content_markers:
        if any(marker in content for marker in markers):
            return facet
    return "general"


def _select_diverse_documents(ranked_documents: list[dict], limit: int, query: str = "") -> list[dict]:
    if limit <= 0:
        return []

    primary_documents = [document for document in ranked_documents if classify_source_role(document) != "evaluation_guide"]
    guide_documents = [document for document in ranked_documents if classify_source_role(document) == "evaluation_guide"]
    guide_requested = query_requests_evaluation_guide(query)
    ordered_documents = ranked_documents if guide_requested else primary_documents + guide_documents

    selected: list[dict] = []
    selected_keys: set[str] = set()
    selected_document_keys: set[str] = set()

    if limit >= 4 and not guide_requested:
        selected_facets: set[str] = set()
        available_facets = {_document_facet(document) for document in primary_documents}
        target_facet_count = min(limit, len(available_facets), 6)
        for document in primary_documents:
            source_key = _source_key(document)
            document_key = _document_key(document)
            facet = _document_facet(document)
            if (
                source_key in selected_keys
                or document_key in selected_document_keys
                or facet in selected_facets
            ):
                continue
            selected.append(document)
            selected_keys.add(source_key)
            selected_document_keys.add(document_key)
            selected_facets.add(facet)
            if len(selected) >= target_facet_count:
                break

    for document in ordered_documents:
        source_key = _source_key(document)
        document_key = _document_key(document)
        if source_key in selected_keys or document_key in selected_document_keys:
            continue
        selected.append(document)
        selected_keys.add(source_key)
        selected_document_keys.add(document_key)
        if len(selected) >= limit:
            return selected

    for document in ordered_documents:
        document_key = _document_key(document)
        if document_key in selected_document_keys:
            continue
        selected.append(document)
        selected_document_keys.add(document_key)
        if len(selected) >= limit:
            return selected

    return selected


def _looks_like_inventory_query(query: str) -> bool:
    normalized = "".join(query.lower().split())
    if not normalized:
        return False

    if re.search(r"《[^》]{2,}》", query) and any(term in normalized for term in ("原文", "概述", "总结", "分析", "核心内容")):
        return False

    scope_patterns = (
        r"知识库",
        r"工作区(?:文档|文件|资料)",
        r"(?:上传的|已上传的|上传了|已上传)(?:文档|文件|资料|内容)?",
        r"knowledge\s*base",
        r"workspace\s*(?:documents|files)",
        r"uploaded\s*(?:documents|files)",
    )
    if not any(re.search(pattern, normalized) for pattern in scope_patterns):
        return False

    content_operation_terms = (
        "总结",
        "概述",
        "分析",
        "比较",
        "区别",
        "作用",
        "要求",
        "规定",
        "字段",
        "问题",
        "原因",
        "为什么",
        "如何",
        "是否",
        "能否",
    )
    if any(term in normalized for term in content_operation_terms):
        return False

    collection_operation_patterns = (
        r"(?:知识库|工作区)(?:里面|里|中|内)?(?:一共有|总共有|一共|总共|共有|有)?(?:多少|几)(?:篇|个)?(?:文档|文件|资料)?",
        r"(?:列出|罗列|展示)(?:知识库|工作区|上传的|已上传的)?(?:全部|所有)?(?:文档|文件|资料)",
        r"(?:上传了|已上传|上传的|已上传的)(?:哪些|什么|些什么|多少|几|全部|所有)(?:文档|文件|资料|内容)?",
        r"(?:知识库|工作区)(?:里|中|内|里面)?(?:有哪些|有什么)(?:文档|文件|资料)",
        r"(?:文档|文件|资料)(?:清单|列表|数量)",
        r"(?:howmany|list|which|what)(?:uploaded|workspace)?(?:documents|files)",
    )
    return any(re.search(pattern, normalized) for pattern in collection_operation_patterns)


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
    comparison_terms = ("对比", "区别", "差异", "区分", "是否", "能否", "还是", "compare", "difference")
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


def _copy_cache_documents(entry: dict | None) -> list[dict]:
    if not entry:
        return []
    documents = entry.get("documents") or entry.get("evidence") or []
    return [dict(document) for document in documents]


def _evaluate_cached_documents(
    query: str,
    entry: dict,
    limit: int,
    rerank_fn: RerankFn,
) -> tuple[list[dict], dict]:
    documents = _copy_cache_documents(entry)
    if not documents:
        return [], evaluate_retrieval_quality(query, [])

    ranked_documents = rerank_fn(query, documents)
    selected_documents = _select_diverse_documents(ranked_documents, limit, query)
    quality = evaluate_retrieval_quality(query, selected_documents)
    return selected_documents, quality


def _merge_documents(
    merged_by_key: dict[str, dict],
    documents: list[dict],
    matched_query: str,
    cache_source: str | None = None,
):
    for document in documents:
        key = _document_key(document)
        current = merged_by_key.get(key)
        if not current or float(document.get("similarity") or 0) > float(current.get("similarity") or 0):
            merged = dict(document)
            existing_queries = (current or {}).get("matched_queries", [])
            merged["matched_queries"] = sorted(set(existing_queries + document.get("matched_queries", []) + [matched_query]))
            if cache_source:
                merged["cache_source"] = cache_source
            merged_by_key[key] = merged
        elif current:
            current["matched_queries"] = sorted(set(current.get("matched_queries", []) + [matched_query]))
            if cache_source and not current.get("cache_source"):
                current["cache_source"] = cache_source


def _cache_summary(status: str, **extra: object) -> dict:
    return {
        "status": status,
        **{key: value for key, value in extra.items() if value is not None},
    }


def _safe_cache_side_effect(
    trace_steps: list[dict],
    action: str,
    input_data: dict,
    fn: Callable[[], None],
) -> bool:
    started_at = _now_ms()
    try:
        fn()
    except Exception:
        trace_steps.append(_trace_step(
            "cache_side_effect",
            "partial",
            started_at,
            {"action": action, **input_data},
            {"ok": False, "error": "Cache side effect failed"},
        ))
        return False

    trace_steps.append(_trace_step(
        "cache_side_effect",
        "success",
        started_at,
        {"action": action, **input_data},
        {"ok": True},
    ))
    return True


def _safe_cache_write(
    trace_steps: list[dict],
    cache_kind: str,
    input_data: dict,
    fn: Callable[[], None],
) -> bool:
    started_at = _now_ms()
    try:
        fn()
    except Exception:
        trace_steps.append(_trace_step(
            "cache_write",
            "partial",
            started_at,
            {"cache_kind": cache_kind, **input_data},
            {"stored": False, "error": "Cache write failed"},
        ))
        return False

    trace_steps.append(_trace_step(
        "cache_write",
        "success",
        started_at,
        {"cache_kind": cache_kind, **input_data},
        {"stored": True},
    ))
    return True


def _verification_status(verification: dict) -> str:
    label = verification.get("support_label")
    if label == "supported":
        return "success"
    if label == "partial":
        return "partial"
    return "failed"


def _quality_with_verification(
    query: str,
    documents: list[dict],
    quality: dict,
    cache_hit_type: str | None = None,
    query_similarity: float | None = None,
) -> tuple[dict, dict]:
    verification = verify_evidence_support(
        query,
        documents,
        cache_hit_type=cache_hit_type,
        query_similarity=query_similarity,
    )
    enriched_quality = {
        **quality,
        "support_label": verification["support_label"],
        "verification_score": verification["support_score"],
        "risk_level": verification["risk_level"],
        "risk_factors": verification["risk_factors"],
        "missing_markers": verification["missing_markers"],
        "matched_markers": verification["matched_markers"],
        "cache_reuse_allowed": verification["cache_reuse_allowed"],
        "must_retrieve": verification["must_retrieve"],
    }
    return enriched_quality, verification


def _should_store_cache(quality: dict) -> bool:
    if quality.get("support_label") == "unsupported":
        return False
    if quality.get("evidence_label") == "weak":
        return False
    try:
        return float(quality.get("overall_score") or 0) >= 0.38
    except (TypeError, ValueError):
        return False


def default_rerank_documents(query: str, documents: list[dict]) -> list[dict]:
    return rerank_documents(query, documents)


def _build_answer_guidance(quality: dict) -> tuple[bool, str]:
    insufficient_evidence = (
        quality.get("evidence_label") == "weak"
        or float(quality.get("overall_score") or 0) < 0.35
        or quality.get("support_label") == "unsupported"
        or (quality.get("risk_level") == "high" and quality.get("support_label") != "supported")
    )

    if not insufficient_evidence:
        return False, ""

    if quality.get("support_label") == "unsupported":
        return True, (
            "Retrieved evidence does not sufficiently support the question. "
            "Do not invent document-backed facts or citations; state that the source material is insufficient."
        )
    if quality.get("risk_level") == "high":
        return True, (
            "This is a high-risk document-grounded question. Answer only from retrieved evidence, "
            "call out missing markers or unresolved conflicts, and avoid unsupported conclusions."
        )

    return True, (
        "Retrieved evidence is weak. Answer cautiously, state what is unsupported, "
        "and ask for more source material if the answer cannot be grounded."
    )


def agentic_retrieve(
    query: str,
    user_id: str,
    project_space_id: str | None = None,
    conversation_id: str | None = None,
    limit: int = 5,
    threshold: float = 0.1,
    retrieve_fn: RetrieveFn = retrieve_documents,
    rerank_fn: RerankFn = default_rerank_documents,
    inventory_fn: InventoryFn = list_files_for_inventory,
    cache_store: RetrievalCacheStore | None = None,
) -> dict:
    run_id = str(uuid.uuid4())
    trace_steps: list[dict] = []

    if _looks_like_inventory_query(query):
        intent = _classify_question(query)
        started_at = _now_ms()
        inventory_limit = INVENTORY_RESULT_LIMIT
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
        inventory_total = len(files)
        trace_steps.append(_trace_step(
            "metadata_lookup",
            "success",
            started_at,
            {"user_id": user_id, "project_space_id": project_space_id, "limit": inventory_limit},
            {"file_count": inventory_total, "complete_within_limit": inventory_total < inventory_limit},
        ))

        started_at = _now_ms()
        quality = _inventory_quality(len(documents))
        insufficient_evidence, answer_guidance = _build_answer_guidance(quality)
        if documents:
            answer_guidance = (
                f"这是文档清单问题。请先明确回答当前知识库共 {inventory_total} 篇文档，"
                "然后按文件名逐条列出所有已返回的文档；不要只列一部分，不要改写文件名。"
                "如果用户询问上传了哪些文档，优先回答文档清单，而不是做内容摘要。"
            )
        trace_steps.append(_trace_step(
            "evidence_check",
            "partial" if insufficient_evidence else "success",
            started_at,
            {"selected_count": len(documents), "inventory_total": inventory_total},
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
            "inventory_total": inventory_total,
            "inventory_limit": inventory_limit,
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
    risk_assessment = assess_query_risk(query)
    trace_steps.append(_trace_step(
        "risk_assess",
        "success",
        started_at,
        {"query": query},
        risk_assessment,
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
    cache_info = _cache_summary("disabled")
    scope_fingerprint: str | None = None
    cache_entry: dict | None = None

    if cache_store:
        normalized_query = normalize_query(query)
        started_at = _now_ms()
        try:
            scope = cache_store.get_scope(user_id, project_space_id)
            scope_fingerprint = str(scope.get("fingerprint") or "")
            exact_entry = cache_store.find_exact(
                user_id,
                project_space_id,
                conversation_id,
                scope_fingerprint,
                normalized_query,
            )
            similar_entry = None if exact_entry else cache_store.find_similar(
                user_id,
                project_space_id,
                conversation_id,
                scope_fingerprint,
                normalized_query,
                min_similarity=SIMILAR_QUERY_THRESHOLD,
            )
            conversation_entry = None if exact_entry or similar_entry or not conversation_id else cache_store.find_conversation_evidence(
                user_id,
                project_space_id,
                conversation_id,
                scope_fingerprint,
                normalized_query,
                min_similarity=CONVERSATION_EVIDENCE_THRESHOLD,
            )
            cache_entry = exact_entry or similar_entry or conversation_entry
            hit_type = "exact" if exact_entry else "similar" if similar_entry else "conversation" if conversation_entry else None
            trace_steps.append(_trace_step(
                "cache_lookup",
                "success",
                started_at,
                {
                    "user_id": user_id,
                    "project_space_id": project_space_id,
                    "conversation_id": conversation_id,
                    "normalized_query": normalized_query,
                },
                {
                    "enabled": True,
                    "scope_fingerprint": scope_fingerprint,
                    "hit_type": hit_type,
                    "query_similarity": (cache_entry or {}).get("query_similarity"),
                },
            ))

            if cache_entry:
                started_at = _now_ms()
                cached_documents, cached_quality = _evaluate_cached_documents(query, cache_entry, limit, rerank_fn)
                query_similarity = cache_entry.get("query_similarity")
                cached_quality, verification = _quality_with_verification(
                    query,
                    cached_documents,
                    cached_quality,
                    cache_hit_type=hit_type,
                    query_similarity=query_similarity,
                )
                trace_steps.append(_trace_step(
                    "evidence_verify",
                    _verification_status(verification),
                    started_at,
                    {
                        "cache_id": cache_entry.get("id"),
                        "hit_type": hit_type,
                        "query_similarity": query_similarity,
                        "selected_count": len(cached_documents),
                    },
                    verification,
                ))
                reusable = (
                    cache_entry_is_reusable(cache_entry, cached_quality, query_similarity)
                    and verification.get("cache_reuse_allowed") is True
                )
                if reusable:
                    _safe_cache_side_effect(
                        trace_steps,
                        "record_hit",
                        {
                            "cache_kind": str(cache_entry.get("cache_kind") or "query"),
                            "cache_id": cache_entry.get("id"),
                            "hit_type": hit_type,
                        },
                        lambda: cache_store.record_hit(cache_entry),
                    )
                    if conversation_id:
                        _safe_cache_write(
                            trace_steps,
                            "conversation_evidence",
                            {
                                "cache_id": cache_entry.get("id"),
                                "hit_type": hit_type,
                                "document_count": len(cached_documents),
                            },
                            lambda: cache_store.upsert_conversation_evidence(
                                user_id=user_id,
                                project_space_id=project_space_id,
                                conversation_id=conversation_id,
                                normalized_query=normalized_query,
                                original_query=query,
                                scope_fingerprint=scope_fingerprint,
                                documents=cached_documents,
                                quality=cached_quality,
                            ),
                        )
                    cache_info = _cache_summary(
                        "hit",
                        hit_type=hit_type,
                        scope_fingerprint=scope_fingerprint,
                        reused_count=len(cached_documents),
                        query_similarity=query_similarity,
                    )
                    trace_steps.append(_trace_step(
                        "evidence_reuse",
                        "success",
                        started_at,
                        {
                            "cache_id": cache_entry.get("id"),
                            "hit_type": hit_type,
                            "query_similarity": query_similarity,
                        },
                        {
                            "reused_count": len(cached_documents),
                            "skipped_retrieve": True,
                            **cached_quality,
                        },
                    ))
                    insufficient_evidence, answer_guidance = _build_answer_guidance(cached_quality)
                    return {
                        "run_id": run_id,
                        "mode": "agentic",
                        "intent": intent,
                        "planned_queries": planned_queries,
                        "results": cached_documents,
                        "trace_steps": trace_steps,
                        "quality": cached_quality,
                        "insufficient_evidence": insufficient_evidence,
                        "answer_guidance": answer_guidance,
                        "cache": cache_info,
                    }

                _merge_documents(merged_by_key, cached_documents, query, cache_source=hit_type or "cache")
                cache_info = _cache_summary(
                    "partial",
                    hit_type=hit_type,
                    scope_fingerprint=scope_fingerprint,
                    reused_count=len(cached_documents),
                    query_similarity=query_similarity,
                )
                trace_steps.append(_trace_step(
                    "evidence_reuse",
                    "partial",
                    started_at,
                    {
                        "cache_id": cache_entry.get("id"),
                        "hit_type": hit_type,
                        "query_similarity": query_similarity,
                    },
                    {
                        "reused_count": len(cached_documents),
                        "skipped_retrieve": False,
                        **cached_quality,
                    },
                ))
            else:
                cache_info = _cache_summary("miss", scope_fingerprint=scope_fingerprint)
        except Exception:
            cache_info = _cache_summary("disabled", error="Cache lookup failed")
            trace_steps.append(_trace_step(
                "cache_lookup",
                "partial",
                started_at,
                {"user_id": user_id, "project_space_id": project_space_id},
                {"enabled": False, "error": "Cache lookup failed"},
            ))

    retrieve_limit = min(max(limit * 2, limit), 20)
    for planned_query in planned_queries:
        if cache_store and scope_fingerprint:
            normalized_planned_query = normalize_query(planned_query)
            started_at = _now_ms()
            try:
                subquery_entry = cache_store.find_subquery(
                    user_id,
                    project_space_id,
                    conversation_id,
                    scope_fingerprint,
                    normalized_planned_query,
                    min_similarity=SIMILAR_QUERY_THRESHOLD,
                )
                if subquery_entry:
                    subquery_documents, subquery_quality = _evaluate_cached_documents(
                        planned_query,
                        subquery_entry,
                        retrieve_limit,
                        rerank_fn,
                    )
                    subquery_quality, subquery_verification = _quality_with_verification(
                        planned_query,
                        subquery_documents,
                        subquery_quality,
                        cache_hit_type="subquery",
                        query_similarity=subquery_entry.get("query_similarity"),
                    )
                    trace_steps.append(_trace_step(
                        "evidence_verify",
                        _verification_status(subquery_verification),
                        started_at,
                        {
                            "query": planned_query,
                            "cache_id": subquery_entry.get("id"),
                            "hit_type": "subquery",
                            "query_similarity": subquery_entry.get("query_similarity"),
                            "selected_count": len(subquery_documents),
                        },
                        subquery_verification,
                    ))
                    if (
                        cache_entry_is_reusable(subquery_entry, subquery_quality, subquery_entry.get("query_similarity"))
                        and subquery_verification.get("cache_reuse_allowed") is True
                    ):
                        _safe_cache_side_effect(
                            trace_steps,
                            "record_hit",
                            {
                                "cache_kind": str(subquery_entry.get("cache_kind") or "subquery"),
                                "cache_id": subquery_entry.get("id"),
                                "hit_type": "subquery",
                            },
                            lambda: cache_store.record_hit(subquery_entry),
                        )
                        _merge_documents(
                            merged_by_key,
                            subquery_documents,
                            planned_query,
                            cache_source="subquery",
                        )
                        cache_info = _cache_summary(
                            "partial",
                            hit_type=cache_info.get("hit_type") or "subquery",
                            scope_fingerprint=scope_fingerprint,
                            reused_count=int(cache_info.get("reused_count") or 0) + len(subquery_documents),
                            query_similarity=cache_info.get("query_similarity"),
                        )
                        trace_steps.append(_trace_step(
                            "subquery_cache_hit",
                            "success",
                            started_at,
                            {
                                "query": planned_query,
                                "cache_id": subquery_entry.get("id"),
                                "query_similarity": subquery_entry.get("query_similarity"),
                            },
                            {
                                "reused_count": len(subquery_documents),
                                **subquery_quality,
                            },
                        ))
                        continue

                    trace_steps.append(_trace_step(
                        "subquery_cache_hit",
                        "partial",
                        started_at,
                        {
                            "query": planned_query,
                            "cache_id": subquery_entry.get("id"),
                            "query_similarity": subquery_entry.get("query_similarity"),
                        },
                        {
                            "reused_count": len(subquery_documents),
                            "reason": "cached evidence confidence was insufficient",
                            **subquery_quality,
                        },
                    ))
            except Exception:
                trace_steps.append(_trace_step(
                    "subquery_cache_hit",
                    "partial",
                    started_at,
                    {"query": planned_query},
                    {"error": "Subquery cache lookup failed"},
                ))

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
                **_retrieval_channel_summary(documents),
            },
        ))

        if cache_store and scope_fingerprint:
            try:
                subquery_quality = evaluate_retrieval_quality(planned_query, documents)
                subquery_quality, _ = _quality_with_verification(planned_query, documents, subquery_quality)
                if _should_store_cache(subquery_quality):
                    _safe_cache_write(
                        trace_steps,
                        "subquery",
                        {
                            "query": planned_query,
                            "document_count": len(documents),
                            "scope_fingerprint": scope_fingerprint,
                        },
                        lambda planned_query=planned_query, documents=documents, subquery_quality=subquery_quality: cache_store.upsert_subquery_cache(
                            user_id=user_id,
                            project_space_id=project_space_id,
                            conversation_id=conversation_id,
                            normalized_query=planned_query,
                            original_query=planned_query,
                            scope_fingerprint=scope_fingerprint,
                            documents=documents,
                            quality=subquery_quality,
                        ),
                    )
            except Exception:
                trace_steps.append(_trace_step(
                    "cache_write",
                    "partial",
                    started_at,
                    {"cache_kind": "subquery", "query": planned_query},
                    {"stored": False, "error": "Cache write failed"},
                ))

        _merge_documents(merged_by_key, documents, planned_query)

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
                **_retrieval_channel_summary(documents),
            },
        ))
        _merge_documents(merged_by_key, documents, retry_query)

    started_at = _now_ms()
    reranker_name = "local-evidence" if rerank_fn is default_rerank_documents else "custom"
    ranked_documents = rerank_fn(query, list(merged_by_key.values()))
    selected_documents = _select_diverse_documents(ranked_documents, limit, query)
    trace_steps.append(_trace_step(
        "rerank",
        "success",
        started_at,
        {"candidate_count": len(ranked_documents), "limit": limit},
        {
            "reranker": reranker_name,
            "selected_count": len(selected_documents),
            "selected_ids": [document.get("id") for document in selected_documents],
            "selected_sources": [
                {
                    "id": document.get("id"),
                    "filename": (document.get("metadata") or {}).get("filename"),
                    "source_role": document.get("source_role") or classify_source_role(document),
                    "agentic_score": document.get("agentic_score") or document.get("rerank_score") or 0,
                    "matched_terms": document.get("matched_terms") or [],
                }
                for document in selected_documents
            ],
        },
    ))

    started_at = _now_ms()
    quality = evaluate_retrieval_quality(query, selected_documents)
    quality, verification = _quality_with_verification(query, selected_documents, quality)
    trace_steps.append(_trace_step(
        "evidence_verify",
        _verification_status(verification),
        started_at,
        {"selected_count": len(selected_documents)},
        verification,
    ))
    insufficient_evidence, answer_guidance = _build_answer_guidance(quality)
    trace_steps.append(_trace_step(
        "evidence_check",
        "partial" if insufficient_evidence else "success",
        started_at,
        {"selected_count": len(selected_documents)},
        {**quality, "insufficient_evidence": insufficient_evidence},
    ))

    if cache_store and scope_fingerprint and selected_documents and _should_store_cache(quality):
        _safe_cache_write(
            trace_steps,
            "query",
            {
                "query": query,
                "document_count": len(selected_documents),
                "scope_fingerprint": scope_fingerprint,
            },
            lambda: cache_store.upsert_query_cache(
                user_id=user_id,
                project_space_id=project_space_id,
                conversation_id=conversation_id,
                normalized_query=query,
                original_query=query,
                scope_fingerprint=scope_fingerprint,
                documents=selected_documents,
                quality=quality,
            ),
        )
        if conversation_id:
            _safe_cache_write(
                trace_steps,
                "conversation_evidence",
                {
                    "query": query,
                    "document_count": len(selected_documents),
                    "scope_fingerprint": scope_fingerprint,
                },
                lambda: cache_store.upsert_conversation_evidence(
                    user_id=user_id,
                    project_space_id=project_space_id,
                    conversation_id=conversation_id,
                    normalized_query=query,
                    original_query=query,
                    scope_fingerprint=scope_fingerprint,
                    documents=selected_documents,
                    quality=quality,
                ),
            )

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
        "cache": cache_info,
    }
