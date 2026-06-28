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

- [x] Write failing Node tests in `scripts/check-env.test.mjs` for missing required keys, forbidden Supabase keys, weak JWT secrets, and valid config.
- [x] Run `node --test scripts/check-env.test.mjs` and verify it fails because `scripts/check-env.mjs` does not exist.
- [x] Implement `scripts/check-env.mjs` with reusable parse and validation helpers.
- [x] Run `node --test scripts/check-env.test.mjs` and verify it passes.

## Task 2: Server Config Validation

- [x] Write failing Node tests in `server/test/env.test.mjs` that import compiled `dist/lib/env.js` in subprocesses.
- [x] Run `npm --prefix server run build && node --test server/test/env.test.mjs` and verify it fails because `server/src/lib/env.ts` does not exist.
- [x] Implement `server/src/lib/env.ts`.
- [x] Refactor server infrastructure modules to consume `serverEnv`.
- [x] Set `server/package.json` test script to build and run `test/env.test.mjs`.
- [x] Run `npm --prefix server run test` and verify it passes.

## Task 3: RAG Config Validation

- [x] Write failing Python unittest coverage in `rag-service/tests/test_config.py`.
- [x] Run `cd rag-service && python -m unittest discover -s tests` and verify it fails because `config.py` does not exist.
- [x] Implement `rag-service/config.py`.
- [x] Refactor RAG modules to consume `settings`.
- [x] Run `cd rag-service && python -m unittest discover -s tests` and verify it passes.

## Task 4: Root Startup Scripts

- [x] Add root `package.json` with scripts: `dev`, `dev:infra`, `dev:server`, `dev:rag`, `dev:client`, `check:config`, `test`, `build`, and `lint`.
- [x] Install root dev dependency `concurrently`.
- [x] Run `npm run check:config` and verify local config passes after local `.env` cleanup.
- [x] Run `npm test` and verify root tests, server tests, and RAG tests pass.

## Task 5: Startup Documentation

- [x] Update `startup.txt` so the main path is `cd D:\project\chatLLM` then `npm run dev` or `pnpm run dev`.
- [x] Keep individual service commands for debugging.
- [x] Run all final verification commands from the design document.
- [x] Commit the implementation.
