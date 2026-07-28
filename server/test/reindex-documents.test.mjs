import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const {
  DOCUMENT_REINGESTION_USAGE,
  parseDocumentReingestionArgs,
  runDocumentReingestion,
} = require(path.join(serverRoot, 'dist', 'scripts', 'reindexDocuments.js'));
const {
  countDocumentsForReingestion,
  queueDocumentsForReingestion,
  SUPPORTED_REINGESTION_DOCUMENT_KINDS,
} = require(path.join(serverRoot, 'dist', 'repositories', 'files.js'));

const projectSpaceId = '11111111-1111-4111-8111-111111111111';
const documentKinds = ['markdown', 'plaintext', 'pdf', 'docx', 'pptx', 'xlsx', 'csv'];

test('document reingestion supports all seven registered document kinds', () => {
  assert.deepEqual([...SUPPORTED_REINGESTION_DOCUMENT_KINDS], documentKinds);
  for (const documentKind of documentKinds) {
    assert.equal(
      parseDocumentReingestionArgs(['--document-kind', documentKind]).documentKind,
      documentKind,
    );
  }
  assert.throws(
    () => parseDocumentReingestionArgs(['--document-kind', 'doc']),
    /must be one of/,
  );
});

test('repository defaults to missing active generations and excludes active ingestion leases', async () => {
  const calls = [];
  const count = await countDocumentsForReingestion({}, async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ count: '7' }] };
  });

  assert.equal(count, 7);
  assert.deepEqual(calls[0].params, [null, documentKinds, false]);
  assert.match(calls[0].sql, /files\.object_key is not null/i);
  assert.match(calls[0].sql, /files\.status in \('completed', 'failed'\)/i);
  assert.match(calls[0].sql, /files\.document_kind = any\(\$2::text\[\]\)/i);
  assert.match(calls[0].sql, /\$3::boolean or files\.active_conversion_generation_id is null/i);
  assert.match(calls[0].sql, /active_job\.status in \('queued', 'processing'\)/i);
  assert.match(calls[0].sql, /active_job\.lease_expires_at > now\(\)/i);
  assert.doesNotMatch(calls[0].sql, /lower\(files\.filename\)|\.markdown'/i);
});

test('repository applies explicit project, document-kind, and include-active filters', async () => {
  let receivedParams;
  await countDocumentsForReingestion({
    projectSpaceId,
    documentKind: 'pdf',
    includeActive: true,
  }, async (_sql, params) => {
    receivedParams = params;
    return { rows: [{ count: 2 }] };
  });

  assert.deepEqual(receivedParams, [projectSpaceId, ['pdf'], true]);
});

test('queue resets only bounded locked candidates through the existing ingestion state machine', async () => {
  let queryCall;
  const queued = await queueDocumentsForReingestion({
    projectSpaceId,
    documentKind: 'xlsx',
    includeActive: true,
    limit: 25,
  }, async (callback) => callback({
    query: async (sql, params) => {
      queryCall = { sql, params };
      return { rows: [{ id: 'file-1' }, { id: 'file-2' }] };
    },
  }));

  assert.deepEqual(queued.map((file) => file.id), ['file-1', 'file-2']);
  assert.deepEqual(queryCall.params.slice(0, 4), [projectSpaceId, ['xlsx'], true, 25]);
  assert.equal(queryCall.params.length, 5);
  assert.equal(Number.isSafeInteger(queryCall.params[4]) && queryCall.params[4] > 0, true);
  assert.match(queryCall.sql, /for update skip locked/i);
  assert.match(queryCall.sql, /limit \$4/i);
  assert.match(queryCall.sql, /set status = 'pending'/i);
  assert.match(queryCall.sql, /progress = 0/i);
  assert.match(queryCall.sql, /attempts = 0/i);
  assert.match(queryCall.sql, /max_attempts = \$5/i);
  assert.match(queryCall.sql, /next_attempt_at = null/i);
  assert.match(queryCall.sql, /last_attempt_at = null/i);
});

test('document reingestion defaults to dry-run and never queues during preview', async () => {
  const options = parseDocumentReingestionArgs(['--limit', '25']);
  let countOptions;
  let queueCalled = false;
  const result = await runDocumentReingestion(options, {
    countTargets: async (receivedOptions) => {
      countOptions = receivedOptions;
      return 42;
    },
    queueTargets: async () => {
      queueCalled = true;
      return [];
    },
  });

  assert.deepEqual(countOptions, {
    projectSpaceId: null,
    includeActive: false,
    documentKind: null,
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.target_count, 42);
  assert.equal(result.would_queue_count, 25);
  assert.equal(result.include_active, false);
  assert.equal(queueCalled, false);
});

test('full-database force execution requires explicit confirmation with every filter', () => {
  assert.throws(
    () => parseDocumentReingestionArgs(['--force']),
    /requires --confirm-all together with --force/,
  );
  assert.throws(
    () => parseDocumentReingestionArgs(['--force', '--document-kind', 'pdf']),
    /requires --confirm-all together with --force/,
  );
  assert.throws(
    () => parseDocumentReingestionArgs(['--apply']),
    /Unsupported argument: --apply/,
  );
  assert.equal(
    parseDocumentReingestionArgs(['--force', '--confirm-all']).force,
    true,
  );
});

test('project-scoped force execution forwards all explicit filters to the repository', async () => {
  const options = parseDocumentReingestionArgs([
    '--force',
    '--include-active',
    '--document-kind', 'docx',
    '--project-space-id', projectSpaceId,
    '--limit', '10',
  ]);
  let countOptions;
  let queueOptions;
  const result = await runDocumentReingestion(options, {
    countTargets: async (receivedOptions) => {
      countOptions = receivedOptions;
      return 12;
    },
    queueTargets: async (receivedOptions) => {
      queueOptions = receivedOptions;
      return [{ id: 'file-1' }, { id: 'file-2' }];
    },
  });

  assert.deepEqual(countOptions, {
    projectSpaceId,
    includeActive: true,
    documentKind: 'docx',
  });
  assert.deepEqual(queueOptions, { ...countOptions, limit: 10 });
  assert.equal(result.mode, 'force');
  assert.equal(result.target_count, 12);
  assert.equal(result.queued_count, 2);
  assert.equal(result.document_kind, 'docx');
  assert.equal(result.include_active, true);
  assert.equal(result.dispatch, 'existing-file-ingestion-queue');
});

test('document reingestion replaces the old Markdown-only command and source names', () => {
  assert.match(DOCUMENT_REINGESTION_USAGE, /reindex:documents/);
  assert.match(DOCUMENT_REINGESTION_USAGE, /--include-active/);
  assert.match(DOCUMENT_REINGESTION_USAGE, /--document-kind pdf/);
  assert.doesNotMatch(DOCUMENT_REINGESTION_USAGE, /reindex:markdown|Markdown reingestion/);
  assert.equal(existsSync(path.join(serverRoot, 'src/scripts/reindexMarkdown.ts')), false);
  assert.equal(existsSync(path.join(serverRoot, 'test/reindex-markdown.test.mjs')), false);
  const packageJson = readFileSync(path.join(serverRoot, 'package.json'), 'utf8');
  assert.match(packageJson, /"reindex:documents"/);
  assert.doesNotMatch(packageJson, /reindex:markdown|reindexMarkdown|reindex-markdown/);
});
