export interface RequestGenerationTicket {
  key: string;
  generation: number;
  controller: AbortController;
}

export class RequestGenerationGuard {
  private generations = new Map<string, number>();
  private active = new Map<string, RequestGenerationTicket>();

  begin(key: string): RequestGenerationTicket {
    this.active.get(key)?.controller.abort();
    const generation = (this.generations.get(key) || 0) + 1;
    this.generations.set(key, generation);
    const ticket = { key, generation, controller: new AbortController() };
    this.active.set(key, ticket);
    return ticket;
  }

  isCurrent(ticket: RequestGenerationTicket) {
    return this.active.get(ticket.key) === ticket
      && this.generations.get(ticket.key) === ticket.generation
      && !ticket.controller.signal.aborted;
  }

  finish(ticket: RequestGenerationTicket) {
    const isCurrent = this.active.get(ticket.key) === ticket
      && this.generations.get(ticket.key) === ticket.generation;
    if (isCurrent) this.active.delete(ticket.key);
    return isCurrent;
  }

  abort(key: string) {
    this.active.get(key)?.controller.abort();
    this.active.delete(key);
    this.generations.set(key, (this.generations.get(key) || 0) + 1);
  }

  abortAll() {
    for (const key of this.active.keys()) this.abort(key);
  }
}

export const isRequestAbortError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError'
    || candidate.name === 'CanceledError'
    || candidate.code === 'ERR_CANCELED';
};

export interface CompletionPoller {
  start: () => void;
  startNow: () => void;
  stop: () => void;
  isRunning: () => boolean;
}

export const createCompletionPoller = (
  task: () => Promise<void>,
  intervalMs: number,
): CompletionPoller => {
  let running = false;
  let inFlight = false;
  let runImmediately = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function runTask() {
    if (!running || inFlight) return;
    inFlight = true;
    void Promise.resolve()
      .then(task)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (running && runImmediately) {
          runImmediately = false;
          runTask();
        } else {
          schedule();
        }
      });
  }

  function schedule() {
    if (!running || inFlight || timer) return;
    timer = setTimeout(() => {
      timer = null;
      runTask();
    }, intervalMs);
  }

  return {
    start: () => {
      if (running) return;
      running = true;
      schedule();
    },
    startNow: () => {
      running = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (inFlight) {
        runImmediately = true;
        return;
      }
      runImmediately = false;
      runTask();
    },
    stop: () => {
      running = false;
      runImmediately = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    isRunning: () => running,
  };
};
