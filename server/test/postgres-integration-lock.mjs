const POSTGRES_INTEGRATION_LOCK_KEY = '581117249386201';

export const acquirePostgresIntegrationLock = async (pool) => {
  const client = await pool.connect();
  try {
    await client.query(
      'select pg_advisory_lock($1::bigint)',
      [POSTGRES_INTEGRATION_LOCK_KEY],
    );
  } catch (error) {
    client.release();
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query(
        'select pg_advisory_unlock($1::bigint)',
        [POSTGRES_INTEGRATION_LOCK_KEY],
      );
    } finally {
      client.release();
    }
  };
};
