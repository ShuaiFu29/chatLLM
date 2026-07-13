import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

test('rag smoke script uses local embeddings and verifies ingest retrieve cleanup', () => {
  const source = readFileSync(path.join(root, 'scripts/rag-smoke.mjs'), 'utf8');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.equal(pkg.scripts['rag:smoke'], 'node scripts/rag-smoke.mjs');
  assert.match(source, /EMBEDDING_PROVIDER:\s*'local'/);
  assert.match(source, /spawn\(/);
  assert.match(source, /\/health\/ready/);
  assert.match(source, /\/ingest-sync/);
  assert.match(source, /\/retrieve/);
  assert.match(source, /\/cleanup-file/);
  assert.match(source, /delete from users where id = \$1/);
});

test('rag smoke script stores the exact uploaded document size and hash', () => {
  const source = readFileSync(path.join(root, 'scripts/rag-smoke.mjs'), 'utf8');

  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /smokeDocument\.length/);
  assert.doesNotMatch(source, /crypto\.randomBytes\(16\)\.toString\('hex'\)/);
  assert.doesNotMatch(source, /,\s*160,\s*objectKey\]/);
});

test('rag smoke authenticates every protected request and owns a valid ingestion lease', () => {
  const source = readFileSync(path.join(root, 'scripts/rag-smoke.mjs'), 'utf8');

  assert.match(source, /X-ChatLLM-RAG-Token/);
  assert.match(source, /insert into file_ingestion_jobs/i);
  assert.match(source, /attempt_id/i);
  assert.match(source, /lease_token/i);
  assert.match(source, /body:\s*JSON\.stringify\(\{\s*file_id:\s*fileId,\s*attempt_id:\s*attemptId,\s*lease_token:\s*leaseToken/s);
  assert.match(source, /from file_ingestion_jobs where file_id = \$1/i);
  assert.doesNotMatch(source, /select status, progress, error_message from files where id = \$1/i);
});

test('rag smoke can use explicit environment configuration without reading local env files', () => {
  const source = readFileSync(path.join(root, 'scripts/rag-smoke.mjs'), 'utf8');

  assert.match(source, /RAG_SMOKE_SKIP_ENV_FILES/);
  assert.match(source, /\.\.\.ragEnv,[\s\S]*\.\.\.process\.env/);
  assert.match(source, /process\.env\[key\][\s\S]*serverEnv\[key\][\s\S]*ragEnv\[key\]/);
});

test('rag smoke bounds cleanup requests so a failed run can terminate', () => {
  const source = readFileSync(path.join(root, 'scripts/rag-smoke.mjs'), 'utf8');
  const cleanupBody = source.split('async function cleanup()', 2)[1].split('const env =', 1)[0];

  assert.match(cleanupBody, /cleanup-file[\s\S]*signal:\s*AbortSignal\.timeout\(/);
});
