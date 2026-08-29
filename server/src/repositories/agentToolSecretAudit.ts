import { query } from '../lib/db';

export type AgentToolSecretEventType =
  | 'configured'
  | 'replaced'
  | 'cleared'
  | 'used'
  | 'decrypt_failed'
  | 'rewrapped';

export interface AgentToolSecretEventInput {
  userId: string;
  toolId: string;
  toolVersionId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  eventType: AgentToolSecretEventType;
  secretVersion: number;
  envelopeVersion?: 1 | 2 | null;
  encryptionKeyId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Record that encrypted material was accessed, never the material itself. Tool
 * runtimes await this write before sending credentials to a remote endpoint so
 * a database/audit outage fails closed rather than creating an unobserved use.
 */
export const recordAgentToolSecretEvent = async (
  input: AgentToolSecretEventInput,
) => {
  await query(
    `insert into agent_tool_secret_events (
       user_id, tool_id, tool_version_id, run_id, agent_id, event_type,
       secret_version, envelope_version, encryption_key_id, metadata
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      input.userId,
      input.toolId,
      input.toolVersionId || null,
      input.runId || null,
      input.agentId || null,
      input.eventType,
      input.secretVersion,
      input.envelopeVersion ?? null,
      input.encryptionKeyId || null,
      JSON.stringify(input.metadata || {}),
    ],
  );
};

