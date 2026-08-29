import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  AgentToolEncryptionUnavailableError,
  decryptAgentToolSecrets,
  encryptAgentToolSecrets,
  getActiveAgentToolSecretKeyId,
  inspectAgentToolSecretEnvelope,
} from '../../lib/agentToolSecrets';
import {
  AgentToolSecretKeyValidationError,
  validateAgentToolSecrets,
} from '../../lib/agentToolSecretKeys';
import { toSafeError } from '../../lib/safeError';
import { serverEnv } from '../../lib/env';
import {
  AgentToolDiagnosticCursorError,
  decodeAgentToolDiagnosticCursor,
  encodeAgentToolDiagnosticCursor,
} from '../../lib/agentToolDiagnosticCursor';
import {
  AgentToolKind,
  AgentToolRiskLevel,
  countEnabledAgentToolBindingsForUser,
  createAgentToolForUser,
  deleteAgentToolForUser,
  findAgentToolForUser,
  findAgentToolWithSecretsForUser,
  findAgentToolVersionForUser,
  listAgentToolsForUser,
  listAgentToolBindingScopesForUser,
  listAgentToolVersionsForUser,
  updateAgentToolForUser,
} from '../../repositories/agentTools';
import { findProjectSpaceForUser } from '../../repositories/projectSpaces';
import {
  validateAgentJsonObjectSchemaDefinition,
  validateAgentJsonSchemaDefinition,
} from './runtime/json-schema-input';
import { recordAgentAuditEvent } from '../../repositories/agentAudit';
import {
  listAgentToolDiagnosticHistory,
  recordAgentToolDiagnosticHistory,
} from '../../repositories/agentToolDiagnostics';
import {
  runAgentToolDiagnostic,
  type AgentToolDiagnosticOperation,
} from './runtime/agent-tool-diagnostics';
import {
  importOpenApiDocument,
  OpenApiToolImportError,
} from './runtime/openapi-tool-import';

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

export interface AgentToolDiagnosticBody {
  operation: AgentToolDiagnosticOperation;
  input?: Record<string, unknown>;
}

export interface AgentToolOpenApiImportBody {
  document: Record<string, unknown>;
  base_url?: string;
}

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
  // A write is retryable only when its owner explicitly confirms that the
  // endpoint de-duplicates requests carrying Idempotency-Key.
  idempotency_mode: z.enum(['none', 'header']).default('none'),
  timeout_ms: z.number().int().min(1000).max(60000).default(15000),
  input_schema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  static_headers: z.record(z.string(), z.string().max(4096)).default({}),
  response_path: z.string().trim().max(500).default(''),
  output_schema: z.record(z.string(), z.unknown()).optional(),
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
  if (configuration.method === 'GET' && configuration.idempotency_mode !== 'none') {
    context.addIssue({
      code: 'custom',
      path: ['idempotency_mode'],
      message: 'GET tools are already safe to retry and must not declare write idempotency',
    });
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
    ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'idempotency-key'].includes(header.toLowerCase())
    || header.toLowerCase().startsWith('proxy-')
  ));
  if (hopBypassHeaders.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['static_headers', hopBypassHeaders[0]],
      message: 'Transport-controlled and runtime idempotency headers are not allowed',
    });
  }
});

const mcpConfigurationSchema = z.object({
  endpoint: z.string().trim().url().max(2048),
  tool_name: z.string().trim().min(1).max(160),
  timeout_ms: z.number().int().min(1000).max(60000).default(20000),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
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

export const inspectStoredAgentToolSecretEnvelope = (payload: string) => {
  try {
    return inspectAgentToolSecretEnvelope(payload);
  } catch {
    // Historical rows can predate the current envelope contract or be
    // corrupted independently of this request. Keep that data-integrity
    // failure inside the stable management API boundary instead of exposing a
    // generic 500 (or parser details) before decryption is attempted.
    throw publicError(
      HttpStatus.CONFLICT,
      'Stored Agent tool credentials use an unsupported encrypted format',
    );
  }
};

const validateSecrets = (secrets?: Record<string, string>) => {
  if (!secrets) return;
  try {
    validateAgentToolSecrets(secrets);
  } catch (error) {
    if (error instanceof AgentToolSecretKeyValidationError) {
      throw publicError(HttpStatus.BAD_REQUEST, error.message);
    }
    throw error;
  }
};

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
const DIAGNOSTIC_OPERATIONS = new Set<AgentToolDiagnosticOperation>([
  'preflight',
  'safe_test',
  'discover',
]);

const readDiagnosticHistoryLimit = (value: unknown) => {
  if (value === undefined || value === null || value === '') return 20;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) {
    throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent tool diagnostic history limit');
  }
  const limit = Number(value);
  if (limit < 1 || limit > 100) {
    throw publicError(HttpStatus.BAD_REQUEST, 'Agent tool diagnostic history limit must be between 1 and 100');
  }
  return limit;
};

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
      if (result.data.output_schema) {
        validateAgentJsonSchemaDefinition(result.data.output_schema, { allowPattern: true });
      }
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

  async listDiagnostics(
    userId: string,
    toolId: string,
    query: Record<string, unknown>,
  ) {
    await this.get(userId, toolId);
    const operationValue = query.operation;
    if (
      operationValue !== undefined
      && (
        typeof operationValue !== 'string'
        || !DIAGNOSTIC_OPERATIONS.has(operationValue as AgentToolDiagnosticOperation)
      )
    ) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent tool diagnostic operation');
    }
    const toolVersionValue = query.toolVersionId ?? query.tool_version_id;
    if (
      toolVersionValue !== undefined
      && (typeof toolVersionValue !== 'string' || !UUID.test(toolVersionValue))
    ) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent tool version id');
    }
    let cursor;
    try {
      cursor = decodeAgentToolDiagnosticCursor(query.cursor);
    } catch (error) {
      if (error instanceof AgentToolDiagnosticCursorError) {
        throw publicError(HttpStatus.BAD_REQUEST, error.message);
      }
      throw error;
    }
    const page = await listAgentToolDiagnosticHistory({
      userId,
      toolId,
      operation: operationValue as AgentToolDiagnosticOperation | undefined,
      toolVersionId: toolVersionValue as string | undefined,
      cursor,
      limit: readDiagnosticHistoryLimit(query.limit),
    });
    const boundary = page.rows.at(-1);
    return {
      // Ownership is enforced in SQL but is not part of the browser contract.
      items: page.rows.map((row) => {
        const { user_id: userId, ...item } = row;
        void userId;
        return item;
      }),
      next_cursor: page.hasMore && boundary
        ? encodeAgentToolDiagnosticCursor({
          checkedAt: boundary.checked_at,
          id: boundary.id,
        })
        : null,
    };
  }

  importOpenApi(body: AgentToolOpenApiImportBody) {
    try {
      const imported = importOpenApiDocument({
        document: body.document,
        baseUrl: body.base_url,
      });
      // Keep the import preview and the create/update boundary in lockstep. An
      // operation presented as importable must survive the exact persisted
      // HTTP configuration validation, including credential-in-URL rules.
      for (const operation of imported.operations) {
        this.validateConfiguration('http', operation.configuration);
      }
      return imported;
    } catch (error) {
      if (error instanceof OpenApiToolImportError) {
        throw publicError(HttpStatus.BAD_REQUEST, error.message);
      }
      throw error;
    }
  }

  async versions(userId: string, toolId: string) {
    await this.get(userId, toolId);
    return listAgentToolVersionsForUser(toolId, userId);
  }

  async version(userId: string, toolId: string, versionId: string) {
    if (!UUID.test(toolId) || !UUID.test(versionId)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent tool version id');
    }
    const version = await findAgentToolVersionForUser(toolId, versionId, userId);
    if (!version) throw publicError(HttpStatus.NOT_FOUND, 'Agent tool version not found');
    return version;
  }

  async diffVersions(
    userId: string,
    toolId: string,
    versionId: string,
    againstVersionId: string | undefined,
  ) {
    if (!againstVersionId || !UUID.test(againstVersionId)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'againstVersionId is required');
    }
    const [target, base] = await Promise.all([
      this.version(userId, toolId, versionId),
      this.version(userId, toolId, againstVersionId),
    ]);
    const fields = [
      'description',
      'kind',
      'risk_level',
      'max_invocations_per_run',
      'configuration',
      'has_secrets',
      'secret_version',
    ] as const;
    const changes = fields.flatMap((field) => (
      isDeepStrictEqual(base[field], target[field])
        ? []
        : [{ field, before: base[field], after: target[field] }]
    ));
    return {
      from: { id: base.id, version: base.version, configuration_hash: base.configuration_hash },
      to: { id: target.id, version: target.version, configuration_hash: target.configuration_hash },
      changed_fields: changes.map((change) => change.field),
      changes,
    };
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
    validateSecrets(body.secrets);
    const toolId = randomUUID();
    let encryptedSecrets: string | null = null;
    let secretEnvelope: ReturnType<typeof inspectAgentToolSecretEnvelope> | undefined;
    if (body.secrets && Object.keys(body.secrets).length > 0) {
      try {
        encryptedSecrets = encryptAgentToolSecrets(body.secrets, {
          userId,
          toolId,
          secretVersion: 1,
        });
        secretEnvelope = inspectAgentToolSecretEnvelope(encryptedSecrets);
      } catch (error) {
        if (error instanceof AgentToolEncryptionUnavailableError) {
          throw publicError(HttpStatus.SERVICE_UNAVAILABLE, 'Agent tool credential encryption is not configured');
        }
        throw error;
      }
    }

    try {
      const created = await createAgentToolForUser({
        toolId,
        userId,
        projectSpaceId,
        name: body.name,
        description: body.description,
        kind: body.kind,
        riskLevel: effectiveRisk,
        maxInvocationsPerRun: normalizeMaxInvocationsPerRun(body.max_invocations_per_run),
        configuration,
        encryptedSecrets,
        secretEnvelope: secretEnvelope ? {
          envelopeVersion: secretEnvelope.envelopeVersion,
          encryptionKeyId: secretEnvelope.keyId,
        } : undefined,
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
    let secretEnvelope: ReturnType<typeof inspectAgentToolSecretEnvelope> | undefined;
    let secretEventType: 'replaced' | 'cleared' | undefined;
    if (body.clear_secrets === true) {
      if (!existing.has_secrets) {
        throw publicError(HttpStatus.CONFLICT, 'Agent tool has no stored credentials to clear');
      }
      updates.encrypted_secrets = null;
      secretEventType = 'cleared';
    }
    if (body.secrets !== undefined) {
      validateSecrets(body.secrets);
      try {
        updates.encrypted_secrets = Object.keys(body.secrets).length > 0
          ? encryptAgentToolSecrets(body.secrets, {
            userId,
            toolId,
            secretVersion: existing.secret_version + 1,
          })
          : null;
        secretEnvelope = updates.encrypted_secrets
          ? inspectAgentToolSecretEnvelope(updates.encrypted_secrets)
          : undefined;
        secretEventType = updates.encrypted_secrets ? 'replaced' : 'cleared';
      } catch (error) {
        if (error instanceof AgentToolEncryptionUnavailableError) {
          throw publicError(HttpStatus.SERVICE_UNAVAILABLE, 'Agent tool credential encryption is not configured');
        }
        throw error;
      }
    }

    try {
      const updated = await updateAgentToolForUser(toolId, userId, updates, {
        expectedCurrentVersionId: existing.current_version_id,
        secretEventType,
        secretEnvelope: secretEnvelope ? {
          envelopeVersion: secretEnvelope.envelopeVersion,
          encryptionKeyId: secretEnvelope.keyId,
        } : undefined,
      });
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
      if (error instanceof Error && error.message === 'AGENT_TOOL_VERSION_CHANGED') {
        throw publicError(HttpStatus.CONFLICT, 'Agent tool changed concurrently; reload and retry');
      }
      if (isUniqueViolation(error)) {
        throw publicError(HttpStatus.CONFLICT, 'An Agent tool with this name already exists');
      }
      console.error('[AgentTools] Failed to update tool:', toSafeError(error, requestId));
      throw publicError(HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to update Agent tool');
    }
  }

  async rotateSecrets(userId: string, toolId: string, requestId?: string) {
    if (!UUID.test(toolId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent tool id');
    const existing = await findAgentToolWithSecretsForUser(toolId, userId);
    if (!existing) throw publicError(HttpStatus.NOT_FOUND, 'Agent tool not found');
    if (!existing.encrypted_secrets) {
      throw publicError(HttpStatus.CONFLICT, 'Agent tool has no stored credentials to rotate');
    }
    const currentEnvelope = inspectStoredAgentToolSecretEnvelope(existing.encrypted_secrets);
    const activeKeyId = getActiveAgentToolSecretKeyId();
    if (currentEnvelope.envelopeVersion === 2 && currentEnvelope.keyId === activeKeyId) {
      throw publicError(HttpStatus.CONFLICT, 'Agent tool credentials already use the active encryption key');
    }

    let plaintext: Record<string, string>;
    let encryptedSecrets: string;
    try {
      plaintext = decryptAgentToolSecrets(existing.encrypted_secrets, {
        userId,
        toolId,
        secretVersion: existing.secret_version,
      });
      encryptedSecrets = encryptAgentToolSecrets(plaintext, {
        userId,
        toolId,
        secretVersion: existing.secret_version + 1,
      });
    } catch (error) {
      if (error instanceof AgentToolEncryptionUnavailableError) {
        throw publicError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'The key required to rotate Agent tool credentials is not configured',
        );
      }
      console.error('[AgentTools] Failed to rotate tool credentials:', toSafeError(error, requestId));
      throw publicError(HttpStatus.CONFLICT, 'Stored Agent tool credentials could not be decrypted');
    }
    const nextEnvelope = inspectAgentToolSecretEnvelope(encryptedSecrets);
    try {
      const updated = await updateAgentToolForUser(
        toolId,
        userId,
        { encrypted_secrets: encryptedSecrets },
        {
          expectedCurrentVersionId: existing.current_version_id,
          secretEventType: 'rewrapped',
          secretEnvelope: {
            envelopeVersion: nextEnvelope.envelopeVersion,
            encryptionKeyId: nextEnvelope.keyId,
          },
        },
      );
      if (!updated) throw publicError(HttpStatus.NOT_FOUND, 'Agent tool not found');
      void this.audit({
        userId,
        toolId,
        action: 'agent_tool.secrets_rewrapped',
        metadata: {
          secret_version: updated.secret_version,
          envelope_version: nextEnvelope.envelopeVersion,
        },
      });
      return updated;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Error && error.message === 'AGENT_TOOL_VERSION_CHANGED') {
        throw publicError(HttpStatus.CONFLICT, 'Agent tool changed concurrently; reload and retry');
      }
      console.error('[AgentTools] Failed to persist rotated credentials:', toSafeError(error, requestId));
      throw publicError(HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to rotate Agent tool credentials');
    }
  }

  async diagnose(
    userId: string,
    toolId: string,
    body: AgentToolDiagnosticBody,
  ) {
    if (!UUID.test(toolId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent tool id');
    const tool = await findAgentToolWithSecretsForUser(toolId, userId);
    if (!tool) throw publicError(HttpStatus.NOT_FOUND, 'Agent tool not found');
    const result = await runAgentToolDiagnostic({
      tool,
      operation: body.operation,
      arguments: body.input,
      recordDiagnosticEvent: async (event) => {
        await recordAgentAuditEvent({
          userId,
          toolId,
          action: `agent_tool.diagnostic_${event.phase}`,
          metadata: {
            operation: event.operation,
            tool_version_id: tool.tool_version_id,
            configuration_hash: tool.configuration_hash,
            input_hash: event.inputHash,
            live_request_attempted: event.liveRequestAttempted,
            ...(event.status ? { status: event.status } : {}),
            ...(event.errorCode ? { error_code: event.errorCode } : {}),
            ...(event.durationMs !== undefined ? { duration_ms: event.durationMs } : {}),
          },
        });
      },
    });
    const countChecks = (status: 'passed' | 'warning' | 'failed') => (
      result.checks.filter((entry) => entry.status === status).length
    );
    try {
      await recordAgentToolDiagnosticHistory({
        userId,
        toolId,
        toolVersionId: result.tool_version_id,
        configurationHash: result.configuration_hash,
        operation: result.operation,
        status: result.status,
        liveRequestAttempted: result.live_request_attempted,
        passedCheckCount: countChecks('passed'),
        warningCheckCount: countChecks('warning'),
        failedCheckCount: countChecks('failed'),
        errorCode: result.error?.code,
        responseStatus: result.response?.status,
        discoveryToolCount: result.discovery?.tools.length,
        discoveryWarningCount: result.discovery?.warnings.length,
        durationMs: result.duration_ms,
        checkedAt: result.checked_at,
      });
    } catch (error) {
      console.error('[AgentTools] Failed to persist diagnostic history:', toSafeError(error));
      throw publicError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Agent tool diagnostic completed, but its health history could not be saved',
      );
    }
    if (body.operation === 'preflight') {
      void this.audit({
        userId,
        toolId,
        action: 'agent_tool.diagnostic_completed',
        metadata: {
          operation: body.operation,
          tool_version_id: tool.tool_version_id,
          configuration_hash: tool.configuration_hash,
          live_request_attempted: false,
          status: result.status,
          ...(result.error?.code ? { error_code: result.error.code } : {}),
          duration_ms: result.duration_ms,
        },
      });
    }
    return result;
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
