import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';

import {
  checkTcpPortAvailable,
  findPortConflicts,
  resolveRequiredDevPorts,
} from './check-ports.mjs';

const listenOnRandomPort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
});

test('resolveRequiredDevPorts derives app ports from server env and stable defaults', () => {
  const ports = resolveRequiredDevPorts({
    'server/.env': {
      PORT: '3100',
    },
  });

  assert.deepEqual(ports, [
    { label: 'backend', port: 3100 },
    { label: 'frontend', port: 5173 },
    { label: 'rag', port: 8000 },
  ]);
});

test('findPortConflicts reports occupied app ports before dev startup', async () => {
  const server = await listenOnRandomPort();
  const port = server.address().port;

  try {
    assert.equal(await checkTcpPortAvailable(port), false);
    const conflicts = await findPortConflicts([
      { label: 'backend', port },
      { label: 'frontend', port: 0 },
    ]);

    assert.deepEqual(conflicts, [
      {
        label: 'backend',
        port,
        message: `backend port ${port} is already in use`,
      },
    ]);
  } finally {
    await closeServer(server);
  }

  assert.equal(await checkTcpPortAvailable(port), true);
});
