import type { AgentToolBinding } from '../../../repositories/agents';
import {
  findAgentToolsWithSecretsForUserByIds,
  findAgentToolVersionsWithSecretsForUserByIds,
} from '../../../repositories/agentTools';
import type { AgentToolWithSecretsRow } from '../../../repositories/agentTools';
import type { AgentRuntimeTool } from './agent-tool';
import { builtinRuntimeToolByKey } from './builtin-tools';
import { createCustomHttpRuntimeTool } from './custom-http-tool';
import { createCustomMcpRuntimeTool } from './custom-mcp-tool';
import { isAgentToolInProjectScope } from './tool-scope';
import type {
  AgentDelegationBinding,
  AgentDelegationMode,
} from '../../../lib/agentDelegation';
import {
  DISPATCH_SUBAGENTS_TOOL_KEY,
  createDispatchSubagentsRuntimeTool,
} from './subagent-tool';

const CUSTOM_TOOL_KEY = /^custom:([0-9a-f-]{36})$/i;

export const resolveAgentRuntimeToolsFromRows = (
  bindings: AgentToolBinding[],
  customRows: AgentToolWithSecretsRow[],
  agentProjectSpaceId?: string | null,
  delegation: {
    mode: AgentDelegationMode;
    bindings: ReadonlyArray<AgentDelegationBinding>;
  } = { mode: 'legacy_dynamic', bindings: [] },
) => {
  const enabled = bindings.filter((binding) => binding.enabled !== false);
  const customById = new Map(customRows.map((item) => [item.id, item]));
  const customByVersionId = new Map(customRows.map((item) => [item.tool_version_id, item]));
  const resolved: AgentRuntimeTool[] = [];

  for (const binding of enabled) {
    if (binding.key === DISPATCH_SUBAGENTS_TOOL_KEY) {
      resolved.push(createDispatchSubagentsRuntimeTool(delegation));
      continue;
    }
    const builtin = builtinRuntimeToolByKey.get(binding.key);
    if (builtin) {
      resolved.push(builtin);
      continue;
    }
    const match = CUSTOM_TOOL_KEY.exec(binding.key);
    const custom = match
      ? binding.tool_version_id
        ? customByVersionId.get(binding.tool_version_id)
        : customById.get(match[1])
      : undefined;
    if (custom && match && custom.id !== match[1]) {
      throw new Error(`Configured Agent tool version belongs to another tool: ${binding.key}`);
    }
    if (!custom || !custom.enabled) throw new Error(`Configured Agent tool is unavailable: ${binding.key}`);
    if (!isAgentToolInProjectScope(custom.project_space_id, agentProjectSpaceId)) {
      throw new Error(`Configured Agent tool is outside the Agent project scope: ${binding.key}`);
    }
    if (custom.kind === 'http') {
      resolved.push(createCustomHttpRuntimeTool(custom));
      continue;
    }
    if (custom.kind === 'mcp') {
      resolved.push(createCustomMcpRuntimeTool(custom));
      continue;
    }
    throw new Error(`Configured Agent tool kind is not available at runtime: ${custom.kind}`);
  }
  return resolved;
};

export const resolveAgentRuntimeTools = async (
  userId: string,
  bindings: AgentToolBinding[],
  agentProjectSpaceId?: string | null,
  delegation?: {
    mode: AgentDelegationMode;
    bindings: ReadonlyArray<AgentDelegationBinding>;
  },
) => {
  const enabled = bindings.filter((binding) => binding.enabled !== false);
  const customVersionIds = enabled.flatMap((binding) => {
    const match = CUSTOM_TOOL_KEY.exec(binding.key);
    return match && binding.tool_version_id ? [binding.tool_version_id] : [];
  });
  const legacyCustomIds = enabled.flatMap((binding) => {
    const match = CUSTOM_TOOL_KEY.exec(binding.key);
    return match && !binding.tool_version_id ? [match[1]] : [];
  });
  const [versionRows, legacyRows] = await Promise.all([
    findAgentToolVersionsWithSecretsForUserByIds(customVersionIds, userId),
    findAgentToolsWithSecretsForUserByIds(legacyCustomIds, userId),
  ]);
  const customRows = [...versionRows, ...legacyRows];
  return resolveAgentRuntimeToolsFromRows(
    bindings,
    customRows,
    agentProjectSpaceId,
    delegation,
  );
};
