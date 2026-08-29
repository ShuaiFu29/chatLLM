import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  createChatClientForModel,
  getChatModelCapabilities,
  getDefaultChatModel,
  isSupportedChatModelName,
} from '../../lib/llmProviders';
import { serverEnv } from '../../lib/env';
import { agentToolSecretEncryptionConfigured } from '../../lib/agentToolSecrets';
import { toSafeError } from '../../lib/safeError';
import {
  findAgentToolsForUserByIds,
  findAgentToolVersionsForUserByIds,
} from '../../repositories/agentTools';
import { recordAgentAuditEvent } from '../../repositories/agentAudit';
import {
  AgentApprovalPolicy,
  AgentMemoryMode,
  AgentPublicationValidationCheck,
  AgentPublicationValidationReport,
  AgentResponseFormat,
  AgentToolBinding,
  AgentVersionConfiguration,
  AgentDetailRow,
  AgentVersionUpdates,
  AgentVisibility,
  agentVersionConfigurationKeys,
  createAgentForUser,
  deleteAgentForUser,
  findAgentForUser,
  findAgentVersionForUser,
  findPublishedAgentForUser,
  listAgentsForUser,
  listAgentVersionsForUser,
  publishAgentForUser,
  rollbackAgentVersionForUser,
  setAgentDisabledForUser,
  updateAgentForUser,
} from '../../repositories/agents';
import { findProjectSpaceForUser } from '../../repositories/projectSpaces';
import { builtinAgentToolKeys, builtinAgentTools } from './builtin-agent-tools';
import { validateAgentJsonObjectSchemaDefinition } from './runtime/json-schema-input';
import { isAgentToolInProjectScope } from './runtime/tool-scope';
import { endpointHostAllowed } from './runtime/remote-endpoint';
import { abortAgentRunsForAgentInProcess } from './agent-run-control';
import { buildAgentVersionDiff } from './agent-version-governance';
import {
  memoryModeFromPolicy,
  memoryPolicyFromLegacyMode,
  parseAgentMemoryPolicy,
  type AgentMemoryPolicy,
} from '../../lib/agentMemoryPolicy';
import {
  parseAgentDelegationBindings,
  type AgentDelegationBinding,
} from '../../lib/agentDelegation';

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
  memory_policy?: AgentMemoryPolicy;
  response_format?: AgentResponseFormat;
  output_schema?: Record<string, unknown>;
  approval_policy?: AgentApprovalPolicy;
  tool_bindings?: AgentToolBinding[];
  delegation_bindings?: AgentDelegationBinding[];
  welcome_message?: string;
  suggested_prompts?: string[];
}

export type AgentUpdateBody = Partial<AgentCreateBody>;

export interface AgentPublishBody {
  release_notes?: string;
  releaseNotes?: string;
}

const CUSTOM_TOOL_KEY = /^custom:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const publicError = (statusCode: number, error: string) => (
  new HttpException({ error }, statusCode)
);

const isUniqueViolation = (error: unknown) => (
  Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23505')
);

const delegationTransactionErrorMessage = (error: unknown) => {
  if (!(error instanceof Error)) return null;
  const messages: Record<string, string> = {
    AGENT_DELEGATION_BINDING_INVALID: 'The collaborator directory is invalid',
    AGENT_DELEGATION_BINDING_UNAVAILABLE: 'A pinned collaborator is no longer available',
    AGENT_DELEGATION_BINDING_SCOPE: 'A collaborator belongs to an incompatible project space',
    AGENT_DELEGATION_CYCLE: 'The collaborator graph contains a cycle',
    AGENT_DELEGATION_DEPTH_EXCEEDED: 'The collaborator graph exceeds the deployment depth limit',
    AGENT_DELEGATION_GRAPH_TOO_LARGE: 'The collaborator graph is too large',
    AGENT_DELEGATION_LEGACY_DEPENDENCY: 'A collaborator still uses legacy dynamic delegation',
  };
  return messages[error.message] || null;
};

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

const validationErrorMessage = (error: unknown) => {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object') {
      const message = (response as { error?: unknown; message?: unknown }).error
        ?? (response as { message?: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.map(String).join('; ');
    }
  }
  return error instanceof Error ? error.message : 'Validation failed';
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
    pinMissingVersions = false,
  ): Promise<AgentToolBinding[]> {
    const unknownBuiltinKeys = bindings
      .filter((binding) => !builtinAgentToolKeys.has(binding.key) && !CUSTOM_TOOL_KEY.test(binding.key))
      .map((binding) => binding.key);
    if (unknownBuiltinKeys.length > 0) {
      throw publicError(HttpStatus.BAD_REQUEST, `Unknown agent tool: ${unknownBuiltinKeys[0]}`);
    }
    const versionedBuiltin = bindings.find((binding) => (
      builtinAgentToolKeys.has(binding.key) && binding.tool_version_id !== undefined
    ));
    if (versionedBuiltin) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        `Built-in tool "${versionedBuiltin.key}" cannot reference a custom tool version`,
      );
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

    const customBindings = bindings.flatMap((binding) => {
      const match = CUSTOM_TOOL_KEY.exec(binding.key);
      return match ? [{ binding, toolId: match[1] }] : [];
    });
    const customIds = customBindings.map((item) => item.toolId);
    const customTools = await findAgentToolsForUserByIds(customIds, userId);
    if (customTools.length !== new Set(customIds).size) {
      throw publicError(HttpStatus.BAD_REQUEST, 'One or more custom tools are unavailable');
    }
    const toolById = new Map(customTools.map((tool) => [tool.id, tool]));
    const requestedVersionIds = customBindings.flatMap(({ binding }) => (
      binding.tool_version_id ? [binding.tool_version_id] : []
    ));
    const requestedVersions = await findAgentToolVersionsForUserByIds(requestedVersionIds, userId);
    const versionById = new Map(requestedVersions.map((version) => [version.tool_version_id, version]));
    const invalidVersion = customBindings.find(({ binding, toolId }) => {
      if (!binding.tool_version_id) return !pinMissingVersions;
      return versionById.get(binding.tool_version_id)?.id !== toolId;
    });
    if (invalidVersion) {
      throw publicError(
        HttpStatus.CONFLICT,
        `Custom tool "${invalidVersion.binding.key}" has an unavailable version`,
      );
    }
    const disabledTool = customBindings
      .filter(({ binding }) => binding.enabled !== false)
      .map(({ toolId }) => toolById.get(toolId))
      .find((tool) => tool && !tool.enabled);
    if (disabledTool) {
      throw publicError(HttpStatus.CONFLICT, `Custom tool "${disabledTool.name}" is disabled`);
    }
    const outOfScope = customBindings
      .filter(({ binding }) => binding.enabled !== false)
      .map(({ toolId }) => toolById.get(toolId))
      .find((tool) => tool && !isAgentToolInProjectScope(
        tool.project_space_id,
        agentProjectSpaceId,
      ));
    if (outOfScope) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        `Custom tool "${outOfScope.name}" belongs to a different project space`,
      );
    }
    return bindings.map((binding) => {
      const match = CUSTOM_TOOL_KEY.exec(binding.key);
      if (!match) return { ...binding };
      const tool = toolById.get(match[1]);
      return {
        ...binding,
        tool_version_id: binding.tool_version_id || tool?.current_version_id,
      };
    });
  }

  private async validateToolDeploymentRequirements(
    userId: string,
    bindings: AgentToolBinding[],
  ) {
    const customBindings = bindings
      .filter((binding) => binding.enabled !== false)
      .flatMap((binding) => {
        const match = CUSTOM_TOOL_KEY.exec(binding.key);
        return match ? [{ binding, toolId: match[1] }] : [];
      });
    if (customBindings.some(({ binding }) => !binding.tool_version_id)) {
      throw new Error('Every custom tool binding must pin tool_version_id');
    }
    const versionIds = customBindings.map(({ binding }) => binding.tool_version_id!);
    const versions = await findAgentToolVersionsForUserByIds(versionIds, userId);
    const byVersion = new Map(versions.map((tool) => [tool.tool_version_id, tool]));
    for (const { binding, toolId } of customBindings) {
      const tool = byVersion.get(binding.tool_version_id!);
      if (!tool || tool.id !== toolId) throw new Error('A pinned custom tool version is unavailable');
      const endpointValue = tool.configuration.endpoint;
      if (typeof endpointValue !== 'string') throw new Error(`Tool "${tool.name}" has no endpoint`);
      const endpoint = new URL(endpointValue);
      const port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80');
      const rules = tool.kind === 'http'
        ? serverEnv.AGENT_HTTP_ALLOWED_HOSTS
        : serverEnv.AGENT_MCP_ALLOWED_HOSTS;
      if (!endpointHostAllowed(endpoint.hostname, port, rules)) {
        throw new Error(`Tool "${tool.name}" endpoint is not in the deployment allowlist`);
      }
      if (tool.has_secrets && !agentToolSecretEncryptionConfigured()) {
        throw new Error(`Tool "${tool.name}" has credentials but encryption is not configured`);
      }
      const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname);
      if (tool.has_secrets && endpoint.protocol !== 'https:' && !loopback) {
        throw new Error(`Tool "${tool.name}" credentials require an HTTPS endpoint`);
      }
    }
  }

  private async validateDelegationBindings(
    userId: string,
    sourceAgentId: string | null,
    bindingsValue: AgentDelegationBinding[],
    agentProjectSpaceId: string | null | undefined,
    toolBindings: AgentToolBinding[],
  ) {
    let bindings: AgentDelegationBinding[];
    try {
      bindings = parseAgentDelegationBindings(bindingsValue);
    } catch (error) {
      throw publicError(HttpStatus.BAD_REQUEST, validationErrorMessage(error));
    }
    const dispatchEnabled = toolBindings.some((binding) => (
      binding.key === 'dispatch_subagents' && binding.enabled !== false
    ));
    if (bindings.length > 0 && !dispatchEnabled) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        'Delegation bindings require the dispatch_subagents tool',
      );
    }
    if (dispatchEnabled && bindings.length === 0) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        'dispatch_subagents requires at least one explicit collaborator',
      );
    }
    const tooWide = bindings.find((binding) => (
      binding.max_parallelism > serverEnv.AGENT_MAX_SUBAGENT_FANOUT
    ));
    if (tooWide) {
      throw publicError(
        HttpStatus.BAD_REQUEST,
        `Collaborator "${tooWide.alias}" exceeds the deployment fan-out limit`,
      );
    }
    if (sourceAgentId && bindings.some((binding) => binding.agent_id === sourceAgentId)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'An Agent cannot delegate to itself');
    }

    const versionCache = new Map<string, Awaited<ReturnType<typeof findAgentVersionForUser>>>();
    const agentCache = new Map<string, Awaited<ReturnType<typeof findAgentForUser>>>();
    const loadTarget = async (agentId: string, versionId: string) => {
      const cacheKey = `${agentId}:${versionId}`;
      if (!versionCache.has(cacheKey)) {
        const [version, agent] = await Promise.all([
          findAgentVersionForUser(agentId, versionId, userId),
          agentCache.has(agentId)
            ? Promise.resolve(agentCache.get(agentId)!)
            : findAgentForUser(agentId, userId),
        ]);
        versionCache.set(cacheKey, version);
        agentCache.set(agentId, agent);
      }
      return {
        version: versionCache.get(cacheKey) || null,
        agent: agentCache.get(agentId) || null,
      };
    };

    let inspectedBindingCount = 0;
    const validateNode = async (
      binding: AgentDelegationBinding,
      ancestorAgentIds: Set<string>,
      depth: number,
    ): Promise<void> => {
      if (depth > serverEnv.AGENT_MAX_SUBAGENT_DEPTH) {
        throw new Error(`Delegation depth exceeds ${serverEnv.AGENT_MAX_SUBAGENT_DEPTH}`);
      }
      inspectedBindingCount += 1;
      if (inspectedBindingCount > 5000) throw new Error('Delegation graph is too large');
      const { version, agent } = await loadTarget(binding.agent_id, binding.agent_version_id);
      if (!version || !agent || agent.status !== 'published') {
        throw new Error(`Collaborator "${binding.alias}" is unavailable`);
      }
      if (
        !version.publication_id
        || version.validation_report?.valid !== true
      ) throw new Error(`Collaborator "${binding.alias}" version was not validly published`);
      if (agent.project_space_id && agent.project_space_id !== agentProjectSpaceId) {
        throw new Error(`Collaborator "${binding.alias}" belongs to a different project space`);
      }
      if (version.delegation_mode !== 'explicit') {
        throw new Error(`Collaborator "${binding.alias}" still uses legacy dynamic delegation`);
      }
      if (ancestorAgentIds.has(binding.agent_id)) {
        throw new Error(`Delegation cycle detected at collaborator "${binding.alias}"`);
      }
      const nextAncestors = new Set(ancestorAgentIds);
      nextAncestors.add(binding.agent_id);
      for (const nested of version.delegation_bindings) {
        await validateNode(nested, nextAncestors, depth + 1);
      }
    };

    try {
      const rootAncestors = new Set(sourceAgentId ? [sourceAgentId] : []);
      for (const binding of bindings) await validateNode(binding, rootAncestors, 1);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(HttpStatus.BAD_REQUEST, validationErrorMessage(error));
    }
    return bindings;
  }

  private async buildPublicationValidationReport(
    userId: string,
    configuration: AgentVersionConfiguration & { project_space_id?: string | null },
  ): Promise<AgentPublicationValidationReport> {
    const checks: AgentPublicationValidationCheck[] = [];
    let modelCapabilityPassed = false;

    try {
      if (!isSupportedChatModelName(configuration.model)) {
        throw new Error(`Unsupported chat model: ${configuration.model}`);
      }
      validateModelOutputBudget(configuration.model, configuration.max_output_tokens);
      modelCapabilityPassed = true;
      checks.push({
        key: 'model_capability',
        status: 'passed',
        message: 'Model and output-token limits are supported',
      });
    } catch (error) {
      checks.push({
        key: 'model_capability',
        status: 'failed',
        message: validationErrorMessage(error),
      });
    }

    if (modelCapabilityPassed) {
      try {
        createChatClientForModel(configuration.model);
        checks.push({
          key: 'provider_configuration',
          status: 'passed',
          message: 'The selected model provider is configured',
        });
      } catch (error) {
        checks.push({
          key: 'provider_configuration',
          status: 'failed',
          message: validationErrorMessage(error),
        });
      }
    } else {
      checks.push({
        key: 'provider_configuration',
        status: 'not_applicable',
        message: 'Provider configuration is not checked until model capability passes',
      });
    }

    try {
      validateAgentJsonObjectSchemaDefinition(configuration.output_schema);
      checks.push({
        key: 'output_contract',
        status: 'passed',
        message: 'The response format and output schema are valid',
      });
    } catch (error) {
      checks.push({
        key: 'output_contract',
        status: 'failed',
        message: validationErrorMessage(error),
      });
    }

    try {
      await this.validateToolBindings(
        userId,
        configuration.tool_bindings,
        configuration.project_space_id,
      );
      await this.validateToolDeploymentRequirements(userId, configuration.tool_bindings);
      checks.push({
        key: 'tool_scope',
        status: 'passed',
        message: 'Pinned tool versions, scopes, endpoint allowlists, and credentials are executable',
      });
    } catch (error) {
      checks.push({
        key: 'tool_scope',
        status: 'failed',
        message: validationErrorMessage(error),
      });
    }

    try {
      if (configuration.delegation_mode !== 'explicit') {
        throw new Error('Legacy dynamic delegation must be replaced before publication');
      }
      await this.validateDelegationBindings(
        userId,
        (configuration as AgentVersionConfiguration & { id?: string }).id || null,
        configuration.delegation_bindings,
        configuration.project_space_id,
        configuration.tool_bindings,
      );
      checks.push({
        key: 'delegation_graph',
        status: configuration.delegation_bindings.length > 0 ? 'passed' : 'not_applicable',
        message: configuration.delegation_bindings.length > 0
          ? 'Pinned collaborators, scopes, versions, cycles, and context allowlists are valid'
          : 'No delegation bindings are configured',
      });
    } catch (error) {
      checks.push({
        key: 'delegation_graph',
        status: 'failed',
        message: validationErrorMessage(error),
      });
    }
    try {
      const memoryPolicy = parseAgentMemoryPolicy(configuration.memory_policy);
      if (memoryPolicy.project_context.enabled && !configuration.project_space_id) {
        throw new Error('Project context requires the Agent to belong to a project space');
      }
      if (memoryPolicy.subagent.share_recalled_memory && !memoryPolicy.read.auto_recall) {
        throw new Error('Subagent sharing requires automatic recall to be enabled');
      }
      const enabledToolKeys = new Set(configuration.tool_bindings
        .filter((binding) => binding.enabled !== false)
        .map((binding) => binding.key));
      if (enabledToolKeys.has('recall') && memoryPolicy.read.allowed_scopes.length === 0) {
        throw new Error('The recall tool is bound but the policy allows no readable scope');
      }
      if (enabledToolKeys.has('remember') && !memoryPolicy.write.enabled) {
        throw new Error('The remember tool is bound but durable writes are disabled');
      }
      if (enabledToolKeys.has('remember') && configuration.approval_policy === 'never') {
        throw new Error('The remember tool is bound but the Agent policy rejects all writes');
      }
      checks.push({
        key: 'memory_policy',
        status: 'passed',
        message: 'Memory reads, writes, context sources, and subagent sharing are executable',
      });
    } catch (error) {
      checks.push({
        key: 'memory_policy',
        status: 'failed',
        message: validationErrorMessage(error),
      });
    }

    return {
      format_version: 1,
      valid: checks.every((check) => check.status !== 'failed'),
      checks,
    };
  }

  private configurationFromBody(body: AgentCreateBody): AgentVersionConfiguration {
    let memoryPolicy: AgentMemoryPolicy;
    try {
      if (body.memory_policy) {
        memoryPolicy = parseAgentMemoryPolicy(body.memory_policy);
      } else {
        const mode = body.memory_mode ?? 'conversation';
        if (mode === 'custom') throw new Error('Custom memory mode requires memory_policy');
        memoryPolicy = memoryPolicyFromLegacyMode(mode);
      }
    } catch (error) {
      throw publicError(HttpStatus.BAD_REQUEST, validationErrorMessage(error));
    }
    const memoryMode = memoryModeFromPolicy(memoryPolicy);
    if (body.memory_mode !== undefined && body.memory_mode !== memoryMode) {
      throw publicError(HttpStatus.BAD_REQUEST, 'memory_mode does not match memory_policy');
    }
    const configuration = {
      instructions: body.instructions,
      model: body.model || getDefaultChatModel(),
      temperature: body.temperature ?? 0.7,
      max_iterations: body.max_iterations ?? 6,
      max_duration_ms: body.max_duration_ms ?? 120000,
      max_output_tokens: body.max_output_tokens ?? 4096,
      memory_mode: memoryMode,
      memory_policy: memoryPolicy,
      response_format: body.response_format ?? 'markdown',
      output_schema: body.output_schema || {},
      approval_policy: body.approval_policy ?? 'writes',
      tool_bindings: body.tool_bindings || [],
      delegation_mode: 'explicit' as const,
      delegation_bindings: parseAgentDelegationBindings(body.delegation_bindings || []),
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

  /**
   * Pin one owned immutable version for a model-only preview. Unlike
   * getRunnable this intentionally permits an unpublished draft, but it never
   * permits a disabled Agent and never follows the mutable current pointer once
   * the version has been selected.
   */
  async getVersionForDryRun(userId: string, agentId: string, versionId: string) {
    if (!UUID.test(agentId) || !UUID.test(versionId)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent version id');
    }
    const [agent, version] = await Promise.all([
      findAgentForUser(agentId, userId),
      findAgentVersionForUser(agentId, versionId, userId),
    ]);
    if (!agent || !version) throw publicError(HttpStatus.NOT_FOUND, 'Agent version not found');
    if (agent.status === 'disabled') {
      throw publicError(HttpStatus.CONFLICT, 'Disabled Agents cannot be dry-run');
    }
    const pinned: AgentDetailRow = {
      ...agent,
      ...version,
      id: agent.id,
      current_version_id: agent.current_version_id,
      published_version_id: version.id,
      published_version: version.version,
      latest_version: agent.latest_version,
      status: agent.status,
      name: agent.name,
      description: agent.description,
      avatar: agent.avatar,
      visibility: agent.visibility,
      project_space_id: agent.project_space_id,
      has_unpublished_changes: agent.current_version_id !== version.id,
      created_at: agent.created_at,
      updated_at: agent.updated_at,
      version_created_at: version.created_at,
    };
    return {
      agent: pinned,
      validationReport: await this.buildPublicationValidationReport(userId, pinned),
    };
  }

  async create(userId: string, body: AgentCreateBody, requestId?: string) {
    const projectSpaceId = readProjectSpaceId(body);
    await this.assertProjectSpace(userId, projectSpaceId);
    if (body.visibility === 'project' && !projectSpaceId) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Project agents require a project space');
    }
    const configuration = this.configurationFromBody(body);
    configuration.tool_bindings = await this.validateToolBindings(
      userId,
      configuration.tool_bindings,
      projectSpaceId,
      true,
    );
    configuration.delegation_bindings = await this.validateDelegationBindings(
      userId,
      null,
      configuration.delegation_bindings,
      projectSpaceId,
      configuration.tool_bindings,
    );

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
      const delegationMessage = delegationTransactionErrorMessage(error);
      if (delegationMessage) throw publicError(HttpStatus.CONFLICT, delegationMessage);
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

    for (const key of agentVersionConfigurationKeys) {
      if (
        key === 'memory_mode'
        || key === 'memory_policy'
        || key === 'delegation_mode'
        || key === 'delegation_bindings'
      ) continue;
      const value = body[key];
      if (value !== undefined) {
        (version as Record<string, unknown>)[key] = value;
      }
    }
    if (body.memory_policy !== undefined) {
      const memoryPolicy = parseAgentMemoryPolicy(body.memory_policy);
      const memoryMode = memoryModeFromPolicy(memoryPolicy);
      if (body.memory_mode !== undefined && body.memory_mode !== memoryMode) {
        throw publicError(HttpStatus.BAD_REQUEST, 'memory_mode does not match memory_policy');
      }
      version.memory_policy = memoryPolicy;
      version.memory_mode = memoryMode;
    } else if (body.memory_mode !== undefined) {
      if (body.memory_mode === 'custom') {
        throw publicError(HttpStatus.BAD_REQUEST, 'Custom memory mode requires memory_policy');
      }
      version.memory_policy = memoryPolicyFromLegacyMode(body.memory_mode);
      version.memory_mode = body.memory_mode;
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
    const validatedToolBindings = await this.validateToolBindings(
      userId,
      effectiveToolBindings,
      effectiveProjectSpaceId,
      version.tool_bindings !== undefined,
    );
    if (version.tool_bindings !== undefined) version.tool_bindings = validatedToolBindings;
    if (body.delegation_bindings !== undefined) {
      version.delegation_mode = 'explicit';
      version.delegation_bindings = await this.validateDelegationBindings(
        userId,
        agentId,
        body.delegation_bindings,
        effectiveProjectSpaceId,
        validatedToolBindings,
      );
    } else if (version.tool_bindings !== undefined || metadata.project_space_id !== undefined) {
      await this.validateDelegationBindings(
        userId,
        agentId,
        current.delegation_bindings,
        effectiveProjectSpaceId,
        validatedToolBindings,
      );
    }

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
      const delegationMessage = delegationTransactionErrorMessage(error);
      if (delegationMessage) throw publicError(HttpStatus.CONFLICT, delegationMessage);
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

  async publish(userId: string, agentId: string, body: AgentPublishBody = {}) {
    const current = await this.get(userId, agentId);
    const validationReport = await this.buildPublicationValidationReport(userId, current);
    if (!validationReport.valid) {
      const failedChecks = validationReport.checks.filter((check) => check.status === 'failed');
      const providerOnlyFailure = failedChecks.length === 1
        && failedChecks[0].key === 'provider_configuration';
      throw new HttpException({
        error: 'Agent cannot be published',
        validation_report: validationReport,
      }, providerOnlyFailure ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_REQUEST);
    }
    let agent: Awaited<ReturnType<typeof publishAgentForUser>>;
    try {
      agent = await publishAgentForUser({
        agentId,
        userId,
        expectedVersionId: current.current_version_id,
        releaseNotes: body.release_notes ?? body.releaseNotes ?? '',
        validationReport,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_DISABLED') {
        throw publicError(HttpStatus.CONFLICT, 'Enable the agent before publishing it');
      }
      if (error instanceof Error && error.message === 'AGENT_VERSION_CHANGED') {
        throw publicError(HttpStatus.CONFLICT, 'Agent changed during publication; validate and retry');
      }
      if (error instanceof Error && (
        error.message === 'AGENT_TOOL_BINDING_UNAVAILABLE'
        || error.message === 'AGENT_TOOL_BINDING_SCOPE'
      )) {
        throw publicError(HttpStatus.CONFLICT, 'Agent tools changed during publication; validate and retry');
      }
      const delegationMessage = delegationTransactionErrorMessage(error);
      if (delegationMessage) {
        throw publicError(
          HttpStatus.CONFLICT,
          `${delegationMessage}; validate and retry publication`,
        );
      }
      throw error;
    }
    if (!agent) throw publicError(HttpStatus.NOT_FOUND, 'Agent not found');
    void this.audit({
      userId,
      agentId,
      action: 'agent.published',
      metadata: {
        version: agent.published_version,
        version_id: agent.current_version_id,
        configuration_hash: agent.configuration_hash,
        publication_id: agent.publication.id,
        release_notes: agent.publication.release_notes,
        validation_report: validationReport,
      },
    });
    return agent;
  }

  async setDisabled(userId: string, agentId: string, disabled: boolean) {
    let agent: Awaited<ReturnType<typeof setAgentDisabledForUser>>;
    try {
      agent = await setAgentDisabledForUser(agentId, userId, disabled);
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_DELEGATION_STILL_BOUND') {
        throw publicError(
          HttpStatus.CONFLICT,
          'Remove this Agent from all current and published collaborator directories before disabling it',
        );
      }
      throw error;
    }
    if (!agent) throw publicError(HttpStatus.NOT_FOUND, 'Agent not found');
    if (disabled) {
      abortAgentRunsForAgentInProcess(
        agentId,
        userId,
        'Agent was disabled while a run was active',
      );
    }
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
      memory_policy: source.memory_policy,
      response_format: source.response_format,
      output_schema: source.output_schema,
      approval_policy: source.approval_policy,
      tool_bindings: source.tool_bindings,
      delegation_bindings: source.delegation_mode === 'explicit'
        ? source.delegation_bindings
        : [],
      welcome_message: source.welcome_message,
      suggested_prompts: source.suggested_prompts,
    }, requestId);
  }

  async versions(userId: string, agentId: string) {
    await this.get(userId, agentId);
    return listAgentVersionsForUser(agentId, userId);
  }

  async version(userId: string, agentId: string, versionId: string) {
    if (!UUID.test(agentId) || !UUID.test(versionId)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent version id');
    }
    const version = await findAgentVersionForUser(agentId, versionId, userId);
    if (!version) throw publicError(HttpStatus.NOT_FOUND, 'Agent version not found');
    return version;
  }

  async diffVersions(
    userId: string,
    agentId: string,
    versionId: string,
    againstVersionId: string | undefined,
  ) {
    if (!againstVersionId || !UUID.test(againstVersionId)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'againstVersionId is required');
    }
    const [target, base] = await Promise.all([
      this.version(userId, agentId, versionId),
      this.version(userId, agentId, againstVersionId),
    ]);
    return buildAgentVersionDiff(base, target);
  }

  async rollback(userId: string, agentId: string, versionId: string) {
    const [current, target] = await Promise.all([
      this.get(userId, agentId),
      this.version(userId, agentId, versionId),
    ]);
    if (target.id === current.current_version_id) {
      throw publicError(HttpStatus.CONFLICT, 'The selected version is already current');
    }
    try {
      if (!isSupportedChatModelName(target.model)) {
        throw new Error(`Unsupported chat model: ${target.model}`);
      }
      validateModelOutputBudget(target.model, target.max_output_tokens);
      validateAgentJsonObjectSchemaDefinition(target.output_schema);
      await this.validateToolBindings(
        userId,
        target.tool_bindings,
        current.project_space_id,
      );
      await this.validateDelegationBindings(
        userId,
        agentId,
        target.delegation_bindings,
        current.project_space_id,
        target.tool_bindings,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw publicError(HttpStatus.BAD_REQUEST, validationErrorMessage(error));
    }

    try {
      const rolledBack = await rollbackAgentVersionForUser({
        agentId,
        versionId,
        userId,
        maxVersionsPerAgent: serverEnv.AGENT_MAX_VERSIONS_PER_AGENT,
      });
      if (!rolledBack) throw publicError(HttpStatus.NOT_FOUND, 'Agent not found');
      void this.audit({
        userId,
        agentId,
        action: 'agent.version_rolled_back',
        metadata: {
          source_version_id: target.id,
          source_version: target.version,
          created_version_id: rolledBack.current_version_id,
          created_version: rolledBack.version,
          configuration_hash: rolledBack.configuration_hash,
        },
      });
      return rolledBack;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const delegationMessage = delegationTransactionErrorMessage(error);
      if (delegationMessage) throw publicError(HttpStatus.CONFLICT, delegationMessage);
      if (error instanceof Error && error.message === 'AGENT_VERSION_NOT_FOUND') {
        throw publicError(HttpStatus.NOT_FOUND, 'Agent version not found');
      }
      if (error instanceof Error && error.message === 'AGENT_VERSION_QUOTA_EXCEEDED') {
        throw publicError(HttpStatus.TOO_MANY_REQUESTS, 'Agent version quota exceeded');
      }
      if (error instanceof Error && (
        error.message === 'AGENT_TOOL_BINDING_UNAVAILABLE'
        || error.message === 'AGENT_TOOL_BINDING_SCOPE'
      )) {
        throw publicError(HttpStatus.CONFLICT, 'Agent tools changed during rollback; retry');
      }
      throw error;
    }
  }

  async delete(userId: string, agentId: string) {
    let deleted: boolean;
    try {
      deleted = await deleteAgentForUser(agentId, userId);
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_DELEGATION_STILL_BOUND') {
        throw publicError(
          HttpStatus.CONFLICT,
          'Remove this Agent from all current and published collaborator directories before deleting it',
        );
      }
      throw error;
    }
    if (!deleted) throw publicError(HttpStatus.NOT_FOUND, 'Agent not found');
    abortAgentRunsForAgentInProcess(
      agentId,
      userId,
      'Agent was deleted while a run was active',
    );
    void this.audit({ userId, agentId, action: 'agent.deleted' });
    return { success: true };
  }

  toolCatalog() {
    return builtinAgentTools;
  }
}
