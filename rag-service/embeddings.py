import hashlib
import math
import re

from compatible_api import CompatibleEmbeddingClient
from config import settings

client = None
if settings.embedding_provider != "local":
    client = CompatibleEmbeddingClient(api_key=settings.embedding_api_key, base_url=settings.embedding_base_url)


REMOTE_EMBEDDING_BATCH_SIZE = 10


class EmbeddingIntegrityError(RuntimeError):
    code = "EMBEDDING_RESPONSE_INVALID"

    def __init__(self, reason: str):
        super().__init__(f"Embedding provider returned an invalid response: {reason}")


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


def _validated_remote_batch(response, expected_count: int) -> list[list[float]]:
    response_data = getattr(response, "data", None)
    if not isinstance(response_data, (list, tuple)):
        raise EmbeddingIntegrityError("data must be a list")
    if len(response_data) != expected_count:
        raise EmbeddingIntegrityError("item count does not match the request")

    vectors_by_index: dict[int, list[float]] = {}
    for item in response_data:
        item_index = getattr(item, "index", None)
        if type(item_index) is not int:
            raise EmbeddingIntegrityError("item index must be an integer")
        if item_index < 0 or item_index >= expected_count:
            raise EmbeddingIntegrityError("item index is outside the request range")
        if item_index in vectors_by_index:
            raise EmbeddingIntegrityError("item indexes must be unique")

        raw_vector = getattr(item, "embedding", None)
        if not isinstance(raw_vector, (list, tuple)) or not raw_vector:
            raise EmbeddingIntegrityError("embedding vector must be non-empty")
        if len(raw_vector) != settings.embedding_dimension:
            raise EmbeddingIntegrityError("embedding vector dimension does not match configuration")

        vector: list[float] = []
        for value in raw_vector:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise EmbeddingIntegrityError("embedding vector values must be numeric")
            try:
                normalized_value = float(value)
            except (OverflowError, ValueError):
                raise EmbeddingIntegrityError(
                    "embedding vector values must be representable as finite floats"
                ) from None
            if not math.isfinite(normalized_value):
                raise EmbeddingIntegrityError("embedding vector values must be finite")
            vector.append(normalized_value)
        vectors_by_index[item_index] = vector

    if set(vectors_by_index) != set(range(expected_count)):
        raise EmbeddingIntegrityError("item indexes do not match the request")
    return [vectors_by_index[index] for index in range(expected_count)]


def get_embedding(text: str) -> list[float]:
    """Generates embedding for a single string."""
    return get_embeddings([text])[0]


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
        embeddings.extend(_validated_remote_batch(response, len(batch)))

    return embeddings
