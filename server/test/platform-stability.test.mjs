import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  REDIS_URL: 'redis://localhost:6379/0',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'minioadmin',
  S3_SECRET_KEY: 'minioadmin',
  JWT_SECRET: 'local-random-secret-with-more-than-32-characters',
  DEEPSEEK_API_KEY: 'sk-test',
  RAG_SERVICE_TOKEN: 'test-rag-service-token-at-least-32-characters',
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
    FILE_QUEUE_INGEST_TIMEOUT_MS: '120000',
    FILE_QUEUE_MAX_ATTEMPTS: '5',
    FILE_QUEUE_RETRY_BASE_DELAY_MS: '60000',
    FILE_QUEUE_STALE_AFTER_MS: '900000',
    RAG_HEALTH_TIMEOUT_MS: '1500',
    RAG_RETRIEVE_TIMEOUT_MS: '8000',
    RAG_CLEANUP_TIMEOUT_MS: '30000',
    RAG_CIRCUIT_FAILURE_THRESHOLD: '4',
    RAG_CIRCUIT_RESET_MS: '45000',
    RAG_SERVICE_TOKEN: 'internal-rag-service-token-at-least-32-characters',
    METRICS_TOKEN: 'internal-metrics-token',
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
  assert.equal(env.FILE_QUEUE_INGEST_TIMEOUT_MS, 120000);
  assert.equal(env.FILE_QUEUE_MAX_ATTEMPTS, 5);
  assert.equal(env.FILE_QUEUE_RETRY_BASE_DELAY_MS, 60000);
  assert.equal(env.FILE_QUEUE_STALE_AFTER_MS, 900000);
  assert.equal(env.RAG_HEALTH_TIMEOUT_MS, 1500);
  assert.equal(env.RAG_RETRIEVE_TIMEOUT_MS, 8000);
  assert.equal(env.RAG_CLEANUP_TIMEOUT_MS, 30000);
  assert.equal(env.RAG_CIRCUIT_FAILURE_THRESHOLD, 4);
  assert.equal(env.RAG_CIRCUIT_RESET_MS, 45000);
  assert.equal(env.RAG_SERVICE_TOKEN, 'internal-rag-service-token-at-least-32-characters');
  assert.equal(env.METRICS_TOKEN, 'internal-metrics-token');
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
  assert.match(dbSource, /export const checkDocumentSchemaReady/);
  assert.match(dbSource, /export const closeDatabasePool/);
});

test('server exposes live and ready health probes with request tracing and shutdown hooks', () => {
  const mainSource = readSource('src/main.ts');
  const operationsSource = readSource('src/modules/operations/operations.controller.ts');
  const ragEvalControllerSource = readSource('src/modules/rag-eval/rag-eval.controller.ts');
  const healthSource = readOptionalSource('src/lib/health.ts');
  const requestHooksSource = readSource('src/common/http/http-hooks.ts');
  const rateLimitSource = readSource('src/common/guards/rate-limit.guard.ts');
  const lifecycleSource = readSource('src/infrastructure/runtime-lifecycle.service.ts');

  assert.match(mainSource, /registerHttpHooks\(fastify\)/);
  assert.match(mainSource, /registerGlobalRateLimitHook\(fastify\)/);
  assert.match(mainSource, /serverEnv\.CORS_ALLOWED_ORIGINS/);
  assert.match(ragEvalControllerSource, /keyPrefix:\s*'rag-eval'/);
  assert.match(ragEvalControllerSource, /max:\s*serverEnv\.RAG_EVAL_RATE_LIMIT_MAX/);
  assert.match(operationsSource, /@Get\('health\/live'\)/);
  assert.match(operationsSource, /@Get\('health\/ready'\)/);
  assert.match(mainSource, /export const installShutdownHandlers/);
  assert.match(mainSource, /const timeoutMs = options\.timeoutMs \?\? serverEnv\.SHUTDOWN_TIMEOUT_MS/);
  assert.match(mainSource, /signalTarget\.once\('SIGINT', onSigint\)/);
  assert.match(mainSource, /signalTarget\.once\('SIGTERM', onSigterm\)/);
  assert.match(mainSource, /timeout = setTimeout\([\s\S]*?await app\.close\(\)/);
  assert.match(mainSource, /shutdownHandlers = installShutdownHandlers\(app\)/);
  assert.match(healthSource, /checkDatabaseReady/);
  assert.match(healthSource, /checkRagServiceReady/);
  assert.doesNotMatch(healthSource, /axios\.(?:get|post)/);
  assert.match(requestHooksSource, /x-request-id/i);
  assert.match(rateLimitSource, /Retry-After/);
  assert.match(lifecycleSource, /closeDatabasePool/);
  assert.match(lifecycleSource, /const queues = \[fileQueue, ragEvalQueue, artifactCleanupQueue\]/);
  assert.match(lifecycleSource, /queues\.map\(\(queue\) => queue\.stop\(\)\)/);
});

test('server applies baseline security headers and structured error responses', () => {
  const mainSource = readSource('src/main.ts');
  const operationsSource = readSource('src/modules/operations/operations.controller.ts');
  const securityHeadersSource = readSource('src/common/http/http-hooks.ts');
  const errorHandlerSource = readSource('src/common/filters/http-exception.filter.ts');

  assert.match(mainSource, /new FastifyAdapter\(/);
  assert.match(mainSource, /registerHttpHooks\(fastify\)/);
  assert.match(mainSource, /app\.useGlobalFilters\(new HttpExceptionFilter\(\)\)/);
  assert.doesNotMatch(mainSource, /platform-express|from ['"]express['"]|require\(['"]express['"]\)/);
  assert.match(operationsSource, /if \(!serverEnv\.METRICS_TOKEN\)[\s\S]*statusCode:\s*503/);
  assert.doesNotMatch(operationsSource, /if \(!serverEnv\.METRICS_TOKEN\) \{\s*return true/);
  assert.doesNotMatch(operationsSource, /@(Req|Res)\s*\(/);

  assert.match(securityHeadersSource, /X-Content-Type-Options/);
  assert.match(securityHeadersSource, /nosniff/);
  assert.match(securityHeadersSource, /X-Frame-Options/);
  assert.match(securityHeadersSource, /DENY/);
  assert.match(securityHeadersSource, /Referrer-Policy/);
  assert.match(securityHeadersSource, /Permissions-Policy/);
  assert.match(securityHeadersSource, /reply\.header\(header, value\)/);

  assert.match(errorHandlerSource, /implements ExceptionFilter/);
  assert.match(errorHandlerSource, /request\.requestId/);
  assert.match(errorHandlerSource, /Not allowed by CORS/);
  assert.match(errorHandlerSource, /statusCode/);
  assert.match(errorHandlerSource, /if \(statusCode >= 500\) return 'Internal server error'/);
  assert.match(errorHandlerSource, /toSafeError\(diagnosticError, requestId\)/);
  assert.doesNotMatch(errorHandlerSource, /stack:/);
  assert.match(errorHandlerSource, /requestId/);
  assert.match(errorHandlerSource, /reply\.code\(statusCode\)\.send/);
});

test('server entrypoint exports app construction separately from process startup', () => {
  const mainSource = readSource('src/main.ts');
  const appModuleSource = readSource('src/app.module.ts');

  assert.match(mainSource, /export const createApplication = async/);
  assert.match(mainSource, /const nestApplicationOptions:[\s\S]*bodyParser:\s*false/);
  assert.match(
    mainSource,
    /NestFactory\.create<NestFastifyApplication>\([\s\S]*AppModule,[\s\S]*adapter,[\s\S]*nestApplicationOptions/,
  );
  assert.match(mainSource, /logController:\s*new LogController\(\{\s*disableRequestLogging:\s*true\s*\}\)/);
  assert.match(mainSource, /routerOptions:\s*\{[\s\S]*ignoreTrailingSlash:\s*true,[\s\S]*caseSensitive:\s*false/);
  assert.match(mainSource, /export const bootstrap = async/);
  assert.match(mainSource, /return app/);
  assert.match(mainSource, /require\.main === module/);
  assert.match(mainSource, /bootstrap\(\)\.catch/);
  assert.match(appModuleSource, /@Module\(/);
  assert.doesNotMatch(mainSource, /express/i);
});

test('file queue has retry metadata, backoff-aware claims, and configurable concurrency', () => {
  const migrationSource = readOptionalSource('migrations/0005_platform_stability.sql');
  const repositorySource = readSource('src/repositories/files.ts');
  const queueSource = readSource('src/services/fileQueue.ts');
  const ragClientSource = readSource('src/lib/ragClient.ts');

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
  assert.match(ragClientSource, /FILE_QUEUE_INGEST_TIMEOUT_MS/);
  assert.match(queueSource, /FILE_QUEUE_MAX_ATTEMPTS/);
  assert.match(queueSource, /FILE_QUEUE_RETRY_BASE_DELAY_MS/);
});

test('file queue renews attempt-scoped leases during long ingestion jobs', () => {
  const repositorySource = readSource('src/repositories/files.ts');
  const queueSource = readSource('src/services/fileQueue.ts');

  assert.match(repositorySource, /export const renewFileIngestionLease/);
  assert.match(repositorySource, /attempt_id = \$2/i);
  assert.match(repositorySource, /lease_token = \$3/i);
  assert.match(repositorySource, /lease_expires_at > now\(\)/i);
  assert.match(queueSource, /renewFileIngestionLease/);
  assert.match(queueSource, /startFileIngestionHeartbeat/);
  assert.match(queueSource, /FILE_QUEUE_STALE_AFTER_MS/);
  assert.match(queueSource, /setTimeout/);
  assert.match(queueSource, /clearTimeout/);
  assert.match(queueSource, /controller\.abort\(\)/);
});

test('message search has large-data index support and remains bounded', () => {
  const migrationSource = readOptionalSource('migrations/0005_platform_stability.sql');
  const messageRepositorySource = readSource('src/repositories/messages.ts');

  assert.match(migrationSource, /create extension if not exists pg_trgm/i);
  assert.match(migrationSource, /using gin\s*\(content gin_trgm_ops\)/i);
  assert.match(messageRepositorySource, /limit \$\$\{\s*values\.length\s*\}/);
});

test('server exposes lightweight metrics for high-concurrency operations', () => {
  const operationsSource = readSource('src/modules/operations/operations.controller.ts');
  const requestContextSource = readSource('src/common/http/http-hooks.ts');
  const rateLimitSource = readSource('src/common/guards/rate-limit.guard.ts');
  const metricsSource = readOptionalSource('src/lib/metrics.ts');

  assert.match(operationsSource, /@Get\('metrics'\)/);
  assert.match(operationsSource, /authorizeMetrics\(authorization, headerToken\)/);
  assert.match(operationsSource, /httpResponse\(metrics\.renderPrometheus\(\)/);
  assert.match(operationsSource, /'content-type':\s*'text\/plain; charset=utf-8'/);
  assert.match(requestContextSource, /recordHttpRequestStart/);
  assert.match(requestContextSource, /recordHttpRequestComplete/);
  assert.match(requestContextSource, /reply\.raw\.once\('finish'/);
  assert.match(requestContextSource, /reply\.raw\.once\('close'/);
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
  assert.match(metricsSource, /chatllm_file_queue_active/);
  assert.match(metricsSource, /chatllm_file_queue_claimed_total/);
  assert.match(metricsSource, /chatllm_file_queue_completed_total/);
  assert.match(metricsSource, /chatllm_file_queue_failed_total/);
  assert.match(metricsSource, /chatllm_rag_retrieve_failures_total/);
  assert.match(metricsSource, /chatllm_rag_eval_runs_started_total/);
  assert.match(metricsSource, /chatllm_rag_eval_runs_reused_total/);
  assert.match(metricsSource, /chatllm_rag_eval_runs_completed_total/);
  assert.match(metricsSource, /chatllm_rag_eval_runs_stale_failed_total/);
  assert.match(metricsSource, /RAG_EVAL_COMPLETION_STATUSES: RagEvalCompletionStatus\[\] = \['completed', 'partial', 'failed', 'cancelled'\]/);
  assert.match(metricsSource, /status="\$\{status\}"/);
  assert.match(operationsSource, /text\/plain/);
});

test('chat streaming is protected by explicit concurrency limits', () => {
  const chatSource = readSource('src/modules/chat/chat-stream.service.ts');
  const gateSource = readOptionalSource('src/lib/concurrencyGate.ts');

  assert.match(gateSource, /tryAcquireChatStreamSlot/);
  assert.match(gateSource, /CHAT_STREAM_MAX_CONCURRENT/);
  assert.match(gateSource, /CHAT_STREAM_MAX_CONCURRENT_PER_USER/);
  assert.match(chatSource, /findConversationForUser[\s\S]*?if \(isChatRequestClosed\(request\)\) return;[\s\S]*?tryAcquireChatStreamSlot/);
  assert.match(chatSource, /tryAcquireChatStreamSlot\(user\.id\)/);
  assert.match(chatSource, /Too many active chat streams/);
  assert.match(chatSource, /chatSlot\.release\(failed\)/);
});

test('chat streaming aborts upstream model requests when the client disconnects', () => {
  const chatSource = readSource('src/modules/chat/chat-stream.service.ts');
  const chatControllerSource = readSource('src/modules/chat/chat.controller.ts');
  const sseWriterSource = readSource('src/common/http/sse-writer.ts');
  const providerSource = readSource('src/lib/llmProviders.ts');

  assert.match(chatSource, /new AbortController\(\)/);
  assert.match(chatSource, /new SseWriter\(responseStream\)/);
  assert.match(chatSource, /request\.connection\.once\('aborted'/);
  assert.match(chatSource, /responseStream\.once\('close'/);
  assert.match(chatSource, /streamAbortController\.abort\(\)/);
  assert.match(chatSource, /signal:\s*streamAbortController\.signal/);
  assert.match(chatSource, /sse\.isClosed/);
  assert.match(
    chatSource,
    /const isChatRequestClosed[\s\S]*?request\.connection\.aborted[\s\S]*?request\.connection\.destroyed/,
  );
  assert.match(
    chatSource,
    /const isChatConnectionClosed[\s\S]*?isChatRequestClosed\(request\)[\s\S]*?stream\.destroyed[\s\S]*?stream\.writableEnded/,
  );
  assert.match(
    chatSource,
    /responseStream\.once\('close', abortUpstreamStream\);[\s\S]*?if \(isChatConnectionClosed\(request, responseStream\)\) abortUpstreamStream\(\)/,
  );
  assert.match(chatSource, /if \(!sse\.open\(\)\) return;/);
  assert.match(
    chatSource,
    /catch \(error\) \{[\s\S]*?failed = !streamAbortController\.signal\.aborted;[\s\S]*?if \(streamAbortController\.signal\.aborted\)/,
  );
  assert.match(chatSource, /new StreamableFile\(responseStream\)/);
  assert.match(chatSource, /headers:\s*SSE_HEADERS/);
  assert.doesNotMatch(chatControllerSource, /@(Req|Res)\s*\(|AppReply|AppRequest/);
  assert.equal(existsSync(path.join(serverRoot, 'src/common/http/raw-stream.ts')), false);
  assert.match(sseWriterSource, /stream\.destroyed/);
  assert.match(sseWriterSource, /stream\.writableEnded/);
  assert.match(providerSource, /signal\?:\s*AbortSignal/);
  assert.match(providerSource, /const \{ signal, \.\.\.payload \} = params;[\s\S]*?signal,/);
});

test('SSE writer resolves false when a synchronous close races a backpressured write', async () => {
  const { SseWriter } = require(path.join(
    serverRoot,
    'dist',
    'common',
    'http',
    'sse-writer.js',
  ));

  class SynchronousCloseResponse extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    statusCode = 0;
    headers = new Map();

    setHeader(name, value) {
      this.headers.set(name, value);
    }

    writeHead(statusCode) {
      this.statusCode = statusCode;
    }

    write() {
      this.destroyed = true;
      this.emit('close');
      return false;
    }

    end() {
      this.writableEnded = true;
    }
  }

  const raw = new SynchronousCloseResponse();
  const writer = new SseWriter(raw);

  assert.equal(writer.open(), true);
  let timeout;
  try {
    const result = await Promise.race([
      writer.send({ content: 'chunk' }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('SSE backpressure wait did not settle')), 100);
      }),
    ]);
    assert.equal(result, false);
    assert.equal(writer.isClosed, true);
  } finally {
    clearTimeout(timeout);
  }
});

test('RAG-routed retrieval failure stops generation instead of falling back to an ungrounded answer', () => {
  const chatSource = readSource('src/modules/chat/chat-stream.service.ts');

  assert.match(chatSource, /rag_retrieval_unavailable/);
  assert.match(chatSource, /ragError:[\s\S]*?retryable: true,[\s\S]*?message: 'Workspace document retrieval failed\. Retry before relying on an answer\.'/);
  assert.match(chatSource, /answer generation stopped/);
  assert.doesNotMatch(chatSource, /continuing without context/);
  assert.doesNotMatch(chatSource, /answering without retrieved context/);
  assert.match(chatSource, /ragError[\s\S]*?await sse\.done\(\)[\s\S]*?sse\.close\(\)/);
  assert.match(
    chatSource,
    /error: \{\s*code: 'chat_stream_failed',\s*message: 'Failed to generate response',\s*retryable: true,\s*\}/,
  );
});

test('server protects internal RAG calls with a shared service token when configured', () => {
  const envSource = readSource('src/lib/env.ts');
  const ragClientSource = readOptionalSource('src/lib/ragClient.ts');
  const fileQueueSource = readSource('src/services/fileQueue.ts');

  assert.match(envSource, /RAG_SERVICE_TOKEN/);
  assert.match(ragClientSource, /buildRagServiceHeaders/);
  assert.match(ragClientSource, /X-ChatLLM-RAG-Token/);
  assert.match(ragClientSource, /headers:\s*buildHeaders\(serviceToken\)/);
  assert.match(fileQueueSource, /ingestRagFile/);
  assert.doesNotMatch(fileQueueSource, /axios\.post/);
});

test('RAG evaluation uses an operation-isolated circuit breaker and metrics', () => {
  const ragEvalControllerSource = readSource('src/modules/rag-eval/rag-eval.service.ts');
  const ragClientSource = readOptionalSource('src/lib/ragClient.ts');
  const circuitBreakerSource = readOptionalSource('src/lib/circuitBreaker.ts');
  const ragEvalQueueSource = readOptionalSource('src/services/ragEvalQueue.ts');

  assert.doesNotMatch(ragEvalControllerSource, /axios\.post/);
  assert.doesNotMatch(ragEvalQueueSource, /axios\.post/);
  assert.match(ragEvalQueueSource, /runRagEvaluation/);
  assert.match(ragClientSource, /new OperationCircuitBreaker<RagOperation>/);
  assert.match(ragClientSource, /breaker\.acquire\(operation\)/);
  assert.match(ragClientSource, /breaker\.recordSuccess\(operation\)/);
  assert.match(ragClientSource, /breaker\.recordFailure\(operation, permit, error\)/);
  assert.match(ragClientSource, /recordRagCircuitOpen\(\)/);
  assert.match(ragClientSource, /recordRagRetrieve\('ok'/);
  assert.match(ragClientSource, /recordRagRetrieve\('error'/);
  assert.match(circuitBreakerSource, /new Map<Operation, CircuitState>/);
  assert.match(
    ragClientSource,
    /const runRagEvaluation[\s\S]*?postRagService<RagEvalRunResponse>\(\s*'eval',\s*'\/eval\/run'/
  );
});

test('RAG cleanup uses the shared client and configurable timeout', () => {
  const authSource = readSource('src/modules/auth/auth.service.ts');
  const uploadSource = readSource('src/modules/upload/upload.service.ts');
  const projectSpacesSource = readSource('src/modules/project-spaces/project-spaces.service.ts');
  const ragClientSource = readOptionalSource('src/lib/ragClient.ts');
  const cleanupQueueSource = readOptionalSource('src/services/cleanupQueue.ts');

  assert.match(ragClientSource, /cleanupRagFileVectors/);
  assert.match(ragClientSource, /\/cleanup-file/);
  assert.match(ragClientSource, /RAG_CLEANUP_TIMEOUT_MS/);
  assert.doesNotMatch(authSource, /\/cleanup-file/);
  assert.doesNotMatch(uploadSource, /\/cleanup-file/);
  assert.doesNotMatch(projectSpacesSource, /\/cleanup-file/);
  assert.doesNotMatch(authSource, /cleanupRagFileVectors/);
  assert.doesNotMatch(uploadSource, /cleanupRagFileVectors/);
  assert.doesNotMatch(projectSpacesSource, /cleanupRagFileVectors/);
  assert.match(cleanupQueueSource, /cleanupRagFileVectors/);
  assert.match(uploadSource, /enqueueFileCleanup/);
  assert.match(projectSpacesSource, /enqueueProjectSpaceCleanup/);
  assert.match(authSource, /enqueueAccountCleanup/);
});

test('account deletion durably queues external cleanup before returning acceptance', () => {
  const authSource = readSource('src/modules/auth/auth.service.ts');
  const cleanupRepositorySource = readOptionalSource('src/repositories/cleanupJobs.ts');
  const cleanupQueueSource = readOptionalSource('src/services/cleanupQueue.ts');

  assert.doesNotMatch(authSource, /Promise\.allSettled\(files\.map/);
  assert.match(authSource, /enqueueAccountCleanup/);
  assert.match(authSource, /statusCode:\s*202/);
  assert.match(cleanupRepositorySource, /set deletion_status = 'pending'/i);
  assert.match(cleanupRepositorySource, /delete from sessions[\s\S]*where user_id/i);
  assert.match(cleanupRepositorySource, /resourceType: 'account'/);
  assert.match(cleanupRepositorySource, /prepareFileCleanupWithClient/);
  assert.match(cleanupQueueSource, /cleanupRagFileVectors/);
  assert.match(cleanupQueueSource, /finalizeAccountCleanup/);
});

test('upload merge verifies server-side hash and final file size before ingestion', () => {
  const uploadSource = readSource('src/modules/upload/upload.service.ts');
  const integritySource = readOptionalSource('src/lib/uploadIntegrity.ts');

  assert.match(integritySource, /computeFileSha256/);
  assert.match(integritySource, /verifyMergedUploadFile/);
  assert.match(integritySource, /createHash\('sha256'\)/);
  assert.match(uploadSource, /verifyMergedUploadFile/);
  assert.match(uploadSource, /hash mismatch/i);
  assert.match(uploadSource, /size mismatch/i);
});

test('embedding client debug logging is opt-in rather than unconditional', () => {
  const envSource = readSource('src/lib/env.ts');
  const llmProviderSource = readSource('src/lib/llmProviders.ts');

  assert.match(envSource, /EMBEDDING_DEBUG_LOGS/);
  assert.match(llmProviderSource, /EMBEDDING_DEBUG_LOGS/);
  assert.doesNotMatch(llmProviderSource, /console\.log/);
});

test('model provider health exposes configured chat providers without leaking keys', () => {
  const envSource = readSource('src/lib/env.ts');
  const llmProviderSource = readSource('src/lib/llmProviders.ts');
  const usageControllerModuleSource = readSource('src/modules/usage/usage.controller.ts');
  const usageServiceSource = readSource('src/modules/usage/usage.service.ts');
  const chatSource = readSource('src/modules/chat/chat-stream.service.ts');

  assert.match(envSource, /MOONSHOT_BASE_URL/);
  assert.match(envSource, /QWEN_API_KEY/);
  assert.match(envSource, /QWEN_BASE_URL/);
  assert.match(envSource, /QWEN_CHAT_MODEL/);

  assert.match(llmProviderSource, /getModelProviderHealth/);
  assert.match(llmProviderSource, /createChatClientForModel/);
  assert.match(llmProviderSource, /getDefaultChatModel/);
  assert.match(llmProviderSource, /resolveChatModelProvider/);
  assert.match(llmProviderSource, /quota_status/);
  assert.match(llmProviderSource, /has_api_key/);
  assert.doesNotMatch(llmProviderSource, /api_key:/);
  assert.doesNotMatch(llmProviderSource, /id:\s*'openai'/i);
  assert.doesNotMatch(llmProviderSource, /name:\s*'OpenAI'/);
  assert.doesNotMatch(llmProviderSource, /https:\/\/api\.openai\.com\/v1/);
  assert.doesNotMatch(llmProviderSource, /OPENAI_API_KEY/);
  assert.doesNotMatch(llmProviderSource, /gpt-4o/);

  assert.match(usageControllerModuleSource, /@Get\('provider-health'\)/);
  assert.match(usageControllerModuleSource, /return this\.usageService\.getProviderHealth\(\)/);
  assert.match(usageServiceSource, /getModelProviderHealth/);
  assert.match(chatSource, /getDefaultChatModel\(\)/);
  assert.match(chatSource, /createChatClientForModel\(model\)/);
  assert.match(chatSource, /resolvedModel/);
});

test('root package includes a no-dependency load smoke script', () => {
  const rootPackage = JSON.parse(readFileSync(path.resolve(serverRoot, '..', 'package.json'), 'utf8'));
  const loadScriptSource = readOptionalSource('../scripts/load-smoke.mjs');

  assert.equal(rootPackage.scripts['load:smoke'], 'node scripts/load-smoke.mjs');
  assert.equal(rootPackage.scripts['check:capacity'], 'node scripts/capacity-check.mjs');
  assert.equal(rootPackage.scripts['check:ops'], 'node scripts/ops-check.mjs');
  assert.match(loadScriptSource, /LOAD_TARGET_URL/);
  assert.match(loadScriptSource, /LOAD_SCENARIO/);
  assert.match(loadScriptSource, /LOAD_CONCURRENCY/);
  assert.match(loadScriptSource, /LOAD_REQUESTS/);
  assert.match(loadScriptSource, /LOAD_MAX_FAILURE_RATE/);
  assert.match(loadScriptSource, /LOAD_P95_MS/);
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
  assert.match(composeSource, /elasticsearch:/);
  assert.match(composeSource, /discovery\.type=single-node/);
  assert.match(composeSource, /xpack\.security\.enabled=false/);
  assert.match(composeSource, /bootstrap\.memory_lock=true/);
  assert.match(composeSource, /ES_JAVA_OPTS=-Xms1g -Xmx1g/);
  assert.match(composeSource, /memlock:/);
  assert.match(composeSource, /9200:9200/);
  assert.match(composeSource, /neo4j:/);
  assert.match(composeSource, /NEO4J_AUTH:\s*"\$\{NEO4J_USER:\?NEO4J_USER is required\}\/\$\{NEO4J_PASSWORD:\?NEO4J_PASSWORD is required\}"/);
  assert.match(composeSource, /NEO4J_server_memory_heap_initial__size:\s*512m/);
  assert.match(composeSource, /NEO4J_server_memory_heap_max__size:\s*1G/);
  assert.match(composeSource, /NEO4J_server_memory_pagecache_size:\s*512m/);
  assert.match(composeSource, /7474:7474/);
  assert.match(composeSource, /7687:7687/);
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
  const mainSource = readSource('src/main.ts');
  const lifecycleSource = readSource('src/infrastructure/runtime-lifecycle.service.ts');
  const sessionsSource = readSource('src/repositories/sessions.ts');
  const filesRepositorySource = readSource('src/repositories/files.ts');
  const maintenanceSource = readOptionalSource('src/services/maintenance.ts');
  const ragEvalRepositorySource = readOptionalSource('src/repositories/ragEval.ts');

  assert.match(envSource, /MAINTENANCE_INTERVAL_MS/);
  assert.match(envSource, /UPLOAD_TEMP_MAX_AGE_MS/);
  assert.match(envSource, /RAG_EVAL_STALE_RUN_MS/);
  assert.match(sessionsSource, /deleteExpiredSessions/);
  assert.match(sessionsSource, /delete from sessions where expires_at < now\(\)/i);
  assert.match(mainSource, /app\.get\(RuntimeLifecycleService\)\.startMaintenance\(\)/);
  assert.match(lifecycleSource, /beforeApplicationShutdown\(\)[\s\S]*maintenanceService\.stop\(\)/);
  assert.match(ragEvalRepositorySource, /failStaleRunningRagEvalRuns/);
  assert.match(ragEvalRepositorySource, /created_at < now\(\) - \(\$1::text \|\| ' milliseconds'\)::interval/i);
  assert.match(maintenanceSource, /cleanupUploadTempDirectory/);
  assert.match(maintenanceSource, /failStaleRunningRagEvalRuns/);
  assert.match(maintenanceSource, /recordRagEvalRunsStaleFailed/);
  assert.match(maintenanceSource, /RAG_EVAL_STALE_RUN_MS/);
  assert.match(maintenanceSource, /UPLOAD_TEMP_MAX_AGE_MS/);
  assert.match(maintenanceSource, /ABANDONED_UPLOAD_RECORD_MAX_AGE_MS/);
  assert.match(maintenanceSource, /60 \* 60 \* 1000/);
  assert.match(maintenanceSource, /setInterval/);
  assert.match(maintenanceSource, /fs\.remove/);
  assert.match(filesRepositorySource, /deleteAbandonedUploadingFiles/);
  assert.match(filesRepositorySource, /status = 'uploading'/);
  assert.match(filesRepositorySource, /object_key is null/);
  assert.match(filesRepositorySource, /not exists[\s\S]*upload_multipart_sessions/);
  assert.match(maintenanceSource, /cleanupAbandonedUploadRecords/);
});
