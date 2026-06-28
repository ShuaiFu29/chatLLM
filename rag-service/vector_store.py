import os
from typing import Any

from dotenv import load_dotenv
from pymilvus import DataType, MilvusClient

load_dotenv()

MILVUS_URI = os.environ.get("MILVUS_URI", "http://localhost:19530")
COLLECTION_NAME = os.environ.get("MILVUS_COLLECTION", "document_chunks")
EMBEDDING_DIMENSION = int(os.environ.get("EMBEDDING_DIMENSION", "1024"))

client = MilvusClient(uri=MILVUS_URI)


def ensure_collection():
    if client.has_collection(COLLECTION_NAME):
      return

    schema = MilvusClient.create_schema(auto_id=True, enable_dynamic_field=False)
    schema.add_field("id", DataType.INT64, is_primary=True)
    schema.add_field("chunk_id", DataType.VARCHAR, max_length=64)
    schema.add_field("file_id", DataType.VARCHAR, max_length=64)
    schema.add_field("user_id", DataType.VARCHAR, max_length=64)
    schema.add_field("filename", DataType.VARCHAR, max_length=512)
    schema.add_field("chunk_index", DataType.INT64)
    schema.add_field("embedding", DataType.FLOAT_VECTOR, dim=EMBEDDING_DIMENSION)

    index_params = MilvusClient.prepare_index_params()
    index_params.add_index(
        field_name="embedding",
        index_type="HNSW",
        metric_type="COSINE",
        params={"M": 16, "efConstruction": 200},
    )

    client.create_collection(
        collection_name=COLLECTION_NAME,
        schema=schema,
        index_params=index_params,
    )


def delete_file_vectors(file_id: str):
    ensure_collection()
    client.delete(
        collection_name=COLLECTION_NAME,
        filter=f'file_id == "{file_id}"',
    )


def insert_vectors(rows: list[dict[str, Any]]):
    if not rows:
        return

    ensure_collection()
    client.insert(collection_name=COLLECTION_NAME, data=rows)


def search_vectors(user_id: str, embedding: list[float], limit: int, threshold: float):
    ensure_collection()

    results = client.search(
        collection_name=COLLECTION_NAME,
        data=[embedding],
        anns_field="embedding",
        limit=limit,
        filter=f'user_id == "{user_id}"',
        output_fields=["chunk_id", "file_id", "user_id", "filename", "chunk_index"],
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
                "filename": entity.get("filename"),
                "chunk_index": entity.get("chunk_index"),
                "similarity": score,
            })
    return filtered
