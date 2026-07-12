import { Pool, PoolClient, QueryResultRow } from 'pg';
import { serverEnv } from './env';
import { metrics } from './metrics';
import { toSafeError } from './safeError';

export const pool = new Pool({
  connectionString: serverEnv.DATABASE_URL,
  max: serverEnv.DB_POOL_MAX,
  connectionTimeoutMillis: serverEnv.DB_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: serverEnv.DB_IDLE_TIMEOUT_MS,
  query_timeout: serverEnv.DB_QUERY_TIMEOUT_MS,
  statement_timeout: serverEnv.DB_QUERY_TIMEOUT_MS,
});

pool.on('error', (error) => {
  console.error('[Postgres] Unexpected idle client error:', toSafeError(error));
});

metrics.setDatabasePoolStatsProvider(() => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
}));

export const query = async <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
) => {
  const startedAt = Date.now();

  try {
    const result = await pool.query<T>(text, params);
    const durationMs = Date.now() - startedAt;
    metrics.recordDatabaseQuery('ok', durationMs, serverEnv.DB_SLOW_QUERY_THRESHOLD_MS);

    if (durationMs >= serverEnv.DB_SLOW_QUERY_THRESHOLD_MS) {
      console.warn(JSON.stringify({
        event: 'database_slow_query',
        duration_ms: durationMs,
      }));
    }

    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    metrics.recordDatabaseQuery('error', durationMs, serverEnv.DB_SLOW_QUERY_THRESHOLD_MS);
    throw error;
  }
};

export const checkDatabaseReady = async () => {
  await pool.query('select 1');
  return true;
};

export const closeDatabasePool = async () => {
  await pool.end();
};

export const withTransaction = async <T>(
  callback: (client: PoolClient) => Promise<T>
) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
