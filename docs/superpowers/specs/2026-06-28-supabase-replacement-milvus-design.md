# Supabase Replacement With PostgreSQL, MinIO, and Milvus

Date: 2026-06-28

## Decision

Replace Supabase completely. Existing Supabase data does not need to be migrated.

The target local development stack is Docker Compose with:

- PostgreSQL for business data.
- MinIO for uploaded source documents.
- Milvus for RAG vector storage and similarity search.
- etcd and an internal Milvus object store as Milvus dependencies.

The React client API shape should remain mostly unchanged. The main implementation work is in the Express server, Python RAG service, local infrastructure, and migrations.

## Goals

- Remove all runtime dependencies on Supabase SDK, Supabase Storage, Supabase migrations, and Supabase service role keys.
- Keep business data in PostgreSQL with explicit SQL migrations.
- Store uploaded source files in MinIO through an S3-compatible API.
- Store embeddings in Milvus and filter retrieval by `user_id`.
- Preserve current frontend routes and most backend HTTP endpoints:
  - `/api/auth/*`
  - `/api/chat/*`
  - `/api/upload/*`
  - `/api/search`
- Start the complete local stack with Docker Compose.
- Allow clearing all prior Supabase data and bootstrapping a fresh local database.

## Non-Goals

- No Supabase data migration.
- No production Kubernetes or managed cloud deployment in this phase.
- No redesign of the React UI.
- No replacement of GitHub OAuth unless required by the database refactor.
- No full document parsing overhaul beyond adapting the existing Markdown/PDF ingestion path.

## Target Architecture

```text
React / Vite client
  |
  | HTTP + cookies
  v
Express API server
  |             |
  | SQL         | S3-compatible object API
  v             v
PostgreSQL    MinIO application bucket
  ^
  | SQL metadata
  |
Python RAG service
  |             |
  | S3 download | vector insert/search
  v             v
MinIO          Milvus
```

Milvus standalone also uses its own etcd and internal object storage. The application should not rely on Milvus internal MinIO buckets for user documents. User documents should live in the application MinIO bucket managed by the server.

## Docker Compose Services

Required services:

- `postgres`: business database.
- `minio`: application object storage for uploaded files.
- `milvus-etcd`: Milvus metadata dependency.
- `milvus-minio`: Milvus internal object storage dependency.
- `milvus-standalone`: vector database.

Optional services:

- `attu`: Milvus UI for local inspection.
- `pgadmin` or Adminer: PostgreSQL UI.

The Compose file should expose only the ports needed for local development:

- PostgreSQL: `5432`
- MinIO API: `9000`
- MinIO console: `9001`
- Milvus: `19530`
- Attu, if enabled: `3001` or another non-conflicting port

## Backend Data Layer

The Express server should stop importing `@supabase/supabase-js`.

Recommended implementation:

- Use `pg` for direct PostgreSQL access first.
- Add small repository modules by domain:
  - `usersRepository`
  - `sessionsRepository`
  - `conversationsRepository`
  - `messagesRepository`
  - `filesRepository`
- Keep SQL explicit and close to current query behavior.

An ORM can be added later, but the first migration should minimize moving parts.

## PostgreSQL Schema

Initial schema:

```sql
users (
  id uuid primary key,
  github_id bigint unique not null,
  username text not null,
  avatar_url text not null default '',
  display_name text,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
)

sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
)

conversations (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  title text not null default 'New Chat',
  model text,
  temperature double precision,
  system_prompt text,
  enable_rag boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

messages (
  id uuid primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
)

files (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  filename text not null,
  file_hash text not null,
  file_size bigint,
  file_type text,
  object_key text,
  status text not null check (status in ('uploading', 'pending', 'processing', 'completed', 'failed')),
  progress integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

file_chunks (
  id uuid primary key,
  file_id uuid not null references files(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (file_id, chunk_index)
)
```

`file_chunks` stores text and metadata for traceability. Milvus stores vectors and enough scalar fields to filter and map results back to PostgreSQL rows.

Important indexes:

- `sessions(user_id)`
- `sessions(expires_at)`
- `conversations(user_id, updated_at desc)`
- `messages(conversation_id, created_at)`
- `files(user_id, created_at desc)`
- `files(status, created_at)`
- `files(file_hash)`
- `file_chunks(file_id, chunk_index)`
- `file_chunks(user_id)`

## MinIO Storage

Use a dedicated application bucket, for example `documents`.

Object key format:

```text
users/{user_id}/files/{file_id}/{sanitized_filename}
```

Do not use the raw file hash alone as the object key. Hash-based deduplication can be added later, but the first implementation should favor clear ownership and deletion semantics.

The Express server owns uploads:

- Receives chunks.
- Merges chunks to a temporary local file.
- Uploads merged file to MinIO.
- Saves `object_key` in PostgreSQL.
- Marks file as `pending`.

The Python RAG service reads the `object_key` and downloads the file from MinIO.

## Milvus Collection Design

Collection name:

```text
document_chunks
```

Fields:

- `id`: Milvus primary key, auto-generated or string id.
- `chunk_id`: PostgreSQL `file_chunks.id` as string.
- `file_id`: PostgreSQL `files.id` as string.
- `user_id`: PostgreSQL `users.id` as string.
- `filename`: string.
- `chunk_index`: integer.
- `embedding`: vector field using the configured embedding dimension.

The embedding dimension must be driven by one shared config value:

```env
EMBEDDING_DIMENSION=1024
```

Retrieval must filter by `user_id` in Milvus. Returned Milvus hits should be mapped back to PostgreSQL `file_chunks` rows by `chunk_id`, then sent to the Express chat controller as:

```json
{
  "content": "...",
  "metadata": {
    "filename": "...",
    "file_id": "...",
    "chunk_index": 0
  },
  "similarity": 0.82
}
```

## RAG Service Flow

`POST /ingest`

1. Receive `file_id`.
2. Load file metadata from PostgreSQL.
3. Mark file `processing`.
4. Download object from MinIO.
5. Extract text.
6. Split into chunks.
7. Delete prior chunks for that file from PostgreSQL and Milvus.
8. Insert chunk text rows into PostgreSQL.
9. Generate embeddings in batches.
10. Insert vectors into Milvus.
11. Update progress during processing.
12. Mark file `completed`.
13. On failure, mark file `failed` with `error_message`.

`POST /retrieve`

1. Receive `query`, `user_id`, `limit`, and `threshold`.
2. Embed query.
3. Search Milvus with a `user_id` filter.
4. Load matching chunk text from PostgreSQL.
5. Return chunks with source metadata and similarity score.

## Queue Design

The current in-memory polling queue can be kept for the first pass, but the database state must prevent duplicate processing.

Minimum behavior:

- Select one `pending` file ordered by `created_at`.
- Atomically update it from `pending` to `processing`.
- Call RAG `/ingest`.
- The RAG service owns final `completed` or `failed` status.

Future improvement:

- Replace polling with a real job queue such as BullMQ and Redis.

## Authentication

Keep the current GitHub OAuth and JWT cookie model.

Changes required:

- Replace all Supabase user/session queries with PostgreSQL repositories.
- Ensure every conversation, message, file, and chunk operation checks `user_id`.
- Keep refresh token rotation behavior.
- Remove Supabase service role assumptions.

## Frontend Impact

The frontend should need minimal changes.

Expected updates:

- Fix any type mismatch where user id is typed as `number`; it should be `string`.
- Keep upload, chat, search, auth routes unchanged.
- If avatar upload remains in UI, implement the backend route or remove the UI entry point.

## Environment Variables

Server:

```env
PORT=3000
FRONTEND_URL=http://localhost:5173
BACKEND_URL=http://localhost:3000

DATABASE_URL=postgres://chatllm:chatllm@localhost:5432/chatllm

S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=documents
S3_FORCE_PATH_STYLE=true

JWT_SECRET=change-me
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
RAG_SERVICE_URL=http://localhost:8000
```

RAG service:

```env
PORT=8000
DATABASE_URL=postgres://chatllm:chatllm@localhost:5432/chatllm

S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=documents
S3_FORCE_PATH_STYLE=true

MILVUS_URI=http://localhost:19530
MILVUS_COLLECTION=document_chunks

EMBEDDING_API_KEY=
EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4/
EMBEDDING_MODEL=embedding-2
EMBEDDING_DIMENSION=1024
```

## Migration Strategy

This is a destructive migration away from Supabase.

1. Add Docker Compose infrastructure.
2. Add PostgreSQL schema migrations.
3. Replace Node Supabase client with PostgreSQL and MinIO clients.
4. Replace Python Supabase client with PostgreSQL, MinIO, and Milvus clients.
5. Remove Supabase migrations and env variables from the active runtime path.
6. Verify auth, upload, ingestion, retrieval, chat streaming, deletion, and search.

Existing Supabase data is intentionally ignored.

## Error Handling

Required behavior:

- Do not silently swallow RAG retrieval failures. Log a structured warning and emit a non-fatal source retrieval status if needed.
- Failed ingestion must mark the file `failed`.
- Upload merge failures must clean temporary chunks when safe.
- Deleting a file must delete:
  - PostgreSQL `files` row.
  - PostgreSQL `file_chunks` rows via cascade.
  - MinIO object.
  - Milvus vectors for that `file_id`.
- If Milvus deletion fails during file delete, return an error or mark a cleanup task; do not pretend deletion fully succeeded.

## Testing And Verification

Required local checks:

- `docker compose up -d` starts all infrastructure.
- PostgreSQL migrations apply from an empty database.
- Server TypeScript check passes.
- Client TypeScript check passes.
- Python RAG syntax/import check passes.
- GitHub OAuth user can be created in PostgreSQL.
- Chat conversation CRUD works.
- Message streaming works.
- Markdown upload writes to MinIO and PostgreSQL.
- RAG ingestion writes chunks to PostgreSQL and vectors to Milvus.
- Chat with RAG enabled returns sources.
- Search returns only the current user's messages.
- File deletion removes database rows, MinIO object, and Milvus vectors.

## Risks

- Milvus adds operational complexity compared with pgvector.
- Two object stores may exist in Docker Compose: one for application files, one for Milvus internals. Naming and documentation must make this clear.
- Current code has security issues around ownership checks; the refactor must fix these rather than preserve them.
- Local Docker resource usage will be higher than the current Supabase-based setup.
- Embedding dimension mismatches can break Milvus inserts; this must be validated at startup.
