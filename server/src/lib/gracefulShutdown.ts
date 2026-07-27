import { Server } from 'http';
import { closeDatabasePool } from './db';
import { serverEnv } from './env';
import { fileQueue } from '../services/fileQueue';
import { ragEvalQueue } from '../services/ragEvalQueue';
import { maintenanceService } from '../services/maintenance';
import { artifactCleanupQueue } from '../services/cleanupQueue';
import { toSafeError } from './safeError';
import { closeRedis } from './redis';

const closeHttpServer = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
});

export const installGracefulShutdown = (server: Server) => {
  let isShuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`[Server] ${signal} received; closing HTTP server`);
    maintenanceService.stop();

    const timeout = setTimeout(() => {
      console.error('[Server] Graceful shutdown timed out');
      process.exit(1);
    }, serverEnv.SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    try {
      await closeHttpServer(server);
      await Promise.all([
        fileQueue.stop(),
        ragEvalQueue.stop(),
        artifactCleanupQueue.stop(),
      ]);
      await closeRedis();
      await closeDatabasePool();
      clearTimeout(timeout);
      console.log('[Server] Shutdown complete');
      process.exit(0);
    } catch (error) {
      clearTimeout(timeout);
      console.error('[Server] Shutdown failed:', toSafeError(error));
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};
