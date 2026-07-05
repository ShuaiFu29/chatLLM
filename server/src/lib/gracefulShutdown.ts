import { Server } from 'http';
import { closeDatabasePool } from './db';
import { serverEnv } from './env';
import { fileQueue } from '../services/fileQueue';
import { ragEvalQueue } from '../services/ragEvalQueue';
import { maintenanceService } from '../services/maintenance';

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
    fileQueue.stop();
    ragEvalQueue.stop();
    maintenanceService.stop();

    const timeout = setTimeout(() => {
      console.error('[Server] Graceful shutdown timed out');
      process.exit(1);
    }, serverEnv.SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    try {
      await closeHttpServer(server);
      await closeDatabasePool();
      clearTimeout(timeout);
      console.log('[Server] Shutdown complete');
      process.exit(0);
    } catch (error) {
      clearTimeout(timeout);
      console.error('[Server] Shutdown failed:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};
