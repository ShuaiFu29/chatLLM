import { createHash } from 'node:crypto';
import { serverEnv } from '../../../lib/env';
import type { ChatMessageParam } from '../../../lib/llmProviders';
import {
  normalizeAgentContextCheckpointState,
  type AgentContextCheckpointState,
} from './agent-context-manager';
import {
  normalizeAgentEvidenceSnapshot,
  type AgentEvidenceSnapshot,
} from './agent-evidence';
import {
  saveAgentRunCheckpoint,
  type AgentRunCheckpointBoundary,
  type AgentRunCheckpointRow,
} from '../../../repositories/agentRunCheckpoints';

export const AGENT_CHECKPOINT_FORMAT_VERSION = 1 as const;

export interface AgentExecutionCheckpoint {
  readonly formatVersion: typeof AGENT_CHECKPOINT_FORMAT_VERSION;
  readonly boundary: AgentRunCheckpointBoundary;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadBytes: number;
  readonly stateHash: string;
}

export class AgentCheckpointError extends Error {
  constructor(
    readonly code: 'invalid' | 'too_large' | 'owner_lost',
    message: string,
  ) {
    super(message);
    this.name = 'AgentCheckpointError';
  }
}

const cloneJsonObject = (payload: Record<string, unknown>) => {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new AgentCheckpointError('invalid', 'Agent checkpoint payload must be JSON serializable');
  }
  if (!serialized || serialized === 'null' || serialized[0] !== '{') {
    throw new AgentCheckpointError('invalid', 'Agent checkpoint payload must be an object');
  }
  const payloadBytes = Buffer.byteLength(serialized, 'utf8');
  if (payloadBytes > Math.min(serverEnv.AGENT_MAX_STEP_PAYLOAD_BYTES, 262_144)) {
    throw new AgentCheckpointError('too_large', 'Agent checkpoint payload exceeds its byte limit');
  }
  return { payload: JSON.parse(serialized) as Record<string, unknown>, payloadBytes };
};

const deepFreezeJson = <T>(value: T): T => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeJson(child);
  }
  return Object.freeze(value);
};

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
};

/** Stable across PostgreSQL jsonb key reordering. */
export const hashAgentCheckpointPayload = (payload: Record<string, unknown>) => createHash('sha256')
  .update(JSON.stringify(sortJsonValue(payload)))
  .digest('hex');

/** Freeze a detached snapshot so later loop mutations cannot change what is written. */
export const createAgentExecutionCheckpoint = (input: {
  boundary: AgentRunCheckpointBoundary;
  payload: Record<string, unknown>;
}): AgentExecutionCheckpoint => {
  const cloned = cloneJsonObject(input.payload);
  const immutablePayload = deepFreezeJson(cloned.payload);
  return Object.freeze({
    formatVersion: AGENT_CHECKPOINT_FORMAT_VERSION,
    boundary: input.boundary,
    payload: immutablePayload,
    payloadBytes: cloned.payloadBytes,
    stateHash: hashAgentCheckpointPayload(immutablePayload),
  });
};

export type AgentCheckpointPendingOperation =
  | { kind: 'none' }
  | { kind: 'tool_batch'; toolCalls: unknown[] }
  | { kind: 'approval'; approvalId: string; toolCallId: string }
  | { kind: 'subagents'; toolCallId: string; arguments: unknown }
  | {
    kind: 'final_answer';
    content: string;
    sources: unknown[];
    grounding: unknown;
    result?: unknown;
    parentSpanId?: string | null;
  };

export interface AgentRuntimeCheckpointState {
  phase: AgentRunCheckpointBoundary;
  messages: ChatMessageParam[];
  counters: {
    iteration: number;
    toolCalls: number;
    nextStepSequence: number;
  };
  usage: Record<string, number>;
  budget: {
    rootRunId: string;
    deadlineAt: number;
    degraded: boolean;
  };
  evidence: AgentEvidenceSnapshot;
  /** Mutable context-compaction cursor needed for deterministic continuation. */
  context?: AgentContextCheckpointState;
  pending: AgentCheckpointPendingOperation;
  /** Exact pre-provider reservation represented by a model_ready boundary. */
  modelInvocation?: {
    invocationId: string;
    reservationTokens: number;
    estimatedPromptTokens: number;
    /** Canonical hash of the exact provider-visible request. */
    requestHash?: string;
  };
}

const nonNegativeInteger = (value: number, name: string) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new AgentCheckpointError('invalid', `${name} must be a non-negative integer`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const invalid = (message: string): never => {
  throw new AgentCheckpointError('invalid', message);
};

const validateToolCall = (value: unknown) => {
  if (!isRecord(value) || typeof value.id !== 'string' || value.type !== 'function') {
    invalid('Agent checkpoint tool call is invalid');
  }
  const fn = (value as Record<string, unknown>).function;
  if (!isRecord(fn) || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
    invalid('Agent checkpoint tool call function is invalid');
  }
};

const validateMessage = (value: unknown) => {
  if (!isRecord(value) || !['system', 'user', 'assistant', 'tool'].includes(String(value.role))) {
    invalid('Agent checkpoint message role is invalid');
  }
  const message = value as Record<string, unknown>;
  if (message.content !== null && typeof message.content !== 'string') {
    invalid('Agent checkpoint message content is invalid');
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) invalid('Agent checkpoint message tools are invalid');
    (message.tool_calls as unknown[]).forEach(validateToolCall);
  }
  if (message.tool_call_id !== undefined && typeof message.tool_call_id !== 'string') {
    invalid('Agent checkpoint tool message identity is invalid');
  }
};

const validateUsage = (value: unknown) => {
  if (!isRecord(value)) invalid('Agent checkpoint usage must be an object');
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (!key || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      invalid('Agent checkpoint usage contains an invalid counter');
    }
  }
};

const expectedPendingKind: Record<
  AgentRunCheckpointBoundary,
  AgentCheckpointPendingOperation['kind']
> = {
  execution_ready: 'none',
  model_ready: 'none',
  tool_batch_ready: 'tool_batch',
  approval_wait: 'approval',
  subagents_wait: 'subagents',
  final_answer_ready: 'final_answer',
};

const validatePending = (
  boundary: AgentRunCheckpointBoundary,
  pending: AgentCheckpointPendingOperation,
) => {
  if (!isRecord(pending) || pending.kind !== expectedPendingKind[boundary]) {
    invalid('Agent checkpoint pending operation does not match its boundary');
  }
  if (pending.kind === 'tool_batch') {
    if (!Array.isArray(pending.toolCalls)) invalid('Agent checkpoint tool batch is invalid');
    pending.toolCalls.forEach(validateToolCall);
  } else if (pending.kind === 'approval') {
    if (!pending.approvalId || !pending.toolCallId) invalid('Agent checkpoint approval is invalid');
  } else if (pending.kind === 'subagents') {
    if (!pending.toolCallId) invalid('Agent checkpoint subagent dispatch is invalid');
  } else if (pending.kind === 'final_answer') {
    if (typeof pending.content !== 'string' || !Array.isArray(pending.sources)) {
      invalid('Agent checkpoint final answer is invalid');
    }
    if (
      pending.parentSpanId !== undefined
      && pending.parentSpanId !== null
      && typeof pending.parentSpanId !== 'string'
    ) invalid('Agent checkpoint final answer parent span is invalid');
  }
};

const validateModelInvocation = (
  phase: AgentRunCheckpointBoundary,
  value: unknown,
) => {
  if (value === undefined) return;
  if (phase !== 'model_ready' || !isRecord(value)) {
    return invalid('Agent checkpoint model invocation is only valid at model_ready');
  }
  if (typeof value.invocationId !== 'string' || !value.invocationId) {
    invalid('Agent checkpoint model invocation identity is invalid');
  }
  nonNegativeInteger(Number(value.reservationTokens), 'Agent checkpoint model reservation');
  nonNegativeInteger(Number(value.estimatedPromptTokens), 'Agent checkpoint prompt estimate');
  if (Number(value.reservationTokens) <= 0) {
    invalid('Agent checkpoint model reservation must be positive');
  }
  if (Number(value.estimatedPromptTokens) > Number(value.reservationTokens)) {
    invalid('Agent checkpoint prompt estimate exceeds its reservation');
  }
  if (
    value.requestHash !== undefined
    && (typeof value.requestHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.requestHash))
  ) invalid('Agent checkpoint model request hash is invalid');
};

const normalizeRuntimeState = (value: unknown): AgentRuntimeCheckpointState => {
  if (!isRecord(value)) invalid('Agent runtime checkpoint must be an object');
  const state = value as Record<string, unknown>;
  const phase = state.phase;
  if (![
    'execution_ready',
    'model_ready',
    'tool_batch_ready',
    'approval_wait',
    'subagents_wait',
    'final_answer_ready',
  ]
    .includes(String(phase))) invalid('Agent checkpoint phase is invalid');
  if (!Array.isArray(state.messages) || state.messages.length === 0) {
    invalid('Agent checkpoint messages cannot be empty');
  }
  const messages = state.messages as unknown[];
  messages.forEach(validateMessage);
  if (!isRecord(state.counters)) invalid('Agent checkpoint counters are invalid');
  const counters = state.counters as Record<string, unknown>;
  nonNegativeInteger(Number(counters.iteration), 'Agent checkpoint iteration');
  nonNegativeInteger(Number(counters.toolCalls), 'Agent checkpoint tool calls');
  nonNegativeInteger(Number(counters.nextStepSequence), 'Agent checkpoint step sequence');
  validateUsage(state.usage);
  if (
    !isRecord(state.budget)
    || typeof state.budget.rootRunId !== 'string'
    || !state.budget.rootRunId
    || typeof state.budget.deadlineAt !== 'number'
    || !Number.isSafeInteger(state.budget.deadlineAt)
    || state.budget.deadlineAt <= 0
    || typeof state.budget.degraded !== 'boolean'
  ) invalid('Agent checkpoint budget is invalid');
  const evidence = normalizeAgentEvidenceSnapshot(state.evidence);
  let context: AgentContextCheckpointState | undefined;
  if (state.context !== undefined) {
    try {
      context = normalizeAgentContextCheckpointState({
        messages: messages as ChatMessageParam[],
        state: state.context,
      });
    } catch (error) {
      invalid(error instanceof Error ? error.message : 'Agent context checkpoint is invalid');
    }
  }
  validatePending(
    phase as AgentRunCheckpointBoundary,
    state.pending as AgentCheckpointPendingOperation,
  );
  validateModelInvocation(phase as AgentRunCheckpointBoundary, state.modelInvocation);
  return {
    phase: phase as AgentRunCheckpointBoundary,
    messages: messages as ChatMessageParam[],
    counters: state.counters as unknown as AgentRuntimeCheckpointState['counters'],
    usage: state.usage as Record<string, number>,
    budget: state.budget as unknown as AgentRuntimeCheckpointState['budget'],
    evidence,
    ...(context ? { context } : {}),
    pending: state.pending as AgentCheckpointPendingOperation,
    ...(state.modelInvocation === undefined ? {} : {
      modelInvocation: state.modelInvocation as AgentRuntimeCheckpointState['modelInvocation'],
    }),
  };
};

export const createAgentRuntimeCheckpoint = (
  state: AgentRuntimeCheckpointState,
): AgentExecutionCheckpoint => {
  const normalized = normalizeRuntimeState(state);
  return createAgentExecutionCheckpoint({
    boundary: normalized.phase,
    payload: normalized as unknown as Record<string, unknown>,
  });
};

/** Validate format, hash and shape before a durable row is used for recovery. */
export const restoreAgentRuntimeCheckpoint = (
  row: AgentRunCheckpointRow,
): Readonly<AgentRuntimeCheckpointState> => {
  if (row.format_version !== AGENT_CHECKPOINT_FORMAT_VERSION) {
    invalid('Agent checkpoint format is unsupported');
  }
  if (!/^[0-9a-f]{64}$/.test(row.state_hash)) invalid('Agent checkpoint hash is invalid');
  if (hashAgentCheckpointPayload(row.payload) !== row.state_hash) {
    invalid('Agent checkpoint state hash does not match its payload');
  }
  const normalized = normalizeRuntimeState(row.payload);
  if (normalized.phase !== row.boundary) {
    invalid('Agent checkpoint row boundary does not match its payload');
  }
  return deepFreezeJson(structuredClone(normalized));
};

export interface AgentCheckpointStore {
  save(input: {
    runId: string;
    userId: string;
    expectedGeneration: number;
    leaseToken?: string | null;
    boundary: AgentRunCheckpointBoundary;
    payload: Record<string, unknown>;
    stateHash: string;
  }): Promise<AgentRunCheckpointRow | null>;
}

const postgresCheckpointStore: AgentCheckpointStore = { save: saveAgentRunCheckpoint };

/**
 * Run-local adapter over the durable CAS store. Any rejected write means this
 * execution path lost ownership and must stop before another external action.
 */
export class AgentCheckpointCoordinator {
  private generation: number;

  constructor(
    private readonly identity: { runId: string; userId: string; leaseToken?: string | null },
    private readonly store: AgentCheckpointStore = postgresCheckpointStore,
    initialGeneration = 0,
  ) {
    if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 0) {
      throw new AgentCheckpointError('invalid', 'Initial Agent checkpoint generation is invalid');
    }
    this.generation = initialGeneration;
  }

  get currentGeneration() {
    return this.generation;
  }

  /** Accept a checkpoint committed atomically with another durable boundary. */
  adopt(row: AgentRunCheckpointRow) {
    if (
      row.run_id !== this.identity.runId
      || row.generation !== this.generation + 1
      || row.owner_lease_token !== (this.identity.leaseToken || null)
    ) {
      throw new AgentCheckpointError(
        'owner_lost',
        'Atomically committed Agent checkpoint does not belong to this owner',
      );
    }
    this.generation = row.generation;
    return row;
  }

  async save(checkpoint: AgentExecutionCheckpoint) {
    const row = await this.store.save({
      ...this.identity,
      expectedGeneration: this.generation,
      boundary: checkpoint.boundary,
      payload: checkpoint.payload as Record<string, unknown>,
      stateHash: checkpoint.stateHash,
    });
    if (!row) {
      throw new AgentCheckpointError(
        'owner_lost',
        'Agent checkpoint owner or generation is no longer current',
      );
    }
    this.generation = row.generation;
    return row;
  }
}
