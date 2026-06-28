from openai import OpenAI
from config import settings

client = OpenAI(api_key=settings.embedding_api_key, base_url=settings.embedding_base_url)

def get_embedding(text: str) -> list[float]:
    """Generates embedding for a single string."""
    text = text.replace("\n", " ")
    response = client.embeddings.create(input=[text], model=settings.embedding_model)
    return response.data[0].embedding

def get_embeddings(texts: list[str]) -> list[list[float]]:
    """Generates embeddings for a list of strings."""
    # Process in batches if necessary, but Zhipu usually handles small batches fine
    clean_texts = [t.replace("\n", " ") for t in texts]
    response = client.embeddings.create(input=clean_texts, model=settings.embedding_model)
    return [item.embedding for item in response.data]
