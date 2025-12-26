import os
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

api_key = os.environ.get("EMBEDDING_API_KEY")
base_url = os.environ.get("EMBEDDING_BASE_URL")
model = os.environ.get("EMBEDDING_MODEL", "embedding-2")

client = OpenAI(api_key=api_key, base_url=base_url)

def get_embedding(text: str) -> list[float]:
    """Generates embedding for a single string."""
    text = text.replace("\n", " ")
    response = client.embeddings.create(input=[text], model=model)
    return response.data[0].embedding

def get_embeddings(texts: list[str]) -> list[list[float]]:
    """Generates embeddings for a list of strings."""
    # Process in batches if necessary, but Zhipu usually handles small batches fine
    clean_texts = [t.replace("\n", " ") for t in texts]
    response = client.embeddings.create(input=clean_texts, model=model)
    return [item.embedding for item in response.data]
