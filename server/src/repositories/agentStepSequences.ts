import { query } from '../lib/db';

export class AgentStepSequenceError extends Error {
  constructor(readonly code: 'owner_lost' | 'invalid', message: string) {
    super(message);
    this.name = 'AgentStepSequenceError';
  }
}

export interface AgentStepSequenceStore {
  allocate(input: {
    runId: string;
    leaseToken: string;
    fencingGeneration: number;
  }): Promise<{ sequence: number; nextSequence: number } | null>;
}

export const allocateAgentStepSequence = async (input: {
  runId: string;
  leaseToken: string;
  fencingGeneration: number;
}) => {
  const { rows } = await query<{ sequence: string | number; next_sequence: string | number }>(
    `with allocated as (
       update agent_runs run
       set next_step_sequence = run.next_step_sequence + 1
       from agent_work_items work
       where run.id = $1
         and work.run_id = run.id
         and work.status = 'running'
         and work.lease_token = $2::uuid
         and work.fencing_generation = $3
         and work.lease_expires_at > now()
         and run.status in ('running', 'waiting_approval', 'waiting_subagent')
       returning run.next_step_sequence - 1 as sequence,
                 run.next_step_sequence as next_sequence
     )
     select sequence, next_sequence from allocated`,
    [input.runId, input.leaseToken, input.fencingGeneration],
  );
  const row = rows[0];
  if (!row) return null;
  const sequence = Number(row.sequence);
  const nextSequence = Number(row.next_sequence);
  if (
    !Number.isSafeInteger(sequence)
    || sequence < 0
    || !Number.isSafeInteger(nextSequence)
    || nextSequence !== sequence + 1
  ) {
    throw new AgentStepSequenceError('invalid', 'Agent step sequence allocator returned invalid state');
  }
  return { sequence, nextSequence };
};

const postgresStepSequenceStore: AgentStepSequenceStore = {
  allocate: allocateAgentStepSequence,
};

/** Claim-fenced adapter shared by root and delegated Agent runtimes. */
export class AgentStepSequenceAllocator {
  private nextHint: number;

  constructor(
    private readonly identity: {
      runId: string;
      leaseToken: string;
      fencingGeneration: number;
    },
    private readonly store: AgentStepSequenceStore = postgresStepSequenceStore,
    initialNextSequence = 0,
  ) {
    if (!Number.isSafeInteger(initialNextSequence) || initialNextSequence < 0) {
      throw new AgentStepSequenceError('invalid', 'Initial Agent step sequence is invalid');
    }
    this.nextHint = initialNextSequence;
  }

  get nextSequenceHint() { return this.nextHint; }

  async next() {
    const allocated = await this.store.allocate(this.identity);
    if (!allocated) {
      throw new AgentStepSequenceError(
        'owner_lost',
        'Agent Work Item ownership was lost before allocating a Step',
      );
    }
    this.nextHint = allocated.nextSequence;
    return allocated.sequence;
  }
}
