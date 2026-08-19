import { query } from '../lib/db';

export const recordAgentAuditEvent = async (input: {
  userId: string;
  action: string;
  agentId?: string | null;
  toolId?: string | null;
  metadata?: Record<string, unknown>;
}) => {
  await query(
    `insert into agent_audit_events (user_id, agent_id, tool_id, action, metadata)
     values ($1, $2, $3, $4, $5)`,
    [
      input.userId,
      input.agentId || null,
      input.toolId || null,
      input.action,
      JSON.stringify(input.metadata || {}),
    ],
  );
};
