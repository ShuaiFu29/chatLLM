import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');

test('RAG retrieval cache migration adds knowledge versions, index versions, and scoped evidence cache', () => {
  const migration = readSource('migrations/0016_rag_retrieval_cache.sql');
  const conversationLookupMigration = readSource('migrations/0017_rag_cache_conversation_lookup.sql');

  assert.match(migration, /add column if not exists knowledge_version bigint not null default 1/i);
  assert.match(migration, /add column if not exists knowledge_version_updated_at timestamptz/i);
  assert.match(migration, /create table if not exists rag_index_versions/i);
  assert.match(migration, /vector_version bigint not null default 1/i);
  assert.match(migration, /bm25_version bigint not null default 1/i);
  assert.match(migration, /graph_version bigint not null default 1/i);
  assert.match(migration, /chunk_strategy_version text not null/i);
  assert.match(migration, /embedding_model text not null/i);
  assert.match(migration, /create table if not exists rag_retrieval_cache/i);
  assert.match(migration, /retrieval_scope_fingerprint text not null/i);
  assert.match(migration, /cache_kind text not null/i);
  assert.match(migration, /query_hash text not null/i);
  assert.match(migration, /evidence jsonb not null default '\[\]'::jsonb/i);
  assert.match(migration, /expires_at timestamptz not null/i);
  assert.match(migration, /rag_retrieval_cache_lookup_idx/i);
  assert.match(conversationLookupMigration, /rag_retrieval_cache_conversation_lookup_idx/i);
  assert.match(conversationLookupMigration, /conversation_id/i);
});

test('chat controller passes conversation id into Agentic RAG so evidence reuse stays session-aware', () => {
  const chatSource = readSource('src/controllers/chat.ts');
  const ragClientSource = readSource('src/lib/ragClient.ts');

  assert.match(ragClientSource, /conversation_id\?: string/);
  assert.match(chatSource, /conversation_id:\s*conversationId/);
  assert.match(chatSource, /retrieveAgenticRagDocuments\(\{/);
});
