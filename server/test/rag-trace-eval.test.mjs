import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');
const readOptionalSource = (relativePath) => {
  const fullPath = path.join(serverRoot, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
};

test('RAG trace migration stores agentic run metadata and links assistant messages', () => {
  const migrationSource = readOptionalSource('migrations/0006_rag_trace_eval.sql');

  assert.match(migrationSource, /create table if not exists rag_runs/i);
  assert.match(migrationSource, /trace_steps jsonb not null default '\[\]'::jsonb/i);
  assert.match(migrationSource, /quality jsonb not null default '\{\}'::jsonb/i);
  assert.match(migrationSource, /alter table messages\s+add column if not exists rag_run_id text/i);
  assert.match(migrationSource, /rag_runs_user_conversation_created_idx/i);
});

test('server has an agentic RAG client and persists trace runs for assistant messages', () => {
  const ragClientSource = readSource('src/lib/ragClient.ts');
  const chatSource = readSource('src/controllers/chat.ts');
  const ragRunsRepositorySource = readOptionalSource('src/repositories/ragRuns.ts');
  const messageRepositorySource = readSource('src/repositories/messages.ts');

  assert.match(ragClientSource, /retrieveAgenticRagDocuments/);
  assert.match(ragClientSource, /\/agentic-retrieve/);
  assert.match(ragClientSource, /AgenticRagResponse/);

  assert.match(chatSource, /retrieveAgenticRagDocuments/);
  assert.match(chatSource, /ragRunId/);
  assert.match(chatSource, /traceSummary/);
  assert.match(chatSource, /qualitySummary/);
  assert.match(chatSource, /insertRagRunForMessage/);

  assert.match(ragRunsRepositorySource, /insertRagRunForMessage/);
  assert.match(ragRunsRepositorySource, /insert into rag_runs/i);
  assert.match(ragRunsRepositorySource, /update messages/i);

  assert.match(messageRepositorySource, /rag_run_id/);
  assert.match(messageRepositorySource, /rag_trace/);
  assert.match(messageRepositorySource, /left join rag_runs/i);
});
