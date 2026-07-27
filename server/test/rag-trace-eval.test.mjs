import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

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
  const moduleSource = readSource('src/modules/rag-workbench/rag-workbench.module.ts');
  const serviceSource = readSource('src/modules/rag-workbench/rag-workbench.service.ts');
  const ragClientSource = readSource('src/lib/ragClient.ts');

  assert.match(nestControllerSource, /@Controller\('rag-workbench'\)/);
  assert.match(nestControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(nestControllerSource, /@RateLimitScope\(\{[\s\S]*?keyPrefix:\s*'rag-workbench'/);
  assert.match(nestControllerSource, /constructor\(private readonly ragWorkbenchService: RagWorkbenchService\)/);
  assert.match(nestControllerSource, /@Post\('inspect'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.ragWorkbenchInspect\)[\s\S]*?@CurrentUser\(\)[\s\S]*?@Body\(\)[\s\S]*?this\.ragWorkbenchService\.inspect\(user\.id, body, requestId\)/);
  assert.match(nestControllerSource, /@Post\('graph\/list'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.ragWorkbenchGraphList\)[\s\S]*?this\.ragWorkbenchService\.listGraph\(user\.id, body, requestId\)/);
  assert.match(nestControllerSource, /@Post\('graph\/search'\)[\s\S]*?@ValidateMutation\(mutationSchemas\.ragWorkbenchGraphSearch\)[\s\S]*?this\.ragWorkbenchService\.searchGraph\(user\.id, body, requestId\)/);
  assert.doesNotMatch(nestControllerSource, /@Res\(|@Req\(|AppReply|AppRequest/);
  assert.match(moduleSource, /providers:\s*\[AuthGuard, RagWorkbenchService\]/);
  assert.equal(existsSync(path.join(serverRoot, 'src/controllers/ragWorkbench.ts')), false);
  assert.match(serviceSource, /@Injectable\(\)/);
  assert.match(serviceSource, /retrieveAgenticRagDocuments/);
  assert.match(serviceSource, /listRagGraphDocuments/);
  assert.match(serviceSource, /searchRagGraphDocuments/);
  assert.match(serviceSource, /new HttpException\(\{ error \}, status\)/);
  assert.doesNotMatch(serviceSource, /AppReply|AppRequest|res\.code|res\.send/);
  assert.match(ragClientSource, /listRagGraphDocuments/);
  assert.match(ragClientSource, /searchRagGraphDocuments/);
  assert.match(ragClientSource, /\/graph\/list/);
  assert.match(ragClientSource, /\/graph\/search/);
});

test('RAG workbench native Nest boundary forwards values and preserves query errors', async () => {
  const { RagWorkbenchController } = require(path.join(
    serverRoot,
    'dist',
    'modules',
    'rag-workbench',
    'rag-workbench.controller.js',
  ));
  const { RagWorkbenchService } = require(path.join(
    serverRoot,
    'dist',
    'modules',
    'rag-workbench',
    'rag-workbench.service.js',
  ));
  const body = { query: 'How does retrieval work?', limit: 5 };
  const expected = { results: [{ id: 'result-one' }] };
  const calls = [];
  const controller = new RagWorkbenchController({
    searchGraph: async (...args) => {
      calls.push(args);
      return expected;
    },
  });

  const result = await controller.searchGraph(
    { id: 'user-one' },
    body,
    'request-one',
  );
  assert.equal(result, expected);
  assert.deepEqual(calls, [['user-one', body, 'request-one']]);

  const service = new RagWorkbenchService();
  await assert.rejects(
    service.inspect('user-one', { query: '   ' }, 'request-one'),
    (error) => {
      assert.equal(error.getStatus(), 400);
      assert.deepEqual(error.getResponse(), { error: 'Content is required' });
      return true;
    },
  );
});
