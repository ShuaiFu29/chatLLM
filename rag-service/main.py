from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import settings
from ingestion import process_file
from retrieval import retrieve_documents
from vector_store import delete_file_vectors, ensure_collection

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
    project_space_id: str | None = None
    limit: int = 5
    threshold: float = 0.1

class CleanupFileRequest(BaseModel):
    file_id: str

@app.get("/")
async def root():
    return {"status": "ok", "service": "rag-service"}

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

@app.on_event("startup")
def startup():
    ensure_collection()

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
            project_space_id=request.project_space_id,
            limit=request.limit,
            threshold=request.threshold
        )
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/cleanup-file")
def cleanup_file_endpoint(request: CleanupFileRequest):
    try:
        delete_file_vectors(request.file_id)
        return {"status": "deleted", "file_id": request.file_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.port)
