import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values, load_dotenv


SERVICE_ENV_PATH = Path(__file__).with_name(".env")
PROJECT_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def _load_local_cache_redis_password() -> None:
    """Make the Compose cache password available for .env interpolation.

    Production deployments should inject CACHE_REDIS_URL directly. The local
    workspace keeps infrastructure credentials in the root .env, so importing
    only this one disposable-cache password avoids duplicating it in the RAG
    service environment file.
    """
    if os.environ.get("CACHE_REDIS_PASSWORD"):
        return
    infrastructure_env = dotenv_values(PROJECT_ENV_PATH)
    password = (
        infrastructure_env.get("CACHE_REDIS_PASSWORD")
        or infrastructure_env.get("REDIS_PASSWORD")
    )
    if password:
        os.environ["CACHE_REDIS_PASSWORD"] = str(password)


_load_local_cache_redis_password()
load_dotenv(dotenv_path=SERVICE_ENV_PATH)


@dataclass
class Settings:
    port: int
    rag_bind_host: str
    database_url: str
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str
    s3_region: str
    s3_force_path_style: bool
    milvus_uri: str
    milvus_collection: str
    milvus_index_type: str
    milvus_metric_type: str
    milvus_hnsw_m: int
    milvus_hnsw_ef_construction: int
    milvus_search_ef: int
    milvus_insert_batch_size: int
    elasticsearch_enabled: bool
    elasticsearch_url: str
    elasticsearch_index: str
    elasticsearch_schema_version: str
    elasticsearch_timeout_ms: int
    elasticsearch_number_of_shards: int
    elasticsearch_number_of_replicas: int
    elasticsearch_bulk_batch_size: int
    elasticsearch_refresh_on_write: bool
    neo4j_enabled: bool
    neo4j_url: str
    neo4j_user: str
    neo4j_password: str
    neo4j_database: str
    neo4j_timeout_ms: int
    neo4j_batch_size: int
    graph_extraction_enabled: bool
    graph_extraction_api_key: str
    graph_extraction_base_url: str
    graph_extraction_model: str
    graph_extraction_timeout_ms: int
    graph_extractor_version: str
    graph_ontology_version: str
    graph_context_window_chunks: int
    graph_extraction_cache_ttl_days: int
    graph_search_max_hops: int
    graph_search_max_branch_factor: int
    graph_search_max_paths: int
    graph_search_hub_degree_limit: int
    embedding_provider: str
    embedding_api_key: str
    embedding_base_url: str
    embedding_model: str
    embedding_dimension: int
    reranker_enabled: bool
    reranker_api_key: str
    reranker_base_url: str
    reranker_model: str
    reranker_timeout_ms: int
    reranker_top_n: int
    reranker_max_document_chars: int
    query_rewrite_enabled: bool
    query_rewrite_api_key: str
    query_rewrite_base_url: str
    query_rewrite_model: str
    query_rewrite_timeout_ms: int
    query_rewrite_max_alternatives: int
    rag_judge_enabled: bool
    rag_judge_api_key: str
    rag_judge_base_url: str
    rag_judge_model: str
    rag_judge_timeout_ms: int
    rag_readiness_timeout_ms: int
    rag_ingest_concurrency: int
    rag_ingest_streaming_threshold_bytes: int
    rag_ingest_chunk_batch_size: int
    rag_ingest_embedding_batch_size: int
    agentic_query_parallelism: int
    rag_service_token: str
    rag_max_request_bytes: int
    rag_db_pool_max: int
    rag_db_pool_timeout_ms: int
    rag_allowed_origins: list[str]
    redis_url: str
    cache_redis_url: str
    redis_cache_enabled: bool
    redis_cache_disabled_reason: str
    redis_cache_ttl_seconds: int
    redis_cache_singleflight_wait_ms: int
    redis_cache_singleflight_lock_seconds: int


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    return value


def _positive_int(name: str, default: str | None = None) -> int:
    raw = os.environ.get(name, default or "").strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive integer") from exc

    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")

    return value


def _bounded_positive_int(name: str, default: str, maximum: int) -> int:
    value = _positive_int(name, default)
    if value > maximum:
        raise ValueError(f"{name} must be at most {maximum}")
    return value


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() != "false"


def _string_list(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name, "")
    values = [item.strip() for item in raw.split(",") if item.strip()]
    return list(dict.fromkeys(values or default))


def load_settings() -> Settings:
    embedding_provider = os.environ.get("EMBEDDING_PROVIDER", "compatible").strip().lower() or "compatible"
    if embedding_provider not in {"compatible", "local"}:
        raise ValueError("EMBEDDING_PROVIDER must be either compatible or local")

    required_keys = [
        "DATABASE_URL",
        "S3_ENDPOINT",
        "S3_ACCESS_KEY",
        "S3_SECRET_KEY",
        "MILVUS_URI",
        "MILVUS_COLLECTION",
    ]
    if embedding_provider != "local":
        required_keys.extend([
            "EMBEDDING_API_KEY",
            "EMBEDDING_BASE_URL",
            "EMBEDDING_MODEL",
        ])
    required_keys.append("EMBEDDING_DIMENSION")
    required_keys.append("RAG_SERVICE_TOKEN")
    missing = [key for key in required_keys if not _required(key)]

    if missing:
        raise ValueError(f"Missing required RAG environment variables: {', '.join(missing)}")

    rag_service_token = _required("RAG_SERVICE_TOKEN")
    if len(rag_service_token) < 32:
        raise ValueError("RAG_SERVICE_TOKEN must be at least 32 characters")

    redis_url = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0").strip() or "redis://127.0.0.1:6379/0"
    redis_cache_requested = _bool("REDIS_CACHE_ENABLED", False)
    cache_redis_url = os.environ.get("CACHE_REDIS_URL", "").strip()
    redis_cache_disabled_reason = ""
    if redis_cache_requested and not cache_redis_url:
        redis_cache_disabled_reason = "CACHE_REDIS_URL is not configured"
    elif redis_cache_requested and cache_redis_url.rstrip("/") == redis_url.rstrip("/"):
        redis_cache_disabled_reason = "CACHE_REDIS_URL must be separate from REDIS_URL"
    redis_cache_enabled = redis_cache_requested and not redis_cache_disabled_reason

    graph_extraction_enabled = _bool("GRAPH_EXTRACTION_ENABLED", False)
    graph_extraction_api_key = os.environ.get("GRAPH_EXTRACTION_API_KEY", "").strip()
    graph_extraction_base_url = os.environ.get("GRAPH_EXTRACTION_BASE_URL", "").strip()
    graph_extraction_model = os.environ.get("GRAPH_EXTRACTION_MODEL", "").strip()
    if graph_extraction_enabled and not all((
        graph_extraction_api_key,
        graph_extraction_base_url,
        graph_extraction_model,
    )):
        raise ValueError(
            "GRAPH_EXTRACTION_API_KEY, GRAPH_EXTRACTION_BASE_URL, and GRAPH_EXTRACTION_MODEL "
            "are required when GRAPH_EXTRACTION_ENABLED=true"
        )

    graph_ontology_version = os.environ.get("GRAPH_ONTOLOGY_VERSION", "core-v2").strip() or "core-v2"
    if graph_ontology_version not in {"core-v1", "core-v2"}:
        raise ValueError("GRAPH_ONTOLOGY_VERSION must be core-v1 or core-v2")

    reranker_enabled = _bool("RERANKER_ENABLED", False)
    reranker_api_key = os.environ.get("RERANKER_API_KEY", "").strip()
    reranker_base_url = os.environ.get("RERANKER_BASE_URL", "").strip()
    reranker_model = os.environ.get("RERANKER_MODEL", "").strip()
    if reranker_enabled and not all((reranker_api_key, reranker_base_url, reranker_model)):
        raise ValueError(
            "RERANKER_API_KEY, RERANKER_BASE_URL, and RERANKER_MODEL are required when RERANKER_ENABLED=true"
        )

    query_rewrite_enabled = _bool("QUERY_REWRITE_ENABLED", False)
    query_rewrite_api_key = os.environ.get("QUERY_REWRITE_API_KEY", "").strip()
    query_rewrite_base_url = os.environ.get("QUERY_REWRITE_BASE_URL", "").strip()
    query_rewrite_model = os.environ.get("QUERY_REWRITE_MODEL", "").strip()
    if query_rewrite_enabled and not all((query_rewrite_api_key, query_rewrite_base_url, query_rewrite_model)):
        raise ValueError(
            "QUERY_REWRITE_API_KEY, QUERY_REWRITE_BASE_URL, and QUERY_REWRITE_MODEL are required "
            "when QUERY_REWRITE_ENABLED=true"
        )

    return Settings(
        port=_positive_int("PORT", "8000"),
        rag_bind_host=os.environ.get("RAG_BIND_HOST", "127.0.0.1").strip() or "127.0.0.1",
        database_url=_required("DATABASE_URL"),
        s3_endpoint=_required("S3_ENDPOINT"),
        s3_access_key=_required("S3_ACCESS_KEY"),
        s3_secret_key=_required("S3_SECRET_KEY"),
        s3_bucket=os.environ.get("S3_BUCKET", "documents").strip() or "documents",
        s3_region=os.environ.get("S3_REGION", "us-east-1").strip() or "us-east-1",
        s3_force_path_style=_bool("S3_FORCE_PATH_STYLE", True),
        milvus_uri=_required("MILVUS_URI"),
        milvus_collection=_required("MILVUS_COLLECTION"),
        milvus_index_type=os.environ.get("MILVUS_INDEX_TYPE", "HNSW").strip().upper() or "HNSW",
        milvus_metric_type=os.environ.get("MILVUS_METRIC_TYPE", "COSINE").strip().upper() or "COSINE",
        milvus_hnsw_m=_positive_int("MILVUS_HNSW_M", "16"),
        milvus_hnsw_ef_construction=_positive_int("MILVUS_HNSW_EF_CONSTRUCTION", "200"),
        milvus_search_ef=_positive_int("MILVUS_SEARCH_EF", "64"),
        milvus_insert_batch_size=_positive_int("MILVUS_INSERT_BATCH_SIZE", "500"),
        elasticsearch_enabled=_bool("ELASTICSEARCH_ENABLED", True),
        elasticsearch_url=os.environ.get("ELASTICSEARCH_URL", "http://127.0.0.1:9200").strip() or "http://127.0.0.1:9200",
        elasticsearch_index=os.environ.get("ELASTICSEARCH_INDEX", "chatllm_chunks_v2").strip() or "chatllm_chunks_v2",
        elasticsearch_schema_version=os.environ.get("ELASTICSEARCH_SCHEMA_VERSION", "markdown-fields-v2").strip() or "markdown-fields-v2",
        elasticsearch_timeout_ms=_positive_int("ELASTICSEARCH_TIMEOUT_MS", "2000"),
        elasticsearch_number_of_shards=_positive_int("ELASTICSEARCH_NUMBER_OF_SHARDS", "1"),
        elasticsearch_number_of_replicas=int(os.environ.get("ELASTICSEARCH_NUMBER_OF_REPLICAS", "0").strip() or "0"),
        elasticsearch_bulk_batch_size=_positive_int("ELASTICSEARCH_BULK_BATCH_SIZE", "500"),
        elasticsearch_refresh_on_write=_bool("ELASTICSEARCH_REFRESH_ON_WRITE", False),
        neo4j_enabled=_bool("NEO4J_ENABLED", True),
        neo4j_url=os.environ.get("NEO4J_URL", "http://127.0.0.1:7474").strip() or "http://127.0.0.1:7474",
        neo4j_user=os.environ.get("NEO4J_USER", "neo4j").strip() or "neo4j",
        neo4j_password=os.environ.get("NEO4J_PASSWORD", "chatllm-password").strip() or "chatllm-password",
        neo4j_database=os.environ.get("NEO4J_DATABASE", "neo4j").strip() or "neo4j",
        neo4j_timeout_ms=_positive_int("NEO4J_TIMEOUT_MS", "60000"),
        neo4j_batch_size=_positive_int("NEO4J_BATCH_SIZE", "100"),
        graph_extraction_enabled=graph_extraction_enabled,
        graph_extraction_api_key=graph_extraction_api_key,
        graph_extraction_base_url=graph_extraction_base_url,
        graph_extraction_model=graph_extraction_model,
        graph_extraction_timeout_ms=_positive_int("GRAPH_EXTRACTION_TIMEOUT_MS", "15000"),
        graph_extractor_version=os.environ.get("GRAPH_EXTRACTOR_VERSION", "llm-json-v2").strip() or "llm-json-v2",
        graph_ontology_version=graph_ontology_version,
        graph_context_window_chunks=_bounded_positive_int("GRAPH_CONTEXT_WINDOW_CHUNKS", "1", 2),
        graph_extraction_cache_ttl_days=_bounded_positive_int("GRAPH_EXTRACTION_CACHE_TTL_DAYS", "30", 365),
        graph_search_max_hops=_bounded_positive_int("GRAPH_SEARCH_MAX_HOPS", "3", 3),
        graph_search_max_branch_factor=_bounded_positive_int("GRAPH_SEARCH_MAX_BRANCH_FACTOR", "8", 32),
        graph_search_max_paths=_bounded_positive_int("GRAPH_SEARCH_MAX_PATHS", "24", 100),
        graph_search_hub_degree_limit=_bounded_positive_int("GRAPH_SEARCH_HUB_DEGREE_LIMIT", "40", 500),
        embedding_provider=embedding_provider,
        embedding_api_key=_required("EMBEDDING_API_KEY"),
        embedding_base_url=_required("EMBEDDING_BASE_URL"),
        embedding_model="local-hash" if embedding_provider == "local" else _required("EMBEDDING_MODEL"),
        embedding_dimension=_positive_int("EMBEDDING_DIMENSION"),
        reranker_enabled=reranker_enabled,
        reranker_api_key=reranker_api_key,
        reranker_base_url=reranker_base_url,
        reranker_model=reranker_model,
        reranker_timeout_ms=_positive_int("RERANKER_TIMEOUT_MS", "2500"),
        reranker_top_n=_positive_int("RERANKER_TOP_N", "20"),
        reranker_max_document_chars=_positive_int("RERANKER_MAX_DOCUMENT_CHARS", "4000"),
        query_rewrite_enabled=query_rewrite_enabled,
        query_rewrite_api_key=query_rewrite_api_key,
        query_rewrite_base_url=query_rewrite_base_url,
        query_rewrite_model=query_rewrite_model,
        query_rewrite_timeout_ms=_positive_int("QUERY_REWRITE_TIMEOUT_MS", "2500"),
        query_rewrite_max_alternatives=_bounded_positive_int("QUERY_REWRITE_MAX_ALTERNATIVES", "2", 2),
        rag_judge_enabled=_bool("RAG_JUDGE_ENABLED", False),
        rag_judge_api_key=os.environ.get("RAG_JUDGE_API_KEY", "").strip(),
        rag_judge_base_url=os.environ.get("RAG_JUDGE_BASE_URL", "https://api.moonshot.cn/v1").strip() or "https://api.moonshot.cn/v1",
        rag_judge_model=os.environ.get("RAG_JUDGE_MODEL", "moonshot-v1-8k").strip() or "moonshot-v1-8k",
        rag_judge_timeout_ms=_positive_int("RAG_JUDGE_TIMEOUT_MS", "10000"),
        rag_readiness_timeout_ms=_positive_int("RAG_READINESS_TIMEOUT_MS", "8000"),
        rag_ingest_concurrency=_positive_int("RAG_INGEST_CONCURRENCY", "2"),
        rag_ingest_streaming_threshold_bytes=_positive_int("RAG_INGEST_STREAMING_THRESHOLD_BYTES", str(50 * 1024 * 1024)),
        rag_ingest_chunk_batch_size=_positive_int("RAG_INGEST_CHUNK_BATCH_SIZE", "100"),
        rag_ingest_embedding_batch_size=_positive_int("RAG_INGEST_EMBEDDING_BATCH_SIZE", "10"),
        agentic_query_parallelism=_bounded_positive_int("AGENTIC_QUERY_PARALLELISM", "3", 3),
        rag_service_token=rag_service_token,
        rag_max_request_bytes=_positive_int("RAG_MAX_REQUEST_BYTES", str(1024 * 1024)),
        rag_db_pool_max=_positive_int("RAG_DB_POOL_MAX", "10"),
        rag_db_pool_timeout_ms=_positive_int("RAG_DB_POOL_TIMEOUT_MS", "5000"),
        rag_allowed_origins=_string_list(
            "RAG_ALLOWED_ORIGINS",
            ["http://localhost:3000", "http://localhost:5173"],
        ),
        redis_url=redis_url,
        cache_redis_url=cache_redis_url,
        redis_cache_enabled=redis_cache_enabled,
        redis_cache_disabled_reason=redis_cache_disabled_reason,
        redis_cache_ttl_seconds=_positive_int("REDIS_CACHE_TTL_SECONDS", str(6 * 60 * 60)),
        redis_cache_singleflight_wait_ms=_positive_int("REDIS_CACHE_SINGLEFLIGHT_WAIT_MS", "800"),
        redis_cache_singleflight_lock_seconds=_positive_int("REDIS_CACHE_SINGLEFLIGHT_LOCK_SECONDS", "30"),
    )


settings = load_settings()
