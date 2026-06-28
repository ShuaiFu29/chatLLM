# Startup and Configuration Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-command local startup and early configuration validation for the Express server, RAG service, and root developer workflow.

**Architecture:** The repository root becomes a lightweight orchestration layer with npm scripts and a config checker. Express and RAG each get one dedicated config module used by existing infrastructure modules. Tests cover validation behavior before implementation.

**Tech Stack:** Node.js built-in test runner, npm scripts, concurrently, TypeScript, Express, Python unittest, FastAPI, Docker Compose.

---

## File Structure

- Create `package.json` in the repository root for orchestration scripts.
- Create `scripts/check-env.mjs` and `scripts/check-env.test.mjs` for local `.env` validation.
- Create `server/src/lib/env.ts` for server runtime configuration.
- Create `server/test/env.test.mjs` for server config validation tests.
- Modify `server/src/lib/db.ts`, `server/src/lib/storage.ts`, `server/src/lib/jwt.ts`, `server/src/lib/openai.ts`, and `server/src/index.ts` to use validated config.
- Modify `server/package.json` to run config tests.
- Create `rag-service/config.py` and `rag-service/tests/test_config.py` for RAG runtime configuration.
- Modify `rag-service/db.py`, `rag-service/storage.py`, `rag-service/vector_store.py`, `rag-service/embeddings.py`, and `rag-service/main.py` to use validated settings.
- Update `startup.txt`.

## Task 1: Root Config Checker

- [ ] Write failing Node tests in `scripts/check-env.test.mjs` for missing required keys, forbidden Supabase keys, weak JWT secrets, and valid config.
- [ ] Run `node --test scripts/check-env.test.mjs` and verify it fails because `scripts/check-env.mjs` does not exist.
- [ ] Implement `scripts/check-env.mjs` with reusable parse and validation helpers.
- [ ] Run `node --test scripts/check-env.test.mjs` and verify it passes.

## Task 2: Server Config Validation

- [ ] Write failing Node tests in `server/test/env.test.mjs` that import compiled `dist/lib/env.js` in subprocesses.
- [ ] Run `npm --prefix server run build && node --test server/test/env.test.mjs` and verify it fails because `server/src/lib/env.ts` does not exist.
- [ ] Implement `server/src/lib/env.ts`.
- [ ] Refactor server infrastructure modules to consume `serverEnv`.
- [ ] Set `server/package.json` test script to build and run `test/env.test.mjs`.
- [ ] Run `npm --prefix server run test` and verify it passes.

## Task 3: RAG Config Validation

- [ ] Write failing Python unittest coverage in `rag-service/tests/test_config.py`.
- [ ] Run `cd rag-service && python -m unittest discover -s tests` and verify it fails because `config.py` does not exist.
- [ ] Implement `rag-service/config.py`.
- [ ] Refactor RAG modules to consume `settings`.
- [ ] Run `cd rag-service && python -m unittest discover -s tests` and verify it passes.

## Task 4: Root Startup Scripts

- [ ] Add root `package.json` with scripts: `dev`, `dev:infra`, `dev:server`, `dev:rag`, `dev:client`, `check:config`, `test`, `build`, and `lint`.
- [ ] Install root dev dependency `concurrently`.
- [ ] Run `npm run check:config` and verify local config passes after local `.env` cleanup.
- [ ] Run `npm test` and verify root tests, server tests, and RAG tests pass.

## Task 5: Startup Documentation

- [ ] Update `startup.txt` so the main path is `cd D:\project\chatLLM` then `npm run dev` or `pnpm run dev`.
- [ ] Keep individual service commands for debugging.
- [ ] Run all final verification commands from the design document.
- [ ] Commit the implementation.

