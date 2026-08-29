import { z } from 'zod';
import { serverEnv } from '../../../lib/env';
import type { AgentRuntimeTool } from './agent-tool';
import { AgentToolError } from './agent-tool-error';
import {
  addAgentTokenUsage,
  attachSubagentDispatchEvidence,
  normalizeAgentTokenUsage,
  type AgentTokenUsage,
} from './agent-evidence';
import { dispatchSubagents, type SubagentTaskOutcome } from './subagent-runtime';
import type {
  AgentDelegationBinding,
  AgentDelegationMode,
} from '../../../lib/agentDelegation';

export const DISPATCH_SUBAGENTS_TOOL_KEY = 'dispatch_subagents';

const MAX_TASK_CHARS = 4_000;
const MAX_CONTEXT_BYTES = 8 * 1024;

const taskSchema = z.object({
  agent_id: z.string().uuid(),
  task: z.string().trim().min(1).max(MAX_TASK_CHARS),
  // Explicitly passed and bounded. A subagent deliberately does not inherit the
  // parent's conversation: that is the whole point of delegating, and it also
  // keeps the parent from leaking history it never decided to share.
  context: z.record(z.string(), z.unknown()).optional(),
}).strict();

const inputSchema = z.object({
  tasks: z.array(taskSchema).min(1),
  mode: z.enum(['parallel', 'sequential']).default('parallel'),
}).strict();

const explicitTaskSchema = z.object({
  alias: z.string().trim().min(1).max(32),
  task: z.string().trim().min(1).max(MAX_TASK_CHARS),
  context: z.record(z.string(), z.unknown()).optional(),
}).strict();

const explicitInputSchema = z.object({
  tasks: z.array(explicitTaskSchema).min(1),
  mode: z.enum(['parallel', 'serialized']).default('parallel'),
}).strict();

export interface AgentDelegationRuntimeConfiguration {
  mode: AgentDelegationMode;
  bindings: ReadonlyArray<AgentDelegationBinding>;
}

const legacyDelegationConfiguration: AgentDelegationRuntimeConfiguration = {
  mode: 'legacy_dynamic',
  bindings: [],
};

export const parseSubagentDispatchInput = (
  rawInput: unknown,
  configuration: AgentDelegationRuntimeConfiguration = legacyDelegationConfiguration,
) => {
  const parsed = configuration.mode === 'explicit'
    ? explicitInputSchema.safeParse(rawInput)
    : inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AgentToolError(
      'tool_input_invalid',
      parsed.error.issues[0]?.message || 'Invalid subagent dispatch input',
    );
  }
  const { tasks, mode } = parsed.data;
  if (tasks.length > serverEnv.AGENT_MAX_SUBAGENT_FANOUT) {
    throw new AgentToolError(
      'tool_input_invalid',
      `At most ${serverEnv.AGENT_MAX_SUBAGENT_FANOUT} tasks may be dispatched at once`,
    );
  }
  for (const task of tasks) {
    if (!task.context) continue;
    const size = Buffer.byteLength(JSON.stringify(task.context), 'utf8');
    if (size > MAX_CONTEXT_BYTES) {
      throw new AgentToolError(
        'tool_input_invalid',
        `Task context must be at most ${MAX_CONTEXT_BYTES} bytes`,
      );
    }
  }
  if (configuration.mode === 'explicit') {
    const bindingByAlias = new Map(configuration.bindings.map((binding) => [
      binding.alias,
      binding,
    ]));
    const counts = new Map<string, number>();
    const resolvedTasks = (tasks as z.infer<typeof explicitTaskSchema>[]).map((task) => {
      const binding = bindingByAlias.get(task.alias);
      if (!binding) {
        throw new AgentToolError(
          'tool_input_invalid',
          `Unknown collaborator alias: ${task.alias}`,
        );
      }
      const nextCount = (counts.get(binding.alias) || 0) + 1;
      counts.set(binding.alias, nextCount);
      if (nextCount > binding.max_parallelism) {
        throw new AgentToolError(
          'tool_input_invalid',
          `Collaborator ${binding.alias} accepts at most ${binding.max_parallelism} task(s) per dispatch`,
        );
      }
      const contextKeys = Object.keys(task.context || {});
      const allowedKeys = new Set(binding.allowed_context_keys);
      const forbiddenKey = contextKeys.find((key) => !allowedKeys.has(key));
      if (forbiddenKey) {
        throw new AgentToolError(
          'tool_input_invalid',
          `Context key "${forbiddenKey}" is not allowed for collaborator ${binding.alias}`,
        );
      }
      return {
        alias: binding.alias,
        role: binding.role,
        agent_id: binding.agent_id,
        agent_version_id: binding.agent_version_id,
        task: task.task,
        context: task.context,
      };
    });
    return {
      tasks: resolvedTasks,
      mode: mode === 'serialized' ? 'sequential' as const : 'parallel' as const,
    };
  }
  const legacyTasks = tasks as z.infer<typeof taskSchema>[];
  const duplicates = legacyTasks.map((task) => task.agent_id)
    .filter((agentId, index, all) => all.indexOf(agentId) !== index);
  if (duplicates.length > 0) {
    throw new AgentToolError(
      'tool_input_invalid',
      'Each Agent may appear at most once in a single dispatch',
    );
  }
  return { tasks: legacyTasks, mode: mode as 'parallel' | 'sequential' };
};

const stripChildLocalCitationLabels = (answer: string) => answer
  .replace(/\s*(?:\[(?:source\s*)?\d+\]|【\s*\d+\s*】)/gi, '')
  .trim();

/**
 * Report an outcome per task rather than a single pass/fail.
 *
 * A partial failure is the common case with a fan-out, and collapsing it would
 * leave the parent unable to tell the user which part of the request was not
 * completed. Each entry keeps its own coded reason.
 */
export const summarizeSubagentOutcomes = (outcomes: SubagentTaskOutcome[]) => {
  const usage: AgentTokenUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const warnings: string[] = [];
  for (const outcome of outcomes) {
    addAgentTokenUsage(usage, outcome.usage);
    if (outcome.status !== 'succeeded') {
      warnings.push([
        `Subagent ${outcome.agentId} ${outcome.status}`,
        outcome.error,
        outcome.message,
      ].filter(Boolean).join(': '));
    }
  }
  const summary = {
    completed: outcomes.filter((outcome) => outcome.status === 'succeeded').length,
    total: outcomes.length,
    usage: normalizeAgentTokenUsage(usage),
    results: outcomes.map((outcome) => ({
      ...(outcome.taskIndex !== undefined ? { task_index: outcome.taskIndex } : {}),
      agent_id: outcome.agentId,
      run_id: outcome.runId,
      status: outcome.status,
      ...(outcome.answer !== undefined ? {
        // A child's numeric labels address its own local source order. Reusing
        // them in the parent would silently point at a different source after
        // several retrieval/dispatch calls, so expose the claim without labels
        // and provide stable filename/chunk references below.
        answer: outcome.result
          ? stripChildLocalCitationLabels(outcome.answer)
          : outcome.answer,
      } : {}),
      ...(outcome.result ? {
        evidence: {
          status: outcome.result.status,
          evidence_used: outcome.result.evidence_used,
          citation_scope: 'subagent_local_labels_removed',
          source_count: outcome.result.sources.length,
          sources: outcome.result.sources.map((source) => ({
            filename: source.filename,
            ...(source.file_id ? { file_id: source.file_id } : {}),
            ...(source.chunk_id ? { chunk_id: source.chunk_id } : {}),
            ...(source.chunk_index !== undefined ? { chunk_index: source.chunk_index } : {}),
            ...(source.source_role ? { source_role: source.source_role } : {}),
          })),
          warnings: outcome.result.warnings,
        },
      } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.message ? { message: outcome.message } : {}),
      duration_ms: outcome.durationMs,
      ...(outcome.iterations !== undefined ? { iterations: outcome.iterations } : {}),
      ...(outcome.toolCalls !== undefined ? { tool_calls: outcome.toolCalls } : {}),
      ...(outcome.usage ? { usage: normalizeAgentTokenUsage(outcome.usage) } : {}),
    })),
  };
  // Full source content is needed by deterministic grounding, but exposing it in
  // the model-visible tool payload duplicates context and can overflow it. A
  // non-enumerable channel keeps JSON output compact; the same envelopes are
  // restored from child assistant steps after cross-process reconciliation.
  return attachSubagentDispatchEvidence(summary, {
    envelopes: outcomes.flatMap((outcome) => outcome.result ? [outcome.result] : []),
    usage,
    warnings,
  });
};

export const createDispatchSubagentsRuntimeTool = (
  configuration: AgentDelegationRuntimeConfiguration = legacyDelegationConfiguration,
): AgentRuntimeTool => ({
  key: DISPATCH_SUBAGENTS_TOOL_KEY,
  modelName: DISPATCH_SUBAGENTS_TOOL_KEY,
  // Dispatching has no external side effect of its own. Whatever a child does is
  // governed by the resolved policy chain, which already takes the strictest
  // constraint from every ancestor -- so marking this `write` would only block
  // read-only delegation without adding any protection.
  riskLevel: 'read',
  // Dispatch creates durable child Runs. Its own fencing handles recovery, but a
  // caller must not start a second tree merely because the first response was lost.
  retryMode: 'never',
  describeApproval: (args) => ({
    kind: 'subagent',
    method: 'dispatch',
    target: Array.isArray(args.tasks)
      ? `${args.tasks.length} delegated task${args.tasks.length === 1 ? '' : 's'}`
      : 'delegated Agent tasks',
    sideEffectSummary: 'Dispatch one or more pinned collaborator Agents, consuming shared Run-tree time and token budgets.',
  }),
  definition: {
    type: 'function',
    function: {
      name: DISPATCH_SUBAGENTS_TOOL_KEY,
      description: 'Delegate parts of the request to configured collaborator aliases, then'
        + ' summarise their findings yourself. Send several tasks in one call to run them at the'
        + ' same time. Each task is answered independently and may fail on its own; report any'
        + ' task you could not complete instead of implying it succeeded.'
        + (configuration.mode === 'explicit'
          ? ` Collaborators: ${configuration.bindings.map((binding) => (
            `${binding.alias} (${binding.role}; allowed context: ${binding.allowed_context_keys.join(', ') || 'none'})`
          )).join('; ')}.`
          : ''),
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: serverEnv.AGENT_MAX_SUBAGENT_FANOUT,
            items: {
              type: 'object',
              properties: {
                ...(configuration.mode === 'explicit'
                  ? {
                    alias: {
                      type: 'string',
                      enum: configuration.bindings.map((binding) => binding.alias),
                      description: 'Configured collaborator alias.',
                    },
                  }
                  : { agent_id: { type: 'string', description: 'Id of the Agent to delegate to.' } }),
                task: {
                  type: 'string',
                  description: 'One self-contained instruction. The Agent cannot see this'
                    + ' conversation, so state everything it needs.',
                },
                context: {
                  type: 'object',
                  description: 'Optional facts the Agent needs. Keep it small.',
                },
              },
              required: [configuration.mode === 'explicit' ? 'alias' : 'agent_id', 'task'],
              additionalProperties: false,
            },
          },
          mode: {
            type: 'string',
            enum: configuration.mode === 'explicit'
              ? ['parallel', 'serialized']
              : ['parallel', 'sequential'],
            description: 'Serialized runs one task at a time but does not inject prior task results.',
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
    },
  },
  execute: async (rawInput, context) => {
    // Bounded before dispatch so an oversized payload is refused here rather
    // than after child Runs have already been created and charged.
    const { tasks, mode } = parseSubagentDispatchInput(rawInput, configuration);

    const outcomes = await dispatchSubagents({
      userId: context.userId,
      projectSpaceId: context.projectSpaceId,
      conversationId: context.conversationId,
      parentRunId: context.runId,
      rootRunId: context.trace.traceId,
      parentToolCallId: context.toolCallId,
      deadlineAt: context.deadlineAt,
      ancestorApprovalPolicies: context.approvalPolicyChain,
      trace: context.trace,
      signal: context.signal,
      sharedMemorySnapshot: context.sharedMemorySnapshot,
      nextSequence: context.nextSequence,
      mode,
      tasks: tasks.map((task) => {
        const resolved = task as typeof task & {
          agent_version_id?: unknown;
          alias?: unknown;
          role?: unknown;
        };
        return {
          agentId: task.agent_id,
          ...(typeof resolved.agent_version_id === 'string'
            ? { agentVersionId: resolved.agent_version_id }
            : {}),
          ...(typeof resolved.alias === 'string' ? { alias: resolved.alias } : {}),
          ...(typeof resolved.role === 'string' ? { role: resolved.role } : {}),
          task: task.task,
          context: task.context,
        };
      }),
    });

    return summarizeSubagentOutcomes(outcomes);
  },
});
