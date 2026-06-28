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
    embedding_api_key: str
    embedding_base_url: str
    embedding_model: str
    embedding_dimension: int


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


def load_settings() -> Settings:
    required_keys = [
        "DATABASE_URL",
        "S3_ENDPOINT",
        "S3_ACCESS_KEY",
        "S3_SECRET_KEY",
        "MILVUS_URI",
        "MILVUS_COLLECTION",
        "EMBEDDING_API_KEY",
        "EMBEDDING_BASE_URL",
        "EMBEDDING_MODEL",
        "EMBEDDING_DIMENSION",
    ]
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
        embedding_api_key=_required("EMBEDDING_API_KEY"),
        embedding_base_url=_required("EMBEDDING_BASE_URL"),
        embedding_model=_required("EMBEDDING_MODEL"),
        embedding_dimension=_positive_int("EMBEDDING_DIMENSION"),
    )


settings = load_settings()
