import { query, withTransaction } from '../lib/db';
import type {
  AgentToolDiagnosticCursor,
} from '../lib/agentToolDiagnosticCursor';
import type {
  AgentToolDiagnosticOperation,
} from '../modules/agents/runtime/agent-tool-diagnostics';

export type AgentToolDiagnosticHistoryStatus = 'passed' | 'failed';

export interface AgentToolDiagnosticHistoryRow {
  id: string;
  user_id: string;
  tool_id: string;
  tool_version_id: string;
  configuration_hash: string;
  operation: AgentToolDiagnosticOperation;
  status: AgentToolDiagnosticHistoryStatus;
  live_request_attempted: boolean;
  passed_check_count: number;
  warning_check_count: number;
  failed_check_count: number;
  error_code: string | null;
  response_status: number | null;
  discovery_tool_count: number | null;
  discovery_warning_count: number | null;
  duration_ms: number;
  checked_at: string;
  created_at: string;
}

const HISTORY_LIMIT_PER_TOOL = 200;

export const recordAgentToolDiagnosticHistory = async (input: {
  userId: string;
  toolId: string;
  toolVersionId: string;
  configurationHash: string;
  operation: AgentToolDiagnosticOperation;
  status: AgentToolDiagnosticHistoryStatus;
  liveRequestAttempted: boolean;
  passedCheckCount: number;
  warningCheckCount: number;
  failedCheckCount: number;
  errorCode?: string | null;
  responseStatus?: number | null;
  discoveryToolCount?: number | null;
  discoveryWarningCount?: number | null;
  durationMs: number;
  checkedAt: string;
}) => withTransaction(async (client) => {
  // Insert and pruning share one tool-scoped lock, so concurrent diagnostics
  // cannot each observe an under-limit history and retain more than 200 rows.
  await client.query(
    `select pg_advisory_xact_lock(
       hashtextextended('agent-tool-diagnostic-history:' || $1::text, 0)
     )`,
    [input.toolId],
  );
  const inserted = await client.query<AgentToolDiagnosticHistoryRow>(
    `insert into agent_tool_diagnostics (
       user_id, tool_id, tool_version_id, configuration_hash, operation,
       status, live_request_attempted, passed_check_count,
       warning_check_count, failed_check_count, error_code, response_status,
       discovery_tool_count, discovery_warning_count, duration_ms, checked_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
     )
     returning *`,
    [
      input.userId,
      input.toolId,
      input.toolVersionId,
      input.configurationHash,
      input.operation,
      input.status,
      input.liveRequestAttempted,
      input.passedCheckCount,
      input.warningCheckCount,
      input.failedCheckCount,
      input.errorCode || null,
      input.responseStatus ?? null,
      input.discoveryToolCount ?? null,
      input.discoveryWarningCount ?? null,
      input.durationMs,
      input.checkedAt,
    ],
  );
  await client.query(
    `delete from agent_tool_diagnostics history
     where history.id in (
       select stale.id
       from agent_tool_diagnostics stale
       where stale.tool_id = $1
       order by stale.checked_at desc, stale.id desc
       offset $2
     )`,
    [input.toolId, HISTORY_LIMIT_PER_TOOL],
  );
  return inserted.rows[0];
});

export const listAgentToolDiagnosticHistory = async (input: {
  userId: string;
  toolId: string;
  operation?: AgentToolDiagnosticOperation;
  toolVersionId?: string;
  cursor?: AgentToolDiagnosticCursor | null;
  limit: number;
}) => {
  const values: unknown[] = [input.userId, input.toolId];
  const conditions = ['user_id = $1', 'tool_id = $2'];
  if (input.operation) {
    values.push(input.operation);
    conditions.push(`operation = $${values.length}`);
  }
  if (input.toolVersionId) {
    values.push(input.toolVersionId);
    conditions.push(`tool_version_id = $${values.length}::uuid`);
  }
  if (input.cursor) {
    values.push(input.cursor.checkedAt, input.cursor.id);
    conditions.push(
      `(checked_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
    );
  }
  values.push(input.limit + 1);
  const { rows } = await query<AgentToolDiagnosticHistoryRow>(
    `select *
     from agent_tool_diagnostics
     where ${conditions.join(' and ')}
     order by checked_at desc, id desc
     limit $${values.length}`,
    values,
  );
  return {
    rows: rows.slice(0, input.limit),
    hasMore: rows.length > input.limit,
  };
};
