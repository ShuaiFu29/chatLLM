import hmac
import threading
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import Field, field_validator

from config import settings
from capabilities import build_capability_report
from agentic_retrieval import agentic_retrieve, normalize_caller_trace
from embeddings import get_embeddings
from db import (
    ConversionGenerationStateError,
    assert_eval_lease_active,
    bump_project_knowledge_version,
    check_database_ready,
    get_file,
    get_cleanup_conversion_generation_chunk_ids,
    get_markdown_index_status,
)
from eval_runner import EvalExecutionStopped, EvalRunDeadlineExceeded, run_eval_cases
from graph_store import (
    check_graph_store_ready,
    delete_chunk_graph,
    delete_file_graph,
    ensure_graph_schema,
    list_graph,
    search_graph,
)
from http_safety import RequestBodyLimitMiddleware, StrictRequestModel, public_internal_error_handler
from ingestion import process_file
from keyword_store import (
    check_keyword_store_ready,
    delete_chunk_keywords,
    delete_file_keywords,
    ensure_keyword_index,
)
from retrieval_cache import check_cache_redis_ready, get_default_retrieval_cache
from retrieval import retrieve_documents
from safe_errors import safe_error_fields
from vector_store import (
    check_vector_store_ready,
    delete_chunk_vectors,
    delete_file_vectors,
    ensure_collection,
)


def startup():
    startup_tasks = [
        ("milvus collection", ensure_collection),
        ("elasticsearch keyword index", ensure_keyword_index),
        ("neo4j graph schema", ensure_graph_schema),
    ]

    for label, task in startup_tasks:
        try:
            task()
        except Exception as error:
            print(f"[startup] Deferred {label} initialization: {safe_error_fields(error)}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    startup()
    yield


app = FastAPI(
    title="RAG Service",
    description="Microservice for Retrieval-Augmented Generation",
    lifespan=lifespan,
)
app.add_exception_handler(Exception, public_internal_error_handler)
ingest_semaphore = threading.BoundedSemaphore(settings.rag_ingest_concurrency)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.rag_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestBodyLimitMiddleware, max_body_bytes=settings.rag_max_request_bytes)


def require_internal_auth(x_chatllm_rag_token: str | None = Header(default=None, alias="X-ChatLLM-RAG-Token")):
    # Documentation marker for source-level checks: Header(alias="X-ChatLLM-RAG-Token")
    expected_token = settings.rag_service_token
    if (
        not expected_token
        or not x_chatllm_rag_token
        or not hmac.compare_digest(x_chatllm_rag_token, expected_token)
    ):
        raise HTTPException(status_code=401, detail={"code": "unauthorized"})

    return True


def strip_and_reject_blank_value(value: str | None):
    if value is None:
        return value

    stripped = value.strip()
    if not stripped:
        raise ValueError("must not be blank")
    return stripped


class FileIdRequest(StrictRequestModel):
    file_id: str = Field(..., min_length=1, max_length=128)

    @field_validator("file_id")
    @classmethod
    def strip_file_id(cls, value: str):
        return strip_and_reject_blank_value(value)


class IngestRequest(FileIdRequest):
    attempt_id: UUID
    lease_token: UUID

class RetrieveRequest(StrictRequestModel):
    query: str = Field(..., min_length=1, max_length=4096)
    user_id: str = Field(..., min_length=1, max_length=128)
    project_space_id: str | None = Field(default=None, max_length=128)
    limit: int = Field(default=5, ge=1, le=50)
    threshold: float = Field(default=0.1, ge=0.0, le=1.0)

    @field_validator("query", "user_id", "project_space_id")
    @classmethod
    def strip_and_reject_blank(cls, value: str | None):
        return strip_and_reject_blank_value(value)


class ConversationTurnRequest(StrictRequestModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=2000)

    @field_validator("content")
    @classmethod
    def strip_content(cls, value: str):
        return strip_and_reject_blank_value(value)


class EmbedRequest(StrictRequestModel):
    # Bounded so one call cannot become an unmetered embedding job. The caller
    # embeds a handful of short memory statements, not documents.
    texts: list[str] = Field(..., min_length=1, max_length=64)

    @field_validator("texts")
    @classmethod
    def reject_blank_texts(cls, value: list[str]):
        cleaned = [item.strip() for item in value]
        if any(not item for item in cleaned):
            raise ValueError("texts must not contain blank entries")
        if any(len(item) > 4096 for item in cleaned):
            raise ValueError("each text must be at most 4096 characters")
        return cleaned


class AgenticRetrieveRequest(RetrieveRequest):
    conversation_id: str | None = Field(default=None, max_length=128)
    conversation_context: list[ConversationTurnRequest] = Field(default_factory=list, max_length=8)

    @field_validator("conversation_id")
    @classmethod
    def strip_optional_conversation_id(cls, value: str | None):
        return strip_and_reject_blank_value(value)


class GraphListRequest(StrictRequestModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    project_space_id: str | None = Field(default=None, max_length=128)
    limit: int = Field(default=30, ge=1, le=50)

    @field_validator("user_id", "project_space_id")
    @classmethod
    def strip_and_reject_blank(cls, value: str | None):
        return strip_and_reject_blank_value(value)


class EvalGraphRelationExpectation(StrictRequestModel):
    source: str = Field(..., min_length=1, max_length=200)
    relation: str = Field(..., min_length=1, max_length=120)
    target: str = Field(..., min_length=1, max_length=200)
    polarity: Literal["affirmative", "negative"] = "affirmative"
    modality: Literal[
        "asserted", "conditional", "planned_or_obligatory", "historical"
    ] = "asserted"

    @field_validator("source", "relation", "target")
    @classmethod
    def strip_relation_fields(cls, value: str):
        return strip_and_reject_blank_value(value)


class EvalHumanScores(StrictRequestModel):
    correctness: float | None = Field(default=None, ge=0.0, le=1.0)
    completeness: float | None = Field(default=None, ge=0.0, le=1.0)
    faithfulness: float | None = Field(default=None, ge=0.0, le=1.0)


class EvalEvaluationSpec(StrictRequestModel):
    expected_chunk_ids: list[str] = Field(default_factory=list, max_length=50)
    expected_evidence: list[str] = Field(default_factory=list, max_length=20)
    expected_answerable: bool | None = None
    expected_graph_relations: list[EvalGraphRelationExpectation] = Field(default_factory=list, max_length=20)
    human_scores: EvalHumanScores | None = None

    @field_validator("expected_chunk_ids", "expected_evidence")
    @classmethod
    def strip_gold_strings(cls, values: list[str]):
        return [strip_and_reject_blank_value(value) for value in values]


class EvalCaseRequest(StrictRequestModel):
    id: str = Field(..., min_length=1, max_length=128)
    question: str = Field(..., min_length=1, max_length=4096)
    expected_answer: str = Field(default="", max_length=4000)
    expected_keywords: list[str] = Field(default_factory=list, max_length=20)
    expected_source_files: list[str] = Field(default_factory=list, max_length=20)
    evaluation_spec: EvalEvaluationSpec = Field(default_factory=EvalEvaluationSpec)
    actual_answer: str = Field(default="", max_length=20000)
    retrieval_snapshot: dict[str, object] = Field(default_factory=dict)
    answer_evaluation: dict[str, object] = Field(default_factory=dict)
    generation_metadata: dict[str, object] = Field(default_factory=dict)

    @field_validator("id", "question")
    @classmethod
    def strip_required_fields(cls, value: str):
        return strip_and_reject_blank_value(value)

    @field_validator("expected_answer", "actual_answer")
    @classmethod
    def strip_expected_answer(cls, value: str):
        return value.strip()


class EvalRunRequest(StrictRequestModel):
    run_id: UUID
    lease_token: UUID
    deadline_at: datetime
    case_timeout_ms: int = Field(..., ge=1, le=2147483647)
    cases: list[EvalCaseRequest] = Field(..., min_length=1, max_length=50)
    user_id: str = Field(..., min_length=1, max_length=128)
    project_space_id: str | None = Field(default=None, max_length=128)
    limit: int = Field(default=10, ge=1, le=50)
    threshold: float = Field(default=0.1, ge=0.0, le=1.0)

    @field_validator("user_id", "project_space_id")
    @classmethod
    def strip_optional_fields(cls, value: str | None):
        return strip_and_reject_blank_value(value)

    @field_validator("deadline_at")
    @classmethod
    def require_timezone_aware_deadline(cls, value: datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("deadline_at must include a timezone")
        return value


class CleanupFileRequest(FileIdRequest):
    pass


class CleanupConversionGenerationRequest(FileIdRequest):
    generation_id: UUID

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
        "cache_redis": "disabled" if not settings.redis_cache_enabled else "error",
    }

    def check_postgres():
        check_database_ready()
        return get_markdown_index_status()

    markdown_index = None
    graph_runtime_quality = None
    check_functions = {
        "postgres": check_postgres,
        "milvus": check_vector_store_ready,
        "elasticsearch": check_keyword_store_ready,
        "neo4j": check_graph_store_ready,
        "cache_redis": check_cache_redis_ready,
    }
    executor = ThreadPoolExecutor(max_workers=len(check_functions), thread_name_prefix="rag-readiness")
    futures = {executor.submit(check): name for name, check in check_functions.items()}
    done, pending = wait(
        futures,
        timeout=settings.rag_readiness_timeout_ms / 1000,
    )
    for future in done:
        name = futures[future]
        try:
            result = future.result()
            checks[name] = result if name == "cache_redis" else "ok"
            if name == "postgres":
                markdown_index = result
            elif name == "neo4j" and isinstance(result, dict):
                graph_runtime_quality = result.get("runtime_quality")
        except Exception:
            checks[name] = "error"
    for future in pending:
        checks[futures[future]] = "timeout"
        future.cancel()
    # Readiness must respect its configured budget even if a dependency client
    # ignores cancellation while its own network timeout is still running.
    executor.shutdown(wait=False, cancel_futures=True)

    capabilities = build_capability_report(
        markdown_index,
        checks["cache_redis"],
        checks["neo4j"],
        graph_runtime_quality,
    )
    ready = all(
        checks[name] == "ok"
        for name in ("postgres", "milvus", "elasticsearch", "neo4j")
    )
    if not ready:
        raise HTTPException(
            status_code=503,
            detail={"status": "not_ready", "checks": checks, "capabilities": capabilities},
        )

    return {"status": "ready", "checks": checks, "capabilities": capabilities}

def process_file_with_guard(file_id: str, attempt_id: UUID, lease_token: UUID):
    try:
        process_file(file_id, attempt_id, lease_token)
    finally:
        ingest_semaphore.release()

@app.post("/ingest", dependencies=[Depends(require_internal_auth)])
async def ingest_endpoint(request: IngestRequest, background_tasks: BackgroundTasks):
    """
    Trigger file ingestion.
    """
    if not ingest_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Too many ingestion jobs")

    background_tasks.add_task(
        process_file_with_guard,
        request.file_id,
        request.attempt_id,
        request.lease_token,
    )
    return {"status": "processing_started", "file_id": request.file_id}


# Protected route marker for legacy source checks: @app.post("/ingest-sync")
@app.post("/ingest-sync", dependencies=[Depends(require_internal_auth)])
def ingest_sync_endpoint(request: IngestRequest):
    """
    Process file ingestion within the request so the durable server-side queue
    can retry failures and timeouts instead of only confirming task acceptance.
    """
    if not ingest_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Too many ingestion jobs")

    try:
        result = process_file(request.file_id, request.attempt_id, request.lease_token)
        return {"status": "completed", "file_id": request.file_id, **result}
    finally:
        ingest_semaphore.release()

@app.post("/retrieve", dependencies=[Depends(require_internal_auth)])
def retrieve_endpoint(request: RetrieveRequest):
    """
    Retrieve relevant documents for a query.
    """
    results = retrieve_documents(
        query=request.query,
        user_id=request.user_id,
        project_space_id=request.project_space_id,
        limit=request.limit,
        threshold=request.threshold,
    )
    return {
        "results": results,
        "channel_status": getattr(results, "channel_status", {}),
        "degraded": bool(getattr(results, "degraded", False)),
    }


# Protected route marker for legacy source checks: @app.post("/agentic-retrieve")
@app.post("/agentic-retrieve", dependencies=[Depends(require_internal_auth)])
def agentic_retrieve_endpoint(
    request: AgenticRetrieveRequest,
    # Correlation travels in headers, not in the request body, so it stays out of
    # the retrieval schema. Malformed values are dropped by
    # normalize_caller_trace rather than rejected: losing the ability to join
    # traces must never cost the user an answer.
    x_chatllm_trace_id: str | None = Header(default=None),
    x_chatllm_span_id: str | None = Header(default=None),
):
    return agentic_retrieve(
        query=request.query,
        user_id=request.user_id,
        project_space_id=request.project_space_id,
        conversation_id=request.conversation_id,
        conversation_context=[turn.model_dump() for turn in request.conversation_context],
        limit=request.limit,
        threshold=request.threshold,
        cache_store=get_default_retrieval_cache(),
        caller_trace=normalize_caller_trace(x_chatllm_trace_id, x_chatllm_span_id),
    )



@app.post("/embed", dependencies=[Depends(require_internal_auth)])
def embed_endpoint(request: EmbedRequest):
    """Embed short texts on behalf of the backend.

    Exposed so the backend can rank Agent memories by relevance without owning an
    embedding client of its own. The dimension travels with the response because
    vectors from different models are not comparable, and the caller stores the
    model name alongside each vector so a model change invalidates them instead of
    silently producing meaningless distances.
    """
    vectors = get_embeddings(list(request.texts))
    return {
        "model": settings.embedding_model,
        "dimension": len(vectors[0]) if vectors else 0,
        "embeddings": vectors,
    }

@app.post("/graph/search", dependencies=[Depends(require_internal_auth)])
def graph_search_endpoint(request: RetrieveRequest):
    results = search_graph(
        query=request.query,
        user_id=request.user_id,
        project_space_id=request.project_space_id,
        limit=request.limit,
    )
    return {"results": results}


@app.post("/graph/list", dependencies=[Depends(require_internal_auth)])
def graph_list_endpoint(request: GraphListRequest):
    results = list_graph(
        user_id=request.user_id,
        project_space_id=request.project_space_id,
        limit=request.limit,
    )
    return {"results": results}


# Protected route marker for legacy source checks: @app.post("/eval/run")
@app.post("/eval/run", dependencies=[Depends(require_internal_auth)])
def eval_run_endpoint(request: EvalRunRequest):
    try:
        return run_eval_cases(
            cases=[case.model_dump() for case in request.cases],
            user_id=request.user_id,
            project_space_id=request.project_space_id,
            limit=request.limit,
            threshold=request.threshold,
            run_id=str(request.run_id),
            lease_token=str(request.lease_token),
            deadline_at=request.deadline_at.timestamp(),
            case_timeout_ms=request.case_timeout_ms,
            assert_lease_fn=assert_eval_lease_active,
        )
    except EvalExecutionStopped as error:
        raise HTTPException(
            status_code=409,
            detail={"code": "eval_lease_inactive"},
        ) from error
    except EvalRunDeadlineExceeded as error:
        raise HTTPException(
            status_code=408,
            detail={"code": "eval_deadline_exceeded"},
        ) from error


@app.post("/cleanup-file", dependencies=[Depends(require_internal_auth)])
def cleanup_file_endpoint(request: CleanupFileRequest):
    file_data = get_file(request.file_id)
    delete_file_vectors(request.file_id)
    delete_file_keywords(request.file_id)
    delete_file_graph(request.file_id)
    if file_data:
        bump_project_knowledge_version(
            str(file_data["user_id"]),
            str(file_data.get("project_space_id")) if file_data.get("project_space_id") else None,
            "file_deleted",
        )
    return {"status": "deleted", "file_id": request.file_id}


@app.post(
    "/cleanup-conversion-generation",
    dependencies=[Depends(require_internal_auth)],
)
def cleanup_conversion_generation_endpoint(
    request: CleanupConversionGenerationRequest,
):
    generation_id = str(request.generation_id)
    try:
        chunk_ids = get_cleanup_conversion_generation_chunk_ids(
            request.file_id,
            generation_id,
        )
    except ConversionGenerationStateError as error:
        raise HTTPException(
            status_code=409,
            detail={"code": "conversion_generation_not_cleanup_safe"},
        ) from error

    if chunk_ids is None:
        return {
            "status": "deleted",
            "file_id": request.file_id,
            "generation_id": generation_id,
            "chunk_count": 0,
        }

    delete_chunk_vectors(chunk_ids)
    delete_chunk_keywords(chunk_ids)
    delete_chunk_graph(request.file_id, chunk_ids)
    return {
        "status": "deleted",
        "file_id": request.file_id,
        "generation_id": generation_id,
        "chunk_count": len(chunk_ids),
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.rag_bind_host, port=settings.port)
