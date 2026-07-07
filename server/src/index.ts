import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { serverEnv } from './lib/env';
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import uploadRoutes from './routes/upload';
import searchRoutes from './routes/search';
import projectSpaceRoutes from './routes/projectSpaces';
import usageRoutes from './routes/usage';
import promptTemplateRoutes from './routes/promptTemplates';
import ragEvalRoutes from './routes/ragEval';
import ragWorkbenchRoutes from './routes/ragWorkbench';
import { fileQueue } from './services/fileQueue';
import { ragEvalQueue } from './services/ragEvalQueue';
import { maintenanceService } from './services/maintenance';
import { JSON_REQUEST_LIMIT, URLENCODED_REQUEST_LIMIT } from './lib/requestLimits';
import { runMigrations } from './lib/migrations';
import { liveHealthHandler, readyHealthHandler } from './lib/health';
import { installGracefulShutdown } from './lib/gracefulShutdown';
import { requestContextMiddleware } from './middleware/requestContext';
import { createRateLimit } from './middleware/rateLimit';
import { metricsHandler } from './lib/metrics';
import { metricsAuthMiddleware } from './middleware/metricsAuth';
import { securityHeadersMiddleware } from './middleware/securityHeaders';
import { errorHandlerMiddleware } from './middleware/errorHandler';
import { notFoundMiddleware } from './middleware/notFound';

export const app = express();

const PORT = serverEnv.PORT;

const allowedOrigins = serverEnv.CORS_ALLOWED_ORIGINS;

app.set('trust proxy', 1);
app.use(requestContextMiddleware);
app.use(securityHeadersMiddleware);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  exposedHeaders: [
    'x-chatllm-has-more',
    'x-chatllm-next-cursor',
    'x-chatllm-page-limit',
  ],
}));

app.get('/health', liveHealthHandler);
app.get('/health/live', liveHealthHandler);
app.get('/health/ready', readyHealthHandler);
app.get('/metrics', metricsAuthMiddleware, metricsHandler);

app.use(createRateLimit({
  keyPrefix: 'global',
  windowMs: serverEnv.RATE_LIMIT_WINDOW_MS,
  max: serverEnv.RATE_LIMIT_MAX,
}));

app.use(express.json({ limit: JSON_REQUEST_LIMIT }));
app.use(express.urlencoded({ limit: URLENCODED_REQUEST_LIMIT, extended: true }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/project-spaces', projectSpaceRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/prompt-templates', promptTemplateRoutes);
app.use('/api/rag-eval', createRateLimit({
  keyPrefix: 'rag-eval',
  windowMs: serverEnv.RATE_LIMIT_WINDOW_MS,
  max: serverEnv.RAG_EVAL_RATE_LIMIT_MAX,
  message: 'Too many RAG evaluation requests',
}), ragEvalRoutes);
app.use('/api/rag-workbench', createRateLimit({
  keyPrefix: 'rag-workbench',
  windowMs: serverEnv.RATE_LIMIT_WINDOW_MS,
  max: serverEnv.RAG_EVAL_RATE_LIMIT_MAX,
  message: 'Too many RAG workbench requests',
}), ragWorkbenchRoutes);
app.use('/api/chat', createRateLimit({
  keyPrefix: 'chat',
  windowMs: serverEnv.RATE_LIMIT_WINDOW_MS,
  max: serverEnv.CHAT_RATE_LIMIT_MAX,
  message: 'Too many chat requests',
}), chatRoutes);
app.use('/api/upload', createRateLimit({
  keyPrefix: 'upload',
  windowMs: serverEnv.RATE_LIMIT_WINDOW_MS,
  max: serverEnv.UPLOAD_RATE_LIMIT_MAX,
  message: 'Too many upload requests',
}), uploadRoutes);

app.use(notFoundMiddleware);
app.use(errorHandlerMiddleware);

export const startServer = async () => {
  await runMigrations();

  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    fileQueue.start();
    ragEvalQueue.start();
    maintenanceService.start();
  });

  installGracefulShutdown(server);

  return server;
};

if (require.main === module) {
  startServer().catch((error) => {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  });
}
