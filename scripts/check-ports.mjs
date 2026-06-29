import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readProjectEnvMaps } from './check-env.mjs';

const DEFAULT_BACKEND_PORT = 3000;
const DEFAULT_FRONTEND_PORT = 5173;
const DEFAULT_RAG_PORT = 8000;

const parsePort = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
};

const readBackendPort = (serverEnv) => {
  if (serverEnv.PORT?.trim()) {
    return parsePort(serverEnv.PORT, DEFAULT_BACKEND_PORT);
  }

  if (serverEnv.BACKEND_URL?.trim()) {
    try {
      const parsed = new URL(serverEnv.BACKEND_URL);
      return parsePort(parsed.port, DEFAULT_BACKEND_PORT);
    } catch {
      return DEFAULT_BACKEND_PORT;
    }
  }

  return DEFAULT_BACKEND_PORT;
};

export function resolveRequiredDevPorts(envMaps = {}) {
  const serverEnv = envMaps['server/.env'] || {};

  return [
    { label: 'backend', port: readBackendPort(serverEnv) },
    { label: 'frontend', port: DEFAULT_FRONTEND_PORT },
    { label: 'rag', port: DEFAULT_RAG_PORT },
  ];
}

export function checkTcpPortAvailable(port, host = '127.0.0.1') {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', (error) => {
      if (error && ['EADDRINUSE', 'EACCES'].includes(error.code)) {
        resolve(false);
        return;
      }

      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen({ port, host, exclusive: true });
  });
}

const PORT_CHECK_HOSTS = ['127.0.0.1', '::1', '0.0.0.0', '::', undefined];

export async function checkAppPortAvailable(port) {
  for (const host of PORT_CHECK_HOSTS) {
    const available = await checkTcpPortAvailable(port, host);
    if (!available) return false;
  }

  return true;
}

export async function findPortConflicts(ports, checker = checkAppPortAvailable) {
  const conflicts = [];

  for (const entry of ports) {
    if (!Number.isInteger(entry.port) || entry.port <= 0 || entry.port > 65535) {
      continue;
    }

    const available = await checker(entry.port);
    if (!available) {
      conflicts.push({
        ...entry,
        message: `${entry.label} port ${entry.port} is already in use`,
      });
    }
  }

  return conflicts;
}

export async function checkProjectPorts(rootDir = process.cwd()) {
  const { envMaps } = readProjectEnvMaps(rootDir);
  const ports = resolveRequiredDevPorts(envMaps);
  return findPortConflicts(ports);
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).pathname : '';

if (pathToFileURL(currentFile).pathname === invokedFile) {
  const conflicts = await checkProjectPorts(process.cwd());

  if (conflicts.length > 0) {
    console.error('Port check failed:');
    for (const conflict of conflicts) {
      console.error(`- ${conflict.message}`);
    }
    console.error('Stop the conflicting process or change the matching local port before running npm run dev.');
    process.exit(1);
  }

  console.log('Port check passed.');
}
