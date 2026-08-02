from config import settings
from db import CHUNK_STRATEGY_VERSION
from reranker import LOCAL_RERANKER_VERSION
from semantic_query_rewriter import QUERY_REWRITER_VERSION


def _feature(status: str, mode: str, version: str, reason: str = "") -> dict:
    feature = {
        "status": status,
        "mode": mode,
        "version": version,
    }
    if reason:
        feature["reason"] = reason
    return feature


def build_capability_report(
    markdown_index: dict | None = None,
    cache_redis_status: str | None = None,
    graph_store_status: str | None = None,
    graph_runtime_quality: dict | None = None,
) -> dict:
    query_rewrite = (
        _feature("enabled", "semantic_llm_with_validated_fallback", QUERY_REWRITER_VERSION)
        if settings.query_rewrite_enabled
        else _feature(
            "disabled",
            "deterministic_multi_turn",
            "deterministic-query-rewrite-v2",
            "QUERY_REWRITE_ENABLED is false; deterministic multi-turn rewriting remains active",
        )
    )
    reranker = (
        _feature("enabled", "provider_after_rrf", "compatible-reranker-v1")
        if settings.reranker_enabled
        else _feature(
            "disabled",
            "deterministic_local_evidence",
            LOCAL_RERANKER_VERSION,
            "RERANKER_ENABLED is false; deterministic evidence reranking remains active",
        )
    )

    if not settings.neo4j_enabled:
        graph = _feature("disabled", "disabled", settings.graph_ontology_version, "NEO4J_ENABLED is false")
    elif graph_store_status not in (None, "ok"):
        graph = _feature(
            "degraded",
            "graph_store_unavailable",
            settings.graph_ontology_version,
            "Neo4j is configured but its readiness probe is not healthy",
        )
    elif settings.graph_extraction_enabled:
        runtime_status = (graph_runtime_quality or {}).get("status")
        if runtime_status == "ok":
            graph = _feature(
                "enabled",
                "llm_primary_with_rule_fallback",
                f"{settings.graph_extractor_version}:{settings.graph_ontology_version}",
            )
        else:
            graph = _feature(
                "degraded",
                "llm_configured_runtime_unverified" if runtime_status in (None, "unknown") else "llm_runtime_degraded",
                f"{settings.graph_extractor_version}:{settings.graph_ontology_version}",
                (
                    "Graph LLM is configured but no successful extraction window was observed in the runtime quality window"
                    if runtime_status in (None, "unknown")
                    else "Recent Graph LLM success/fallback ratios are below the production quality threshold"
                ),
            )
        if graph_runtime_quality:
            graph["runtime_quality"] = graph_runtime_quality
    else:
        graph = _feature(
            "degraded",
            "rules_only",
            settings.graph_ontology_version,
            "GRAPH_EXTRACTION_ENABLED is false; deterministic rules cover only explicit predicates and are not production-complete",
        )

    if settings.redis_cache_enabled and cache_redis_status == "ok":
        retrieval_cache = _feature("enabled", "redis_l1_postgres_l2", "exact-evidence-cache-v2")
    elif settings.redis_cache_enabled:
        retrieval_cache = _feature(
            "degraded",
            "postgres_l2_only",
            "exact-evidence-cache-v2",
            "Cache Redis is configured but unavailable; requests fall back to PostgreSQL",
        )
    elif settings.redis_cache_disabled_reason:
        retrieval_cache = _feature(
            "degraded",
            "postgres_l2_only",
            "exact-evidence-cache-v2",
            settings.redis_cache_disabled_reason,
        )
    else:
        retrieval_cache = _feature(
            "disabled",
            "postgres_l2_only",
            "exact-evidence-cache-v2",
            "REDIS_CACHE_ENABLED is false",
        )

    answer_judge = (
        _feature("enabled", "llm_judge_with_human_calibration", "rag-answer-judge-v2")
        if settings.rag_judge_enabled
        else _feature(
            "disabled",
            "n/a",
            "rag-answer-judge-v2",
            "RAG_JUDGE_ENABLED is false; Judge-only metrics remain N/A",
        )
    )

    markdown_status = markdown_index or {
        "status": "unknown",
        "current_chunk_strategy_version": CHUNK_STRATEGY_VERSION,
        "indexed_file_count": None,
        "stale_file_count": None,
        "stale_chunk_count": None,
        "reindex_required": None,
    }
    features = {
        "query_rewrite": query_rewrite,
        "reranker": reranker,
        "graph_extraction": graph,
        "retrieval_cache": retrieval_cache,
        "answer_judge": answer_judge,
        "markdown_index": markdown_status,
    }
    degraded = any(
        feature.get("status") in {"degraded", "unknown"}
        for feature in features.values()
    )
    return {
        "status": "degraded" if degraded else "ok",
        "features": features,
    }
