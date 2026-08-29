import {
  decryptAgentToolSecrets,
  inspectAgentToolSecretEnvelope,
} from '../../../lib/agentToolSecrets';
import { validateAgentToolSecrets } from '../../../lib/agentToolSecretKeys';
import type { AgentToolWithSecretsRow } from '../../../repositories/agentTools';
import {
  recordAgentToolSecretEvent,
  type AgentToolSecretEventInput,
} from '../../../repositories/agentToolSecretAudit';
import type { AgentToolExecutionContext } from './agent-tool';
import { AgentToolError } from './agent-tool-error';

export type AgentToolSecretAuditWriter = (
  input: AgentToolSecretEventInput,
) => Promise<void>;

export interface ResolvedAgentToolSecrets {
  secrets: Readonly<Record<string, string>>;
  placements: ReturnType<typeof validateAgentToolSecrets>;
}

const redactText = (value: string, secrets: string[]) => secrets.reduce(
  (current, secret) => current.split(secret).join('[REDACTED]'),
  value,
);

/**
 * Diagnostic endpoints show remote-controlled content in an authenticated UI.
 * A server can intentionally or accidentally echo Authorization/query material,
 * so remove every decrypted value before a preview or discovered schema crosses
 * the API boundary. Production tool results are intentionally left untouched.
 */
export const redactAgentToolSecretValues = (
  value: unknown,
  secrets: Readonly<Record<string, string>>,
): unknown => {
  const values = [...new Set(Object.values(secrets).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (values.length === 0) return value;
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === 'string') return redactText(current, values);
    if (depth >= 40 || current === null || typeof current !== 'object') return current;
    if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
    return Object.fromEntries(Object.entries(current as Record<string, unknown>).map(
      ([key, item]) => [redactText(key, values), visit(item, depth + 1)],
    ));
  };
  return visit(value, 0);
};

export type AgentToolSecretUseContext = Pick<
  AgentToolExecutionContext,
  'attempt' | 'toolCallId'
> & {
  runId?: string | null;
  agentId?: string | null;
};

/**
 * Decrypt and audit immediately before a runtime may place credentials on a
 * request. A successful decrypt is not returned when its append-only audit write
 * fails, ensuring the remote side never receives an unobserved credential use.
 */
export const resolveAgentToolSecretsForUse = async (input: {
  tool: AgentToolWithSecretsRow;
  context: AgentToolSecretUseContext;
  recordEvent?: AgentToolSecretAuditWriter;
}): Promise<ResolvedAgentToolSecrets | null> => {
  const payload = input.tool.encrypted_secrets;
  if (!payload) return null;
  const recordEvent = input.recordEvent || recordAgentToolSecretEvent;
  let envelope: ReturnType<typeof inspectAgentToolSecretEnvelope>;
  let secrets: Record<string, string>;
  try {
    envelope = inspectAgentToolSecretEnvelope(payload);
    secrets = decryptAgentToolSecrets(payload, {
      userId: input.tool.user_id,
      toolId: input.tool.id,
      secretVersion: input.tool.secret_version,
    });
  } catch {
    await recordEvent({
      userId: input.tool.user_id,
      toolId: input.tool.id,
      toolVersionId: input.tool.tool_version_id,
      runId: input.context.runId,
      agentId: input.context.agentId,
      eventType: 'decrypt_failed',
      secretVersion: input.tool.secret_version,
      metadata: {
        attempt: input.context.attempt,
        tool_call_id: input.context.toolCallId,
      },
    }).catch(() => undefined);
    throw new AgentToolError(
      'tool_secret_decryption_failed',
      'Agent tool credentials could not be decrypted',
    );
  }
  const placements = validateAgentToolSecrets(secrets);
  try {
    await recordEvent({
      userId: input.tool.user_id,
      toolId: input.tool.id,
      toolVersionId: input.tool.tool_version_id,
      runId: input.context.runId,
      agentId: input.context.agentId,
      eventType: 'used',
      secretVersion: input.tool.secret_version,
      envelopeVersion: envelope.envelopeVersion,
      encryptionKeyId: envelope.keyId,
      metadata: {
        attempt: input.context.attempt,
        tool_call_id: input.context.toolCallId,
        secret_count: Object.keys(secrets).length,
      },
    });
  } catch {
    throw new AgentToolError(
      'tool_secret_audit_failed',
      'Agent tool credential use could not be audited',
    );
  }
  return { secrets, placements };
};
