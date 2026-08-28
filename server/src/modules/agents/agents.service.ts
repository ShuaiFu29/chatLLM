import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  createChatClientForModel,
  getChatModelCapabilities,
  getDefaultChatModel,
  isSupportedChatModelName,
} from '../../lib/llmProviders';
import { serverEnv } from '../../lib/env';
import { toSafeError } from '../../lib/safeError';
import { findAgentToolsForUserByIds } from '../../repositories/agentTools';
import { cancelActiveAgentRunsForAgentForUser } from '../../repositories/agentRuns';
import { recordAgentAuditEvent } from '../../repositories/agentAudit';
import {
  AgentApprovalPolicy,
  AgentMemoryMode,
  AgentResponseFormat,
  AgentToolBinding,
  AgentVersionConfiguration,
  AgentVersionUpdates,
  AgentVisibility,
  createAgentForUser,
  deleteAgentForUser,
  findAgentForUser,
  findPublishedAgentForUser,
  listAgentsForUser,
  listAgentVersionsForUser,
  publishAgentForUser,
  setAgentDisabledForUser,
  updateAgentForUser,
} from '../../repositories/agents';
import { findProjectSpaceForUser } from '../../repositories/projectSpaces';
import { builtinAgentToolKeys, builtinAgentTools } from './builtin-agent-tools';
import { validateAgentJsonObjectSchemaDefinition } from './runtime/json-schema-input';
import { isAgentToolInProjectScope } from './runtime/tool-scope';
import { abortAgentRunsForAgentInProcess } from './agent-run-control';

export interface AgentCreateBody {
  name: string;
  description?: string;
  avatar?: string;
  visibility?: AgentVisibility;
  project_space_id?: string | null;
  projectSpaceId?: string | null;
  instructions: string;
  model?: string;
  temperature?: number;
  max_iterations?: number;
  max_duration_ms?: number;
  max_output_tokens?: number;
  memory_mode?: AgentMemoryMode;
  response_format?: AgentResponseFormat;
  output_schema?: Record<string, unknown>;
  approval_policy?: AgentApprovalPolicy;
  tool_bindings?: AgentToolBinding[];
  welcome_message?: string;
  suggested_prompts?: string[];
}

export type AgentUpdateBody = Partial<AgentCreateBody>;

const CUSTOM_TOOL_KEY = /^custom:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

const readIncludeDisabled = (value: unknown) => value === 'true' || value === '1';

const validateModelOutputBudget = (model: string, maxOutputTokens: number) => {
  const capabilities = getChatModelCapabilities(model);
  const minimumPromptReserve = 256;
  if (maxOutputTokens > capabilities.context_window_tokens - minimumPromptReserve) {
    throw new Error(
      `max_output_tokens must be at most ${capabilities.context_window_tokens - minimumPromptReserve} for model ${model}`,
    );
  }
  return capabilities;
};

@Injectable()
export class AgentsService {
  private audit(input: Parameters<typeof recordAgentAuditEvent>[0]) {
    return recordAgentAuditEvent(input).catch((error) => {
      console.warn('[Agents] Failed to write audit event:', toSafeError(error));
    });
  }
  private async assertProjectSpace(userId: string, projectSpaceId?: string | null) {
    if (!projectSpaceId) return null;
    const projectSpace = await findProjectSpaceForUser(projectSpaceId, userId);
    if (!projectSpace) throw publicError(HttpStatus.NOT_FOUND, 'Project space not found');
    return projectSpace.id;
  }

  private async validateToolBindings(
    userId: string,
    bindings: AgentToolBinding[],
    agentProjectSpaceId?: string | null,
  ) {
    const unknownBuiltinKeys = bindings
      .filter((binding) => !builtinAgentToolKeys.has(binding.key) && !CUSTOM_TOOL_KEY.test(binding.key))
      .map((binding) => binding.key);
    if (unknownBuiltinKeys.length > 0) {
      throw publicError(HttpStatus.BAD_REQUEST, `Unknown agent tool: ${unknownBuiltinKeys[0]}`);
    }

    const missingProject = bindings.find((binding) => {
      if (binding.enabled === false) return false;
      const builtin = builtinAgentTools.find((tool) => tool.key === binding.key);
      return Boolean(builtin?.requires_project && !agentProjectSpaceId);
    });
    if (missingProject) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        `Agent tool "${missingProject.key}" requires a project space`,
      );
    }

    const customIds = bindings.filter((binding) => binding.enabled !== false).flatMap((binding) => {
      const match = CUSTOM_TOOL_KEY.exec(binding.key);
      return match ? [match[1]] : [];
    });
    const customTools = await findAgentToolsForUserByIds(customIds, userId);
    if (customTools.length !== new Set(customIds).size) {
      throw publicError(HttpStatus.BAD_REQUEST, 'One or more custom tools are unavailable');
    }
    const disabledTool = customTools.find((tool) => !tool.enabled);
    if (disabledTool) {
      throw publicError(HttpStatus.CONFLICT, `Custom tool "${disabledTool.name}" is disabled`);
    }
    const outOfScope = customTools.find((tool) => (
      !isAgentToolInProjectScope(tool.project_space_id, agentProjectSpaceId)
    ));
    if (outOfScope) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        `Custom tool "${outOfScope.name}" belongs to a different project space`,
      );
    }
  }

  private configurationFromBody(body: AgentCreateBody): AgentVersionConfiguration {
    const configuration = {
      instructions: body.instructions,
      model: body.model || getDefaultChatModel(),
      temperature: body.temperature ?? 0.7,
      max_iterations: body.max_iterations ?? 6,
      max_duration_ms: body.max_duration_ms ?? 120000,
      max_output_tokens: body.max_output_tokens ?? 4096,
      memory_mode: body.memory_mode ?? 'conversation',
      response_format: body.response_format ?? 'markdown',
      output_schema: body.output_schema || {},
      approval_policy: body.approval_policy ?? 'writes',
      tool_bindings: body.tool_bindings || [],
      welcome_message: body.welcome_message || '',
      suggested_prompts: body.suggested_prompts || [],
    };
    try {
      if (!isSupportedChatModelName(configuration.model)) {
        throw new Error(`Unsupported chat model: ${configuration.model}`);
      }
      validateModelOutputBudget(configuration.model, configuration.max_output_tokens);
      validateAgentJsonObjectSchemaDefinition(configuration.output_schema);
    } catch (error) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        error instanceof Error ? error.message : 'Invalid Agent configuration',
      );
    }
    return configuration;
  }

  async list(userId: string, query: Record<string, unknown>) {
    const rawProjectSpaceId = query.projectSpaceId ?? query.project_space_id;
    const projectSpaceId = typeof rawProjectSpaceId === 'string' && rawProjectSpaceId.trim()
      ? rawProjectSpaceId.trim()
      : undefined;
    if (projectSpaceId && !UUID.test(projectSpaceId)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid project space id');
    }
    return listAgentsForUser(userId, {
      projectSpaceId,
      includeDisabled: readIncludeDisabled(query.includeDisabled ?? query.include_disabled),
    });
  }

  async get(userId: string, agentId: string) {
    if (!UUID.test(agentId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid agent id');
    const agent = await findAgentForUser(agentId, userId);
    if (!agent) throw publicError(HttpStatus.NOT_FOUND, 'Agent not found');
    return agent;
  }

  async getRunnable(userId: string, agentId: string, projectSpaceId?: string | null) {
    if (!UUID.test(agentId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid agent id');
    const agent = await findPublishedAgentForUser(agentId, userId);
    if (!agent) throw publicError(HttpStatus.NOT_FOUND, 'Published Agent not found');
    if (!isSupportedChatModelName(agent.model)) {
      throw publicError(HttpStatus.BAD_REQUEST, `Unsupported chat model: ${agent.model}`);
    }
    try {
      validateModelOutputBudget(agent.model, agent.max_output_tokens);
    } catch (error) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        error instanceof Error ? error.message : 'Invalid Agent output budget',
      );
    }
    if (agent.project_space_id && agent.project_space_id !== projectSpaceId) {
      throw publicError(HttpStatus.FORBIDDEN, 'Agent is not available in this project space');
    }
    return agent;
  }

  async create(userId: string, body: AgentCreateBody, requestId?: string) {
    const projectSpaceId = readProjectSpaceId(body);
    await this.assertProjectSpace(userId, projectSpaceId);
    if (body.visibility === 'project' && !projectSpaceId) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Project agents require a project space');
    }
    const configuration = this.configurationFromBody(body);
    await this.validateToolBindings(userId, configuration.tool_bindings, projectSpaceId);

    try {
      const created = await createAgentForUser({
        userId,
        projectSpaceId,
        name: body.name,
        description: body.description,
        avatar: body.avatar,
        visibility: body.visibility,
        maxAgentsPerUser: serverEnv.AGENT_MAX_AGENTS_PER_USER,
        ...configuration,
      });
      void this.audit({ userId, agentId: created.id, action: 'agent.created' });
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw publicError(HttpStatus.CONFLICT, 'An agent with this name already exists');
      }
      if (error instanceof Error && error.message === 'AGENT_QUOTA_EXCEEDED') {
        throw publicError(HttpStatus.TOO_MANY_REQUESTS, 'Agent quota exceeded');
      }
      console.error('[Agents] Failed to create agent:', toSafeError(error, requestId));
      throw publicError(HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to create agent');
    }
  }

  async update(userId: string, agentId: string, body: AgentUpdateBody, requestId?: string) {
    const current = await this.get(userId, agentId);
    const metadata: Parameters<typeof updateAgentForUser>[0]['metadata'] = {};
    const version: AgentVersionUpdates = {};

    if (body.name !== undefined) metadata.name = body.name;
    if (body.description !== undefined) metadata.description = body.description;
    if (body.avatar !== undefined) metadata.avatar = body.avatar;
    if (body.visibility !== undefined) metadata.visibility = body.visibility;
    if (body.project_space_id !== undefined || body.projectSpaceId !== undefined) {
      const projectSpaceId = readProjectSpaceId(body) ?? null;
      await this.assertProjectSpace(userId, projectSpaceId);
      metadata.project_space_id = projectSpaceId;
    }
    const effectiveProjectSpaceId = metadata.project_space_id !== undefined
      ? metadata.project_space_id
      : current.project_space_id;
    const effectiveVisibility = metadata.visibility ?? current.visibility;
    if (effectiveVisibility === 'project' && !effectiveProjectSpaceId) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Project agents require a project space');
    }

    const versionKeys: Array<keyof AgentVersionConfiguration> = [
      'instructions',
      'model',
      'temperature',
      'max_iterations',
      'max_duration_ms',
      'max_output_tokens',
      'memory_mode',
      'response_format',
      'output_schema',
      'approval_policy',
      'tool_bindings',
      'welcome_message',
      'suggested_prompts',
    ];
    for (const key of versionKeys) {
      const value = body[key];
      if (value !== undefined) {
        (version as Record<string, unknown>)[key] = value;
      }
    }
    const effectiveToolBindings = version.tool_bindings ?? current.tool_bindings;
    const effectiveOutputSchema = version.output_schema ?? current.output_schema;
    try {
      if (!isSupportedChatModelName(version.model ?? current.model)) {
        throw new Error(`Unsupported chat model: ${version.model ?? current.model}`);
      }
      validateModelOutputBudget(
        version.model ?? current.model,
        version.max_output_tokens ?? current.max_output_tokens,
      );
      validateAgentJsonObjectSchemaDefinition(effectiveOutputSchema);
    } catch (error) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        error instanceof Error ? error.message : 'Invalid Agent configuration',
      );
    }
    await this.validateToolBindings(userId, effectiveToolBindings, effectiveProjectSpaceId);

    try {
      const agent = await updateAgentForUser({
        agentId,
        userId,
        metadata,
        version,
        maxVersionsPerAgent: serverEnv.AGENT_MAX_VERSIONS_PER_AGENT,
      });
      if (!agent) throw publicError(HttpStatus.NOT_FOUND, 'Agent not found');
      void this.audit({ userId, agentId, action: 'agent.updated', metadata: { version: agent.version } });
      return agent;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Error && error.message === 'AGENT_TOOL_BINDING_UNAVAILABLE') {
        throw publicError(HttpStatus.CONFLICT, 'One or more custom tools are unavailable');
      }
      if (error instanceof Error && error.message === 'AGENT_TOOL_BINDING_SCOPE') {
        throw publicError(HttpStatus.CONFLICT, 'One or more custom tools belong to a different project space');
      }
      if (error instanceof Error && error.message === 'AGENT_VERSION_QUOTA_EXCEEDED') {
        throw publicError(HttpStatus.TOO_MANY_REQUESTS, 'Agent version quota exceeded');
      }
      if (isUniqueViolation(error)) {
        throw publicError(HttpStatus.CONFLICT, 'An agent with this name already exists');
      }
      console.error('[Agents] Failed to update agent:', toSafeError(error, requestId));
      throw publicError(HttpStatus.INTERNAL_SERVER_ERROR, 'Failed to update agent');
    }
  }

  async publish(userId: string, agentId: string) {
    const current = await this.get(userId, agentId);
    try {
      if (!isSupportedChatModelName(current.model)) {
        throw new Error(`Unsupported chat model: ${current.model}`);
      }
      validateModelOutputBudget(current.model, current.max_output_tokens);
      createChatClientForModel(current.model);
      await this.validateToolBindings(userId, current.tool_bindings, current.project_space_id);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(
        error instanceof Error && /provider/i.test(error.message)
          ? HttpStatus.SERVICE_UNAVAILABLE
          : HttpStatus.BAD_REQUEST,
        error instanceof Error ? error.message : 'Agent cannot be published',
      );
    }
    let agent: Awaited<ReturnType<typeof publishAgentForUser>>;
    try {
      agent = await publishAgentForUser(agentId, userId);
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_DISABLED') {
        throw publicError(HttpStatus.CONFLICT, 'Enable the agent before publishing it');
      }
      throw error;
    }
    if (!agent) throw publicError(HttpStatus.NOT_FOUND, 'Agent not found');
    void this.audit({ userId, agentId, action: 'agent.published', metadata: { version: agent.published_version } });
    return agent;
  }

  async setDisabled(userId: string, agentId: string, disabled: boolean) {
    if (disabled) {
      abortAgentRunsForAgentInProcess(
        agentId,
        userId,
        'Agent was disabled while a run was active',
      );
      await cancelActiveAgentRunsForAgentForUser(
        agentId,
        userId,
        'Agent was disabled while a run was active',
      );
    }
    const agent = await setAgentDisabledForUser(agentId, userId, disabled);
    if (!agent) throw publicError(HttpStatus.NOT_FOUND, 'Agent not found');
    void this.audit({ userId, agentId, action: disabled ? 'agent.disabled' : 'agent.enabled' });
    return agent;
  }

  async duplicate(userId: string, agentId: string, name?: string, requestId?: string) {
    const source = await this.get(userId, agentId);
    return this.create(userId, {
      name: name || `${source.name} copy`,
      description: source.description,
      avatar: source.avatar,
      visibility: source.visibility,
      project_space_id: source.project_space_id,
      instructions: source.instructions,
      model: source.model,
      temperature: source.temperature,
      max_iterations: source.max_iterations,
      max_duration_ms: source.max_duration_ms,
      max_output_tokens: source.max_output_tokens,
      memory_mode: source.memory_mode,
      response_format: source.response_format,
      output_schema: source.output_schema,
      approval_policy: source.approval_policy,
      tool_bindings: source.tool_bindings,
      welcome_message: source.welcome_message,
      suggested_prompts: source.suggested_prompts,
    }, requestId);
  }

  async versions(userId: string, agentId: string) {
    await this.get(userId, agentId);
    return listAgentVersionsForUser(agentId, userId);
  }

  async delete(userId: string, agentId: string) {
    abortAgentRunsForAgentInProcess(
      agentId,
      userId,
      'Agent was deleted while a run was active',
    );
    await cancelActiveAgentRunsForAgentForUser(
      agentId,
      userId,
      'Agent was deleted while a run was active',
    );
    const deleted = await deleteAgentForUser(agentId, userId);
    if (!deleted) throw publicError(HttpStatus.NOT_FOUND, 'Agent not found');
    void this.audit({ userId, agentId, action: 'agent.deleted' });
    return { success: true };
  }

  toolCatalog() {
    return builtinAgentTools;
  }
}
