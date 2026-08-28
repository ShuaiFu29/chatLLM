import { z } from 'zod';
import { serverEnv } from '../../../lib/env';
import type { AgentRuntimeTool } from './agent-tool';
import { AgentToolError } from './agent-tool-error';
import { dispatchSubagents, type SubagentTaskOutcome } from './subagent-runtime';

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

/**
 * Report an outcome per task rather than a single pass/fail.
 *
 * A partial failure is the common case with a fan-out, and collapsing it would
 * leave the parent unable to tell the user which part of the request was not
 * completed. Each entry keeps its own coded reason.
 */
const summarizeOutcomes = (outcomes: SubagentTaskOutcome[]) => ({
  completed: outcomes.filter((outcome) => outcome.status === 'succeeded').length,
  total: outcomes.length,
  results: outcomes.map((outcome) => ({
    agent_id: outcome.agentId,
    run_id: outcome.runId,
    status: outcome.status,
    ...(outcome.answer !== undefined ? { answer: outcome.answer } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
    duration_ms: outcome.durationMs,
    ...(outcome.iterations !== undefined ? { iterations: outcome.iterations } : {}),
    ...(outcome.toolCalls !== undefined ? { tool_calls: outcome.toolCalls } : {}),
  })),
});

export const createDispatchSubagentsRuntimeTool = (): AgentRuntimeTool => ({
  key: DISPATCH_SUBAGENTS_TOOL_KEY,
  modelName: DISPATCH_SUBAGENTS_TOOL_KEY,
  // Dispatching has no external side effect of its own. Whatever a child does is
  // governed by the resolved policy chain, which already takes the strictest
  // constraint from every ancestor -- so marking this `write` would only block
  // read-only delegation without adding any protection.
  riskLevel: 'read',
  definition: {
    type: 'function',
    function: {
      name: DISPATCH_SUBAGENTS_TOOL_KEY,
      description: 'Delegate parts of the request to other Agents you are allowed to use, then'
        + ' summarise their findings yourself. Send several tasks in one call to run them at the'
        + ' same time. Each task is answered independently and may fail on its own; report any'
        + ' task you could not complete instead of implying it succeeded.',
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
                agent_id: { type: 'string', description: 'Id of the Agent to delegate to.' },
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
              required: ['agent_id', 'task'],
              additionalProperties: false,
            },
          },
          mode: {
            type: 'string',
            enum: ['parallel', 'sequential'],
            description: 'Use sequential only when one task depends on another\'s result.',
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
    },
  },
  execute: async (rawInput, context) => {
    const parsed = inputSchema.safeParse(rawInput);
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
    // Bounded before dispatch so an oversized payload is refused here rather than
    // after child Runs have already been created and charged.
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
    // Refusing a self-dispatch here as well as in the database keeps the model's
    // feedback immediate; the transactional guard remains the actual guarantee.
    const duplicates = tasks.map((task) => task.agent_id)
      .filter((agentId, index, all) => all.indexOf(agentId) !== index);
    if (duplicates.length > 0) {
      throw new AgentToolError(
        'tool_input_invalid',
        'Each Agent may appear at most once in a single dispatch',
      );
    }

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
      nextSequence: context.nextSequence,
      mode,
      tasks: tasks.map((task) => ({
        agentId: task.agent_id,
        task: task.task,
        context: task.context,
      })),
    });

    return summarizeOutcomes(outcomes);
  },
});
