import { Pool, PoolClient, QueryResultRow } from 'pg';
import { serverEnv } from './env';

export const pool = new Pool({
  connectionString: serverEnv.DATABASE_URL,
});

pool.on('error', (error) => {
  console.error('[Postgres] Unexpected idle client error:', error);
});

export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
) => pool.query<T>(text, params);

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
