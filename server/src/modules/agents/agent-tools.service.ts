import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  AgentToolEncryptionUnavailableError,
  encryptAgentToolSecrets,
} from '../../lib/agentToolSecrets';
import { toSafeError } from '../../lib/safeError';
import { serverEnv } from '../../lib/env';
import {
  AgentToolKind,
  AgentToolRiskLevel,
  countEnabledAgentToolBindingsForUser,
  createAgentToolForUser,
  deleteAgentToolForUser,
  findAgentToolForUser,
  listAgentToolsForUser,
  listAgentToolBindingScopesForUser,
  updateAgentToolForUser,
} from '../../repositories/agentTools';
import { findProjectSpaceForUser } from '../../repositories/projectSpaces';
import { validateAgentJsonObjectSchemaDefinition } from './runtime/json-schema-input';
import { recordAgentAuditEvent } from '../../repositories/agentAudit';

export interface AgentToolCreateBody {
  name: string;
  description?: string;
  kind: AgentToolKind;
  risk_level?: AgentToolRiskLevel;
  /**
   * Per-run ceiling for this tool. Omitted or null means only the global ceiling
   * applies, so this is an opt-in tightening for tools with a real side effect.
   */
  max_invocations_per_run?: number | null;
  project_space_id?: string | null;
  projectSpaceId?: string | null;
  configuration: Record<string, unknown>;
  secrets?: Record<string, string>;
  enabled?: boolean;
}

export type AgentToolUpdateBody = Partial<Omit<AgentToolCreateBody, 'kind'>> & {
  clear_secrets?: boolean;
};

/**
 * A per-run ceiling is either absent or a small positive integer. Rejecting a
 * malformed value here keeps the database constraint from being the thing that
 * reports a user-facing configuration mistake.
 */
const normalizeMaxInvocationsPerRun = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 100) {
    throw publicError(
      HttpStatus.BAD_REQUEST,
      'max_invocations_per_run must be an integer between 1 and 100',
    );
  }
  return Number(value);
};
const looksLikeCredentialQueryKey = (key: string) => (
  /(?:^|[-_])(api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|credential|key|pass(?:word|wd)?|signature|secret|token)(?:$|[-_])/i.test(key)
);

const validateEndpointSecretPlacement = (endpoint: string, context: z.RefinementCtx) => {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return;
  }
  if (parsed.hash) {
    context.addIssue({
      code: 'custom',
      path: ['endpoint'],
      message: 'Endpoint fragments are not allowed; store credentials in the secrets section',
    });
  }
  const credentialKey = [...parsed.searchParams.keys()].find(looksLikeCredentialQueryKey);
  if (credentialKey) {
    context.addIssue({
      code: 'custom',
      path: ['endpoint'],
      message: 'Credential query parameters must be stored in the secrets section',
    });
  }
};

const httpConfigurationSchema = z.object({
  endpoint: z.string().trim().url().max(2048),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  timeout_ms: z.number().int().min(1000).max(60000).default(15000),
  input_schema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  static_headers: z.record(z.string(), z.string().max(4096)).default({}),
  response_path: z.string().trim().max(500).default(''),
}).strict().superRefine((configuration, context) => {
  let parsed: URL;
  try {
    parsed = new URL(configuration.endpoint);
  } catch {
    return;
  }
  validateEndpointSecretPlacement(configuration.endpoint, context);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Only HTTP(S) endpoints are supported' });
  }
  const unsafeHeaders = Object.keys(configuration.static_headers).filter((header) => {
    const normalized = header.toLowerCase().replace(/_/g, '-');
    // Static headers are returned as part of the public tool configuration.
    // Keep credential-bearing values in the encrypted `secrets` field so they
    // cannot be exposed by catalog/list endpoints or run snapshots.
    return [
      'authorization',
      'cookie',
      'proxy-authorization',
      'x-api-key',
      'api-key',
      'x-auth-token',
      'x-access-token',
      'x-client-secret',
      'x-api-secret',
    ].includes(normalized)
      || /(?:^|[-])(?:password|passwd|token|secret|credential)s?(?:$|[-])/.test(normalized);
  });
  if (unsafeHeaders.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['static_headers', unsafeHeaders[0]],
      message: 'Credentials must be stored in the secrets section',
    });
  }
  const hopBypassHeaders = Object.keys(configuration.static_headers).filter((header) => (
    ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade'].includes(header.toLowerCase())
    || header.toLowerCase().startsWith('proxy-')
  ));
  if (hopBypassHeaders.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['static_headers', hopBypassHeaders[0]],
      message: 'Transport-controlled headers are not allowed',
    });
  }
});

const mcpConfigurationSchema = z.object({
  endpoint: z.string().trim().url().max(2048),
  tool_name: z.string().trim().min(1).max(160),
  timeout_ms: z.number().int().min(1000).max(60000).default(20000),
  input_schema: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((configuration, context) => {
  let parsed: URL;
  try {
    parsed = new URL(configuration.endpoint);
  } catch {
    return;
  }
  validateEndpointSecretPlacement(configuration.endpoint, context);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Only remote HTTP MCP endpoints are supported' });
  }
});

const publicError = (statusCode: number, error: string) => (
  new HttpException({ error }, statusCode)
);

const isUniqueViolation = (error: unknown) => (
  Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23505')
);

const readProjectSpaceId = (body: {
  project_space_id?: string | null;
  projectSpaceId?: string | null;
}) => {
  const value = body.project_space_id ?? body.projectSpaceId;
  if (typeof value !== 'string') return value ?? undefined;
  return value.trim() || null;
};

const readBooleanQuery = (value: unknown) => value === 'true' || value === '1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AgentToolsService {
  private audit(input: Parameters<typeof recordAgentAuditEvent>[0]) {
    return recordAgentAuditEvent(input).catch((error) => {
      console.warn('[AgentTools] Failed to write audit event:', toSafeError(error));
    });
  }
  private validateConfiguration(kind: AgentToolKind, value: Record<string, unknown>) {
    const result = kind === 'http'
      ? httpConfigurationSchema.safeParse(value)
      : mcpConfigurationSchema.safeParse(value);
    if (!result.success) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        result.error.issues[0]?.message || 'Invalid tool configuration',
      );
    }
    try {
      // Tool input schemas may constrain strings with `pattern` so a malformed
      // argument is reported to the model as invalid input instead of reaching
      // the endpoint and coming back as an opaque 400. Agent output schemas
      // deliberately do not get this: a refusal placeholder has to remain
      // synthesizable.
      validateAgentJsonObjectSchemaDefinition(
        result.data.input_schema || { type: 'object', properties: {} },
        { allowPattern: true },
      );
    } catch (error) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        error instanceof Error ? error.message : 'Invalid tool input JSON Schema',
      );
    }
    return result.data;
  }

  private async assertProjectSpace(userId: string, projectSpaceId?: string | null) {
    if (!projectSpaceId) return null;
    const projectSpace = await findProjectSpaceForUser(projectSpaceId, userId);
    if (!projectSpace) throw publicError(HttpStatus.NOT_FOUND, 'Project space not found');
    return projectSpace.id;
  }

  list(userId: string, query: Record<string, unknown>) {
    const projectSpaceId = typeof (query.projectSpaceId ?? query.project_space_id) === 'string'
      ? String(query.projectSpaceId ?? query.project_space_id).trim() || undefined
      : undefined;
    if (projectSpaceId && !UUID.test(projectSpaceId)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid project space id');
    }
    return listAgentToolsForUser({
      userId,
      projectSpaceId,
      includeDisabled: readBooleanQuery(query.includeDisabled ?? query.include_disabled),
    });
  }

  async get(userId: string, toolId: string) {
    if (!UUID.test(toolId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent tool id');
    const tool = await findAgentToolForUser(toolId, userId);
    if (!tool) throw publicError(HttpStatus.NOT_FOUND, 'Agent tool not found');
    return tool;
  }

  async create(userId: string, body: AgentToolCreateBody, requestId?: string) {
    const projectSpaceId = readProjectSpaceId(body);
    await this.assertProjectSpace(userId, projectSpaceId);
    const configuration = this.validateConfiguration(body.kind, body.configuration);
    const requestedRisk = body.risk_level || 'read';
    const configurationMethod = body.kind === 'http' && 'method' in configuration
      ? configuration.method
      : undefined;
    const effectiveRisk = requestedRisk === 'read'
      && (body.kind === 'mcp' || configurationMethod !== 'GET')
      ? 'write'
      : requestedRisk;
    let encryptedSecrets: string | null = null;
    if (body.secrets && Object.keys(body.secrets).length > 0) {
      try {
        encryptedSecrets = encryptAgentToolSecrets(body.secrets);
      } catch (error) {
        if (error instanceof AgentToolEncryptionUnavailableError) {
          throw publicError(HttpStatus.SERVICE_UNAVAILABLE, 'Agent tool credential encryption is not configured');
        }
        throw error;
      }
    }

    try {
      const created = await createAgentToolForUser({
        userId,
        projectSpaceId,
        name: body.name,
        description: body.description,
        kind: body.kind,
        riskLevel: effectiveRisk,
        maxInvocationsPerRun: normalizeMaxInvocationsPerRun(body.max_invocations_per_run),
        configuration,
        encryptedSecrets,
        enabled: body.enabled,
        maxToolsPerUser: serverEnv.AGENT_MAX_TOOLS_PER_USER,
      });
      void this.audit({ userId, toolId: created.id, action: 'agent_tool.created' });
      return created;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (isUniqueViolation(error)) {
        throw publicError(HttpStatus.CONFLICT, 'An Agent tool with this name already exists');
      }
      if (error instanceof Error && error.message === 'AGENT_TOOL_QUOTA_EXCEEDED') {
        throw publicError(HttpStatus.TOO_MANY_REQUESTS, 'Agent tool quota exceeded');
      }
      console.error('[AgentTools] Failed to create tool:', toSafeError(error, requestId));
      throw publicError(HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to create Agent tool');
    }
  }

  async update(
    userId: string,
    toolId: string,
    body: AgentToolUpdateBody,
    requestId?: string,
  ) {
    const existing = await this.get(userId, toolId);
    const updates: Parameters<typeof updateAgentToolForUser>[2] = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.risk_level !== undefined) updates.risk_level = body.risk_level;
    if (body.max_invocations_per_run !== undefined) {
      updates.max_invocations_per_run = normalizeMaxInvocationsPerRun(body.max_invocations_per_run);
    }
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.enabled === false && existing.enabled) {
      const bindingCount = await countEnabledAgentToolBindingsForUser(toolId, userId);
      if (bindingCount > 0) {
        throw publicError(
          HttpStatus.CONFLICT,
          'Remove this tool from all current and published Agent versions before disabling it',
        );
      }
    }
    if (body.project_space_id !== undefined || body.projectSpaceId !== undefined) {
      const projectSpaceId = readProjectSpaceId(body) ?? null;
      await this.assertProjectSpace(userId, projectSpaceId);
      if (projectSpaceId !== existing.project_space_id) {
        const boundAgents = await listAgentToolBindingScopesForUser(toolId, userId);
        if (boundAgents.some((agent) => (
          projectSpaceId !== null && agent.project_space_id !== projectSpaceId
        ))) {
          throw publicError(
            HttpStatus.CONFLICT,
            'Remove this tool from Agents in other project spaces before moving it',
          );
        }
      }
      updates.project_space_id = projectSpaceId;
    }
    if (body.configuration !== undefined) {
      updates.configuration = this.validateConfiguration(existing.kind, body.configuration);
    }
    const effectiveConfiguration = updates.configuration || existing.configuration;
    const effectiveMethod = typeof effectiveConfiguration.method === 'string'
      ? effectiveConfiguration.method
      : undefined;
    // A configuration change can turn a previously read-only HTTP tool into a
    // mutating tool. Persist the elevated risk even when the request omitted
    // `risk_level`; otherwise the catalog and audit state would claim "read"
    // while the runtime correctly requires write approval.
    const effectiveRiskLevel = updates.risk_level ?? existing.risk_level;
    if (effectiveRiskLevel === 'read' && (
      existing.kind === 'mcp'
      || (effectiveMethod && effectiveMethod !== 'GET')
    )) {
      updates.risk_level = 'write';
    }
    if (body.clear_secrets === true) updates.encrypted_secrets = null;
    if (body.secrets !== undefined) {
      try {
        updates.encrypted_secrets = Object.keys(body.secrets).length > 0
          ? encryptAgentToolSecrets(body.secrets)
          : null;
      } catch (error) {
        if (error instanceof AgentToolEncryptionUnavailableError) {
          throw publicError(HttpStatus.SERVICE_UNAVAILABLE, 'Agent tool credential encryption is not configured');
        }
        throw error;
      }
    }

    try {
      const updated = await updateAgentToolForUser(toolId, userId, updates);
      if (!updated) throw publicError(HttpStatus.NOT_FOUND, 'Agent tool not found');
      void this.audit({ userId, toolId, action: 'agent_tool.updated' });
      return updated;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Error && error.message === 'AGENT_TOOL_STILL_BOUND') {
        throw publicError(
          HttpStatus.CONFLICT,
          'Remove this tool from all current and published Agent versions before disabling it',
        );
      }
      if (error instanceof Error && error.message === 'AGENT_TOOL_BINDING_SCOPE') {
        throw publicError(
          HttpStatus.CONFLICT,
          'Remove this tool from Agents in other project spaces before moving it',
        );
      }
      if (isUniqueViolation(error)) {
        throw publicError(HttpStatus.CONFLICT, 'An Agent tool with this name already exists');
      }
      console.error('[AgentTools] Failed to update tool:', toSafeError(error, requestId));
      throw publicError(HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to update Agent tool');
    }
  }

  async delete(userId: string, toolId: string) {
    await this.get(userId, toolId);
    const deleted = await deleteAgentToolForUser(toolId, userId);
    if (!deleted) {
      throw publicError(
        HttpStatus.CONFLICT,
        'Remove this tool from all current and published Agent versions before deleting it',
      );
    }
    void this.audit({ userId, toolId, action: 'agent_tool.deleted' });
    return { success: true };
  }
}
