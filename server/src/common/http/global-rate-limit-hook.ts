import { FastifyInstance } from 'fastify';
import {
  consumeRequestRateLimit,
} from '../guards/rate-limit.guard';
import { serverEnv } from '../../lib/env';
import { toSafeError } from '../../lib/safeError';
import { AppReply, AppRequest } from './app-request';

const operationalRoutes = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/health/queues',
  '/metrics',
]);

export const registerGlobalRateLimitHook = (instance: FastifyInstance) => {
  instance.addHook('onRequest', async (rawRequest, rawReply) => {
    const request = rawRequest as AppRequest;
    const reply = rawReply as AppReply;
    if (operationalRoutes.has(request.routeOptions?.url || '')) return;

    try {
      const decision = await consumeRequestRateLimit(request, reply, {
        keyPrefix: 'global',
        max: serverEnv.RATE_LIMIT_MAX,
      });
      if (!decision.allowed) {
        await reply.code(decision.statusCode).send(decision.body);
      }
    } catch (error) {
      console.error(
        '[RateLimit] Shared store unavailable:',
        toSafeError(error, request.requestId),
      );
      reply.header('Retry-After', '1');
      await reply.code(503).send({
        error: 'Rate limit service unavailable',
        requestId: request.requestId,
      });
    }
  });
};
