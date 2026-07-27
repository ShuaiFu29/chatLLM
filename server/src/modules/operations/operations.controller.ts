import { Controller, Get, HttpCode, Req, Res } from '@nestjs/common';
import { AppReply, AppRequest } from '../../common/http/app-request';
import { SkipRateLimit } from '../../common/guards/rate-limit.guard';
import { serverEnv } from '../../lib/env';
import { readReadyHealth } from '../../lib/health';
import { metrics } from '../../lib/metrics';
import { classifyQueueHealth, readQueueHealthCounts } from '../../lib/queueHealth';
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
@SkipRateLimit()
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
    const result = await readReadyHealth({}, request.requestId);
    reply.code(result.statusCode).send(result.body);
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
