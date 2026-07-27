import {
  BeforeApplicationShutdown,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { closeDatabasePool } from '../lib/db';
import { serverEnv } from '../lib/env';
import { runMigrations } from '../lib/migrations';
import { closeRedis, connectRedis } from '../lib/redis';
import { toSafeError } from '../lib/safeError';
import { artifactCleanupQueue } from '../services/cleanupQueue';
import { fileQueue } from '../services/fileQueue';
import { maintenanceService } from '../services/maintenance';
import { ragEvalQueue } from '../services/ragEvalQueue';

const withTimeout = async (operation: Promise<unknown>, timeoutMs: number) => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Graceful shutdown timed out')),
          timeoutMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

@Injectable()
export class RuntimeLifecycleService implements
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
  OnApplicationShutdown {
  private maintenanceStarted = false;
  private runtimeStarted = false;

  async onApplicationBootstrap() {
    await runMigrations();
    await connectRedis();

    try {
      await Promise.all([
        fileQueue.start(),
        ragEvalQueue.start(),
        artifactCleanupQueue.start(),
      ]);
      this.runtimeStarted = true;
    } catch (error) {
      await Promise.allSettled([
        fileQueue.stop(),
        ragEvalQueue.stop(),
        artifactCleanupQueue.stop(),
        closeRedis(),
        closeDatabasePool(),
      ]);
      throw error;
    }
  }

  startMaintenance() {
    if (this.maintenanceStarted) return;
    maintenanceService.start();
    this.maintenanceStarted = true;
  }

  beforeApplicationShutdown() {
    if (!this.maintenanceStarted) return;
    maintenanceService.stop();
    this.maintenanceStarted = false;
  }

  async onApplicationShutdown() {
    try {
      await withTimeout((async () => {
        if (this.runtimeStarted) {
          await Promise.all([
            fileQueue.stop(),
            ragEvalQueue.stop(),
            artifactCleanupQueue.stop(),
          ]);
          this.runtimeStarted = false;
        }
        await closeRedis();
        await closeDatabasePool();
      })(), serverEnv.SHUTDOWN_TIMEOUT_MS);
    } catch (error) {
      console.error('[Server] Shutdown failed:', toSafeError(error));
      process.exitCode = 1;
    }
  }
}
