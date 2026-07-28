import { checkDatabaseReady, checkDocumentSchemaReady } from './db';
import { checkRagServiceReady } from './ragClient';
import { checkRedisReady } from './redis';
import { toSafeError } from './safeError';

export interface ReadyHealthDependencies {
  checkDatabaseReady?: typeof checkDatabaseReady;
  checkDocumentSchemaReady?: typeof checkDocumentSchemaReady;
  checkRedisReady?: typeof checkRedisReady;
  checkRagServiceReady?: typeof checkRagServiceReady;
}

export const readReadyHealth = async (
  dependencies: ReadyHealthDependencies = {},
  requestId?: string,
) => {
  const checkDatabase = dependencies.checkDatabaseReady || checkDatabaseReady;
  const checkDocumentSchema = (
    dependencies.checkDocumentSchemaReady || checkDocumentSchemaReady
  );
  const checkRedis = dependencies.checkRedisReady || checkRedisReady;
  const checkRag = dependencies.checkRagServiceReady || checkRagServiceReady;
  const checks: Record<string, 'ok' | 'error'> = {
    postgres: 'error',
    postgres_schema: 'error',
    redis: 'error',
    rag: 'error',
  };

  let postgresReady = false;
  try {
    await checkDatabase();
    checks.postgres = 'ok';
    postgresReady = true;
  } catch (error) {
    console.warn('[Health] Postgres readiness check failed:', toSafeError(error, requestId));
  }

  if (postgresReady) {
    try {
      await checkDocumentSchema();
      checks.postgres_schema = 'ok';
    } catch (error) {
      console.warn('[Health] Postgres schema readiness check failed:', toSafeError(error, requestId));
    }
  }

  try {
    await checkRedis();
    checks.redis = 'ok';
  } catch (error) {
    console.warn('[Health] Redis readiness check failed:', toSafeError(error, requestId));
  }

  try {
    await checkRag();
    checks.rag = 'ok';
  } catch (error) {
    console.warn('[Health] RAG readiness check failed:', toSafeError(error, requestId));
  }

  const ready = Object.values(checks).every((status) => status === 'ok');
  return {
    statusCode: ready ? 200 : 503,
    body: {
      status: ready ? 'ready' : 'not_ready',
      checks,
    },
  };
};
