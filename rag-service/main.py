import threading

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from config import settings
from agentic_retrieval import agentic_retrieve
from db import check_database_ready
from eval_runner import run_eval_cases
from graph_store import check_graph_store_ready, delete_file_graph, ensure_graph_schema, search_graph
from ingestion import process_file
from keyword_store import check_keyword_store_ready, delete_file_keywords, ensure_keyword_index
from retrieval import retrieve_documents
from vector_store import check_vector_store_ready, delete_file_vectors, ensure_collection

app = FastAPI(title="RAG Service", description="Microservice for Retrieval-Augmented Generation")
ingest_semaphore = threading.BoundedSemaphore(settings.rag_ingest_concurrency)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.rag_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def strip_and_reject_blank_value(value: str | None):
    if value is None:
        return value

    stripped = value.strip()
    if not stripped:
        raise ValueError("must not be blank")
    return stripped


class FileIdRequest(BaseModel):
    file_id: str = Field(..., min_length=1, max_length=128)

    @field_validator("file_id")
    @classmethod
    def strip_file_id(cls, value: str):
        return strip_and_reject_blank_value(value)


class IngestRequest(FileIdRequest):
    pass

class RetrieveRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=4096)
    user_id: str = Field(..., min_length=1, max_length=128)
    project_space_id: str | None = Field(default=None, max_length=128)
    limit: int = Field(default=5, ge=1, le=50)
    threshold: float = Field(default=0.1, ge=0.0, le=1.0)

    @field_validator("query", "user_id", "project_space_id")
    @classmethod
    def strip_and_reject_blank(cls, value: str | None):
        return strip_and_reject_blank_value(value)


class AgenticRetrieveRequest(RetrieveRequest):
    pass


class EvalCaseRequest(BaseModel):
    id: str = Field(..., min_length=1, max_length=128)
    question: str = Field(..., min_length=1, max_length=4096)
    expected_answer: str = Field(default="", max_length=4000)
    expected_keywords: list[str] = Field(default_factory=list, max_length=20)
    expected_source_files: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("id", "question")
    @classmethod
    def strip_required_fields(cls, value: str):
        return strip_and_reject_blank_value(value)

    @field_validator("expected_answer")
    @classmethod
    def strip_expected_answer(cls, value: str):
        return value.strip()


class EvalRunRequest(BaseModel):
    cases: list[EvalCaseRequest] = Field(..., min_length=1, max_length=50)
    user_id: str = Field(..., min_length=1, max_length=128)
    project_space_id: str | None = Field(default=None, max_length=128)
    limit: int = Field(default=10, ge=1, le=50)
    threshold: float = Field(default=0.1, ge=0.0, le=1.0)

    @field_validator("user_id", "project_space_id")
    @classmethod
    def strip_optional_fields(cls, value: str | None):
        return strip_and_reject_blank_value(value)


class CleanupFileRequest(FileIdRequest):
    pass

@app.get("/")
async def root():
    return {"status": "ok", "service": "rag-service"}

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

@app.get("/health/ready")
def ready_health_check():
    checks = {
        "postgres": "error",
        "milvus": "error",
        "elasticsearch": "error",
        "neo4j": "error",
    }

    try:
        check_database_ready()
        checks["postgres"] = "ok"
    except Exception:
        checks["postgres"] = "error"

    try:
        check_vector_store_ready()
        checks["milvus"] = "ok"
    except Exception:
        checks["milvus"] = "error"

    try:
        check_keyword_store_ready()
        checks["elasticsearch"] = "ok"
    except Exception:
        checks["elasticsearch"] = "error"

    try:
        check_graph_store_ready()
        checks["neo4j"] = "ok"
    except Exception:
        checks["neo4j"] = "error"

    ready = all(status == "ok" for status in checks.values())
    if not ready:
        raise HTTPException(status_code=503, detail={"status": "not_ready", "checks": checks})

    return {"status": "ready", "checks": checks}

@app.on_event("startup")
def startup():
    ensure_collection()
    ensure_keyword_index()
    ensure_graph_schema()

def process_file_with_guard(file_id: str):
    try:
        process_file(file_id)
    finally:
        ingest_semaphore.release()

@app.post("/ingest")
async def ingest_endpoint(request: IngestRequest, background_tasks: BackgroundTasks):
    """
    Trigger file ingestion.
    """
    if not ingest_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Too many ingestion jobs")

    background_tasks.add_task(process_file_with_guard, request.file_id)
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


@app.post("/agentic-retrieve")
def agentic_retrieve_endpoint(request: AgenticRetrieveRequest):
    try:
        return agentic_retrieve(
            query=request.query,
            user_id=request.user_id,
            project_space_id=request.project_space_id,
            limit=request.limit,
            threshold=request.threshold,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/graph/search")
def graph_search_endpoint(request: RetrieveRequest):
    try:
        results = search_graph(
            query=request.query,
            user_id=request.user_id,
            project_space_id=request.project_space_id,
            limit=request.limit,
        )
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/eval/run")
def eval_run_endpoint(request: EvalRunRequest):
    try:
        return run_eval_cases(
            cases=[case.model_dump() for case in request.cases],
            user_id=request.user_id,
            project_space_id=request.project_space_id,
            limit=request.limit,
            threshold=request.threshold,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/cleanup-file")
def cleanup_file_endpoint(request: CleanupFileRequest):
    try:
        delete_file_vectors(request.file_id)
        delete_file_keywords(request.file_id)
        delete_file_graph(request.file_id)
        return {"status": "deleted", "file_id": request.file_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.port)
