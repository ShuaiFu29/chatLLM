import { serverEnv } from './env';
import { metrics } from './metrics';

interface AcquiredSlot {
  acquired: true;
  release: () => void;
}

interface RejectedSlot {
  acquired: false;
  reason: 'global' | 'user';
  retryAfterSeconds: number;
}

type SlotResult = AcquiredSlot | RejectedSlot;

class ConcurrencyGate {
  private activeTotal = 0;
  private activeByKey = new Map<string, number>();

  constructor(
    private readonly maxTotal: number,
    private readonly maxPerKey: number
  ) {}

  tryAcquire(key: string): SlotResult {
    const currentForKey = this.activeByKey.get(key) || 0;

    if (this.activeTotal >= this.maxTotal) {
      return { acquired: false, reason: 'global', retryAfterSeconds: 5 };
    }

    if (currentForKey >= this.maxPerKey) {
      return { acquired: false, reason: 'user', retryAfterSeconds: 5 };
    }

    this.activeTotal += 1;
    this.activeByKey.set(key, currentForKey + 1);

    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;

        this.activeTotal = Math.max(this.activeTotal - 1, 0);
        const nextForKey = Math.max((this.activeByKey.get(key) || 1) - 1, 0);
        if (nextForKey === 0) this.activeByKey.delete(key);
        else this.activeByKey.set(key, nextForKey);
      },
    };
  }
}

const chatStreamGate = new ConcurrencyGate(
  serverEnv.CHAT_STREAM_MAX_CONCURRENT,
  serverEnv.CHAT_STREAM_MAX_CONCURRENT_PER_USER
);

export const tryAcquireChatStreamSlot = (userId: string) => {
  const slot = chatStreamGate.tryAcquire(userId);

  if (slot.acquired) {
    metrics.recordChatStreamStarted();
    return {
      acquired: true as const,
      release: (failed = false) => {
        slot.release();
        metrics.recordChatStreamFinished(failed ? 'failed' : 'completed');
      },
    };
  }

  metrics.recordChatStreamFinished('rejected');
  return slot;
};
