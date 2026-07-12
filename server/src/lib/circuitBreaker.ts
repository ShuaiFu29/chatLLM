export interface CircuitPermit {
  isProbe: boolean;
}

interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
  probeInFlight: boolean;
}

interface OperationCircuitBreakerOptions {
  failureThreshold: number;
  resetMs: number;
  now?: () => number;
  isServiceFailure: (error: unknown) => boolean;
}

export class CircuitOpenError<Operation extends string> extends Error {
  readonly code = 'RAG_CIRCUIT_OPEN';

  constructor(readonly operation: Operation) {
    super(`RAG ${operation} circuit is open`);
    this.name = 'CircuitOpenError';
  }
}

export class OperationCircuitBreaker<Operation extends string> {
  private readonly states = new Map<Operation, CircuitState>();
  private readonly now: () => number;

  constructor(private readonly options: OperationCircuitBreakerOptions) {
    this.now = options.now || Date.now;
  }

  acquire(operation: Operation): CircuitPermit {
    const state = this.getState(operation);
    if (state.openedAt === null) return { isProbe: false };

    const resetElapsed = this.now() - state.openedAt >= this.options.resetMs;
    if (!resetElapsed || state.probeInFlight) {
      throw new CircuitOpenError(operation);
    }

    state.probeInFlight = true;
    return { isProbe: true };
  }

  recordSuccess(operation: Operation) {
    this.states.delete(operation);
  }

  recordFailure(operation: Operation, permit: CircuitPermit, error: unknown) {
    const state = this.getState(operation);
    if (permit.isProbe) state.probeInFlight = false;
    if (!this.options.isServiceFailure(error)) return;

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.options.failureThreshold) {
      state.openedAt = this.now();
    }
  }

  private getState(operation: Operation): CircuitState {
    const existing = this.states.get(operation);
    if (existing) return existing;

    const created: CircuitState = {
      consecutiveFailures: 0,
      openedAt: null,
      probeInFlight: false,
    };
    this.states.set(operation, created);
    return created;
  }
}
