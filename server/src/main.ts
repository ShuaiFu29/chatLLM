import 'reflect-metadata';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { registerHttpHooks } from './common/http/http-hooks';
import { RuntimeLifecycleService } from './infrastructure/runtime-lifecycle.service';
import { serverEnv } from './lib/env';
import {
  JSON_REQUEST_LIMIT_BYTES,
  URLENCODED_REQUEST_LIMIT_BYTES,
} from './lib/requestLimits';
import {
  AVATAR_UPLOAD_LIMIT_BYTES,
} from './lib/uploadLimits';
import { toSafeError } from './lib/safeError';

const operationalRoutes = [
  'health',
  'health/live',
  'health/ready',
  'health/queues',
  'metrics',
].map((path) => ({ path, method: RequestMethod.GET }));

export const createApplication = async () => {
  const adapter = new FastifyAdapter({
    bodyLimit: JSON_REQUEST_LIMIT_BYTES,
    trustProxy: serverEnv.TRUST_PROXY_HOPS,
    disableRequestLogging: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  const fastify = app.getHttpAdapter().getInstance();

  registerHttpHooks(fastify);
  await app.register(cookie);
  await app.register(formbody, { bodyLimit: URLENCODED_REQUEST_LIMIT_BYTES });
  await app.register(multipart, {
    limits: {
      fileSize: AVATAR_UPLOAD_LIMIT_BYTES,
      files: 1,
      fields: 8,
      parts: 9,
    },
  });
  await app.register(cors, {
    credentials: true,
    exposedHeaders: [
      'x-chatllm-has-more',
      'x-chatllm-next-cursor',
      'x-chatllm-page-limit',
    ],
    origin: (origin, callback) => {
      if (!origin || serverEnv.CORS_ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      const error = new Error('Not allowed by CORS') as Error & { statusCode?: number };
      error.statusCode = 403;
      callback(error, false);
    },
  });

  app.setGlobalPrefix('api', { exclude: operationalRoutes });
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  return app;
};

export const bootstrap = async () => {
  const app = await createApplication();
  await app.listen(serverEnv.PORT, '0.0.0.0');
  app.get(RuntimeLifecycleService).startMaintenance();
  console.log(`Server running on port ${serverEnv.PORT}`);
  return app;
};

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('[Server] Failed to start:', toSafeError(error));
    process.exitCode = 1;
  });
}
