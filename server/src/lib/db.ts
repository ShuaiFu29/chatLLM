import { Pool, PoolClient, QueryResultRow } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is missing');
}

export const pool = new Pool({
  connectionString,
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
