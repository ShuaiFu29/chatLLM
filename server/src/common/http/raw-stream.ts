import type { ServerResponse } from 'http';
import type { Readable } from 'stream';
import type { AppReply } from './app-request';

const copyReplyHeaders = (reply: AppReply, response: ServerResponse) => {
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) response.setHeader(name, value);
  }
};

export const streamReadableReply = async (
  stream: Readable,
  reply: AppReply,
): Promise<void> => {
  reply.hijack();
  const response = reply.raw;
  copyReplyHeaders(reply, response);

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      stream.off('error', onStreamError);
      response.off('error', onResponseError);
      response.off('finish', onFinish);
      response.off('close', onClose);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onStreamError = (error: Error) => {
      stream.unpipe(response);
      settle(error);
    };
    const onResponseError = (error: Error) => {
      stream.unpipe(response);
      if (!stream.destroyed) stream.destroy();
      settle(error);
    };
    const onFinish = () => settle();
    const onClose = () => {
      stream.unpipe(response);
      if (!stream.destroyed) stream.destroy();
      settle();
    };

    stream.once('error', onStreamError);
    response.once('error', onResponseError);
    response.once('finish', onFinish);
    response.once('close', onClose);

    if (response.destroyed || response.writableEnded) {
      onClose();
      return;
    }
    stream.pipe(response);
  });
};

export const sendHijackedJson = (
  reply: AppReply,
  statusCode: number,
  payload: unknown,
): boolean => {
  const response = reply.raw;
  if (response.headersSent || response.destroyed || response.writableEnded) return false;

  response.statusCode = statusCode;
  response.removeHeader('Content-Disposition');
  response.removeHeader('Content-Length');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
  return true;
};

export const endHijackedReply = (reply: AppReply): void => {
  const response = reply.raw;
  if (!response.destroyed && !response.writableEnded) response.end();
};
