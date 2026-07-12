import { randomUUID } from 'crypto';
import { RequestHandler } from 'express';
import { metrics } from '../lib/metrics';
import { toSafeRequestId } from '../lib/safeError';

const getRouteLabel = (req: Parameters<RequestHandler>[0]) =>
  typeof req.route?.path === 'string' && req.route.path
    ? req.route.path
    : 'unmatched';

export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const incomingRequestId = req.header('x-request-id');
  const requestId = toSafeRequestId(incomingRequestId) || randomUUID();
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
      path: getRouteLabel(req),
      status_code: statusCode,
      duration_ms: Date.now() - startedAt,
    }));
  };

  res.on('finish', () => recordComplete(res.statusCode));
  res.on('close', () => recordComplete(res.writableEnded ? res.statusCode : 499));

  next();
};
