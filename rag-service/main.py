import os
import threading
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from ingestion import process_file
from retrieval import retrieve_documents

# Load environment variables
load_dotenv()

app = FastAPI(title="RAG Service", description="Microservice for Retrieval-Augmented Generation")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class IngestRequest(BaseModel):
    file_id: str

class RetrieveRequest(BaseModel):
    query: str
    user_id: str
    limit: int = 5
    threshold: float = 0.1

@app.get("/")
async def root():
    return {"status": "ok", "service": "rag-service"}

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

@app.post("/ingest")
async def ingest_endpoint(request: IngestRequest, background_tasks: BackgroundTasks):
    """
    Trigger file ingestion.
    """
    # Run in background to avoid blocking
    background_tasks.add_task(process_file, request.file_id)
    return {"status": "processing_started", "file_id": request.file_id}

@app.post("/retrieve")
def retrieve_endpoint(request: RetrieveRequest):
    """
    Retrieve relevant documents for a query.
    """
    try:
        results = retrieve_documents(
            query=request.query, 
            user_id=request.user_id, 
            limit=request.limit,
            threshold=request.threshold
        )
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
