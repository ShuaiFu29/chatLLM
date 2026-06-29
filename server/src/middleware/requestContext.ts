import { randomUUID } from 'crypto';
import { RequestHandler } from 'express';
import { metrics } from '../lib/metrics';

export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const incomingRequestId = req.header('x-request-id');
  const requestId = incomingRequestId && incomingRequestId.trim()
    ? incomingRequestId.trim()
    : randomUUID();
  const startedAt = Date.now();
  const metricsContext = metrics.recordHttpRequestStart();
  let recorded = false;

  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const recordComplete = (statusCode: number) => {
    if (recorded) return;
    recorded = true;

    metrics.recordHttpRequestComplete(metricsContext, statusCode);

    console.info(JSON.stringify({
      event: 'http_request',
      request_id: requestId,
      method: req.method,
      path: req.originalUrl,
      status_code: statusCode,
      duration_ms: Date.now() - startedAt,
    }));
  };

  res.on('finish', () => recordComplete(res.statusCode));
  res.on('close', () => recordComplete(res.writableEnded ? res.statusCode : 499));

  next();
};
