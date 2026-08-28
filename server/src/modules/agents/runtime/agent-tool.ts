import type { ChatToolDefinition } from '../../../lib/llmProviders';
import type { TraceContext } from '../../../lib/traceContext';
import type { AgentApprovalPolicy } from './tool-policy';
import type { AgentToolRiskLevel } from '../../../repositories/agentTools';

export interface AgentToolExecutionContext {
  userId: string;
  projectSpaceId?: string | null;
  conversationId: string;
  signal: AbortSignal;
  /**
   * Identity of the tool_call step that is running. Tools that reach another
   * service forward it so the downstream trace can be joined back to this exact
   * step instead of being matched up by timestamp.
   */
  trace: TraceContext;
  /**
   * Stable across retry attempts of the same logical call. A tool that reaches an
   * external system should forward it (an `Idempotency-Key` header, a request id
   * field) so a retry after a lost response is recognised as the same operation
   * rather than applied twice.
   */
  idempotencyKey: string;
  /** 1 on the first attempt. Lets a tool distinguish a retry from a fresh call. */
  attempt: number;
  /** The Run executing this tool. Not necessarily the root of the tree. */
  runId: string;
  /** The Agent this Run is executing, so agent-scoped state can be addressed. */
  agentId: string;
  /**
   * 0 for a Run started by a user, greater for a dispatched subagent. Tools that
   * write state outliving the request refuse a non-zero depth: a subagent works
   * from an instruction it was handed, with no human watching its steps.
   */
  depth: number;
  /** The model's id for this call, used to anchor dispatched work to it. */
  toolCallId: string;
  /**
   * Approval policies from the tree root down to and including this Run. A tool
   * that starts further work has to pass it on, or the child would resolve its
   * permissions without the constraints its ancestors imposed.
   */
  approvalPolicyChain: AgentApprovalPolicy[];
  /**
   * Allocates the next step sequence on the calling Run. Sequences are unique per
   * run, so a tool that records its own steps must draw from the run loop's counter
   * rather than keeping one of its own.
   */
  nextSequence(): number;
  /**
   * Absolute deadline of the run tree in epoch milliseconds. A tool that starts
   * further work must not let it outlive the run that asked for it.
   */
  deadlineAt?: number;
}

export interface AgentRuntimeTool {
  key: string;
  modelName: string;
  riskLevel: AgentToolRiskLevel;
  /**
   * Per-run invocation ceiling for this specific tool, or undefined when only the
   * global ceiling applies. The global limit treats every tool alike, which is
   * wrong for anything with an external side effect: forty calls is reasonable for
   * a research tool and unreasonable for a tool that issues refunds.
   */
  maxInvocationsPerRun?: number;
  definition: ChatToolDefinition;
  execute(input: unknown, context: AgentToolExecutionContext): Promise<unknown>;
}

export const requireAgentProjectSpace = (context: AgentToolExecutionContext) => {
  if (!context.projectSpaceId) throw new Error('This tool requires an active project space');
  return context.projectSpaceId;
};
