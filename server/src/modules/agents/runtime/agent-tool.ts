import type { ChatToolDefinition } from '../../../lib/llmProviders';
import type { AgentToolRiskLevel } from '../../../repositories/agentTools';

export interface AgentToolExecutionContext {
  userId: string;
  projectSpaceId?: string | null;
  conversationId: string;
  signal: AbortSignal;
}

export interface AgentRuntimeTool {
  key: string;
  modelName: string;
  riskLevel: AgentToolRiskLevel;
  definition: ChatToolDefinition;
  execute(input: unknown, context: AgentToolExecutionContext): Promise<unknown>;
}

export const requireAgentProjectSpace = (context: AgentToolExecutionContext) => {
  if (!context.projectSpaceId) throw new Error('This tool requires an active project space');
  return context.projectSpaceId;
};
