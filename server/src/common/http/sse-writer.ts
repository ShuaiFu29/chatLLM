import type { ServerResponse } from 'http';
import type { AppReply } from './app-request';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

export class SseWriter {
  private readonly response: ServerResponse;
  private opened = false;
  private closed = false;

  constructor(private readonly reply: AppReply) {
    this.response = reply.raw;
    this.response.once('close', () => {
      this.closed = true;
    });
  }

  get isClosed(): boolean {
    return this.closed || this.response.destroyed || this.response.writableEnded;
  }

  open(): boolean {
    if (this.opened) return !this.isClosed;
    if (this.isClosed) return false;

    this.reply.hijack();
    for (const [name, value] of Object.entries(this.reply.getHeaders())) {
      if (value !== undefined) this.response.setHeader(name, value);
    }
    for (const [name, value] of Object.entries(SSE_HEADERS)) {
      this.response.setHeader(name, value);
    }
    this.response.writeHead(200);
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
    if (!this.response.destroyed && !this.response.writableEnded) {
      this.response.end();
    }
  }

  private write(frame: string): Promise<boolean> {
    if (!this.opened || this.isClosed) return Promise.resolve(false);
    if (this.response.write(frame, 'utf8')) return Promise.resolve(true);

    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        this.response.off('drain', onDrain);
        this.response.off('close', onClose);
        this.response.off('error', onError);
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

      this.response.once('drain', onDrain);
      this.response.once('close', onClose);
      this.response.once('error', onError);
      if (this.isClosed) onClose();
    });
  }
}
