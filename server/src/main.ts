import 'reflect-metadata';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { NestApplicationOptions, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { LogController } from 'fastify';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { registerHttpHooks } from './common/http/http-hooks';
import { HttpResponseInterceptor } from './common/interceptors/http-response.interceptor';
import { registerGlobalRateLimitHook } from './common/http/global-rate-limit-hook';
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

interface CreateApplicationOptions {
  createNestApplication?: (
    adapter: FastifyAdapter,
    options: NestApplicationOptions,
  ) => NestFastifyApplication | Promise<NestFastifyApplication>;
}

const nestApplicationOptions: NestApplicationOptions = {
  bodyParser: false,
};

export const createApplication = async (options: CreateApplicationOptions = {}) => {
  const adapter = new FastifyAdapter({
    bodyLimit: JSON_REQUEST_LIMIT_BYTES,
    trustProxy: serverEnv.TRUST_PROXY_HOPS,
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: {
      ignoreTrailingSlash: true,
      caseSensitive: false,
    },
  });
  const app = options.createNestApplication
    ? await options.createNestApplication(adapter, nestApplicationOptions)
    : await NestFactory.create<NestFastifyApplication>(
      AppModule,
      adapter,
      nestApplicationOptions,
    );
  try {
    const fastify = app.getHttpAdapter().getInstance();

    registerHttpHooks(fastify);
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
    await app.register(cookie);
    registerGlobalRateLimitHook(fastify);
    await app.register(formbody, { bodyLimit: URLENCODED_REQUEST_LIMIT_BYTES });
    await app.register(multipart, {
      limits: {
        fileSize: AVATAR_UPLOAD_LIMIT_BYTES,
        files: 1,
        fields: 8,
        parts: 9,
      },
    });

    app.setGlobalPrefix('api', { exclude: operationalRoutes });
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new HttpResponseInterceptor());
    return app;
  } catch (error) {
    await app.close().catch((closeError) => {
      console.error('[Server] Failed to close after application setup error:', toSafeError(closeError));
    });
    throw error;
  }
};

interface ShutdownSignalTarget {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

interface ShutdownHandlerOptions {
  signalTarget?: ShutdownSignalTarget;
  timeoutMs?: number;
  exit?: (code: number) => void;
}

export const installShutdownHandlers = (
  app: Pick<NestFastifyApplication, 'close'>,
  options: ShutdownHandlerOptions = {},
) => {
  const signalTarget = options.signalTarget ?? process;
  const timeoutMs = options.timeoutMs ?? serverEnv.SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shutdownPromise: Promise<void> | null = null;
  let timeout: NodeJS.Timeout | null = null;
  let exited = false;

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  const onSigint = () => { void shutdown('SIGINT'); };
  const onSigterm = () => { void shutdown('SIGTERM'); };
  const dispose = () => {
    signalTarget.off('SIGINT', onSigint);
    signalTarget.off('SIGTERM', onSigterm);
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    console.log(`[Server] ${signal} received; closing application`);
    timeout = setTimeout(() => {
      console.error('[Server] Graceful shutdown timed out');
      dispose();
      exitOnce(1);
    }, timeoutMs);
    timeout.unref();

    shutdownPromise = (async () => {
      try {
        await app.close();
        dispose();
        console.log('[Server] Shutdown complete');
        exitOnce(0);
      } catch (error) {
        dispose();
        console.error('[Server] Shutdown failed:', toSafeError(error));
        exitOnce(1);
      }
    })();
    return shutdownPromise;
  };

  signalTarget.once('SIGINT', onSigint);
  signalTarget.once('SIGTERM', onSigterm);
  return { dispose, shutdown };
};

export const bootstrap = async () => {
  const app = await createApplication();
  let shutdownHandlers: ReturnType<typeof installShutdownHandlers> | null = null;
  try {
    await app.listen(serverEnv.PORT, '0.0.0.0');
    shutdownHandlers = installShutdownHandlers(app);
    app.get(RuntimeLifecycleService).startMaintenance();
    console.log(`Server running on port ${serverEnv.PORT}`);
    return app;
  } catch (error) {
    shutdownHandlers?.dispose();
    await app.close().catch((closeError) => {
      console.error('[Server] Failed to close after startup error:', toSafeError(closeError));
    });
    throw error;
  }
};

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('[Server] Failed to start:', toSafeError(error));
    process.exitCode = 1;
  });
}
