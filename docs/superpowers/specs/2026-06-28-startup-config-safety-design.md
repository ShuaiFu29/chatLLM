# Startup and Configuration Safety Design

## Goal

Make the project easier to start from the repository root and fail early when required local infrastructure or secrets are not configured. This optimization keeps the existing React, Express, and Python RAG service boundaries intact.

## Scope

This change covers:

- A root-level command surface for daily development.
- Early environment validation for the Express server and Python RAG service.
- A small root-level config checker that catches missing required keys and leftover Supabase variables in local `.env` files.
- Updated startup instructions that prefer one root command while preserving per-service commands.

This change does not cover RAG request authentication, queue retries, frontend bundle splitting, UI redesign, or production deployment hardening.

## Architecture

The root project gets a `package.json` that acts as an orchestration layer. `npm run dev` or `pnpm run dev` first validates local `.env` files, starts Docker infrastructure with `docker compose up -d`, then runs Express, RAG, and React concurrently.

The Express server gets a focused `server/src/lib/env.ts` module. It loads `server/.env`, validates required keys, rejects weak JWT placeholders, and exposes typed settings to database, storage, JWT, OpenAI, and server bootstrap code.

The RAG service gets a focused `rag-service/config.py` module. It loads `rag-service/.env`, validates PostgreSQL, MinIO, Milvus, and embedding settings, and exposes a `settings` object used by the RAG modules.

## Required Configuration

Express requires:

- `DATABASE_URL`
- `S3_ENDPOINT`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `JWT_SECRET`
- At least one chat model key: `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, or `OPENAI_API_KEY`

RAG requires:

- `DATABASE_URL`
- `S3_ENDPOINT`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `MILVUS_URI`
- `MILVUS_COLLECTION`
- `EMBEDDING_API_KEY`
- `EMBEDDING_BASE_URL`
- `EMBEDDING_MODEL`
- `EMBEDDING_DIMENSION`

Local `.env` files must not contain `SUPABASE_*` variables.

## Error Handling

Startup validation must report missing key names only. It must not print secret values. The server and RAG service should exit during startup when required configuration is missing or unsafe.

The root config checker should print a concise list of configuration problems and exit non-zero. This keeps `npm run dev` from starting half-configured services.

## Testing

Add test coverage without introducing heavyweight test frameworks:

- Server config validation uses Node's built-in test runner against the compiled server code.
- RAG config validation uses Python's built-in `unittest` with subprocess imports.
- Root config checker uses Node's built-in test runner.

Verification commands:

- `npm test`
- `npm --prefix server run build`
- `npm --prefix client run lint`
- `npm --prefix client run build`
- `python -m py_compile rag-service/main.py rag-service/ingestion.py rag-service/retrieval.py rag-service/embeddings.py rag-service/db.py rag-service/storage.py rag-service/vector_store.py rag-service/config.py`
- `docker compose config --quiet`

