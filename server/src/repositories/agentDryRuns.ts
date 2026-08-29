import { query, withTransaction } from '../lib/db';
import { serverEnv } from '../lib/env';
import type { AgentPublicationValidationReport } from './agents';
import type {
  AgentDryRunPlannedToolCall,
} from '../modules/agents/runtime/agent-dry-run';
import type { AgentTokenUsage } from '../modules/agents/runtime/agent-evidence';

export type AgentVersionDryRunStatus = 'running' | 'succeeded' | 'failed';

export interface AgentVersionDryRunRow {
  id: string;
  user_id: string;
  agent_id: string;
  agent_version_id: string;
  status: AgentVersionDryRunStatus;
  input_text: string;
  output_text: string;
  validation_report: AgentPublicationValidationReport;
  planned_tool_calls: AgentDryRunPlannedToolCall[];
  usage: AgentTokenUsage;
  isolation_report: {
    mode: 'model_only';
    blocked_effects: string[];
    omitted_context: string[];
  };
  failure_code?: string | null;
  failure_message?: string | null;
  created_at: string;
  completed_at?: string | null;
}

const dryRunColumns = `
  id,
  user_id,
  agent_id,
  agent_version_id,
  status,
  input_text,
  output_text,
  validation_report,
  planned_tool_calls,
  usage,
  isolation_report,
  failure_code,
  failure_message,
  created_at,
  completed_at
`;

export const createAgentVersionDryRun = async (input: {
  userId: string;
  agentId: string;
  agentVersionId: string;
  inputText: string;
  validationReport: AgentPublicationValidationReport;
  isolationReport: AgentVersionDryRunRow['isolation_report'];
}) => withTransaction(async (client) => {
  await client.query(
    `select pg_advisory_xact_lock(hashtextextended('agent-dry-run:' || $1::text, 0))`,
    [input.userId],
  );
  const { rows: versionRows } = await client.query<{ id: string; status: string }>(
    `select version.id, agent.status
     from agents agent
     join agent_versions version on version.id = $2 and version.agent_id = agent.id
     where agent.id = $1 and agent.user_id = $3
     for share of agent, version`,
    [input.agentId, input.agentVersionId, input.userId],
  );
  if (!versionRows[0]) throw new Error('AGENT_VERSION_NOT_FOUND');
  if (versionRows[0].status === 'disabled') throw new Error('AGENT_DISABLED');

  const { rows: activeRows } = await client.query<{ count: string }>(
    `select count(*)::text as count
     from agent_version_dry_runs
     where user_id = $1 and status = 'running'`,
    [input.userId],
  );
  if (Number(activeRows[0]?.count || 0) >= serverEnv.AGENT_MAX_ACTIVE_RUNS_PER_USER) {
    throw new Error('AGENT_DRY_RUN_LIMIT');
  }

  const { rows } = await client.query<AgentVersionDryRunRow>(
    `insert into agent_version_dry_runs (
       user_id, agent_id, agent_version_id, input_text,
       validation_report, isolation_report
     ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     returning ${dryRunColumns}`,
    [
      input.userId,
      input.agentId,
      input.agentVersionId,
      input.inputText,
      JSON.stringify(input.validationReport),
      JSON.stringify(input.isolationReport),
    ],
  );
  return rows[0];
});

export const completeAgentVersionDryRun = async (input: {
  dryRunId: string;
  userId: string;
  outputText: string;
  plannedToolCalls: AgentDryRunPlannedToolCall[];
  usage: AgentTokenUsage;
}) => {
  const { rows } = await query<AgentVersionDryRunRow>(
    `update agent_version_dry_runs
     set status = 'succeeded',
         output_text = $3,
         planned_tool_calls = $4::jsonb,
         usage = $5::jsonb,
         completed_at = now()
     where id = $1 and user_id = $2 and status = 'running'
     returning ${dryRunColumns}`,
    [
      input.dryRunId,
      input.userId,
      input.outputText,
      JSON.stringify(input.plannedToolCalls),
      JSON.stringify(input.usage),
    ],
  );
  return rows[0] || null;
};

export const failAgentVersionDryRun = async (input: {
  dryRunId: string;
  userId: string;
  failureCode: string;
  failureMessage: string;
  plannedToolCalls?: AgentDryRunPlannedToolCall[];
  usage?: AgentTokenUsage;
}) => {
  const { rows } = await query<AgentVersionDryRunRow>(
    `update agent_version_dry_runs
     set status = 'failed',
         failure_code = $3,
         failure_message = $4,
         planned_tool_calls = $5::jsonb,
         usage = $6::jsonb,
         completed_at = now()
     where id = $1 and user_id = $2 and status = 'running'
     returning ${dryRunColumns}`,
    [
      input.dryRunId,
      input.userId,
      input.failureCode,
      input.failureMessage,
      JSON.stringify(input.plannedToolCalls || []),
      JSON.stringify(input.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      }),
    ],
  );
  return rows[0] || null;
};

export const listAgentVersionDryRunsForUser = async (input: {
  userId: string;
  agentId: string;
  agentVersionId: string;
  limit?: number;
}) => {
  const limit = Math.max(1, Math.min(100, input.limit ?? 20));
  const { rows } = await query<AgentVersionDryRunRow>(
    `select ${dryRunColumns.split('\n').map((column) => column.trim()).filter(Boolean)
      .map((column) => `dry_run.${column.replace(/,$/, '')}`).join(', ')}
     from agent_version_dry_runs dry_run
     join agents agent on agent.id = dry_run.agent_id and agent.user_id = $1
     where dry_run.user_id = $1
       and dry_run.agent_id = $2
       and dry_run.agent_version_id = $3
     order by dry_run.created_at desc, dry_run.id desc
     limit $4`,
    [input.userId, input.agentId, input.agentVersionId, limit],
  );
  return rows;
};

export const findAgentVersionDryRunForUser = async (dryRunId: string, userId: string) => {
  const { rows } = await query<AgentVersionDryRunRow>(
    `select ${dryRunColumns}
     from agent_version_dry_runs
     where id = $1 and user_id = $2`,
    [dryRunId, userId],
  );
  return rows[0] || null;
};

export const isAgentVersionDryRunActiveForUser = async (dryRunId: string, userId: string) => {
  const { rows } = await query<{ active: boolean }>(
    `select exists (
       select 1
       from agent_version_dry_runs dry_run
       join agents agent on agent.id = dry_run.agent_id
       where dry_run.id = $1
         and dry_run.user_id = $2
         and dry_run.status = 'running'
         and agent.user_id = $2
         and agent.status <> 'disabled'
     ) as active`,
    [dryRunId, userId],
  );
  return rows[0]?.active === true;
};

export const failStaleAgentVersionDryRuns = async (staleBefore: Date) => {
  const { rows } = await query<{ id: string }>(
    `update agent_version_dry_runs
     set status = 'failed',
         failure_code = 'dry_run_interrupted',
         failure_message = 'The Agent dry-run was interrupted before it completed',
         completed_at = now()
     where status = 'running' and created_at < $1
     returning id`,
    [staleBefore.toISOString()],
  );
  return rows.map((row) => row.id);
};
