import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).with_name(".env"))


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
    embedding_provider: str
    embedding_api_key: str
    embedding_base_url: str
    embedding_model: str
    embedding_dimension: int
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
    rag_service_token: str
    rag_db_pool_max: int
    rag_db_pool_timeout_ms: int
    rag_allowed_origins: list[str]


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
        elasticsearch_url=os.environ.get("ELASTICSEARCH_URL", "http://localhost:9200").strip() or "http://localhost:9200",
        elasticsearch_index=os.environ.get("ELASTICSEARCH_INDEX", "chatllm_chunks").strip() or "chatllm_chunks",
        elasticsearch_timeout_ms=_positive_int("ELASTICSEARCH_TIMEOUT_MS", "2000"),
        elasticsearch_number_of_shards=_positive_int("ELASTICSEARCH_NUMBER_OF_SHARDS", "1"),
        elasticsearch_number_of_replicas=int(os.environ.get("ELASTICSEARCH_NUMBER_OF_REPLICAS", "0").strip() or "0"),
        elasticsearch_bulk_batch_size=_positive_int("ELASTICSEARCH_BULK_BATCH_SIZE", "500"),
        elasticsearch_refresh_on_write=_bool("ELASTICSEARCH_REFRESH_ON_WRITE", False),
        neo4j_enabled=_bool("NEO4J_ENABLED", True),
        neo4j_url=os.environ.get("NEO4J_URL", "http://localhost:7474").strip() or "http://localhost:7474",
        neo4j_user=os.environ.get("NEO4J_USER", "neo4j").strip() or "neo4j",
        neo4j_password=os.environ.get("NEO4J_PASSWORD", "chatllm-password").strip() or "chatllm-password",
        neo4j_database=os.environ.get("NEO4J_DATABASE", "neo4j").strip() or "neo4j",
        neo4j_timeout_ms=_positive_int("NEO4J_TIMEOUT_MS", "15000"),
        neo4j_batch_size=_positive_int("NEO4J_BATCH_SIZE", "100"),
        embedding_provider=embedding_provider,
        embedding_api_key=_required("EMBEDDING_API_KEY"),
        embedding_base_url=_required("EMBEDDING_BASE_URL"),
        embedding_model="local-hash" if embedding_provider == "local" else _required("EMBEDDING_MODEL"),
        embedding_dimension=_positive_int("EMBEDDING_DIMENSION"),
        rag_judge_enabled=_bool("RAG_JUDGE_ENABLED", False),
        rag_judge_api_key=os.environ.get("RAG_JUDGE_API_KEY", "").strip(),
        rag_judge_base_url=os.environ.get("RAG_JUDGE_BASE_URL", "https://api.moonshot.cn/v1").strip() or "https://api.moonshot.cn/v1",
        rag_judge_model=os.environ.get("RAG_JUDGE_MODEL", "moonshot-v1-8k").strip() or "moonshot-v1-8k",
        rag_judge_timeout_ms=_positive_int("RAG_JUDGE_TIMEOUT_MS", "10000"),
        rag_readiness_timeout_ms=_positive_int("RAG_READINESS_TIMEOUT_MS", "2000"),
        rag_ingest_concurrency=_positive_int("RAG_INGEST_CONCURRENCY", "2"),
        rag_ingest_streaming_threshold_bytes=_positive_int("RAG_INGEST_STREAMING_THRESHOLD_BYTES", str(50 * 1024 * 1024)),
        rag_ingest_chunk_batch_size=_positive_int("RAG_INGEST_CHUNK_BATCH_SIZE", "100"),
        rag_ingest_embedding_batch_size=_positive_int("RAG_INGEST_EMBEDDING_BATCH_SIZE", "10"),
        rag_service_token=rag_service_token,
        rag_db_pool_max=_positive_int("RAG_DB_POOL_MAX", "10"),
        rag_db_pool_timeout_ms=_positive_int("RAG_DB_POOL_TIMEOUT_MS", "5000"),
        rag_allowed_origins=_string_list(
            "RAG_ALLOWED_ORIGINS",
            ["http://localhost:3000", "http://localhost:5173"],
        ),
    )


settings = load_settings()
