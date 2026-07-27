import type { Writable } from 'stream';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export class SseWriter {
  private opened = false;
  private closed = false;

  constructor(private readonly stream: Writable) {
    this.stream.once('close', () => {
      this.closed = true;
    });
  }

  get isClosed(): boolean {
    return this.closed || this.stream.destroyed || this.stream.writableEnded;
  }

  open(): boolean {
    if (this.opened) return !this.isClosed;
    if (this.isClosed) return false;
    this.opened = true;
    return true;
  }

  send(payload: unknown): Promise<boolean> {
    return this.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  done(): Promise<boolean> {
    return this.write('data: [DONE]\n\n');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.stream.destroyed && !this.stream.writableEnded) {
      this.stream.end();
    }
  }

  private write(frame: string): Promise<boolean> {
    if (!this.opened || this.isClosed) return Promise.resolve(false);
    if (this.stream.write(frame, 'utf8')) return Promise.resolve(true);

    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        this.stream.off('drain', onDrain);
        this.stream.off('close', onClose);
        this.stream.off('error', onError);
      };
      const onDrain = () => {
        cleanup();
        resolve(true);
      };
      const onClose = () => {
        cleanup();
        resolve(false);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      this.stream.once('drain', onDrain);
      this.stream.once('close', onClose);
      this.stream.once('error', onError);
      if (this.isClosed) onClose();
    });
  }
}
