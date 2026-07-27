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

test('server exposes authenticated RAG workbench endpoints for inspection and graph search', () => {
  const indexSource = readSource('src/index.ts');
  const routesSource = readOptionalSource('src/routes/ragWorkbench.ts');
  const controllerSource = readOptionalSource('src/controllers/ragWorkbench.ts');
  const ragClientSource = readSource('src/lib/ragClient.ts');

  assert.match(indexSource, /ragWorkbenchRoutes/);
  assert.match(indexSource, /\/api\/rag-workbench/);
  assert.match(routesSource, /router\.post\('\/inspect'/);
  assert.match(routesSource, /router\.post\('\/graph\/list'/);
  assert.match(routesSource, /router\.post\('\/graph\/search'/);
  assert.match(routesSource, /requireAuth/);
  assert.match(controllerSource, /inspectRagRetrieval/);
  assert.match(controllerSource, /listRagGraph/);
  assert.match(controllerSource, /searchRagGraph/);
  assert.match(controllerSource, /retrieveAgenticRagDocuments/);
  assert.match(controllerSource, /listRagGraphDocuments/);
  assert.match(controllerSource, /searchRagGraphDocuments/);
  assert.match(ragClientSource, /listRagGraphDocuments/);
  assert.match(ragClientSource, /searchRagGraphDocuments/);
  assert.match(ragClientSource, /\/graph\/list/);
  assert.match(ragClientSource, /\/graph\/search/);
});
