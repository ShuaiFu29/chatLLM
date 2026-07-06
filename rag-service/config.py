import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).with_name(".env"))


@dataclass(frozen=True)
class Settings:
    port: int
    database_url: str
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str
    s3_region: str
    s3_force_path_style: bool
    milvus_uri: str
    milvus_collection: str
    elasticsearch_enabled: bool
    elasticsearch_url: str
    elasticsearch_index: str
    elasticsearch_timeout_ms: int
    neo4j_enabled: bool
    neo4j_url: str
    neo4j_user: str
    neo4j_password: str
    neo4j_database: str
    neo4j_timeout_ms: int
    embedding_provider: str
    embedding_api_key: str
    embedding_base_url: str
    embedding_model: str
    embedding_dimension: int
    rag_readiness_timeout_ms: int
    rag_ingest_concurrency: int
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
    embedding_provider = os.environ.get("EMBEDDING_PROVIDER", "openai-compatible").strip().lower() or "openai-compatible"
    if embedding_provider not in {"openai-compatible", "local"}:
        raise ValueError("EMBEDDING_PROVIDER must be either openai-compatible or local")

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
    missing = [key for key in required_keys if not _required(key)]

    if missing:
        raise ValueError(f"Missing required RAG environment variables: {', '.join(missing)}")

    return Settings(
        port=_positive_int("PORT", "8000"),
        database_url=_required("DATABASE_URL"),
        s3_endpoint=_required("S3_ENDPOINT"),
        s3_access_key=_required("S3_ACCESS_KEY"),
        s3_secret_key=_required("S3_SECRET_KEY"),
        s3_bucket=os.environ.get("S3_BUCKET", "documents").strip() or "documents",
        s3_region=os.environ.get("S3_REGION", "us-east-1").strip() or "us-east-1",
        s3_force_path_style=_bool("S3_FORCE_PATH_STYLE", True),
        milvus_uri=_required("MILVUS_URI"),
        milvus_collection=_required("MILVUS_COLLECTION"),
        elasticsearch_enabled=_bool("ELASTICSEARCH_ENABLED", True),
        elasticsearch_url=os.environ.get("ELASTICSEARCH_URL", "http://localhost:9200").strip() or "http://localhost:9200",
        elasticsearch_index=os.environ.get("ELASTICSEARCH_INDEX", "chatllm_chunks").strip() or "chatllm_chunks",
        elasticsearch_timeout_ms=_positive_int("ELASTICSEARCH_TIMEOUT_MS", "2000"),
        neo4j_enabled=_bool("NEO4J_ENABLED", True),
        neo4j_url=os.environ.get("NEO4J_URL", "http://localhost:7474").strip() or "http://localhost:7474",
        neo4j_user=os.environ.get("NEO4J_USER", "neo4j").strip() or "neo4j",
        neo4j_password=os.environ.get("NEO4J_PASSWORD", "chatllm-password").strip() or "chatllm-password",
        neo4j_database=os.environ.get("NEO4J_DATABASE", "neo4j").strip() or "neo4j",
        neo4j_timeout_ms=_positive_int("NEO4J_TIMEOUT_MS", "3000"),
        embedding_provider=embedding_provider,
        embedding_api_key=_required("EMBEDDING_API_KEY"),
        embedding_base_url=_required("EMBEDDING_BASE_URL"),
        embedding_model="local-hash" if embedding_provider == "local" else _required("EMBEDDING_MODEL"),
        embedding_dimension=_positive_int("EMBEDDING_DIMENSION"),
        rag_readiness_timeout_ms=_positive_int("RAG_READINESS_TIMEOUT_MS", "2000"),
        rag_ingest_concurrency=_positive_int("RAG_INGEST_CONCURRENCY", "2"),
        rag_allowed_origins=_string_list(
            "RAG_ALLOWED_ORIGINS",
            ["http://localhost:3000", "http://localhost:5173"],
        ),
    )


settings = load_settings()
