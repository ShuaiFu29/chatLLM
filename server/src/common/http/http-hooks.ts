import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { metrics } from '../../lib/metrics';
import { toSafeRequestId } from '../../lib/safeError';
import { AppRequest } from './app-request';

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export const registerHttpHooks = (instance: FastifyInstance) => {
  instance.addHook('onRequest', (request, reply, done) => {
    const appRequest = request as AppRequest;
    const incomingRequestId = request.headers['x-request-id'];
    const rawRequestId = Array.isArray(incomingRequestId)
      ? incomingRequestId[0]
      : incomingRequestId;
    const requestId = toSafeRequestId(rawRequestId) || randomUUID();
    const startedAt = Date.now();
    const metricsContext = metrics.recordHttpRequestStart();
    let recorded = false;

    appRequest.requestId = requestId;
    reply.header('x-request-id', requestId);
    for (const [header, value] of Object.entries(securityHeaders)) {
      reply.header(header, value);
    }

    const recordComplete = (statusCode: number) => {
      if (recorded) return;
      recorded = true;
      metrics.recordHttpRequestComplete(metricsContext, statusCode);

      console.info(JSON.stringify({
        event: 'http_request',
        request_id: requestId,
        method: request.method,
        path: request.routeOptions?.url || 'unmatched',
        status_code: statusCode,
        duration_ms: Date.now() - startedAt,
      }));
    };

    reply.raw.once('finish', () => recordComplete(reply.raw.statusCode));
    reply.raw.once('close', () => recordComplete(
      reply.raw.writableEnded ? reply.raw.statusCode : 499,
    ));
    done();
  });
};
