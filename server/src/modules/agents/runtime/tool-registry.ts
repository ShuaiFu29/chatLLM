import type { AgentToolBinding } from '../../../repositories/agents';
import { findAgentToolsWithSecretsForUserByIds } from '../../../repositories/agentTools';
import type { AgentToolWithSecretsRow } from '../../../repositories/agentTools';
import type { AgentRuntimeTool } from './agent-tool';
import { builtinRuntimeToolByKey } from './builtin-tools';
import { createCustomHttpRuntimeTool } from './custom-http-tool';
import { createCustomMcpRuntimeTool } from './custom-mcp-tool';
import { isAgentToolInProjectScope } from './tool-scope';

const CUSTOM_TOOL_KEY = /^custom:([0-9a-f-]{36})$/i;

export const resolveAgentRuntimeToolsFromRows = (
  bindings: AgentToolBinding[],
  customRows: AgentToolWithSecretsRow[],
  agentProjectSpaceId?: string | null,
) => {
  const enabled = bindings.filter((binding) => binding.enabled !== false);
  const customById = new Map(customRows.map((item) => [item.id, item]));
  const resolved: AgentRuntimeTool[] = [];

  for (const binding of enabled) {
    const builtin = builtinRuntimeToolByKey.get(binding.key);
    if (builtin) {
      resolved.push(builtin);
      continue;
    }
    const match = CUSTOM_TOOL_KEY.exec(binding.key);
    const custom = match ? customById.get(match[1]) : undefined;
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
) => {
  const enabled = bindings.filter((binding) => binding.enabled !== false);
  const customIds = enabled.flatMap((binding) => {
    const match = CUSTOM_TOOL_KEY.exec(binding.key);
    return match ? [match[1]] : [];
  });
  const customRows = await findAgentToolsWithSecretsForUserByIds(customIds, userId);
  return resolveAgentRuntimeToolsFromRows(bindings, customRows, agentProjectSpaceId);
};
