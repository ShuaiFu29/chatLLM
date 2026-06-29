import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BACKEND_PORT = '3000';

function parseEnvFile(content) {
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function readServerEnv(clientDir) {
  const serverEnvPath = path.resolve(clientDir, '..', 'server', '.env');

  if (!fs.existsSync(serverEnvPath)) {
    return {};
  }

  return parseEnvFile(fs.readFileSync(serverEnvPath, 'utf8'));
}

export function resolveApiProxyTarget(env = process.env, clientDir = process.cwd()) {
  const explicitTarget = env.VITE_API_PROXY_TARGET?.trim();
  if (explicitTarget) {
    return explicitTarget;
  }

  const serverEnv = readServerEnv(clientDir);
  const backendUrl = serverEnv.BACKEND_URL?.trim();
  if (backendUrl) {
    return backendUrl;
  }

  const serverPort = serverEnv.PORT?.trim() || DEFAULT_BACKEND_PORT;
  return `http://localhost:${serverPort}`;
}
