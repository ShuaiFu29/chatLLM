import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');
const readOptionalSource = (relativePath) => {
  const fullPath = path.join(serverRoot, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
};

const baseEnv = {
  DATABASE_URL: 'postgres://chatllm:chatllm@localhost:5432/chatllm',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'minioadmin',
  S3_SECRET_KEY: 'minioadmin',
  JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
  DEEPSEEK_API_KEY: 'sk-test',
};

test('server env exposes runtime stability knobs', () => {
  const { loadServerEnv } = require(path.join(serverRoot, 'dist', 'lib', 'env.js'));

  const env = loadServerEnv({
    ...baseEnv,
    DB_POOL_MAX: '17',
    DB_CONNECTION_TIMEOUT_MS: '2500',
    DB_IDLE_TIMEOUT_MS: '20000',
    DB_QUERY_TIMEOUT_MS: '15000',
    DB_SLOW_QUERY_THRESHOLD_MS: '750',
    RATE_LIMIT_WINDOW_MS: '120000',
    RATE_LIMIT_MAX: '200',
    CHAT_RATE_LIMIT_MAX: '40',
    UPLOAD_RATE_LIMIT_MAX: '20',
    FILE_QUEUE_INTERVAL_MS: '3000',
    FILE_QUEUE_CONCURRENCY: '4',
    FILE_QUEUE_INGEST_TIMEOUT_MS: '45000',
    FILE_QUEUE_MAX_ATTEMPTS: '5',
    FILE_QUEUE_RETRY_BASE_DELAY_MS: '60000',
    FILE_QUEUE_STALE_AFTER_MS: '900000',
    RAG_HEALTH_TIMEOUT_MS: '1500',
    RAG_RETRIEVE_TIMEOUT_MS: '8000',
    RAG_CLEANUP_TIMEOUT_MS: '30000',
    RAG_CIRCUIT_FAILURE_THRESHOLD: '4',
    RAG_CIRCUIT_RESET_MS: '45000',
    RAG_EVAL_RATE_LIMIT_MAX: '12',
    RAG_EVAL_STALE_RUN_MS: '900000',
    CHAT_STREAM_MAX_CONCURRENT: '25',
    CHAT_STREAM_MAX_CONCURRENT_PER_USER: '5',
    MAINTENANCE_INTERVAL_MS: '600000',
    UPLOAD_TEMP_MAX_AGE_MS: '3600000',
    SHUTDOWN_TIMEOUT_MS: '7000',
  });

  assert.equal(env.DB_POOL_MAX, 17);
  assert.equal(env.DB_CONNECTION_TIMEOUT_MS, 2500);
  assert.equal(env.DB_IDLE_TIMEOUT_MS, 20000);
  assert.equal(env.DB_QUERY_TIMEOUT_MS, 15000);
  assert.equal(env.DB_SLOW_QUERY_THRESHOLD_MS, 750);
  assert.equal(env.RATE_LIMIT_WINDOW_MS, 120000);
  assert.equal(env.RATE_LIMIT_MAX, 200);
  assert.equal(env.CHAT_RATE_LIMIT_MAX, 40);
  assert.equal(env.UPLOAD_RATE_LIMIT_MAX, 20);
  assert.equal(env.FILE_QUEUE_INTERVAL_MS, 3000);
  assert.equal(env.FILE_QUEUE_CONCURRENCY, 4);
  assert.equal(env.FILE_QUEUE_INGEST_TIMEOUT_MS, 45000);
  assert.equal(env.FILE_QUEUE_MAX_ATTEMPTS, 5);
  assert.equal(env.FILE_QUEUE_RETRY_BASE_DELAY_MS, 60000);
  assert.equal(env.FILE_QUEUE_STALE_AFTER_MS, 900000);
  assert.equal(env.RAG_HEALTH_TIMEOUT_MS, 1500);
  assert.equal(env.RAG_RETRIEVE_TIMEOUT_MS, 8000);
  assert.equal(env.RAG_CLEANUP_TIMEOUT_MS, 30000);
  assert.equal(env.RAG_CIRCUIT_FAILURE_THRESHOLD, 4);
  assert.equal(env.RAG_CIRCUIT_RESET_MS, 45000);
  assert.equal(env.RAG_EVAL_RATE_LIMIT_MAX, 12);
  assert.equal(env.RAG_EVAL_STALE_RUN_MS, 900000);
  assert.equal(env.CHAT_STREAM_MAX_CONCURRENT, 25);
  assert.equal(env.CHAT_STREAM_MAX_CONCURRENT_PER_USER, 5);
  assert.equal(env.MAINTENANCE_INTERVAL_MS, 600000);
  assert.equal(env.UPLOAD_TEMP_MAX_AGE_MS, 3600000);
  assert.equal(env.SHUTDOWN_TIMEOUT_MS, 7000);
});

test('database layer configures pool limits and exposes readiness helpers', () => {
  const dbSource = readSource('src/lib/db.ts');

  assert.match(dbSource, /max:\s*serverEnv\.DB_POOL_MAX/);
  assert.match(dbSource, /connectionTimeoutMillis:\s*serverEnv\.DB_CONNECTION_TIMEOUT_MS/);
  assert.match(dbSource, /idleTimeoutMillis:\s*serverEnv\.DB_IDLE_TIMEOUT_MS/);
  assert.match(dbSource, /query_timeout:\s*serverEnv\.DB_QUERY_TIMEOUT_MS/);
  assert.match(dbSource, /DB_SLOW_QUERY_THRESHOLD_MS/);
  assert.match(dbSource, /recordDatabaseQuery/);
  assert.match(dbSource, /setDatabasePoolStatsProvider/);
  assert.match(dbSource, /pool\.totalCount/);
  assert.match(dbSource, /pool\.idleCount/);
  assert.match(dbSource, /pool\.waitingCount/);
  assert.match(dbSource, /export const checkDatabaseReady/);
  assert.match(dbSource, /export const closeDatabasePool/);
});

test('server exposes live and ready health probes with request tracing and shutdown hooks', () => {
  const indexSource = readSource('src/index.ts');
  const healthSource = readOptionalSource('src/lib/health.ts');
  const requestContextSource = readOptionalSource('src/middleware/requestContext.ts');
  const rateLimitSource = readOptionalSource('src/middleware/rateLimit.ts');
  const shutdownSource = readOptionalSource('src/lib/gracefulShutdown.ts');

  assert.match(indexSource, /requestContextMiddleware/);
  assert.match(indexSource, /createRateLimit/);
  assert.match(indexSource, /serverEnv\.CORS_ALLOWED_ORIGINS/);
  assert.match(indexSource, /keyPrefix:\s*'rag-eval'/);
  assert.match(indexSource, /max:\s*serverEnv\.RAG_EVAL_RATE_LIMIT_MAX/);
  assert.match(indexSource, /app\.get\('\/health\/live', liveHealthHandler\)/);
  assert.match(indexSource, /app\.get\('\/health\/ready', readyHealthHandler\)/);
  assert.match(indexSource, /installGracefulShutdown/);
  assert.match(healthSource, /checkDatabaseReady/);
  assert.match(healthSource, /RAG_SERVICE_URL/);
  assert.match(requestContextSource, /x-request-id/i);
  assert.match(rateLimitSource, /Retry-After/);
  assert.match(shutdownSource, /closeDatabasePool/);
  assert.match(shutdownSource, /fileQueue\.stop/);
});

test('server applies baseline security headers and structured error responses', () => {
  const indexSource = readSource('src/index.ts');
  const securityHeadersSource = readOptionalSource('src/middleware/securityHeaders.ts');
  const errorHandlerSource = readOptionalSource('src/middleware/errorHandler.ts');

  assert.match(indexSource, /securityHeadersMiddleware/);
  assert.match(indexSource, /errorHandlerMiddleware/);
  assert.match(indexSource, /app\.use\(requestContextMiddleware\);[\s\S]*app\.use\(securityHeadersMiddleware\);/);
  assert.match(indexSource, /app\.use\('\/api\/upload'[\s\S]*app\.use\(errorHandlerMiddleware\);/);

  assert.match(securityHeadersSource, /X-Content-Type-Options/);
  assert.match(securityHeadersSource, /nosniff/);
  assert.match(securityHeadersSource, /X-Frame-Options/);
  assert.match(securityHeadersSource, /DENY/);
  assert.match(securityHeadersSource, /Referrer-Policy/);
  assert.match(securityHeadersSource, /Permissions-Policy/);
  assert.match(securityHeadersSource, /next\(\)/);

  assert.match(errorHandlerSource, /ErrorRequestHandler/);
  assert.match(errorHandlerSource, /res\.locals\.requestId/);
  assert.match(errorHandlerSource, /Not allowed by CORS/);
  assert.match(errorHandlerSource, /statusCode/);
  assert.match(errorHandlerSource, /NODE_ENV !== 'production'/);
  assert.match(errorHandlerSource, /requestId/);
  assert.match(errorHandlerSource, /res\.status\(statusCode\)\.json/);
});

test('server entrypoint exports app construction separately from process startup', () => {
  const indexSource = readSource('src/index.ts');

  assert.match(indexSource, /export const app = express\(\)/);
  assert.match(indexSource, /export const startServer = async/);
  assert.match(indexSource, /return server/);
  assert.match(indexSource, /require\.main === module/);
  assert.match(indexSource, /startServer\(\)\.catch/);
});

test('file queue has retry metadata, backoff-aware claims, and configurable concurrency', () => {
  const migrationSource = readOptionalSource('migrations/0005_platform_stability.sql');
  const repositorySource = readSource('src/repositories/files.ts');
  const queueSource = readSource('src/services/fileQueue.ts');

  assert.match(migrationSource, /add column if not exists attempts integer not null default 0/i);
  assert.match(migrationSource, /add column if not exists max_attempts integer not null default 3/i);
  assert.match(migrationSource, /add column if not exists next_attempt_at timestamptz/i);
  assert.match(migrationSource, /add column if not exists last_attempt_at timestamptz/i);
  assert.match(repositorySource, /attempts/);
  assert.match(repositorySource, /next_attempt_at/);
  assert.match(repositorySource, /last_attempt_at/);
  assert.match(repositorySource, /status = 'failed'/);
  assert.match(repositorySource, /for update skip locked/i);
  assert.match(queueSource, /FILE_QUEUE_CONCURRENCY/);
  assert.match(queueSource, /FILE_QUEUE_INGEST_TIMEOUT_MS/);
  assert.match(queueSource, /FILE_QUEUE_MAX_ATTEMPTS/);
  assert.match(queueSource, /FILE_QUEUE_RETRY_BASE_DELAY_MS/);
});

test('message search has large-data index support and remains bounded', () => {
  const migrationSource = readOptionalSource('migrations/0005_platform_stability.sql');
  const messageRepositorySource = readSource('src/repositories/messages.ts');

  assert.match(migrationSource, /create extension if not exists pg_trgm/i);
  assert.match(migrationSource, /using gin\s*\(content gin_trgm_ops\)/i);
  assert.match(messageRepositorySource, /limit \$\$\{\s*values\.length\s*\}/);
});

test('server exposes lightweight metrics for high-concurrency operations', () => {
  const indexSource = readSource('src/index.ts');
  const requestContextSource = readOptionalSource('src/middleware/requestContext.ts');
  const rateLimitSource = readOptionalSource('src/middleware/rateLimit.ts');
  const metricsSource = readOptionalSource('src/lib/metrics.ts');

  assert.match(indexSource, /metricsHandler/);
  assert.match(indexSource, /app\.get\('\/metrics', metricsHandler\)/);
  assert.match(requestContextSource, /recordHttpRequestStart/);
  assert.match(requestContextSource, /recordHttpRequestComplete/);
  assert.match(requestContextSource, /res\.on\('finish'/);
  assert.match(requestContextSource, /res\.on\('close'/);
  assert.match(requestContextSource, /recorded/);
  assert.match(metricsSource, /chatllm_http_requests_total/);
  assert.match(metricsSource, /chatllm_http_requests_by_status_family_total/);
  assert.match(metricsSource, /status_family="\$\{family\}"/);
  assert.match(metricsSource, /2xx/);
  assert.match(metricsSource, /3xx/);
  assert.match(metricsSource, /4xx/);
  assert.match(metricsSource, /5xx/);
  assert.match(rateLimitSource, /recordRateLimitRejected/);
  assert.match(metricsSource, /chatllm_rate_limit_rejections_total/);
  assert.match(metricsSource, /scope="\$\{scope\}"/);
  assert.match(metricsSource, /chatllm_database_queries_total/);
  assert.match(metricsSource, /chatllm_database_query_failures_total/);
  assert.match(metricsSource, /chatllm_database_slow_queries_total/);
  assert.match(metricsSource, /chatllm_database_pool_total/);
  assert.match(metricsSource, /chatllm_database_pool_idle/);
  assert.match(metricsSource, /chatllm_database_pool_waiting/);
  assert.match(metricsSource, /chatllm_chat_streams_active/);
  assert.match(metricsSource, /chatllm_rag_retrieve_failures_total/);
  assert.match(metricsSource, /chatllm_rag_eval_runs_started_total/);
  assert.match(metricsSource, /chatllm_rag_eval_runs_reused_total/);
  assert.match(metricsSource, /chatllm_rag_eval_runs_completed_total/);
  assert.match(metricsSource, /chatllm_rag_eval_runs_stale_failed_total/);
  assert.match(metricsSource, /RAG_EVAL_COMPLETION_STATUSES: RagEvalCompletionStatus\[\] = \['completed', 'partial', 'failed', 'cancelled'\]/);
  assert.match(metricsSource, /status="\$\{status\}"/);
  assert.match(metricsSource, /text\/plain/);
});

test('chat streaming is protected by explicit concurrency limits', () => {
  const chatSource = readSource('src/controllers/chat.ts');
  const gateSource = readOptionalSource('src/lib/concurrencyGate.ts');

  assert.match(gateSource, /tryAcquireChatStreamSlot/);
  assert.match(gateSource, /CHAT_STREAM_MAX_CONCURRENT/);
  assert.match(gateSource, /CHAT_STREAM_MAX_CONCURRENT_PER_USER/);
  assert.match(chatSource, /tryAcquireChatStreamSlot\(req\.user\.id\)/);
  assert.match(chatSource, /Too many active chat streams/);
  assert.match(chatSource, /chatSlot\.release\(failed\)/);
});

test('RAG retrieval uses a circuit-breaker client instead of inline axios calls', () => {
  const chatSource = readSource('src/controllers/chat.ts');
  const ragClientSource = readOptionalSource('src/lib/ragClient.ts');

  assert.doesNotMatch(chatSource, /axios\.post\(`\$\{serverEnv\.RAG_SERVICE_URL\}\/retrieve`/);
  assert.match(chatSource, /retrieveAgenticRagDocuments/);
  assert.match(ragClientSource, /\/agentic-retrieve/);
  assert.match(ragClientSource, /RAG_RETRIEVE_TIMEOUT_MS/);
  assert.match(ragClientSource, /RAG_CIRCUIT_FAILURE_THRESHOLD/);
  assert.match(ragClientSource, /RAG_CIRCUIT_RESET_MS/);
  assert.match(ragClientSource, /recordRagRetrieve/);
  assert.match(ragClientSource, /recordRagCircuitOpen/);
});

test('RAG evaluation uses the shared circuit breaker and metrics', () => {
  const ragEvalControllerSource = readSource('src/controllers/ragEval.ts');
  const ragClientSource = readOptionalSource('src/lib/ragClient.ts');

  assert.doesNotMatch(ragEvalControllerSource, /axios\.post/);
  assert.match(ragEvalControllerSource, /runRagEvaluation/);
  assert.match(
    ragClientSource,
    /const postRagService = async <T>[\s\S]*?if \(isCircuitOpen\(\)\) \{[\s\S]*?metrics\.recordRagCircuitOpen\(\);[\s\S]*?throw new Error\('RAG circuit is open'\);[\s\S]*?axios\.post/
  );
  assert.match(
    ragClientSource,
    /const postRagService = async <T>[\s\S]*?metrics\.recordRagRetrieve\('ok', Date\.now\(\) - startedAt\);[\s\S]*?catch \(error\) \{[\s\S]*?consecutiveFailures \+= 1;[\s\S]*?metrics\.recordRagRetrieve\('error', Date\.now\(\) - startedAt\);[\s\S]*?RAG_CIRCUIT_FAILURE_THRESHOLD/
  );
  assert.match(
    ragClientSource,
    /export const runRagEvaluation[\s\S]*?postRagService<RagEvalRunResponse>\(\s*'\/eval\/run'/
  );
});

test('RAG cleanup uses the shared client and configurable timeout', () => {
  const authSource = readSource('src/controllers/auth.ts');
  const uploadSource = readSource('src/controllers/upload.ts');
  const projectSpacesSource = readSource('src/controllers/projectSpaces.ts');
  const ragClientSource = readOptionalSource('src/lib/ragClient.ts');

  assert.match(ragClientSource, /cleanupRagFileVectors/);
  assert.match(ragClientSource, /\/cleanup-file/);
  assert.match(ragClientSource, /RAG_CLEANUP_TIMEOUT_MS/);
  assert.doesNotMatch(authSource, /\/cleanup-file/);
  assert.doesNotMatch(uploadSource, /\/cleanup-file/);
  assert.doesNotMatch(projectSpacesSource, /\/cleanup-file/);
  assert.match(authSource, /cleanupRagFileVectors/);
  assert.match(uploadSource, /cleanupRagFileVectors/);
  assert.match(projectSpacesSource, /cleanupRagFileVectors/);
});

test('embedding client debug logging is opt-in rather than unconditional', () => {
  const envSource = readSource('src/lib/env.ts');
  const openAiSource = readSource('src/lib/openai.ts');

  assert.match(envSource, /EMBEDDING_DEBUG_LOGS/);
  assert.match(openAiSource, /EMBEDDING_DEBUG_LOGS/);
  assert.doesNotMatch(openAiSource, /console\.log/);
});

test('root package includes a no-dependency load smoke script', () => {
  const rootPackage = JSON.parse(readFileSync(path.resolve(serverRoot, '..', 'package.json'), 'utf8'));
  const loadScriptSource = readOptionalSource('../scripts/load-smoke.mjs');

  assert.equal(rootPackage.scripts['load:smoke'], 'node scripts/load-smoke.mjs');
  assert.match(loadScriptSource, /LOAD_TARGET_URL/);
  assert.match(loadScriptSource, /LOAD_CONCURRENCY/);
  assert.match(loadScriptSource, /LOAD_REQUESTS/);
  assert.match(loadScriptSource, /Promise\.all/);
  assert.match(loadScriptSource, /process\.exitCode = 1/);
});

test('docker compose infrastructure has restart policies and health-gated dependencies', () => {
  const composeSource = readOptionalSource('../docker-compose.yml');

  assert.match(composeSource, /restart:\s+unless-stopped/);
  assert.match(composeSource, /stop_grace_period:\s+30s/);
  assert.match(composeSource, /milvus-etcd:[\s\S]*?healthcheck:/);
  assert.match(composeSource, /test:\s+\["CMD",\s+"etcdctl"/);
  assert.match(composeSource, /milvus-standalone:[\s\S]*?healthcheck:/);
  assert.match(composeSource, /condition:\s+service_healthy/);
});

test('startup guide includes readiness, metrics, and smoke-test commands', () => {
  const startupSource = readOptionalSource('../startup.txt');

  assert.match(startupSource, /\/health\/live/);
  assert.match(startupSource, /\/health\/ready/);
  assert.match(startupSource, /\/metrics/);
  assert.match(startupSource, /npm run load:smoke/);
});

test('maintenance service cleans expired sessions and stale upload temp files', () => {
  const envSource = readSource('src/lib/env.ts');
  const indexSource = readSource('src/index.ts');
  const shutdownSource = readOptionalSource('src/lib/gracefulShutdown.ts');
  const sessionsSource = readSource('src/repositories/sessions.ts');
  const maintenanceSource = readOptionalSource('src/services/maintenance.ts');
  const ragEvalRepositorySource = readOptionalSource('src/repositories/ragEval.ts');

  assert.match(envSource, /MAINTENANCE_INTERVAL_MS/);
  assert.match(envSource, /UPLOAD_TEMP_MAX_AGE_MS/);
  assert.match(envSource, /RAG_EVAL_STALE_RUN_MS/);
  assert.match(sessionsSource, /deleteExpiredSessions/);
  assert.match(sessionsSource, /delete from sessions where expires_at < now\(\)/i);
  assert.match(indexSource, /maintenanceService\.start\(\)/);
  assert.match(shutdownSource, /maintenanceService\.stop\(\)/);
  assert.match(ragEvalRepositorySource, /failStaleRunningRagEvalRuns/);
  assert.match(ragEvalRepositorySource, /created_at < now\(\) - \(\$1::text \|\| ' milliseconds'\)::interval/i);
  assert.match(maintenanceSource, /cleanupUploadTempDirectory/);
  assert.match(maintenanceSource, /failStaleRunningRagEvalRuns/);
  assert.match(maintenanceSource, /recordRagEvalRunsStaleFailed/);
  assert.match(maintenanceSource, /RAG_EVAL_STALE_RUN_MS/);
  assert.match(maintenanceSource, /UPLOAD_TEMP_MAX_AGE_MS/);
  assert.match(maintenanceSource, /setInterval/);
  assert.match(maintenanceSource, /fs\.remove/);
});
