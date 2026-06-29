from typing import Any

from pymilvus import DataType, MilvusClient
from config import settings

client: MilvusClient | None = None
_project_space_field_available: bool | None = None


def get_client() -> MilvusClient:
    global client

    if client is None:
        client = MilvusClient(uri=settings.milvus_uri)

    return client


def _escape_filter_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _has_project_space_field() -> bool:
    global _project_space_field_available

    if _project_space_field_available is not None:
        return _project_space_field_available

    client = get_client()
    try:
        description = client.describe_collection(collection_name=settings.milvus_collection)
        fields = description.get("fields", [])
        _project_space_field_available = any(field.get("name") == "project_space_id" for field in fields)
    except Exception:
        _project_space_field_available = False

    return _project_space_field_available


def ensure_collection():
    global _project_space_field_available

    client = get_client()
    if client.has_collection(settings.milvus_collection):
        return

    schema = MilvusClient.create_schema(auto_id=True, enable_dynamic_field=False)
    schema.add_field("id", DataType.INT64, is_primary=True)
    schema.add_field("chunk_id", DataType.VARCHAR, max_length=64)
    schema.add_field("file_id", DataType.VARCHAR, max_length=64)
    schema.add_field("user_id", DataType.VARCHAR, max_length=64)
    schema.add_field("project_space_id", DataType.VARCHAR, max_length=64)
    schema.add_field("filename", DataType.VARCHAR, max_length=512)
    schema.add_field("chunk_index", DataType.INT64)
    schema.add_field("embedding", DataType.FLOAT_VECTOR, dim=settings.embedding_dimension)

    index_params = MilvusClient.prepare_index_params()
    index_params.add_index(
        field_name="embedding",
        index_type="HNSW",
        metric_type="COSINE",
        params={"M": 16, "efConstruction": 200},
    )

    client.create_collection(
        collection_name=settings.milvus_collection,
        schema=schema,
        index_params=index_params,
    )
    _project_space_field_available = True


def check_vector_store_ready() -> bool:
    client = get_client()
    client.has_collection(settings.milvus_collection)
    return True


def delete_file_vectors(file_id: str):
    client = get_client()
    ensure_collection()
    escaped_file_id = _escape_filter_value(file_id)
    client.delete(
        collection_name=settings.milvus_collection,
        filter=f'file_id == "{escaped_file_id}"',
    )


def insert_vectors(rows: list[dict[str, Any]]):
    if not rows:
        return

    client = get_client()
    ensure_collection()
    if not _has_project_space_field():
        rows = [{key: value for key, value in row.items() if key != "project_space_id"} for row in rows]
    client.insert(collection_name=settings.milvus_collection, data=rows)


def search_vectors(
    user_id: str,
    embedding: list[float],
    limit: int,
    threshold: float,
    project_space_id: str | None = None,
):
    client = get_client()
    ensure_collection()
    has_project_space_field = _has_project_space_field()
    escaped_user_id = _escape_filter_value(user_id)
    filters = [f'user_id == "{escaped_user_id}"']
    output_fields = ["chunk_id", "file_id", "user_id", "filename", "chunk_index"]

    if project_space_id and has_project_space_field:
        escaped_project_space_id = _escape_filter_value(project_space_id)
        filters.append(f'project_space_id == "{escaped_project_space_id}"')
        output_fields.append("project_space_id")

    results = client.search(
        collection_name=settings.milvus_collection,
        data=[embedding],
        anns_field="embedding",
        limit=limit,
        filter=" and ".join(filters),
        output_fields=output_fields,
        search_params={"metric_type": "COSINE", "params": {"ef": 64}},
    )

    hits = results[0] if results else []
    filtered = []
    for hit in hits:
        score = float(hit.get("distance", 0))
        if score >= threshold:
            entity = hit.get("entity", {})
            filtered.append({
                "chunk_id": entity.get("chunk_id"),
                "file_id": entity.get("file_id"),
                "user_id": entity.get("user_id"),
                "project_space_id": entity.get("project_space_id"),
                "filename": entity.get("filename"),
                "chunk_index": entity.get("chunk_index"),
                "similarity": score,
            })
    return filtered
