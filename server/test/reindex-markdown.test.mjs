import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const {
  parseMarkdownReingestionArgs,
  runMarkdownReingestion,
} = require(path.join(serverRoot, 'dist', 'scripts', 'reindexMarkdown.js'));

const projectSpaceId = '11111111-1111-4111-8111-111111111111';

test('Markdown reingestion defaults to dry-run and never queues during preview', async () => {
  const options = parseMarkdownReingestionArgs(['--limit', '25']);
  let queueCalled = false;
  const result = await runMarkdownReingestion(options, {
    countTargets: async () => 42,
    queueTargets: async () => {
      queueCalled = true;
      return [];
    },
  });

  assert.equal(result.mode, 'dry-run');
  assert.equal(result.target_count, 42);
  assert.equal(result.would_queue_count, 25);
  assert.equal(queueCalled, false);
});

test('full-database execution requires both --force and --confirm-all', () => {
  assert.throws(
    () => parseMarkdownReingestionArgs(['--force']),
    /requires --confirm-all together with --force/,
  );
  assert.throws(
    () => parseMarkdownReingestionArgs(['--apply']),
    /Unsupported argument: --apply/,
  );
  assert.equal(
    parseMarkdownReingestionArgs(['--force', '--confirm-all']).force,
    true,
  );
});

test('project-scoped force execution queues through the repository dependency', async () => {
  const options = parseMarkdownReingestionArgs([
    '--force',
    '--project-space-id', projectSpaceId,
    '--limit', '10',
  ]);
  let receivedOptions;
  const result = await runMarkdownReingestion(options, {
    countTargets: async (receivedProjectSpaceId) => {
      assert.equal(receivedProjectSpaceId, projectSpaceId);
      return 12;
    },
    queueTargets: async (queueOptions) => {
      receivedOptions = queueOptions;
      return [{ id: 'file-1' }, { id: 'file-2' }];
    },
  });

  assert.deepEqual(receivedOptions, { limit: 10, projectSpaceId });
  assert.equal(result.mode, 'force');
  assert.equal(result.target_count, 12);
  assert.equal(result.queued_count, 2);
  assert.equal(result.dispatch, 'existing-file-ingestion-queue');
});
