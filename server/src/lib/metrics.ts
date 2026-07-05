import { RequestHandler } from 'express';

type RagStatus = 'ok' | 'error';
type DatabaseStatus = 'ok' | 'error';
type ChatStreamStatus = 'completed' | 'failed' | 'rejected';
type HttpStatusFamily = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other';
type RagEvalCompletionStatus = 'completed' | 'partial' | 'failed' | 'cancelled';

const HTTP_STATUS_FAMILIES: HttpStatusFamily[] = ['1xx', '2xx', '3xx', '4xx', '5xx', 'other'];
const RAG_EVAL_COMPLETION_STATUSES: RagEvalCompletionStatus[] = ['completed', 'partial', 'failed', 'cancelled'];

interface RequestContext {
  startedAt: number;
}

interface DatabasePoolStats {
  total: number;
  idle: number;
  waiting: number;
}

const getHttpStatusFamily = (statusCode: number): HttpStatusFamily => {
  if (statusCode >= 100 && statusCode < 600) {
    return `${Math.floor(statusCode / 100)}xx` as HttpStatusFamily;
  }

  return 'other';
};

class MetricsRegistry {
  private startedAt = Date.now();
  private httpRequestsTotal = 0;
  private httpErrorsTotal = 0;
  private httpActiveRequests = 0;
  private httpDurationMsTotal = 0;
  private httpRequestsByStatusFamily = new Map<HttpStatusFamily, number>(
    HTTP_STATUS_FAMILIES.map((family) => [family, 0])
  );
  private rateLimitRejectionsByScope = new Map<string, number>();
  private databaseQueriesTotal = 0;
  private databaseQueryFailuresTotal = 0;
  private databaseQueryDurationMsTotal = 0;
  private databaseSlowQueriesTotal = 0;
  private databasePoolStatsProvider: (() => DatabasePoolStats) | null = null;
  private chatStreamsActive = 0;
  private chatStreamsCompletedTotal = 0;
  private chatStreamsFailedTotal = 0;
  private chatStreamsRejectedTotal = 0;
  private ragRetrieveTotal = 0;
  private ragRetrieveFailuresTotal = 0;
  private ragRetrieveDurationMsTotal = 0;
  private ragCircuitOpenTotal = 0;
  private ragEvalRunsStartedTotal = 0;
  private ragEvalRunsReusedTotal = 0;
  private ragEvalRunsQueueClaimedTotal = 0;
  private ragEvalRunsRetriedTotal = 0;
  private ragEvalRunsCompletedByStatus = new Map<RagEvalCompletionStatus, number>(
    RAG_EVAL_COMPLETION_STATUSES.map((status) => [status, 0])
  );
  private ragEvalRunsStaleFailedTotal = 0;

  recordHttpRequestStart(): RequestContext {
    this.httpActiveRequests += 1;
    return { startedAt: Date.now() };
  }

  recordHttpRequestComplete(context: RequestContext, statusCode: number) {
    this.httpActiveRequests = Math.max(this.httpActiveRequests - 1, 0);
    this.httpRequestsTotal += 1;
    if (statusCode >= 500) this.httpErrorsTotal += 1;
    this.httpDurationMsTotal += Date.now() - context.startedAt;
    const family = getHttpStatusFamily(statusCode);
    this.httpRequestsByStatusFamily.set(
      family,
      (this.httpRequestsByStatusFamily.get(family) || 0) + 1
    );
  }

  setDatabasePoolStatsProvider(provider: () => DatabasePoolStats) {
    this.databasePoolStatsProvider = provider;
  }

  recordDatabaseQuery(status: DatabaseStatus, durationMs: number, slowQueryThresholdMs: number) {
    this.databaseQueriesTotal += 1;
    this.databaseQueryDurationMsTotal += durationMs;
    if (status === 'error') this.databaseQueryFailuresTotal += 1;
    if (durationMs >= slowQueryThresholdMs) this.databaseSlowQueriesTotal += 1;
  }

  recordChatStreamStarted() {
    this.chatStreamsActive += 1;
  }

  recordChatStreamFinished(status: ChatStreamStatus) {
    if (status !== 'rejected') {
      this.chatStreamsActive = Math.max(this.chatStreamsActive - 1, 0);
    }

    if (status === 'completed') this.chatStreamsCompletedTotal += 1;
    if (status === 'failed') this.chatStreamsFailedTotal += 1;
    if (status === 'rejected') this.chatStreamsRejectedTotal += 1;
  }

  recordRagRetrieve(status: RagStatus, durationMs: number) {
    this.ragRetrieveTotal += 1;
    this.ragRetrieveDurationMsTotal += durationMs;
    if (status === 'error') this.ragRetrieveFailuresTotal += 1;
  }

  recordRagCircuitOpen() {
    this.ragCircuitOpenTotal += 1;
  }

  recordRagEvalRunStarted() {
    this.ragEvalRunsStartedTotal += 1;
  }

  recordRagEvalRunReused() {
    this.ragEvalRunsReusedTotal += 1;
  }

  recordRagEvalRunQueueClaimed() {
    this.ragEvalRunsQueueClaimedTotal += 1;
  }

  recordRagEvalRunRetried() {
    this.ragEvalRunsRetriedTotal += 1;
  }

  recordRagEvalRunCompleted(status: RagEvalCompletionStatus) {
    this.ragEvalRunsCompletedByStatus.set(
      status,
      (this.ragEvalRunsCompletedByStatus.get(status) || 0) + 1
    );
  }

  recordRagEvalRunsStaleFailed(count: number) {
    this.ragEvalRunsStaleFailedTotal += Math.max(count, 0);
  }

  recordRateLimitRejected(scope: string) {
    this.rateLimitRejectionsByScope.set(
      scope,
      (this.rateLimitRejectionsByScope.get(scope) || 0) + 1
    );
  }

  renderPrometheus() {
    const uptimeSeconds = Math.max((Date.now() - this.startedAt) / 1000, 0);
    const databasePoolStats = this.databasePoolStatsProvider
      ? this.databasePoolStatsProvider()
      : { total: 0, idle: 0, waiting: 0 };
    const lines = [
      '# HELP chatllm_process_uptime_seconds Process uptime in seconds.',
      '# TYPE chatllm_process_uptime_seconds gauge',
      `chatllm_process_uptime_seconds ${uptimeSeconds.toFixed(3)}`,
      '# HELP chatllm_http_requests_total Total HTTP requests.',
      '# TYPE chatllm_http_requests_total counter',
      `chatllm_http_requests_total ${this.httpRequestsTotal}`,
      '# HELP chatllm_http_requests_by_status_family_total Total HTTP requests by status code family.',
      '# TYPE chatllm_http_requests_by_status_family_total counter',
      ...HTTP_STATUS_FAMILIES.map((family) => (
        `chatllm_http_requests_by_status_family_total{status_family="${family}"} ${this.httpRequestsByStatusFamily.get(family) || 0}`
      )),
      '# HELP chatllm_rate_limit_rejections_total Total HTTP requests rejected by route rate limit scope.',
      '# TYPE chatllm_rate_limit_rejections_total counter',
      ...Array.from(this.rateLimitRejectionsByScope.entries()).map(([scope, count]) => (
        `chatllm_rate_limit_rejections_total{scope="${scope}"} ${count}`
      )),
      '# HELP chatllm_http_errors_total Total HTTP responses with status >= 500.',
      '# TYPE chatllm_http_errors_total counter',
      `chatllm_http_errors_total ${this.httpErrorsTotal}`,
      '# HELP chatllm_http_requests_active Active HTTP requests.',
      '# TYPE chatllm_http_requests_active gauge',
      `chatllm_http_requests_active ${this.httpActiveRequests}`,
      '# HELP chatllm_http_request_duration_ms_total Total HTTP request duration in milliseconds.',
      '# TYPE chatllm_http_request_duration_ms_total counter',
      `chatllm_http_request_duration_ms_total ${this.httpDurationMsTotal}`,
      '# HELP chatllm_database_queries_total Total database queries.',
      '# TYPE chatllm_database_queries_total counter',
      `chatllm_database_queries_total ${this.databaseQueriesTotal}`,
      '# HELP chatllm_database_query_failures_total Failed database queries.',
      '# TYPE chatllm_database_query_failures_total counter',
      `chatllm_database_query_failures_total ${this.databaseQueryFailuresTotal}`,
      '# HELP chatllm_database_query_duration_ms_total Total database query duration in milliseconds.',
      '# TYPE chatllm_database_query_duration_ms_total counter',
      `chatllm_database_query_duration_ms_total ${this.databaseQueryDurationMsTotal}`,
      '# HELP chatllm_database_slow_queries_total Database queries slower than the configured threshold.',
      '# TYPE chatllm_database_slow_queries_total counter',
      `chatllm_database_slow_queries_total ${this.databaseSlowQueriesTotal}`,
      '# HELP chatllm_database_pool_total Total Postgres clients in the pool.',
      '# TYPE chatllm_database_pool_total gauge',
      `chatllm_database_pool_total ${databasePoolStats.total}`,
      '# HELP chatllm_database_pool_idle Idle Postgres clients in the pool.',
      '# TYPE chatllm_database_pool_idle gauge',
      `chatllm_database_pool_idle ${databasePoolStats.idle}`,
      '# HELP chatllm_database_pool_waiting Requests waiting for a Postgres client.',
      '# TYPE chatllm_database_pool_waiting gauge',
      `chatllm_database_pool_waiting ${databasePoolStats.waiting}`,
      '# HELP chatllm_chat_streams_active Active chat streams.',
      '# TYPE chatllm_chat_streams_active gauge',
      `chatllm_chat_streams_active ${this.chatStreamsActive}`,
      '# HELP chatllm_chat_streams_completed_total Completed chat streams.',
      '# TYPE chatllm_chat_streams_completed_total counter',
      `chatllm_chat_streams_completed_total ${this.chatStreamsCompletedTotal}`,
      '# HELP chatllm_chat_streams_failed_total Failed chat streams.',
      '# TYPE chatllm_chat_streams_failed_total counter',
      `chatllm_chat_streams_failed_total ${this.chatStreamsFailedTotal}`,
      '# HELP chatllm_chat_streams_rejected_total Rejected chat streams.',
      '# TYPE chatllm_chat_streams_rejected_total counter',
      `chatllm_chat_streams_rejected_total ${this.chatStreamsRejectedTotal}`,
      '# HELP chatllm_rag_retrieve_total Total RAG retrieve attempts.',
      '# TYPE chatllm_rag_retrieve_total counter',
      `chatllm_rag_retrieve_total ${this.ragRetrieveTotal}`,
      '# HELP chatllm_rag_retrieve_failures_total Failed RAG retrieve attempts.',
      '# TYPE chatllm_rag_retrieve_failures_total counter',
      `chatllm_rag_retrieve_failures_total ${this.ragRetrieveFailuresTotal}`,
      '# HELP chatllm_rag_retrieve_duration_ms_total Total RAG retrieve duration in milliseconds.',
      '# TYPE chatllm_rag_retrieve_duration_ms_total counter',
      `chatllm_rag_retrieve_duration_ms_total ${this.ragRetrieveDurationMsTotal}`,
      '# HELP chatllm_rag_circuit_open_total RAG circuit-open short circuits.',
      '# TYPE chatllm_rag_circuit_open_total counter',
      `chatllm_rag_circuit_open_total ${this.ragCircuitOpenTotal}`,
      '# HELP chatllm_rag_eval_runs_started_total Newly started RAG evaluation background runs.',
      '# TYPE chatllm_rag_eval_runs_started_total counter',
      `chatllm_rag_eval_runs_started_total ${this.ragEvalRunsStartedTotal}`,
      '# HELP chatllm_rag_eval_runs_reused_total Duplicate RAG evaluation run requests served by an existing running run.',
      '# TYPE chatllm_rag_eval_runs_reused_total counter',
      `chatllm_rag_eval_runs_reused_total ${this.ragEvalRunsReusedTotal}`,
      '# HELP chatllm_rag_eval_runs_queue_claimed_total Queued RAG evaluation runs claimed by workers.',
      '# TYPE chatllm_rag_eval_runs_queue_claimed_total counter',
      `chatllm_rag_eval_runs_queue_claimed_total ${this.ragEvalRunsQueueClaimedTotal}`,
      '# HELP chatllm_rag_eval_runs_retried_total RAG evaluation runs scheduled for retry after a failed attempt.',
      '# TYPE chatllm_rag_eval_runs_retried_total counter',
      `chatllm_rag_eval_runs_retried_total ${this.ragEvalRunsRetriedTotal}`,
      '# HELP chatllm_rag_eval_runs_completed_total RAG evaluation background runs completed by status.',
      '# TYPE chatllm_rag_eval_runs_completed_total counter',
      ...RAG_EVAL_COMPLETION_STATUSES.map((status) => (
        `chatllm_rag_eval_runs_completed_total{status="${status}"} ${this.ragEvalRunsCompletedByStatus.get(status) || 0}`
      )),
      '# HELP chatllm_rag_eval_runs_stale_failed_total Stale RAG evaluation runs marked failed by maintenance.',
      '# TYPE chatllm_rag_eval_runs_stale_failed_total counter',
      `chatllm_rag_eval_runs_stale_failed_total ${this.ragEvalRunsStaleFailedTotal}`,
      '',
    ];

    return lines.join('\n');
  }
}

export const metrics = new MetricsRegistry();

export const metricsHandler: RequestHandler = (_req, res) => {
  res.type('text/plain').send(metrics.renderPrometheus());
};
