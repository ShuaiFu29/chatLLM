import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveApiProxyTarget } from './vite-proxy-target.mjs';

function withWorkspace(serverEnv, run) {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'chatllm-vite-proxy-'));
  const clientDir = path.join(workspaceRoot, 'client');
  const serverDir = path.join(workspaceRoot, 'server');

  mkdirSync(clientDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(path.join(serverDir, '.env'), serverEnv, 'utf8');

  try {
    run(clientDir);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

test('uses VITE_API_PROXY_TARGET when it is explicitly provided', () => {
  withWorkspace('PORT=3002\n', (clientDir) => {
    const target = resolveApiProxyTarget(
      { VITE_API_PROXY_TARGET: 'http://localhost:3999' },
      clientDir,
    );

    assert.equal(target, 'http://localhost:3999');
  });
});

test('uses the backend port from server .env when no explicit proxy target exists', () => {
  withWorkspace('PORT=3002\n', (clientDir) => {
    const target = resolveApiProxyTarget({}, clientDir);

    assert.equal(target, 'http://localhost:3002');
  });
});

test('uses BACKEND_URL from server .env before deriving a localhost port', () => {
  withWorkspace('PORT=3002\nBACKEND_URL=http://127.0.0.1:3010\n', (clientDir) => {
    const target = resolveApiProxyTarget({}, clientDir);

    assert.equal(target, 'http://127.0.0.1:3010');
  });
});

test('falls back to localhost port 3000 when server .env is unavailable', () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'chatllm-vite-proxy-'));
  const clientDir = path.join(workspaceRoot, 'client');

  mkdirSync(clientDir, { recursive: true });

  try {
    const target = resolveApiProxyTarget({}, clientDir);

    assert.equal(target, 'http://localhost:3000');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
