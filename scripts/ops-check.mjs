import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 3000;

const joinUrl = (baseUrl, pathname) => new URL(pathname, baseUrl).toString();

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
};

const parsePositiveInteger = (value, fallback, key) => {
  const raw = value === undefined || value === null || value === '' ? String(fallback) : String(value);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
};

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  const content = fs.readFileSync(filePath, 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

export function buildOpsTargets(env = process.env) {
  if (env.OPS_TARGETS_JSON) {
    const targets = JSON.parse(env.OPS_TARGETS_JSON);
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error('OPS_TARGETS_JSON must be a non-empty JSON array');
    }
    return targets.map((target) => ({
      label: target.label,
      url: target.url,
      method: target.method || 'GET',
    }));
  }

  const backendUrl = env.OPS_BACKEND_URL || env.LOAD_TARGET_URL || 'http://localhost:3000';
  const ragUrl = env.OPS_RAG_URL || 'http://localhost:8000';
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const serverEnv = parseEnvFile(path.join(rootDir, 'server', '.env'));
  const metricsToken = env.OPS_METRICS_TOKEN || env.METRICS_TOKEN || serverEnv.METRICS_TOKEN || '';
  const targets = [
    { label: 'backend live', url: joinUrl(backendUrl, '/health/live') },
    { label: 'backend ready', url: joinUrl(backendUrl, '/health/ready') },
    {
      label: 'backend metrics',
      url: joinUrl(backendUrl, '/metrics'),
      headers: metricsToken ? { authorization: `Bearer ${metricsToken}` } : undefined,
    },
    { label: 'rag ready', url: joinUrl(ragUrl, '/health/ready') },
  ];

  if (!parseBoolean(env.OPS_SKIP_INFRA, false)) {
    targets.push(
      {
        label: 'elasticsearch',
        url: joinUrl(env.OPS_ELASTICSEARCH_URL || 'http://localhost:9200', '/_cluster/health'),
      },
      {
        label: 'neo4j',
        url: env.OPS_NEO4J_URL || 'http://localhost:7474',
      },
      {
        label: 'milvus',
        url: env.OPS_MILVUS_HEALTH_URL || 'http://localhost:9091/healthz',
      }
    );
  }

  return targets;
}

const runOneCheck = async (target, options, fetchImpl) => {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();

  try {
    const response = await fetchImpl(target.url, {
      method: target.method || 'GET',
      headers: target.headers,
      signal: controller.signal,
    });
    const durationMs = performance.now() - startedAt;
    const ok = response.status >= 200 && response.status < 300;
    return {
      label: target.label,
      url: target.url,
      status: ok ? 'ok' : 'error',
      detail: `HTTP ${response.status}`,
      durationMs,
    };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    return {
      label: target.label,
      url: target.url,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
};

export async function runOpsChecks(targets, options = {}, fetchImpl = fetch) {
  const timeoutMs = parsePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'OPS_TIMEOUT_MS');
  return Promise.all(targets.map((target) => runOneCheck(target, { timeoutMs }, fetchImpl)));
}

export const hasFailedOpsChecks = (checks) => checks.some((check) => check.status !== 'ok');

export function buildOpsReport(checks) {
  const lines = ['Ops check completed.'];
  for (const check of checks) {
    lines.push(
      `${check.status.toUpperCase()} ${check.label} - ${check.detail} (${check.durationMs.toFixed(1)}ms)`
    );
  }
  return lines.join('\n');
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).pathname : '';

if (pathToFileURL(currentFile).pathname === invokedFile) {
  const targets = buildOpsTargets(process.env);
  const checks = await runOpsChecks(targets, {
    timeoutMs: process.env.OPS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  });
  console.log(buildOpsReport(checks));

  if (hasFailedOpsChecks(checks)) {
    process.exitCode = 1;
  }
}
