# Supabase Replacement With Milvus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Supabase with local PostgreSQL, MinIO, and Milvus while fixing the known security, RAG, upload, and API consistency issues.

**Architecture:** Express remains the API gateway and owns auth, chat, upload, and file state in PostgreSQL. MinIO stores uploaded source documents. The Python RAG service reads metadata/text from PostgreSQL, downloads files from MinIO, stores embeddings in Milvus, and returns source chunks to the chat controller.

**Tech Stack:** React/Vite/TypeScript, Express/TypeScript, PostgreSQL via `pg`, MinIO/S3 via AWS SDK v3, FastAPI/Python, `psycopg`, `boto3`, `pymilvus`, Docker Compose.

---

## File Map

- Create `docker-compose.yml`: local PostgreSQL, application MinIO, Milvus etcd, Milvus MinIO, Milvus standalone, optional Attu.
- Create `server/migrations/0001_init.sql`: fresh PostgreSQL schema for users, sessions, conversations, messages, files, file_chunks.
- Create `server/src/lib/db.ts`: PostgreSQL connection pool and transaction helper.
- Create `server/src/lib/storage.ts`: MinIO/S3 bucket creation, upload, delete, download metadata helpers.
- Create `server/src/repositories/*.ts`: focused SQL repositories for users, sessions, conversations, messages, files.
- Modify `server/src/controllers/auth.ts`: replace Supabase queries with repositories.
- Modify `server/src/controllers/chat.ts`: replace Supabase queries, add ownership checks, preserve SSE.
- Modify `server/src/controllers/upload.ts`: replace Supabase Storage with MinIO, validate ownership for chunk/merge/delete, fix file deletion cleanup.
- Modify `server/src/services/fileQueue.ts`: use PostgreSQL atomic status transitions.
- Modify `server/src/middleware/auth.ts`: verify JWT user exists through PostgreSQL.
- Modify `server/src/routes/upload.ts`: add missing avatar route or remove caller; plan implements route using MinIO and profile update.
- Modify `server/package.json`: remove Supabase package, add `pg`, AWS SDK, and required typings.
- Create `rag-service/db.py`: PostgreSQL helpers.
- Create `rag-service/storage.py`: MinIO/S3 download helper.
- Create `rag-service/vector_store.py`: Milvus collection setup, insert, search, delete helpers.
- Modify `rag-service/ingestion.py`: PostgreSQL + MinIO + Milvus ingestion flow.
- Modify `rag-service/retrieval.py`: Milvus filtered retrieval and PostgreSQL chunk hydration.
- Modify `rag-service/requirements.txt`: replace `supabase` with `psycopg`, `boto3`, `pymilvus`.
- Modify `client/src/stores/useAuthStore.ts`: change user id type from `number` to `string`.
- Modify `client/src/components/MarkdownRenderer.tsx`: remove raw HTML rendering or sanitize it.
- Modify `.gitignore` if runtime upload/temp directories need ignoring.
- Modify README or add setup docs if time permits.

## Task 1: Local Infrastructure And Schema

**Files:**
- Create: `docker-compose.yml`
- Create: `server/migrations/0001_init.sql`
- Modify: `server/.env.example`
- Modify: `rag-service/requirements.txt`

- [ ] **Step 1: Add Docker Compose infrastructure**

Create `docker-compose.yml` with services for PostgreSQL, application MinIO, Milvus dependencies, Milvus standalone, and Attu. Use distinct buckets/volumes for application files and Milvus internals.

- [ ] **Step 2: Add PostgreSQL schema**

Create `server/migrations/0001_init.sql` with `pgcrypto`, `users`, `sessions`, `conversations`, `messages`, `files`, `file_chunks`, and indexes. Use UUID ids and text `object_key`.

- [ ] **Step 3: Update env examples**

Remove Supabase variables from active examples. Add `DATABASE_URL`, `S3_*`, and `MILVUS_*` variables.

- [ ] **Step 4: Verify syntax**

Run:

```powershell
docker compose config
```

Expected: valid normalized Compose output.

## Task 2: Express PostgreSQL And MinIO Foundations

**Files:**
- Create: `server/src/lib/db.ts`
- Create: `server/src/lib/storage.ts`
- Create: `server/src/repositories/users.ts`
- Create: `server/src/repositories/sessions.ts`
- Create: `server/src/repositories/conversations.ts`
- Create: `server/src/repositories/messages.ts`
- Create: `server/src/repositories/files.ts`
- Modify: `server/package.json`

- [ ] **Step 1: Add dependencies**

Install `pg`, `@types/pg`, `@aws-sdk/client-s3`, and `@aws-sdk/lib-storage`. Remove `@supabase/supabase-js` only after all imports are gone.

- [ ] **Step 2: Add DB pool**

Implement `query`, `withTransaction`, and `getClient` helpers using `DATABASE_URL`.

- [ ] **Step 3: Add storage client**

Implement bucket initialization, `putObjectFromFile`, `deleteObject`, and avatar/document key builders using S3-compatible MinIO config.

- [ ] **Step 4: Add repositories**

Implement repository functions matching current controller behavior:

- users: find by GitHub id, find by id, create, update, delete.
- sessions: create, find with user, delete by id, delete by user.
- conversations: list, create, update owned, delete owned, find owned.
- messages: insert, list for owned conversation, search by user, delete owned.
- files: create upload, find owned, list owned, update status, claim pending, delete owned, list chunks.

- [ ] **Step 5: Typecheck**

Run:

```powershell
npm exec tsc -- --noEmit
```

Expected: no TypeScript errors from the new foundations.

## Task 3: Express Controllers And Security Fixes

**Files:**
- Modify: `server/src/controllers/auth.ts`
- Modify: `server/src/controllers/chat.ts`
- Modify: `server/src/controllers/upload.ts`
- Modify: `server/src/middleware/auth.ts`
- Modify: `server/src/services/fileQueue.ts`
- Modify: `server/src/routes/upload.ts`
- Delete or stop using: `server/src/lib/supabase.ts`

- [ ] **Step 1: Refactor auth**

Replace all Supabase user/session calls with PostgreSQL repositories while preserving GitHub OAuth, access cookie, refresh cookie, token rotation, logout, profile update, and account deletion.

- [ ] **Step 2: Refactor auth middleware**

Verify JWT and then check user existence in PostgreSQL. Return 401 if the user no longer exists.

- [ ] **Step 3: Refactor chat**

Before inserting a user message or reading messages, verify the conversation belongs to `req.user.id`. Search only the user's messages. Generate assistant SSE as before. Log RAG failures rather than silently swallowing them.

- [ ] **Step 4: Refactor upload**

Validate every `uploadId` belongs to `req.user.id` before accepting chunks or merging. Merge chunks, upload to MinIO, update file status to `pending`, and trigger the queue.

- [ ] **Step 5: Implement avatar upload route**

Add `POST /api/upload/avatar`, upload image files to MinIO, update `users.avatar_url` or return a locally resolvable URL strategy. If public MinIO URLs are not reliable, store object key and return a presigned URL in a later step.

- [ ] **Step 6: Fix file delete cleanup**

Delete owned file metadata, MinIO object, PostgreSQL chunks, and call RAG cleanup endpoint or direct cleanup strategy for Milvus vectors by `file_id`.

- [ ] **Step 7: Refactor file queue**

Atomically claim pending files with PostgreSQL and call RAG `/ingest`. Avoid double-processing by checking the status transition.

- [ ] **Step 8: Typecheck server**

Run:

```powershell
npm exec tsc -- --noEmit
```

Expected: no TypeScript errors.

## Task 4: Python RAG PostgreSQL, MinIO, And Milvus

**Files:**
- Create: `rag-service/db.py`
- Create: `rag-service/storage.py`
- Create: `rag-service/vector_store.py`
- Modify: `rag-service/database.py`
- Modify: `rag-service/ingestion.py`
- Modify: `rag-service/retrieval.py`
- Modify: `rag-service/main.py`
- Modify: `rag-service/requirements.txt`

- [ ] **Step 1: Add Python dependencies**

Use `psycopg[binary]`, `boto3`, `pymilvus`, `fastapi`, `uvicorn`, `python-dotenv`, `langchain`, `langchain-text-splitters`, `openai`, and `pypdf`.

- [ ] **Step 2: Implement PostgreSQL helpers**

Use `DATABASE_URL` and return dict rows. Implement helpers for file metadata, status updates, chunk deletion/insertion/hydration, and owned user filtering.

- [ ] **Step 3: Implement MinIO downloader**

Use `boto3` with endpoint URL and credentials. Download file bytes by `object_key`.

- [ ] **Step 4: Implement Milvus vector store**

Create `document_chunks` if missing, using `EMBEDDING_DIMENSION`. Implement `delete_file_vectors`, `insert_vectors`, and `search_vectors` with `user_id` filter.

- [ ] **Step 5: Refactor ingestion**

Load file metadata from PostgreSQL, download from MinIO, split text, insert `file_chunks`, embed batches, insert Milvus vectors, update file progress and status.

- [ ] **Step 6: Refactor retrieval**

Embed query, search Milvus with `user_id`, hydrate chunk text from PostgreSQL by `chunk_id`, return current response shape.

- [ ] **Step 7: Add cleanup endpoint**

Add `POST /cleanup-file` or `DELETE /files/{file_id}/vectors` so Express can remove Milvus vectors during file deletion.

- [ ] **Step 8: Python syntax check**

Run:

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'; python -m py_compile rag-service\main.py rag-service\ingestion.py rag-service\retrieval.py rag-service\embeddings.py rag-service\db.py rag-service\storage.py rag-service\vector_store.py
```

Expected: no syntax errors.

## Task 5: Frontend Consistency And Rendering Safety

**Files:**
- Modify: `client/src/stores/useAuthStore.ts`
- Modify: `client/src/components/MarkdownRenderer.tsx`
- Inspect: `client/src/pages/Profile.tsx`
- Inspect: `client/src/lib/uploadManager.ts`

- [ ] **Step 1: Fix user id type**

Change `User.id` from `number` to `string`.

- [ ] **Step 2: Remove raw HTML rendering risk**

Remove `rehypeRaw` from Markdown rendering unless a sanitizer is added. Prefer no raw HTML for this pass.

- [ ] **Step 3: Ensure avatar upload matches backend**

Keep `Profile.tsx` using `/upload/avatar` if the backend route is implemented.

- [ ] **Step 4: Typecheck client**

Run:

```powershell
npm exec tsc -- -b --noEmit
```

Expected: no TypeScript errors.

## Task 6: End-To-End Verification

**Files:**
- Inspect all changed files.

- [ ] **Step 1: Dependency install**

Run in `server`:

```powershell
npm install
```

Run in `client`:

```powershell
npm install
```

Install RAG requirements in the active Python environment if needed.

- [ ] **Step 2: Static checks**

Run:

```powershell
cd server; npm exec tsc -- --noEmit
cd ..\client; npm exec tsc -- -b --noEmit
cd ..; $env:PYTHONDONTWRITEBYTECODE='1'; python -m py_compile rag-service\*.py
```

Expected: all pass.

- [ ] **Step 3: Infrastructure check**

Run:

```powershell
docker compose config
```

Expected: valid Compose configuration.

- [ ] **Step 4: Migration smoke check**

If Docker is available, start Postgres and apply `server/migrations/0001_init.sql`. Verify the schema contains `users`, `files`, and `file_chunks`.

- [ ] **Step 5: Final review**

Run:

```powershell
git diff --stat
git status --short
```

Expected: only intentional migration/refactor files changed, no build artifacts or secret env files staged.
