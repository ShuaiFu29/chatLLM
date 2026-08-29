import type {
  ChatCompletionCreateParams,
  ChatCompletionResponse,
  ChatMessageParam,
} from '../../../lib/llmProviders';
import { serverEnv } from '../../../lib/env';
import type { AgentToolBinding } from '../../../repositories/agents';
import type { AgentToolRow } from '../../../repositories/agentTools';
import type {
  AgentDelegationBinding,
  AgentDelegationMode,
} from '../../../lib/agentDelegation';
import type { AgentRuntimeTool } from './agent-tool';
import { normalizeAgentTokenUsage, type AgentTokenUsage } from './agent-evidence';
import {
  assertModelFinalAnswerNotTruncated,
  assertModelResponseComplete,
  assertModelToolCallsExecutable,
  AgentProtocolError,
} from './model-protocol-guard';
import { createAgentOutputContract } from './agent-output-contract';
import { validateAgentJsonSchemaInput } from './json-schema-input';
import {
  decideAgentToolPolicyFromResolved,
  partitionToolsByPolicy,
  resolveAgentToolPolicyChain,
  type AgentApprovalPolicy,
  type AgentToolPolicyDecision,
} from './tool-policy';
import { builtinRuntimeToolByKey } from './builtin-tools';
import {
  createDispatchSubagentsRuntimeTool,
  DISPATCH_SUBAGENTS_TOOL_KEY,
} from './subagent-tool';
import { isAgentToolInProjectScope } from './tool-scope';

const MAX_DRY_RUN_TURNS = 3;
const MAX_TOOL_CALLS_PER_TURN = 4;
const MAX_DRY_RUN_TOOL_CALLS = 24;
const CUSTOM_TOOL_KEY = /^custom:([0-9a-f-]{36})$/i;
const DEFAULT_CUSTOM_TOOL_DESCRIPTION = 'Custom Agent tool';

export const AGENT_DRY_RUN_ISOLATION_REPORT = Object.freeze({
  mode: 'model_only' as const,
  blocked_effects: Object.freeze([
    'tool_execution',
    'approval_creation',
    'subagent_dispatch',
    'conversation_write',
    'memory_write',
  ]),
  omitted_context: Object.freeze([
    'conversation_history',
    'persona',
    'long_term_memory',
    'project_context',
  ]),
});

export interface AgentDryRunPlannedToolCall {
  tool_call_id: string;
  tool_key: string;
  model_name: string;
  risk_level: AgentRuntimeTool['riskLevel'];
  policy_decision: AgentToolPolicyDecision;
  status: 'simulated' | 'invalid';
  arguments?: Record<string, unknown>;
  validation_error?: string;
}

export interface AgentDryRunModelResult {
  output: string;
  finish_reason: string;
  planned_tool_calls: AgentDryRunPlannedToolCall[];
  withheld_tools: Array<{ key: string; riskLevel: AgentRuntimeTool['riskLevel'] }>;
  usage: AgentTokenUsage;
  turns: number;
}

export interface AgentToolSimulationResolution {
  matched: boolean;
  result?: unknown;
}

export interface AgentModelSimulationOptions {
  mode: 'dry_run' | 'evaluation';
  resolveToolResult?: (
    plan: AgentDryRunPlannedToolCall,
    planIndex: number,
  ) => AgentToolSimulationResolution;
}

export type AgentDryRunModelInvoker = (
  params: ChatCompletionCreateParams,
) => Promise<ChatCompletionResponse>;

/**
 * Resolve the exact model-visible catalog without loading or decrypting tool
 * credentials. The returned execute functions are unreachable by design and
 * throw if a caller ever violates that boundary.
 */
export const createAgentDryRunToolCatalog = (input: {
  bindings: AgentToolBinding[];
  customTools: AgentToolRow[];
  projectSpaceId?: string | null;
  delegationMode: AgentDelegationMode;
  delegationBindings: ReadonlyArray<AgentDelegationBinding>;
}): AgentRuntimeTool[] => {
  const customByVersion = new Map(input.customTools.map((tool) => [tool.tool_version_id, tool]));
  const catalog: AgentRuntimeTool[] = [];
  for (const binding of input.bindings.filter((item) => item.enabled !== false)) {
    if (binding.key === DISPATCH_SUBAGENTS_TOOL_KEY) {
      const dispatch = createDispatchSubagentsRuntimeTool({
        mode: input.delegationMode,
        bindings: input.delegationBindings,
      });
      catalog.push({
        ...dispatch,
        execute: async () => {
          throw new Error('Agent dry-run tools cannot be executed');
        },
      });
      continue;
    }
    const builtin = builtinRuntimeToolByKey.get(binding.key);
    if (builtin) {
      catalog.push({
        ...builtin,
        execute: async () => {
          throw new Error('Agent dry-run tools cannot be executed');
        },
      });
      continue;
    }
    const match = CUSTOM_TOOL_KEY.exec(binding.key);
    const tool = binding.tool_version_id
      ? customByVersion.get(binding.tool_version_id)
      : undefined;
    if (!match || !tool || tool.id !== match[1] || !tool.enabled) {
      throw new Error(`Configured Agent tool version is unavailable: ${binding.key}`);
    }
    if (!isAgentToolInProjectScope(tool.project_space_id, input.projectSpaceId)) {
      throw new Error(`Configured Agent tool is outside the Agent project scope: ${binding.key}`);
    }
    const configuration = tool.configuration;
    const inputSchema = configuration.input_schema
      ?? (tool.kind === 'mcp' ? { type: 'object', properties: {} } : undefined);
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      throw new Error(`Configured Agent tool has an invalid input schema: ${binding.key}`);
    }
    const isMcp = tool.kind === 'mcp';
    const method = typeof configuration.method === 'string' ? configuration.method : '';
    const effectiveRisk = isMcp || (tool.risk_level === 'read' && method !== 'GET')
      ? (tool.risk_level === 'high' ? 'high' : 'write')
      : tool.risk_level;
    const modelName = `custom_${tool.id.replace(/-/g, '_')}`;
    catalog.push({
      key: binding.key,
      modelName,
      riskLevel: effectiveRisk,
      retryMode: 'never',
      maxInvocationsPerRun: tool.max_invocations_per_run ?? undefined,
      definition: {
        type: 'function',
        function: {
          name: modelName,
          description: tool.description || DEFAULT_CUSTOM_TOOL_DESCRIPTION,
          parameters: inputSchema as Record<string, unknown>,
        },
      },
      execute: async () => {
        throw new Error('Agent dry-run tools cannot be executed');
      },
    });
  }
  return catalog;
};

const addUsage = (total: AgentTokenUsage, raw?: ChatCompletionResponse['usage']) => {
  const usage = normalizeAgentTokenUsage(raw);
  total.prompt_tokens += usage.prompt_tokens;
  total.completion_tokens += usage.completion_tokens;
  total.total_tokens += usage.total_tokens;
};

const parseDryRunToolArguments = (raw: string) => {
  if (Buffer.byteLength(raw, 'utf8') > serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES) {
    throw new Error('Tool arguments exceed the Agent step payload limit');
  }
  const parsed = JSON.parse(raw || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be an object');
  }
  return parsed as Record<string, unknown>;
};

const stringifyBoundedSimulationResult = (value: Record<string, unknown>) => {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES) {
    throw new Error('Simulated tool result exceeds the Agent step payload limit');
  }
  return serialized;
};

const simulatedToolResult = (
  plan: AgentDryRunPlannedToolCall,
  planIndex: number,
  simulation?: AgentModelSimulationOptions,
) => {
  const isEvaluation = simulation?.mode === 'evaluation';
  if (plan.status === 'invalid') {
    return stringifyBoundedSimulationResult({
      ok: false,
      simulated: true,
      evaluation: isEvaluation,
      code: isEvaluation ? 'evaluation_tool_input_invalid' : 'dry_run_tool_input_invalid',
      message: plan.validation_error,
    });
  }
  const resolution = simulation?.resolveToolResult?.(plan, planIndex);
  if (isEvaluation && resolution?.matched) {
    return stringifyBoundedSimulationResult({
      ok: true,
      simulated: true,
      evaluation_fixture: true,
      result: resolution.result ?? null,
    });
  }
  return stringifyBoundedSimulationResult({
    ok: false,
    simulated: true,
    evaluation: isEvaluation,
    code: isEvaluation ? 'evaluation_fixture_missing' : 'dry_run_tool_not_executed',
    message: isEvaluation
      ? 'The requested tool has no matching evaluation fixture and was not executed.'
      : 'The tool call was recorded but not executed because this is an isolated Agent dry-run.',
  });
};

/**
 * Execute a pinned Agent version as an isolated model preview.
 *
 * The function deliberately accepts tool definitions but no tool executor. A
 * future refactor therefore cannot accidentally turn a preview into a production
 * side effect by passing a different context flag. Calls are schema-validated,
 * reported to the caller, and answered with deterministic simulated results.
 */
export const executeAgentDryRunModel = async (input: {
  model: string;
  systemPrompt: string;
  question: string;
  temperature: number;
  maxOutputTokens: number;
  responseFormat: 'markdown' | 'json';
  outputSchema: Record<string, unknown>;
  supportsStructuredOutput: boolean;
  supportsToolCalling: boolean;
  approvalPolicy: AgentApprovalPolicy;
  runtimeTools: AgentRuntimeTool[];
  signal: AbortSignal;
  invoke: AgentDryRunModelInvoker;
  simulation?: AgentModelSimulationOptions;
}): Promise<AgentDryRunModelResult> => {
  input.signal.throwIfAborted();
  const outputContract = createAgentOutputContract({
    responseFormat: input.responseFormat,
    outputSchema: input.outputSchema,
    supportsStructuredOutput: input.supportsStructuredOutput,
  });
  const resolvedPolicy = resolveAgentToolPolicyChain([input.approvalPolicy]);
  const { available, withheld } = partitionToolsByPolicy(input.runtimeTools, resolvedPolicy);
  if (available.length > 0 && !input.supportsToolCalling) {
    throw new Error(`Model ${input.model} does not support Agent tool calling`);
  }
  const toolByModelName = new Map(available.map((tool) => [tool.modelName, tool]));
  if (toolByModelName.size !== available.length) {
    throw new Error('Agent dry-run tool names are not unique');
  }

  const isEvaluation = input.simulation?.mode === 'evaluation';
  const messages: ChatMessageParam[] = [
    {
      role: 'system',
      content: `${input.systemPrompt}\n\n${isEvaluation ? 'EVALUATION' : 'DRY-RUN'} ISOLATION: `
        + `${isEvaluation ? 'This is a fixture-backed Agent evaluation.' : 'This is a model-only preview.'} `
        + 'You may propose calls to the supplied tools, but every call will be validated and simulated; '
        + 'no real tool, approval, subagent, conversation write, or Memory write will occur. '
        + (isEvaluation
          ? 'Only a matching deterministic fixture can return simulated data. Never claim a real side effect occurred.'
          : 'Do not claim that a simulated call succeeded.'),
    },
    { role: 'user', content: input.question },
  ];
  const usage: AgentTokenUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const plannedToolCalls: AgentDryRunPlannedToolCall[] = [];
  let toolsAdvertised = available.length > 0;
  let correctionAttempted = false;

  for (let turn = 1; turn <= MAX_DRY_RUN_TURNS; turn += 1) {
    input.signal.throwIfAborted();
    const response = await input.invoke({
      model: input.model,
      messages,
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens,
      ...(outputContract.modelResponseFormat
        ? { response_format: outputContract.modelResponseFormat }
        : {}),
      ...(toolsAdvertised ? {
        tools: available.map((tool) => tool.definition),
        tool_choice: 'auto' as const,
      } : {
        tool_choice: 'none' as const,
      }),
      signal: input.signal,
    });
    addUsage(usage, response.usage);
    if (response.choices.length !== 1) {
      throw new AgentProtocolError('Agent dry-run model response must contain exactly one choice');
    }
    const choice = response.choices[0];
    const finishReason = assertModelResponseComplete(choice.finish_reason);
    const toolCalls = choice.message.tool_calls || [];
    assertModelToolCallsExecutable({
      finishReason,
      toolCallCount: toolCalls.length,
      toolsAdvertised,
    });

    if (toolCalls.length > 0) {
      if (toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
        throw new Error(`Agent dry-run requested more than ${MAX_TOOL_CALLS_PER_TURN} tools in one turn`);
      }
      if (plannedToolCalls.length + toolCalls.length > MAX_DRY_RUN_TOOL_CALLS) {
        throw new Error('Agent dry-run exceeded its tool-plan limit');
      }
      const seenCallIds = new Set<string>();
      messages.push({
        role: 'assistant',
        content: choice.message.content || null,
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        if (!call.id || call.id.length > 512 || seenCallIds.has(call.id)) {
          throw new AgentProtocolError('Agent dry-run tool call id is invalid or duplicated');
        }
        seenCallIds.add(call.id);
        const tool = toolByModelName.get(call.function.name);
        if (!tool) {
          throw new AgentProtocolError('Agent dry-run model requested an unavailable tool');
        }
        const base = {
          tool_call_id: call.id,
          tool_key: tool.key,
          model_name: tool.modelName,
          risk_level: tool.riskLevel,
          policy_decision: decideAgentToolPolicyFromResolved(resolvedPolicy, tool.riskLevel),
        };
        let plan: AgentDryRunPlannedToolCall;
        try {
          const parsed = parseDryRunToolArguments(call.function.arguments);
          validateAgentJsonSchemaInput(parsed, tool.definition.function.parameters);
          plan = { ...base, status: 'simulated', arguments: parsed };
        } catch (error) {
          plan = {
            ...base,
            status: 'invalid',
            validation_error: error instanceof Error ? error.message : 'Tool input is invalid',
          };
        }
        plannedToolCalls.push(plan);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: simulatedToolResult(plan, plannedToolCalls.length - 1, input.simulation),
        });
      }
      // One planning turn is enough to verify tool choice and input. Removing
      // definitions guarantees that a preview cannot recursively plan an
      // unbounded chain and makes any later tool call a protocol error.
      toolsAdvertised = false;
      continue;
    }

    assertModelFinalAnswerNotTruncated(finishReason);
    const rawOutput = choice.message.content || '';
    if (!rawOutput.trim()) throw new AgentProtocolError('Agent dry-run returned an empty final answer');
    try {
      return {
        output: outputContract.validate(rawOutput),
        finish_reason: finishReason,
        planned_tool_calls: plannedToolCalls,
        withheld_tools: withheld,
        usage,
        turns: turn,
      };
    } catch (error) {
      if (correctionAttempted || turn >= MAX_DRY_RUN_TURNS) throw error;
      correctionAttempted = true;
      messages.push({ role: 'assistant', content: rawOutput });
      messages.push({ role: 'user', content: outputContract.correctionMessage(error) });
      toolsAdvertised = false;
    }
  }
  throw new Error('Agent dry-run reached its turn limit without a valid final answer');
};
