import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const dbSource = readFileSync(path.join(serverRoot, 'src/lib/db.ts'), 'utf8');
const healthSource = readFileSync(path.join(serverRoot, 'src/lib/health.ts'), 'utf8');
const { checkDocumentSchemaReady } = require(path.join(serverRoot, 'dist/lib/db.js'));
const { readReadyHealth } = require(path.join(serverRoot, 'dist/lib/health.js'));

const schemaState = (overrides = {}) => ({
  migrations_ready: true,
  generation_table_ready: true,
  columns_ready: true,
  ...overrides,
});

test('document schema readiness requires migrations 0032/0033 and every provenance column', async () => {
  let statement = '';
  const result = await checkDocumentSchemaReady(async (sql) => {
    statement = sql;
    return { rows: [schemaState()] };
  });

  assert.equal(result, true);
  assert.match(statement, /0032_multi_format_documents\.sql/);
  assert.match(statement, /0033_conversion_generation_integrity\.sql/);
  assert.match(statement, /to_regclass\(current_schema\(\) \|\| '\.file_conversion_generations'\)/);
  for (const column of [
    'active_conversion_generation_id',
    'source_map_hash',
    'manifest_hash',
    'source_map_byte_size',
    'manifest_byte_size',
    'conversion_generation_id',
    'source_unit_ids',
    'source_locator',
    'content_hash',
    'token_count',
  ]) {
    assert.match(statement, new RegExp(`'${column}'`));
  }
});

for (const [name, state] of [
  ['migration', schemaState({ migrations_ready: false })],
  ['generation table', schemaState({ generation_table_ready: false })],
  ['column', schemaState({ columns_ready: false })],
]) {
  test(`document schema readiness rejects a missing ${name} without leaking details`, async () => {
    await assert.rejects(
      () => checkDocumentSchemaReady(async () => ({ rows: [state] })),
      (error) => {
        assert.equal(error.message, 'Required document schema is not ready');
        assert.doesNotMatch(error.message, /password|postgres:\/\//i);
        return true;
      },
    );
  });
}

test('ready health reports connectivity and schema independently', async () => {
  const schemaMissing = await readReadyHealth({
    checkDatabaseReady: async () => true,
    checkDocumentSchemaReady: async () => { throw new Error('private schema detail'); },
    checkRedisReady: async () => true,
    checkRagServiceReady: async () => true,
  });
  assert.equal(schemaMissing.statusCode, 503);
  assert.deepEqual(schemaMissing.body, {
    status: 'not_ready',
    checks: {
      postgres: 'ok',
      postgres_schema: 'error',
      redis: 'ok',
      rag: 'ok',
    },
  });

  let schemaChecks = 0;
  const databaseMissing = await readReadyHealth({
    checkDatabaseReady: async () => { throw new Error('private connection detail'); },
    checkDocumentSchemaReady: async () => { schemaChecks += 1; return true; },
    checkRedisReady: async () => true,
    checkRagServiceReady: async () => true,
  });
  assert.equal(databaseMissing.statusCode, 503);
  assert.equal(schemaChecks, 0);
  assert.equal(databaseMissing.body.checks.postgres, 'error');
  assert.equal(databaseMissing.body.checks.postgres_schema, 'error');
});

test('readiness source never treats select 1 as document schema validation', () => {
  assert.match(dbSource, /export const checkDocumentSchemaReady/);
  assert.match(healthSource, /postgres_schema/);
  assert.doesNotMatch(
    dbSource.split('export const checkDocumentSchemaReady', 2)[1],
    /select 1/,
  );
});
