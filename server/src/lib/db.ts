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

interface DocumentSchemaReadinessRow extends QueryResultRow {
  migrations_ready: boolean;
  generation_table_ready: boolean;
  columns_ready: boolean;
}

const documentSchemaReadinessSql = `
  with required_migrations(filename) as (
    values
      ('0032_multi_format_documents.sql'),
      ('0033_conversion_generation_integrity.sql'),
      ('0034_parallel_conversion_generations.sql'),
      ('0035_conversion_generation_cleanup_jobs.sql'),
      ('0036_user_configurable_agents.sql'),
      ('0037_agent_integrity_and_indexes.sql'),
      ('0038_agent_project_scope_restrict.sql'),
      ('0039_agent_version_composite_fks.sql'),
      ('0040_agent_audit_events.sql'),
      ('0041_agent_grounding_summary.sql'),
      ('0042_agent_pre_run_cancellation.sql')
  ), required_columns(table_name, column_name) as (
    values
      ('files', 'document_kind'),
      ('files', 'declared_mime_type'),
      ('files', 'detected_mime_type'),
      ('files', 'conversion_warning_count'),
      ('files', 'active_conversion_generation_id'),
      ('file_conversion_generations', 'attempt_id'),
      ('file_conversion_generations', 'document_kind'),
      ('file_conversion_generations', 'source_object_key'),
      ('file_conversion_generations', 'markdown_object_key'),
      ('file_conversion_generations', 'source_map_object_key'),
      ('file_conversion_generations', 'manifest_object_key'),
      ('file_conversion_generations', 'markdown_hash'),
      ('file_conversion_generations', 'source_map_hash'),
      ('file_conversion_generations', 'manifest_hash'),
      ('file_conversion_generations', 'markdown_byte_size'),
      ('file_conversion_generations', 'source_map_byte_size'),
      ('file_conversion_generations', 'manifest_byte_size'),
      ('file_conversion_generations', 'error_code'),
      ('file_conversion_generations', 'status'),
      ('file_ingestion_jobs', 'conversion_generation_id'),
      ('file_chunks', 'conversion_generation_id'),
      ('file_chunks', 'source_unit_ids'),
      ('file_chunks', 'source_locator'),
      ('file_chunks', 'content_hash'),
      ('file_chunks', 'token_count')
  )
  select
    not exists (
      select 1
      from required_migrations required
      left join schema_migrations applied on applied.filename = required.filename
      where applied.filename is null
    ) as migrations_ready,
    to_regclass(current_schema() || '.file_conversion_generations') is not null
      as generation_table_ready,
    not exists (
      select 1
      from required_columns required
      left join information_schema.columns available
        on available.table_schema = current_schema()
       and available.table_name = required.table_name
       and available.column_name = required.column_name
      where available.column_name is null
    ) as columns_ready
`;

export const checkDocumentSchemaReady = async (
  runQuery: typeof query = query,
) => {
  const { rows } = await runQuery<DocumentSchemaReadinessRow>(documentSchemaReadinessSql);
  const readiness = rows[0];
  if (
    !readiness
    || readiness.migrations_ready !== true
    || readiness.generation_table_ready !== true
    || readiness.columns_ready !== true
  ) {
    throw new Error('Required document schema is not ready');
  }
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
