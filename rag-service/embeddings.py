import hashlib
import math
import re

from compatible_api import CompatibleEmbeddingClient
from config import settings

client = None
if settings.embedding_provider != "local":
    client = CompatibleEmbeddingClient(api_key=settings.embedding_api_key, base_url=settings.embedding_base_url)


REMOTE_EMBEDDING_BATCH_SIZE = 10


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[\w\u4e00-\u9fff]+", text.lower())


def _local_embedding(text: str) -> list[float]:
    vector = [0.0] * settings.embedding_dimension
    tokens = _tokenize(text)

    if not tokens:
        tokens = [text.strip().lower() or "empty"]

    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % settings.embedding_dimension
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vector[index] += sign

    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        return vector

    return [value / norm for value in vector]

def get_embedding(text: str) -> list[float]:
    """Generates embedding for a single string."""
    if settings.embedding_provider == "local":
        return _local_embedding(text)

    text = text.replace("\n", " ")
    if client is None:
        raise RuntimeError("Embedding client is not initialized")
    response = client.embeddings.create(input=[text], model=settings.embedding_model)
    return response.data[0].embedding

def get_embeddings(texts: list[str]) -> list[list[float]]:
    """Generates embeddings for a list of strings."""
    if settings.embedding_provider == "local":
        return [_local_embedding(text) for text in texts]

    clean_texts = [t.replace("\n", " ") for t in texts]
    if client is None:
        raise RuntimeError("Embedding client is not initialized")

    embeddings: list[list[float]] = []
    for index in range(0, len(clean_texts), REMOTE_EMBEDDING_BATCH_SIZE):
        batch = clean_texts[index: index + REMOTE_EMBEDDING_BATCH_SIZE]
        response = client.embeddings.create(input=batch, model=settings.embedding_model)
        embeddings.extend(item.embedding for item in response.data)

    return embeddings
