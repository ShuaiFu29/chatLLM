import {
  BeforeApplicationShutdown,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { closeDatabasePool } from '../lib/db';
import { runMigrations } from '../lib/migrations';
import { closeRedis, connectRedis } from '../lib/redis';
import { artifactCleanupQueue } from '../services/cleanupQueue';
import { fileQueue } from '../services/fileQueue';
import { maintenanceService } from '../services/maintenance';
import { ragEvalQueue } from '../services/ragEvalQueue';
import { agentRecoveryQueue } from '../services/agentRecoveryQueue';
import { agentEvalQueue } from '../services/agentEvalQueue';
import { agentMemoryEmbeddingQueue } from '../services/agentMemoryEmbeddingQueue';

const queues = [
  fileQueue,
  ragEvalQueue,
  agentEvalQueue,
  artifactCleanupQueue,
  agentRecoveryQueue,
  agentMemoryEmbeddingQueue,
] as const;

const getRejectedReasons = (results: PromiseSettledResult<unknown>[]) => (
  results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
);

const createLifecycleError = (message: string, causes: unknown[]) => {
  const error = new Error(message) as Error & { causes: unknown[] };
  error.causes = causes;
  return error;
};

@Injectable()
export class RuntimeLifecycleService implements
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
  OnApplicationShutdown {
  private maintenanceStarted = false;
  private queuesMayBeRunning = false;
  private resourcesClosed = false;
  private shutdownPromise: Promise<void> | null = null;

  async onApplicationBootstrap() {
    try {
      await runMigrations();
      await connectRedis();
      this.queuesMayBeRunning = true;
      const startResults = await Promise.allSettled(queues.map((queue) => queue.start()));
      const startErrors = getRejectedReasons(startResults);
      if (startErrors.length > 0) throw startErrors[0];
    } catch (error) {
      try {
        await this.shutdownRuntime();
      } catch (rollbackError) {
        throw createLifecycleError('Runtime startup and rollback failed', [error, rollbackError]);
      }
      throw error;
    }
  }

  startMaintenance() {
    if (this.maintenanceStarted) return;
    maintenanceService.start();
    this.maintenanceStarted = true;
  }

  async beforeApplicationShutdown() {
    if (!this.maintenanceStarted) return;
    this.maintenanceStarted = false;
    await maintenanceService.stop();
  }

  async onApplicationShutdown() {
    await this.shutdownRuntime();
  }

  private shutdownRuntime(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = (async () => {
      const errors: unknown[] = [];
      if (this.queuesMayBeRunning) {
        this.queuesMayBeRunning = false;
        const stopResults = await Promise.allSettled(queues.map((queue) => queue.stop()));
        errors.push(...getRejectedReasons(stopResults));
      }

      if (!this.resourcesClosed) {
        this.resourcesClosed = true;
        try {
          await closeRedis();
        } catch (error) {
          errors.push(error);
        }
        try {
          await closeDatabasePool();
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length > 0) {
        throw createLifecycleError('Runtime shutdown failed', errors);
      }
    })();

    return this.shutdownPromise;
  }
}
