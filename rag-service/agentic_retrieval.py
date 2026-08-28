import inspect
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from itertools import zip_longest
from typing import Callable

from config import settings
from evaluation import evaluate_retrieval_quality
from evidence_verifier import assess_query_risk, verify_evidence_support
from query_planner import plan_queries, resolve_standalone_query
from db import (
    count_files_for_inventory,
    get_active_chunks_by_ids,
    list_files_for_inventory,
    list_parent_chunks_for_matches,
)
from parent_context import build_parent_section_documents
from reranker import LOCAL_RERANKER_VERSION, classify_source_role
from semantic_reranker import rerank_with_provider, reranker_fingerprint
from semantic_query_rewriter import query_rewriter_fingerprint, rewrite_query_resolution
from retrieval import retrieve_documents
from retrieval_cache import (
    CONVERSATION_EVIDENCE_THRESHOLD,
    RetrievalCacheStore,
    build_retrieval_request_fingerprint,
    cache_metrics_snapshot,
    cache_entry_is_reusable,
    normalize_query,
    record_cache_metric,
)


RetrieveFn = Callable[..., list[dict]]
RerankFn = Callable[[str, list[dict]], list[dict]]
InventoryFn = Callable[[str, str | None, int], list[dict]]
InventoryCountFn = Callable[[str, str | None], int]
ParentDepthFn = Callable[[str, str | None, list[dict], int, int], list[dict]]
ActiveChunksFn = Callable[[list[str], str, str | None], list[dict]]

INVENTORY_RESULT_LIMIT = 100
PARENT_SECTION_LIMIT = 8
PARENT_SECTION_CHUNK_LIMIT = 6
PARENT_SECTION_MAX_CHARS = 8000
QUERY_PARALLELISM = max(1, min(settings.agentic_query_parallelism, 3))


class PlannedRetrievalUnavailableError(RuntimeError):
    """Raised when every planned query fails before producing retrieval evidence."""


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


def _completed_trace_step(
    step_type: str,
    status: str,
    duration_ms: int,
    input_data: dict,
    output_data: dict,
) -> dict:
    """Build a trace for work that completed concurrently in another thread."""
    return {
        "step_type": step_type,
        "status": status,
        "duration_ms": max(0, duration_ms),
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

    channel_status = getattr(documents, "channel_status", None)
    return {
        "channel_counts": dict(sorted(channel_counts.items())),
        "mode_counts": dict(sorted(mode_counts.items())),
        "unique_source_count": len(source_ids),
        **({"channel_status": dict(channel_status)} if isinstance(channel_status, dict) else {}),
        "degraded": bool(getattr(documents, "degraded", False)),
    }


def _retrieval_trace_status(documents: list[dict]) -> str:
    if bool(getattr(documents, "degraded", False)) or not documents:
        return "partial"
    return "success"


def _select_diverse_documents(ranked_documents: list[dict], limit: int) -> list[dict]:
    if limit <= 0:
        return []

    selected: list[dict] = []
    selected_document_keys: set[str] = set()
    source_counts: dict[str, int] = {}
    max_per_source = 1 if limit <= 2 else 2

    for document in ranked_documents:
        source_key = _source_key(document)
        document_key = _document_key(document)
        if document_key in selected_document_keys:
            continue
        count_key = source_key or f"document:{document_key}"
        if source_counts.get(count_key, 0) >= max_per_source:
            continue
        selected.append(document)
        selected_document_keys.add(document_key)
        source_counts[count_key] = source_counts.get(count_key, 0) + 1
        if len(selected) >= limit:
            return selected

    # Do not under-fill when all relevant evidence lives in one Markdown file.
    # The final answer context remains bounded by the token packer.
    for document in ranked_documents:
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
    # Keep this query vocabulary aligned with the controlled graph ontology.
    # A direct one-hop predicate question is a graph use case even when it is
    # phrased as a yes/no comparison (for example “A 使用 B 吗？”).
    relationship_terms = (
        "关联", "依赖", "影响", "链路", "连接", "接入", "转发", "路由到", "冲突", "替代",
        "协作", "配合", "隶属", "属于", "归属", "使用", "采用", "利用", "负责", "职责",
        "承担", "经办", "提供", "交付", "供应", "支付", "付款", "结算", "签署", "签订",
        "盖章", "位于", "坐落", "适用于", "面向", "针对", "生成", "产出", "消费", "读取",
        "订阅", "配置", "实现", "组成",
    )
    comparison_terms = ("对比", "区别", "差异", "区分", "是否", "能否", "还是")
    relationship_match = (
        any(term in normalized for term in relationship_terms)
        # “关系型数据库” describes a category rather than an entity-to-entity
        # relationship, so it must stay on the normal knowledge retrieval path.
        or bool(re.search(r"关系(?!型)", normalized))
        or bool(re.search(
            r"(?:谁|哪些(?:服务|组件|模块|系统)?)(?:使用|生产|消费|配置|实现)(?:了)?|"
            r"(?:由哪些|由什么)(?:服务|组件|模块|系统)?组成|"
            r"\b(?:connect(?:s|ed|ing|ion|ions)?|relate[ds]?|related|relationship|relationships|"
            r"depend(?:s|ed|ing)?|dependency|dependencies|conflict(?:s|ed|ing)?|"
            r"replace(?:s|d)?|impact(?:s|ed|ing)?|collaborat(?:e|es|ed|ing|ion)|"
            r"cooperat(?:e|es|ed|ing|ion)|uses|used|part\s+of|produces|consumes|configures|implements)\b",
            query,
            re.IGNORECASE,
        ))
        or bool(re.search(
            r"\b(?:use[sd]?|adopt(?:s|ed|ing)?|utilize[sd]?|responsible\s+for|owns?|"
            r"provide[sd]?|deliver(?:s|ed)?|suppl(?:y|ies|ied)|pay[sd]?|paid|settle[sd]?|"
            r"belong(?:s|ed)?\s+to|member\s+of|located\s+in|based\s+in|signed\s+by|"
            r"executed\s+by|appl(?:y|ies|ied)\s+to|generate[sd]?|emit[st]?|read[st]?|"
            r"subscribe[sd]?\s+to|configure[sd]?|implement(?:s|ed)?)\b",
            query,
            re.IGNORECASE,
        ))
        or bool(re.search(r"支持(?!哪些|什么).+(?:吗|么|？|\?)$", normalized))
    )
    comparison_match = any(term in normalized for term in comparison_terms) or bool(re.search(
        r"\b(?:compare[ds]?|comparing|difference|differences|distinguish(?:es|ed|ing)?)\b",
        query,
        re.IGNORECASE,
    ))
    inventory = _looks_like_inventory_query(query)

    if inventory:
        intent_type = "inventory"
        complexity = "simple"
        routes = ["metadata"]
    elif relationship_match:
        intent_type = "relationship"
        complexity = "multi_hop"
        routes = ["vector", "bm25", "graph"]
    elif comparison_match:
        intent_type = "comparison"
        complexity = "multi_hop"
        routes = ["vector", "bm25"]
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
    is_cjk = bool(re.search(r"[\u3400-\u9fff]", query))
    if intent.get("type") in {"relationship", "comparison"}:
        suffix = "相关实体 关系 链路 背景" if is_cjk else "related entities relationships dependencies context"
        return f"{query} {suffix}"
    suffix = "相关背景 具体说明 原文" if is_cjk else "related context detailed explanation source text"
    return f"{query} {suffix}"


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


def _cached_document_chunk_ids(document: dict) -> list[str]:
    """Chunk ids that must still be active for this cached document to be citable.

    Plain retrieval documents carry the chunk id in `id`. Parent-section
    documents use a synthetic `parent:<file>:<generation>:<section>` id, which is
    not a chunk at all, and keep the real chunk ids in
    `metadata.matched_child_ids`; those are the ones to re-authorize.
    """
    metadata = document.get("metadata") or {}
    matched_child_ids = [
        str(value).strip()
        for value in metadata.get("matched_child_ids") or []
        if str(value).strip()
    ]
    if matched_child_ids:
        return list(dict.fromkeys(matched_child_ids))
    candidate = str(document.get("id") or document.get("chunk_id") or "").strip()
    return [candidate] if candidate else []


def _active_cached_documents(
    documents: list[dict],
    user_id: str,
    project_space_id: str | None,
    active_chunks_fn: ActiveChunksFn,
) -> tuple[list[dict], int]:
    """Re-authorize cached evidence against PostgreSQL before reusing it.

    A cache key embeds `knowledge_version`, but deleting a file only marks
    `files.status = 'deleting'` right away; the version is bumped later, once the
    async cleanup worker reaches the RAG service. Inside that window the old key
    is still valid, so a cache hit would keep citing content the user already
    deleted. Fresh retrieval already filters on file status -- this closes the
    same hole on the short-circuit path. A document we cannot prove is live is
    dropped: a cache miss is always cheaper than quoting deleted material.
    """
    if not documents:
        return [], 0

    candidate_ids: list[str] = []
    ids_by_document: list[list[str]] = []
    for document in documents:
        chunk_ids = _cached_document_chunk_ids(document)
        ids_by_document.append(chunk_ids)
        candidate_ids.extend(chunk_ids)

    active_rows = active_chunks_fn(candidate_ids, user_id, project_space_id) or []
    active_ids = {str(row.get("id")) for row in active_rows if row.get("id")}

    kept: list[dict] = []
    for document, chunk_ids in zip(documents, ids_by_document):
        if chunk_ids and all(chunk_id in active_ids for chunk_id in chunk_ids):
            kept.append(document)
    return kept, len(documents) - len(kept)


def _evaluate_cached_documents(
    query: str,
    entry: dict,
    limit: int,
    rerank_fn: RerankFn,
    user_id: str,
    project_space_id: str | None,
    active_chunks_fn: ActiveChunksFn,
) -> tuple[list[dict], dict, int]:
    documents = _copy_cache_documents(entry)
    if not documents:
        return [], evaluate_retrieval_quality(query, []), 0

    documents, dropped_count = _active_cached_documents(
        documents,
        user_id,
        project_space_id,
        active_chunks_fn,
    )
    if not documents:
        return [], evaluate_retrieval_quality(query, []), dropped_count

    ranked_documents = rerank_fn(query, documents)
    selected_documents = _select_diverse_documents(ranked_documents, limit)
    quality = evaluate_retrieval_quality(query, selected_documents)
    return selected_documents, quality, dropped_count


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
    return rerank_with_provider(query, documents)


def _reranker_cache_fingerprint(rerank_fn: RerankFn) -> str:
    explicit = str(getattr(rerank_fn, "cache_fingerprint", "") or "").strip()
    if explicit:
        return explicit
    if rerank_fn is default_rerank_documents:
        return reranker_fingerprint()
    module = str(getattr(rerank_fn, "__module__", "custom") or "custom")
    qualified_name = str(
        getattr(rerank_fn, "__qualname__", getattr(rerank_fn, "__name__", "anonymous"))
        or "anonymous"
    )
    return f"custom:{module}.{qualified_name}"


def _request_cache_fingerprint(
    scope_fingerprint: str,
    routes: list[str],
    limit: int,
    threshold: float,
    rerank_fn: RerankFn,
) -> str:
    return build_retrieval_request_fingerprint(
        scope_fingerprint=scope_fingerprint,
        routes=routes,
        limit=limit,
        threshold=threshold,
        reranker_fingerprint=_reranker_cache_fingerprint(rerank_fn),
        query_rewriter_fingerprint=query_rewriter_fingerprint(),
    )


def _planned_queries(query: str, query_resolution: dict | None, max_queries: int = 3) -> list[str]:
    """Merge the deterministic query plan with the rewriter's alternatives.

    These used to be concatenated with the rewriter's alternatives ahead of the
    deterministic plan, so two alternatives were enough to push the entire
    deterministic plan past `max_queries` and out of the request. That plan is
    what makes literal identifiers findable, because it contributes an
    exact-marker query, and unlike the rewriter it cannot fail or wander. The two
    sources therefore share the remaining budget round-robin instead of competing
    for it by position.
    """
    semantic_alternatives = list((query_resolution or {}).get("semantic_alternatives") or [])
    deterministic_plan = plan_queries(query, max_queries)
    planned: list[str] = []
    identities: set[str] = set()

    def accept(candidate: object) -> None:
        if len(planned) >= max_queries:
            return
        normalized = str(candidate or "").strip()
        identity = normalize_query(normalized)
        if not normalized or not identity or identity in identities:
            return
        identities.add(identity)
        planned.append(normalized)

    # The user's own wording always leads.
    accept(query)
    # Deterministic first within each round: when only one slot is left it should
    # go to the source that does not depend on an external rewriter call.
    for deterministic_candidate, semantic_candidate in zip_longest(
        deterministic_plan, semantic_alternatives
    ):
        accept(deterministic_candidate)
        accept(semantic_candidate)
        if len(planned) >= max_queries:
            break
    return planned


def _invoke_retriever(
    retrieve_fn: RetrieveFn,
    query: str,
    user_id: str,
    project_space_id: str | None,
    limit: int,
    threshold: float,
    routes: list[str],
) -> list[dict]:
    """Pass routes to route-aware retrievers while preserving simple test adapters."""
    try:
        parameters = inspect.signature(retrieve_fn).parameters.values()
        supports_routes = any(
            parameter.name == "routes" or parameter.kind == inspect.Parameter.VAR_KEYWORD
            for parameter in parameters
        )
    except (TypeError, ValueError):
        supports_routes = False

    if supports_routes:
        return retrieve_fn(
            query,
            user_id,
            project_space_id,
            limit,
            threshold,
            routes=routes,
        )
    return retrieve_fn(query, user_id, project_space_id, limit, threshold)


def _retrieve_planned_queries(
    queries: list[str],
    user_id: str,
    project_space_id: str | None,
    limit: int,
    threshold: float,
    routes: list[str],
    retrieve_fn: RetrieveFn,
) -> list[dict]:
    """Run bounded query variants concurrently and return deterministic results.

    A failure in one variant is isolated so another useful variant can still
    provide evidence. Results are sorted back into planner order before fusion.
    """
    if not queries:
        return []

    def run(index: int, planned_query: str) -> dict:
        started_at = _now_ms()
        try:
            documents = _invoke_retriever(
                retrieve_fn,
                planned_query,
                user_id,
                project_space_id,
                limit,
                threshold,
                routes,
            )
            return {
                "index": index,
                "query": planned_query,
                "documents": documents,
                "duration_ms": max(0, _now_ms() - started_at),
                "error": None,
            }
        except Exception:
            return {
                "index": index,
                "query": planned_query,
                "documents": [],
                "duration_ms": max(0, _now_ms() - started_at),
                "error": "Retrieval failed",
            }

    max_workers = min(QUERY_PARALLELISM, len(queries))
    if max_workers <= 1:
        completed = [run(index, planned_query) for index, planned_query in enumerate(queries)]
    else:
        completed = []
        with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="rag-query") as executor:
            futures = {
                executor.submit(run, index, planned_query): index
                for index, planned_query in enumerate(queries)
            }
            for future in as_completed(futures):
                completed.append(future.result())

    ordered = sorted(completed, key=lambda item: int(item["index"]))
    if ordered and all(item.get("error") for item in ordered):
        raise PlannedRetrievalUnavailableError(
            f"All {len(ordered)} planned retrieval queries failed"
        )
    return ordered


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


_TRACE_IDENTIFIER_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def normalize_caller_trace(trace_id: str | None, span_id: str | None) -> dict:
    """Accept only well-formed correlation ids from the calling service.

    These values arrive in HTTP headers and end up echoed into a trace that is
    read by operators, so they are validated at the boundary rather than trusted.
    An unusable value is dropped instead of failing the retrieval: losing
    correlation must never cost the user an answer.
    """
    normalized: dict = {}
    if isinstance(trace_id, str) and _TRACE_IDENTIFIER_PATTERN.match(trace_id.strip()):
        normalized["trace_id"] = trace_id.strip().lower()
    if isinstance(span_id, str) and _TRACE_IDENTIFIER_PATTERN.match(span_id.strip()):
        normalized["parent_span_id"] = span_id.strip().lower()
    return normalized


def _agentic_retrieve_impl(
    query: str,
    user_id: str,
    project_space_id: str | None = None,
    conversation_id: str | None = None,
    query_resolution: dict | None = None,
    limit: int = 5,
    threshold: float = 0.1,
    retrieve_fn: RetrieveFn = retrieve_documents,
    rerank_fn: RerankFn = default_rerank_documents,
    inventory_fn: InventoryFn = list_files_for_inventory,
    inventory_count_fn: InventoryCountFn | None = None,
    cache_store: RetrievalCacheStore | None = None,
    parent_depth_fn: ParentDepthFn = list_parent_chunks_for_matches,
    active_chunks_fn: ActiveChunksFn = get_active_chunks_by_ids,
    caller_trace: dict | None = None,
) -> dict:
    run_id = str(uuid.uuid4())
    trace_steps: list[dict] = []
    if query_resolution:
        started_at = _now_ms()
        trace_steps.append(_trace_step(
            "conversation_query_resolve",
            "success" if query_resolution.get("confidence") != "low" else "partial",
            started_at,
            {
                "original_query": query_resolution.get("original_query"),
                "context_turn_count": query_resolution.get("available_context_turns", 0),
            },
            query_resolution,
        ))

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
        count_fn = inventory_count_fn or (count_files_for_inventory if inventory_fn is list_files_for_inventory else None)
        inventory_total = count_fn(user_id, project_space_id) if count_fn else len(files)
        inventory_truncated = inventory_total > len(files)
        trace_steps.append(_trace_step(
            "metadata_lookup",
            "success",
            started_at,
            {"user_id": user_id, "project_space_id": project_space_id, "limit": inventory_limit},
            {
                "file_count": inventory_total,
                "returned_count": len(files),
                "complete_within_limit": not inventory_truncated,
            },
        ))

        started_at = _now_ms()
        quality = _inventory_quality(len(documents))
        insufficient_evidence, answer_guidance = _build_answer_guidance(quality)
        if documents:
            listing_guidance = (
                f"当前只返回前 {len(documents)} 篇，必须明确说明清单已截断；"
                if inventory_truncated
                else "然后按文件名逐条列出所有已返回的文档；"
            )
            answer_guidance = (
                f"这是文档清单问题。请先明确回答当前知识库共 {inventory_total} 篇文档，"
                f"{listing_guidance}不要改写文件名。"
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
            "query_resolution": query_resolution,
            "intent": intent,
            "planned_queries": [query],
            "results": documents,
            "trace_steps": trace_steps,
            "quality": quality,
            "inventory_total": inventory_total,
            "inventory_limit": inventory_limit,
            "inventory_returned": len(files),
            "inventory_truncated": inventory_truncated,
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
        {
            "routes": intent["routes"],
            "graph_extraction_mode": (
                "not_routed"
                if "graph" not in intent["routes"]
                else "llm_primary_with_rule_fallback"
                if settings.graph_extraction_enabled
                else "rules_fallback"
            ),
        },
    ))

    started_at = _now_ms()
    planned_queries = _planned_queries(query, query_resolution, max_queries=3)
    trace_steps.append(_trace_step(
        "query_rewrite",
        "success",
        started_at,
        {"query": query, "max_queries": 3},
        {
            "planned_queries": planned_queries,
            "semantic_rewrite": (query_resolution or {}).get("semantic_rewrite") or {},
        },
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
            base_scope_fingerprint = str(scope.get("fingerprint") or "")
            scope_fingerprint = _request_cache_fingerprint(
                base_scope_fingerprint,
                intent["routes"],
                limit,
                threshold,
                rerank_fn,
            )
            exact_entry = cache_store.find_exact(
                user_id,
                project_space_id,
                conversation_id,
                scope_fingerprint,
                normalized_query,
            )
            record_cache_metric("exact_hit" if exact_entry else "exact_miss")
            conversation_entry = None if exact_entry or not conversation_id else cache_store.find_conversation_evidence(
                user_id,
                project_space_id,
                conversation_id,
                scope_fingerprint,
                normalized_query,
                min_similarity=CONVERSATION_EVIDENCE_THRESHOLD,
            )
            cache_entry = exact_entry or conversation_entry
            hit_type = "exact" if exact_entry else "conversation" if conversation_entry else None
            lookup_duration_ms = max(0, _now_ms() - started_at)
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
                    "lookup_duration_ms": lookup_duration_ms,
                    "similar_query_policy": "disabled_for_short_circuit",
                },
            ))

            if cache_entry:
                started_at = _now_ms()
                cached_documents, cached_quality, stale_document_count = _evaluate_cached_documents(
                    query,
                    cache_entry,
                    limit,
                    rerank_fn,
                    user_id,
                    project_space_id,
                    active_chunks_fn,
                )
                if stale_document_count:
                    record_cache_metric("stale_documents_dropped", stale_document_count)
                    trace_steps.append(_trace_step(
                        "cache_authority_check",
                        "partial",
                        started_at,
                        {"cache_id": cache_entry.get("id"), "hit_type": hit_type},
                        {
                            "dropped_document_count": stale_document_count,
                            "remaining_document_count": len(cached_documents),
                            "reason": "cached_evidence_no_longer_active",
                        },
                    ))
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
                    hit_type == "exact"
                    and cache_entry_is_reusable(cache_entry, cached_quality, query_similarity)
                    and verification.get("cache_reuse_allowed") is True
                )
                if reusable:
                    saved_retrieval_queries = len(planned_queries)
                    saved_channel_calls = saved_retrieval_queries * len(intent["routes"])
                    record_cache_metric("saved_retrieval_queries", saved_retrieval_queries)
                    record_cache_metric("saved_channel_calls", saved_channel_calls)
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
                        reason="exact_evidence_verified",
                        skipped_retrieve=True,
                        saved_retrieval_queries=saved_retrieval_queries,
                        saved_channel_calls=saved_channel_calls,
                        lookup_duration_ms=lookup_duration_ms,
                        metrics=cache_metrics_snapshot(),
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
                        "query_resolution": query_resolution,
                        "intent": intent,
                        "planned_queries": planned_queries,
                        "results": cached_documents,
                        "trace_steps": trace_steps,
                        "quality": cached_quality,
                        "insufficient_evidence": insufficient_evidence,
                        "answer_guidance": answer_guidance,
                        "cache": cache_info,
                    }

                rejection_reason = (
                    "conversation_evidence_candidate_only"
                    if hit_type == "conversation"
                    else "exact_evidence_verification_rejected"
                )
                record_cache_metric(
                    "conversation_candidate" if hit_type == "conversation" else "exact_rejected"
                )
                cache_info = _cache_summary(
                    "partial",
                    hit_type=hit_type,
                    scope_fingerprint=scope_fingerprint,
                    reused_count=len(cached_documents),
                    query_similarity=query_similarity,
                    reason=rejection_reason,
                    skipped_retrieve=False,
                    lookup_duration_ms=lookup_duration_ms,
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
                        "reason": rejection_reason,
                        **cached_quality,
                    },
                ))
            else:
                cache_info = _cache_summary(
                    "miss",
                    scope_fingerprint=scope_fingerprint,
                    reason="exact_not_found",
                    skipped_retrieve=False,
                    lookup_duration_ms=lookup_duration_ms,
                )
        except Exception:
            record_cache_metric("lookup_bypass")
            cache_info = _cache_summary(
                "bypass",
                reason="lookup_error",
                skipped_retrieve=False,
                error="Cache lookup failed",
            )
            trace_steps.append(_trace_step(
                "cache_lookup",
                "partial",
                started_at,
                {"user_id": user_id, "project_space_id": project_space_id},
                {"enabled": False, "error": "Cache lookup failed"},
            ))

    retrieve_limit = min(max(limit * 2, limit), 20)
    queries_to_retrieve: list[str] = []
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
                )
                if subquery_entry:
                    subquery_documents, subquery_quality, stale_subquery_count = _evaluate_cached_documents(
                        planned_query,
                        subquery_entry,
                        retrieve_limit,
                        rerank_fn,
                        user_id,
                        project_space_id,
                        active_chunks_fn,
                    )
                    if stale_subquery_count:
                        record_cache_metric("stale_documents_dropped", stale_subquery_count)
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
                            reason="exact_subquery_reused",
                            skipped_retrieve=False,
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
        queries_to_retrieve.append(planned_query)

    retrieval_outcomes = _retrieve_planned_queries(
        queries_to_retrieve,
        user_id,
        project_space_id,
        retrieve_limit,
        threshold,
        intent["routes"],
        retrieve_fn,
    )
    retrieval_degraded = False
    for outcome in retrieval_outcomes:
        planned_query = str(outcome["query"])
        documents = outcome["documents"]
        error = outcome.get("error")
        retrieval_summary = {
            "hit_count": len(documents),
            "top_similarity": max([float(doc.get("similarity") or 0) for doc in documents] or [0]),
            "parallelism": min(QUERY_PARALLELISM, len(queries_to_retrieve)),
            **_retrieval_channel_summary(documents),
        }
        if error:
            retrieval_summary["error"] = error
        if error or bool(getattr(documents, "degraded", False)):
            retrieval_degraded = True
        trace_steps.append(_completed_trace_step(
            "retrieve",
            "failed" if error else _retrieval_trace_status(documents),
            int(outcome["duration_ms"]),
            {
                "query": planned_query,
                "limit": retrieve_limit,
                "threshold": threshold,
                "routes": intent["routes"],
            },
            retrieval_summary,
        ))
        if error:
            continue

        if cache_store and scope_fingerprint:
            cache_started_at = _now_ms()
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
                    cache_started_at,
                    {"cache_kind": "subquery", "query": planned_query},
                    {"stored": False, "error": "Cache write failed"},
                ))

        _merge_documents(merged_by_key, documents, planned_query)

    preliminary_verification = verify_evidence_support(query, list(merged_by_key.values()))
    retry_reasons: list[str] = []
    if not merged_by_key:
        retry_reasons.append("no_candidates")
    if preliminary_verification.get("support_label") == "unsupported":
        retry_reasons.append("unsupported_candidates")
    if preliminary_verification.get("missing_markers"):
        retry_reasons.append("missing_required_markers")
    if retrieval_degraded:
        retry_reasons.append("retrieval_degraded")

    if retry_reasons:
        retry_query = _build_retry_query(query, intent)
        if retry_query not in planned_queries:
            planned_queries.append(retry_query)
        started_at = _now_ms()
        retry_error = None
        try:
            documents = _invoke_retriever(
                retrieve_fn,
                retry_query,
                user_id,
                project_space_id,
                retrieve_limit,
                max(0.0, threshold * 0.5),
                intent["routes"],
            )
        except Exception:
            documents = []
            retry_error = "Retrieval retry failed"
        trace_steps.append(_trace_step(
            "retrieve_retry",
            "failed" if retry_error else _retrieval_trace_status(documents),
            started_at,
            {
                "query": retry_query,
                "limit": retrieve_limit,
                "threshold": max(0.0, threshold * 0.5),
                "routes": intent["routes"],
                "reasons": sorted(set(retry_reasons)),
            },
            {
                "hit_count": len(documents),
                "top_similarity": max([float(doc.get("similarity") or 0) for doc in documents] or [0]),
                **_retrieval_channel_summary(documents),
                **({"error": retry_error} if retry_error else {}),
            },
        ))
        _merge_documents(merged_by_key, documents, retry_query)

    started_at = _now_ms()
    reranker_name = (
        settings.reranker_model
        if rerank_fn is default_rerank_documents and settings.reranker_enabled
        else LOCAL_RERANKER_VERSION
        if rerank_fn is default_rerank_documents
        else "custom"
    )
    reranker_mode = (
        "provider_after_rrf"
        if rerank_fn is default_rerank_documents and settings.reranker_enabled
        else "deterministic_local_evidence"
        if rerank_fn is default_rerank_documents
        else "custom"
    )
    ranked_documents = rerank_fn(query, list(merged_by_key.values()))
    selected_documents = _select_diverse_documents(ranked_documents, limit)
    trace_steps.append(_trace_step(
        "rerank",
        "success",
        started_at,
        {"candidate_count": len(ranked_documents), "limit": limit},
        {
            "reranker": reranker_name,
            "reranker_mode": reranker_mode,
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

    parent_candidates = [
        document
        for document in selected_documents
        if str((document.get("metadata") or {}).get("parent_section_id") or "").strip()
    ]
    if parent_candidates:
        started_at = _now_ms()
        try:
            parent_rows = parent_depth_fn(
                user_id,
                project_space_id,
                parent_candidates,
                PARENT_SECTION_LIMIT,
                PARENT_SECTION_CHUNK_LIMIT,
            )
            expanded_documents = build_parent_section_documents(
                selected_documents,
                parent_rows,
                max_parent_chars=PARENT_SECTION_MAX_CHARS,
            )
            expanded_count = sum(1 for document in expanded_documents if document.get("parent_child") is True)
            selected_documents = expanded_documents
            trace_steps.append(_trace_step(
                "parent_expand",
                "success" if expanded_count else "partial",
                started_at,
                {
                    "matched_child_count": len(parent_candidates),
                    "max_parents": PARENT_SECTION_LIMIT,
                    "max_chunks_per_parent": PARENT_SECTION_CHUNK_LIMIT,
                },
                {
                    "loaded_chunk_count": len(parent_rows),
                    "expanded_parent_count": expanded_count,
                    "context_document_count": len(selected_documents),
                },
            ))
        except Exception:
            trace_steps.append(_trace_step(
                "parent_expand",
                "partial",
                started_at,
                {"matched_child_count": len(parent_candidates)},
                {
                    "expanded_parent_count": 0,
                    "context_document_count": len(selected_documents),
                    "error": "Parent expansion failed; ranked child evidence was retained",
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

    cache_info["metrics"] = cache_metrics_snapshot()
    return {
        "run_id": run_id,
        "mode": "agentic",
        "query_resolution": query_resolution,
        "intent": intent,
        "planned_queries": planned_queries,
        "results": selected_documents,
        "trace_steps": trace_steps,
        "quality": quality,
        "insufficient_evidence": insufficient_evidence,
        "answer_guidance": answer_guidance,
        "cache": cache_info,
        # Echoes the calling service's trace so this retrieval can be joined back
        # to the Agent step that caused it. Empty when the caller sent nothing
        # usable, which is not an error.
        "caller_trace": dict(caller_trace or {}),
    }


def agentic_retrieve(
    query: str,
    user_id: str,
    project_space_id: str | None = None,
    conversation_id: str | None = None,
    conversation_context: list[dict] | None = None,
    limit: int = 5,
    threshold: float = 0.1,
    retrieve_fn: RetrieveFn = retrieve_documents,
    rerank_fn: RerankFn = default_rerank_documents,
    inventory_fn: InventoryFn = list_files_for_inventory,
    inventory_count_fn: InventoryCountFn | None = None,
    cache_store: RetrievalCacheStore | None = None,
    parent_depth_fn: ParentDepthFn = list_parent_chunks_for_matches,
    active_chunks_fn: ActiveChunksFn = get_active_chunks_by_ids,
    caller_trace: dict | None = None,
) -> dict:
    """Coordinate identical exact-cache misses before running retrieval.

    The lease is only a short-lived cache-fill lock. A timeout or Redis error
    always continues with normal retrieval and never changes business state.
    """

    deterministic_resolution = resolve_standalone_query(query, conversation_context)
    query_resolution = rewrite_query_resolution(deterministic_resolution, conversation_context)
    query_resolution["available_context_turns"] = len(conversation_context or [])
    retrieval_query = str(query_resolution.get("standalone_query") or query)
    implementation_args = (
        retrieval_query,
        user_id,
        project_space_id,
        conversation_id,
        query_resolution,
        limit,
        threshold,
        retrieve_fn,
        rerank_fn,
        inventory_fn,
        inventory_count_fn,
        cache_store,
        parent_depth_fn,
        active_chunks_fn,
        dict(caller_trace or {}),
    )
    if not cache_store or _looks_like_inventory_query(retrieval_query):
        return _agentic_retrieve_impl(*implementation_args)

    acquire = getattr(cache_store, "acquire_singleflight", None)
    wait_for_fill = getattr(cache_store, "wait_for_singleflight", None)
    release = getattr(cache_store, "release_singleflight", None)
    if not callable(acquire) or not callable(wait_for_fill) or not callable(release):
        return _agentic_retrieve_impl(*implementation_args)

    coordination_started_at = _now_ms()
    lease: dict | None = None
    coordination = {"role": "bypass", "reason": "coordination_unavailable"}
    normalized_query = normalize_query(retrieval_query)
    try:
        intent = _classify_question(retrieval_query)
        scope = cache_store.get_scope(user_id, project_space_id)
        scope_fingerprint = _request_cache_fingerprint(
            str(scope.get("fingerprint") or ""),
            intent["routes"],
            limit,
            threshold,
            rerank_fn,
        )
        existing = cache_store.find_exact(
            user_id,
            project_space_id,
            conversation_id,
            scope_fingerprint,
            normalized_query,
        )
        if existing:
            return _agentic_retrieve_impl(*implementation_args)

        lease = acquire(
            user_id,
            project_space_id,
            scope_fingerprint,
            normalized_query,
        ) or {"role": "bypass", "reason": "coordination_unavailable"}
        coordination = dict(lease)
        role = str(lease.get("role") or "bypass")
        if role == "leader":
            record_cache_metric("singleflight_leader")
        elif role == "waiter":
            record_cache_metric("singleflight_waiter")
            waited_entry = wait_for_fill(
                user_id,
                project_space_id,
                scope_fingerprint,
                normalized_query,
                wait_ms=lease.get("wait_ms"),
            )
            if waited_entry:
                coordination["outcome"] = "coalesced_hit"
                record_cache_metric("singleflight_coalesced")
            else:
                coordination["outcome"] = "timeout_fallback"
                record_cache_metric("singleflight_timeout")
        else:
            record_cache_metric("singleflight_bypass")
    except Exception:
        coordination = {"role": "bypass", "reason": "coordination_error"}
        record_cache_metric("singleflight_bypass")

    try:
        result = _agentic_retrieve_impl(*implementation_args)
    finally:
        if lease and lease.get("role") == "leader":
            try:
                release(lease)
            except Exception:
                record_cache_metric("singleflight_release_error")

    if isinstance(result, dict):
        duration_ms = max(0, _now_ms() - coordination_started_at)
        public_coordination = {
            "role": coordination.get("role"),
            "outcome": coordination.get("outcome"),
            "reason": coordination.get("reason"),
            "wait_ms": duration_ms if coordination.get("role") == "waiter" else 0,
        }
        result.setdefault("trace_steps", []).append(_trace_step(
            "cache_singleflight",
            "partial" if public_coordination["outcome"] == "timeout_fallback" else "success",
            coordination_started_at,
            {
                "user_id": user_id,
                "project_space_id": project_space_id,
                "normalized_query": normalized_query,
            },
            public_coordination,
        ))
        cache_info = result.setdefault("cache", _cache_summary("disabled"))
        cache_info["singleflight"] = public_coordination
        cache_info["metrics"] = cache_metrics_snapshot()
    return result
