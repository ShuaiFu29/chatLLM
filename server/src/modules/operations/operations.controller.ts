import {
  Controller,
  Get,
  Headers,
  HttpCode,
} from '@nestjs/common';
import {
  HttpResponse,
  httpResponse,
} from '../../common/http/http-response';
import { RequestId } from '../../common/http/request-context.decorator';
import { SkipRateLimit } from '../../common/guards/rate-limit.guard';
import { serverEnv } from '../../lib/env';
import { readReadyHealth } from '../../lib/health';
import { metrics } from '../../lib/metrics';
import { classifyQueueHealth, readQueueHealthCounts } from '../../lib/queueHealth';
import { toSafeError } from '../../lib/safeError';

const readMetricsToken = (
  authorization?: unknown,
  headerToken?: unknown,
) => {
  const bearer = typeof authorization === 'string'
    ? /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1]?.trim()
    : '';
  return bearer || (typeof headerToken === 'string' ? headerToken : '');
};

const authorizeMetrics = (
  authorization?: unknown,
  headerToken?: unknown,
): HttpResponse<{ error: string }> | null => {
  if (!serverEnv.METRICS_TOKEN) {
    return httpResponse(
      { error: 'Metrics token is not configured' },
      { statusCode: 503 },
    );
  }
  if (readMetricsToken(authorization, headerToken) !== serverEnv.METRICS_TOKEN) {
    return httpResponse({ error: 'Unauthorized' }, { statusCode: 401 });
  }
  return null;
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
  async ready(@RequestId() requestId?: string) {
    const result = await readReadyHealth({}, requestId);
    return httpResponse(result.body, { statusCode: result.statusCode });
  }

  @Get('health/queues')
  async queues(
    @Headers('authorization') authorization?: unknown,
    @Headers('x-chatllm-metrics-token') headerToken?: unknown,
    @RequestId() requestId?: string,
  ) {
    const authorizationError = authorizeMetrics(authorization, headerToken);
    if (authorizationError) return authorizationError;

    try {
      const result = classifyQueueHealth(await readQueueHealthCounts());
      return httpResponse(result, {
        statusCode: result.status === 'ok' ? 200 : 503,
      });
    } catch (error) {
      console.warn('[Health] Queue health check failed:', toSafeError(error, requestId));
      return httpResponse({
        status: 'unavailable',
        checks: {
          cleanup: { status: 'error' },
          ingestion_leases: { status: 'error' },
          eval_leases: { status: 'error' },
        },
        ...(requestId ? { requestId } : {}),
      }, { statusCode: 503 });
    }
  }

  @Get('metrics')
  metrics(
    @Headers('authorization') authorization?: unknown,
    @Headers('x-chatllm-metrics-token') headerToken?: unknown,
  ) {
    const authorizationError = authorizeMetrics(authorization, headerToken);
    if (authorizationError) return authorizationError;
    return httpResponse(metrics.renderPrometheus(), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
