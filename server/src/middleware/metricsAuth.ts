import { RequestHandler } from 'express';
import { serverEnv } from '../lib/env';

const readBearerToken = (authorization?: string) => {
  if (!authorization) return '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || '';
};

export const metricsAuthMiddleware: RequestHandler = (req, res, next) => {
  const expectedToken = serverEnv.METRICS_TOKEN;
  if (!expectedToken) {
    res.status(503).json({ error: 'Metrics token is not configured' });
    return;
  }

  const providedToken = readBearerToken(req.header('authorization')) || req.header('x-chatllm-metrics-token') || '';
  if (providedToken === expectedToken) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
};
