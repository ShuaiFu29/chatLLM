import { Controller, Get, HttpCode, Req, Res } from '@nestjs/common';
import { AppReply, AppRequest } from '../../common/http/app-request';
import { checkDatabaseReady } from '../../lib/db';
import { serverEnv } from '../../lib/env';
import { metrics } from '../../lib/metrics';
import { classifyQueueHealth, readQueueHealthCounts } from '../../lib/queueHealth';
import { checkRagServiceReady } from '../../lib/ragClient';
import { checkRedisReady } from '../../lib/redis';
import { toSafeError } from '../../lib/safeError';

const readMetricsToken = (request: AppRequest) => {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === 'string'
    ? /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1]?.trim()
    : '';
  const headerToken = request.headers['x-chatllm-metrics-token'];
  return bearer || (typeof headerToken === 'string' ? headerToken : '');
};

const authorizeMetrics = (request: AppRequest, reply: AppReply) => {
  if (!serverEnv.METRICS_TOKEN) {
    reply.code(503).send({ error: 'Metrics token is not configured' });
    return false;
  }
  if (readMetricsToken(request) !== serverEnv.METRICS_TOKEN) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
};

@Controller()
export class OperationsController {
  @Get('health')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  @Get('health/live')
  @HttpCode(200)
  liveAlias() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Req() request: AppRequest, @Res() reply: AppReply) {
    const checks: Record<string, 'ok' | 'error'> = {
      postgres: 'error',
      redis: 'error',
      rag: 'error',
    };
    const dependencies = [
      ['postgres', checkDatabaseReady],
      ['redis', checkRedisReady],
      ['rag', checkRagServiceReady],
    ] as const;

    for (const [name, check] of dependencies) {
      try {
        await check();
        checks[name] = 'ok';
      } catch (error) {
        console.warn(`[Health] ${name} readiness check failed:`, toSafeError(error, request.requestId));
      }
    }

    const isReady = Object.values(checks).every((status) => status === 'ok');
    reply.code(isReady ? 200 : 503).send({
      status: isReady ? 'ready' : 'not_ready',
      checks,
    });
  }

  @Get('health/queues')
  async queues(@Req() request: AppRequest, @Res() reply: AppReply) {
    if (!authorizeMetrics(request, reply)) return;

    try {
      const result = classifyQueueHealth(await readQueueHealthCounts());
      reply.code(result.status === 'ok' ? 200 : 503).send(result);
    } catch (error) {
      console.warn('[Health] Queue health check failed:', toSafeError(error, request.requestId));
      reply.code(503).send({
        status: 'unavailable',
        checks: {
          cleanup: { status: 'error' },
          ingestion_leases: { status: 'error' },
          eval_leases: { status: 'error' },
        },
        ...(request.requestId ? { requestId: request.requestId } : {}),
      });
    }
  }

  @Get('metrics')
  metrics(@Req() request: AppRequest, @Res() reply: AppReply) {
    if (!authorizeMetrics(request, reply)) return;
    reply.type('text/plain').send(metrics.renderPrometheus());
  }
}
