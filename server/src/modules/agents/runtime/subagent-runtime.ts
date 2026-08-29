import type { AgentApprovalPolicy } from './tool-policy';
import type { TraceContext } from '../../../lib/traceContext';
import type { AgentTokenUsage, SubagentResultEnvelope } from './agent-evidence';
import type { AgentSharedMemorySnapshot } from '../../../lib/agentMemoryPolicy';

/**
 * Late binding between the tool that dispatches subagents and the runtime that
 * executes them.
 *
 * The dispatch tool has to live with the other builtin tools so it can be bound
 * to an Agent like any other capability, but the tool registry is imported by the
 * run service -- importing the run service back would close a cycle. Rather than
 * hoisting the whole loop into a shared module, the run service registers itself
 * here once at load time and the tool calls through this indirection.
 */

export interface SubagentTaskRequest {
  agentId: string;
  /** Exact historically published version selected by an explicit alias. */
  agentVersionId?: string;
  alias?: string;
  role?: string;
  task: string;
  /** Bounded payload the parent chose to share. Never the parent's history. */
  context?: Record<string, unknown>;
}

export interface SubagentTaskOutcome {
  /** Stable position in the model-requested dispatch batch. */
  taskIndex?: number;
  agentId: string;
  runId?: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  /** The child's final answer, present only when it succeeded. */
  answer?: string;
  /** Structured, durable evidence behind a successful answer. */
  result?: SubagentResultEnvelope;
  /** A coded reason, so the parent can report honestly rather than guess. */
  error?: string;
  message?: string;
  durationMs: number;
  iterations?: number;
  toolCalls?: number;
  /** Includes the entire subtree rooted at this child. */
  usage?: AgentTokenUsage;
}

export interface SubagentDispatchRequest {
  userId: string;
  projectSpaceId?: string | null;
  conversationId: string;
  parentRunId: string;
  /**
   * The tree root. Approvals a subagent needs are created here, because the chat
   * stream, the approval API and the timeline are all anchored to the root.
   */
  rootRunId: string;
  parentToolCallId: string;
  /** Root-first, including the dispatching Run's own policy. */
  ancestorApprovalPolicies: AgentApprovalPolicy[];
  trace: TraceContext;
  signal: AbortSignal;
  tasks: SubagentTaskRequest[];
  /** Labelled, parent-recalled items; never a long-term-store capability. */
  sharedMemorySnapshot: AgentSharedMemorySnapshot;
  mode: 'parallel' | 'sequential';
  requestId?: string;
  /**
   * Absolute deadline of the tree, so a bubbled approval cannot outlive the run it
   * belongs to. Undefined when the caller has no deadline to impose.
   */
  deadlineAt?: number;
  /**
   * Allocates the next step sequence on the *parent* run.
   *
   * The parent's counter lives in its run loop, and step sequences are unique per
   * run, so the dispatcher cannot invent its own numbers without colliding. Passing
   * the allocator keeps a single source of truth for the parent's ordering.
   */
  nextSequence(): Promise<number>;
}

export type SubagentExecutor = (
  request: SubagentDispatchRequest,
) => Promise<SubagentTaskOutcome[]>;

let executor: SubagentExecutor | null = null;

export const registerSubagentExecutor = (next: SubagentExecutor) => {
  executor = next;
};

export const isSubagentDispatchAvailable = () => executor !== null;

export const dispatchSubagents = async (
  request: SubagentDispatchRequest,
): Promise<SubagentTaskOutcome[]> => {
  if (!executor) {
    // Reaching here means the runtime was never registered, which is a wiring
    // bug rather than a user-facing condition. Failing loudly beats silently
    // reporting that every subtask failed.
    throw new Error('Subagent runtime is not registered');
  }
  return executor(request);
};
