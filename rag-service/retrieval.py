from database import get_supabase_client
from embeddings import get_embedding

supabase = get_supabase_client()

def retrieve_documents(query: str, user_id: str, limit: int = 5, threshold: float = 0.1):
    
    embedding = get_embedding(query)
    
    params = {
        "query_embedding": embedding,
        "match_threshold": threshold,
        "match_count": limit,
        "filter": {"user_id": int(user_id)}
    }
    
    response = supabase.rpc("match_documents", params).execute()
    
    if not response.data:
        return []
        
    return response.data
