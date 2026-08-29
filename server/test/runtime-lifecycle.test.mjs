import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const lifecyclePath = path.join(
  serverRoot,
  'dist',
  'infrastructure',
  'runtime-lifecycle.service.js',
);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const loadLifecycleWithMocks = (overrides = {}) => {
  const previousEntries = new Map();
  const mockModule = (relativePath, exports) => {
    const resolved = require.resolve(path.join(serverRoot, 'dist', relativePath));
    previousEntries.set(resolved, require.cache[resolved]);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
  };

  const resolvedLifecycle = require.resolve(lifecyclePath);
  previousEntries.set(resolvedLifecycle, require.cache[resolvedLifecycle]);
  delete require.cache[resolvedLifecycle];

  mockModule('lib/db.js', {
    closeDatabasePool: overrides.closeDatabasePool || (async () => undefined),
  });
  mockModule('lib/migrations.js', {
    runMigrations: overrides.runMigrations || (async () => undefined),
  });
  mockModule('lib/redis.js', {
    closeRedis: overrides.closeRedis || (async () => undefined),
    connectRedis: overrides.connectRedis || (async () => undefined),
  });
  mockModule('services/fileQueue.js', {
    fileQueue: overrides.fileQueue || {
      start: async () => undefined,
      stop: async () => undefined,
    },
  });
  mockModule('services/ragEvalQueue.js', {
    ragEvalQueue: overrides.ragEvalQueue || {
      start: async () => undefined,
      stop: async () => undefined,
    },
  });
  mockModule('services/cleanupQueue.js', {
    artifactCleanupQueue: overrides.artifactCleanupQueue || {
      start: async () => undefined,
      stop: async () => undefined,
    },
  });
  mockModule('services/agentEvalQueue.js', {
    agentEvalQueue: overrides.agentEvalQueue || {
      start: async () => undefined,
      stop: async () => undefined,
    },
  });
  mockModule('services/agentRecoveryQueue.js', {
    agentRecoveryQueue: overrides.agentRecoveryQueue || {
      start: async () => undefined,
      stop: async () => undefined,
    },
  });
  mockModule('services/agentMemoryEmbeddingQueue.js', {
    agentMemoryEmbeddingQueue: overrides.agentMemoryEmbeddingQueue || {
      start: async () => undefined,
      stop: async () => undefined,
    },
  });
  mockModule('services/maintenance.js', {
    maintenanceService: overrides.maintenanceService || {
      start: () => undefined,
      stop: async () => undefined,
    },
  });

  const lifecycle = require(lifecyclePath);
  return {
    ...lifecycle,
    restore() {
      for (const [resolved, entry] of previousEntries.entries()) {
        if (entry) require.cache[resolved] = entry;
        else delete require.cache[resolved];
      }
    },
  };
};

test('startup rollback waits for every queue start to settle before stopping queues', async () => {
  const events = [];
  const ragStart = deferred();
  const cleanupStart = deferred();
  const { RuntimeLifecycleService, restore } = loadLifecycleWithMocks({
    runMigrations: async () => events.push('migrations-complete'),
    connectRedis: async () => events.push('redis-connected'),
    closeRedis: async () => events.push('redis-closed'),
    closeDatabasePool: async () => events.push('database-closed'),
    fileQueue: {
      start: async () => {
        events.push('file-start');
        throw new Error('file queue failed to start');
      },
      stop: async () => events.push('file-stop'),
    },
    ragEvalQueue: {
      start: async () => {
        events.push('rag-start');
        await ragStart.promise;
        events.push('rag-start-settled');
      },
      stop: async () => events.push('rag-stop'),
    },
    artifactCleanupQueue: {
      start: async () => {
        events.push('cleanup-start');
        await cleanupStart.promise;
        events.push('cleanup-start-settled');
      },
      stop: async () => events.push('cleanup-stop'),
    },
  });

  try {
    const service = new RuntimeLifecycleService();
    const startup = service.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(events, [
      'migrations-complete',
      'redis-connected',
      'file-start',
      'rag-start',
      'cleanup-start',
    ]);
    assert.equal(events.some((event) => event.endsWith('-stop')), false);

    ragStart.resolve();
    cleanupStart.resolve();
    await assert.rejects(startup, /file queue failed to start/);

    const firstStop = Math.min(
      events.indexOf('file-stop'),
      events.indexOf('rag-stop'),
      events.indexOf('cleanup-stop'),
    );
    assert.ok(firstStop > events.indexOf('rag-start-settled'));
    assert.ok(firstStop > events.indexOf('cleanup-start-settled'));
    assert.ok(events.indexOf('redis-closed') > events.indexOf('cleanup-stop'));
    assert.ok(events.indexOf('database-closed') > events.indexOf('redis-closed'));
  } finally {
    restore();
  }
});

test('shutdown closes Redis and PostgreSQL even when a queue stop fails', async () => {
  const events = [];
  const { RuntimeLifecycleService, restore } = loadLifecycleWithMocks({
    closeRedis: async () => events.push('redis-closed'),
    closeDatabasePool: async () => events.push('database-closed'),
    fileQueue: {
      start: async () => undefined,
      stop: async () => {
        events.push('file-stop');
        throw new Error('file queue failed to stop');
      },
    },
    ragEvalQueue: {
      start: async () => undefined,
      stop: async () => events.push('rag-stop'),
    },
    artifactCleanupQueue: {
      start: async () => undefined,
      stop: async () => events.push('cleanup-stop'),
    },
  });

  try {
    const service = new RuntimeLifecycleService();
    await service.onApplicationBootstrap();
    await assert.rejects(
      service.onApplicationShutdown(),
      (error) => error?.message === 'Runtime shutdown failed'
        && error.causes.some((reason) => reason?.message === 'file queue failed to stop'),
    );

    assert.deepEqual(events.slice(0, 3).sort(), [
      'cleanup-stop',
      'file-stop',
      'rag-stop',
    ]);
    assert.deepEqual(events.slice(3), ['redis-closed', 'database-closed']);
  } finally {
    restore();
  }
});

test('repeated application shutdown closes queues, Redis, and PostgreSQL only once', async () => {
  const calls = {
    fileStop: 0,
    ragStop: 0,
    cleanupStop: 0,
    closeRedis: 0,
    closeDatabase: 0,
  };
  const { RuntimeLifecycleService, restore } = loadLifecycleWithMocks({
    closeRedis: async () => { calls.closeRedis += 1; },
    closeDatabasePool: async () => { calls.closeDatabase += 1; },
    fileQueue: {
      start: async () => undefined,
      stop: async () => { calls.fileStop += 1; },
    },
    ragEvalQueue: {
      start: async () => undefined,
      stop: async () => { calls.ragStop += 1; },
    },
    artifactCleanupQueue: {
      start: async () => undefined,
      stop: async () => { calls.cleanupStop += 1; },
    },
  });

  try {
    const service = new RuntimeLifecycleService();
    await service.onApplicationBootstrap();
    await Promise.all([
      service.onApplicationShutdown(),
      service.onApplicationShutdown(),
    ]);
    await service.onApplicationShutdown();

    assert.deepEqual(calls, {
      fileStop: 1,
      ragStop: 1,
      cleanupStop: 1,
      closeRedis: 1,
      closeDatabase: 1,
    });
  } finally {
    restore();
  }
});

test('shutdown handler timeout covers a hanging app close and exits once with failure', async () => {
  const { installShutdownHandlers } = require(path.join(serverRoot, 'dist', 'main.js'));
  const listeners = new Map();
  const exits = [];
  let closeCalls = 0;
  const signalTarget = {
    once(signal, listener) {
      listeners.set(signal, listener);
      return this;
    },
    off(signal, listener) {
      if (listeners.get(signal) === listener) listeners.delete(signal);
      return this;
    },
  };
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;

  try {
    const handlers = installShutdownHandlers({
      close: async () => {
        closeCalls += 1;
        await new Promise(() => undefined);
      },
    }, {
      signalTarget,
      timeoutMs: 10,
      exit: (code) => exits.push(code),
    });

    listeners.get('SIGTERM')();
    await new Promise((resolve) => setTimeout(resolve, 30));
    void handlers.shutdown('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, [1]);
  assert.equal(listeners.size, 0);
});
