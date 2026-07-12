import assert from 'node:assert/strict';
import test from 'node:test';

import { acquirePostgresIntegrationLock } from './postgres-integration-lock.mjs';

test('PostgreSQL integration lock is held on one client and released idempotently', async () => {
  const queries = [];
  let releases = 0;
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
    release: () => { releases += 1; },
  };
  const pool = { connect: async () => client };

  const releaseLock = await acquirePostgresIntegrationLock(pool);
  assert.match(queries[0].sql, /pg_advisory_lock\(\$1::bigint\)/i);
  assert.equal(queries[0].params.length, 1);

  await releaseLock();
  await releaseLock();

  assert.match(queries[1].sql, /pg_advisory_unlock\(\$1::bigint\)/i);
  assert.deepEqual(queries[1].params, queries[0].params);
  assert.equal(queries.length, 2);
  assert.equal(releases, 1);
});

test('PostgreSQL integration lock releases its client when acquisition fails', async () => {
  const expected = new Error('lock failed');
  let releases = 0;
  const client = {
    query: async () => { throw expected; },
    release: () => { releases += 1; },
  };
  const pool = { connect: async () => client };

  await assert.rejects(acquirePostgresIntegrationLock(pool), expected);
  assert.equal(releases, 1);
});
