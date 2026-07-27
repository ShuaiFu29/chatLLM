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
  const nestControllerSource = readSource('src/modules/rag-workbench/rag-workbench.controller.ts');
  const handlerSource = readOptionalSource('src/controllers/ragWorkbench.ts');
  const ragClientSource = readSource('src/lib/ragClient.ts');

  assert.match(nestControllerSource, /@Controller\('rag-workbench'\)/);
  assert.match(nestControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(nestControllerSource, /@RateLimitScope\(\{[\s\S]*?keyPrefix:\s*'rag-workbench'/);
  assert.match(nestControllerSource, /@Post\('inspect'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.ragWorkbenchInspect\)[\s\S]*?return inspectRagRetrieval\(request, reply\)/);
  assert.match(nestControllerSource, /@Post\('graph\/list'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.ragWorkbenchGraphList\)[\s\S]*?return listRagGraph\(request, reply\)/);
  assert.match(nestControllerSource, /@Post\('graph\/search'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.ragWorkbenchGraphSearch\)[\s\S]*?return searchRagGraph\(request, reply\)/);
  assert.match(handlerSource, /retrieveAgenticRagDocuments/);
  assert.match(handlerSource, /listRagGraphDocuments/);
  assert.match(handlerSource, /searchRagGraphDocuments/);
  assert.match(ragClientSource, /listRagGraphDocuments/);
  assert.match(ragClientSource, /searchRagGraphDocuments/);
  assert.match(ragClientSource, /\/graph\/list/);
  assert.match(ragClientSource, /\/graph\/search/);
});
