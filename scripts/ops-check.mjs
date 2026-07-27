import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatSafeError, toSafeUrl } from './safe-error.mjs';

const DEFAULT_TIMEOUT_MS = 12000;

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

const firstNonBlank = (...values) => {
  for (const value of values) {
    const normalized = value === undefined || value === null ? '' : String(value).trim();
    if (normalized) return normalized;
  }
  return '';
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

export function buildOpsTargets(env = process.env, envFiles = {}) {
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

  const backendUrl = env.OPS_BACKEND_URL || env.LOAD_TARGET_URL || 'http://127.0.0.1:3000';
  const ragUrl = env.OPS_RAG_URL || 'http://127.0.0.1:8000';
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const explicitMetricsToken = firstNonBlank(env.OPS_METRICS_TOKEN, env.METRICS_TOKEN);
  const explicitRagToken = firstNonBlank(env.OPS_RAG_TOKEN, env.RAG_SERVICE_TOKEN);
  const serverEnv = explicitMetricsToken && explicitRagToken
    ? {}
    : (envFiles.serverEnv ?? parseEnvFile(path.join(rootDir, 'server', '.env')));
  const metricsToken = firstNonBlank(
    explicitMetricsToken,
    serverEnv.METRICS_TOKEN,
  );
  const ragEnv = explicitRagToken || serverEnv.RAG_SERVICE_TOKEN
    ? {}
    : (envFiles.ragEnv ?? parseEnvFile(path.join(rootDir, 'rag-service', '.env')));
  const ragToken = firstNonBlank(
    explicitRagToken,
    serverEnv.RAG_SERVICE_TOKEN,
    ragEnv.RAG_SERVICE_TOKEN,
  );
  const targets = [
    { label: 'backend live', url: joinUrl(backendUrl, '/health/live') },
    {
      label: 'backend ready',
      url: joinUrl(backendUrl, '/health/ready'),
      responseKind: 'backend-ready',
    },
    {
      label: 'backend metrics',
      url: joinUrl(backendUrl, '/metrics'),
      headers: metricsToken ? { authorization: `Bearer ${metricsToken}` } : undefined,
    },
    {
      label: 'backend queue health',
      url: joinUrl(backendUrl, '/health/queues'),
      headers: metricsToken ? { authorization: `Bearer ${metricsToken}` } : undefined,
      responseKind: 'queue-health',
    },
    {
      label: 'rag ready',
      url: joinUrl(ragUrl, '/health/ready'),
      headers: ragToken ? { 'X-ChatLLM-RAG-Token': ragToken } : undefined,
      responseKind: 'rag-ready',
    },
  ];

  if (!parseBoolean(env.OPS_SKIP_INFRA, false)) {
    targets.push(
      {
        label: 'elasticsearch',
        url: joinUrl(env.OPS_ELASTICSEARCH_URL || 'http://127.0.0.1:9200', '/_cluster/health'),
      },
      {
        label: 'neo4j',
        url: env.OPS_NEO4J_URL || 'http://127.0.0.1:7474',
      },
      {
        label: 'milvus',
        url: env.OPS_MILVUS_HEALTH_URL || 'http://127.0.0.1:9091/healthz',
      }
    );
  }

  return targets;
}

const QUEUE_HEALTH_CHECKS = ['cleanup', 'ingestion_leases', 'eval_leases'];
const QUEUE_HEALTH_STATUSES = new Set(['ok', 'degraded', 'error']);
const READY_STATUS_VALUES = new Set(['ok', 'error', 'timeout']);
const CAPABILITY_STATUS_VALUES = new Set(['enabled', 'disabled', 'degraded', 'ok', 'unknown']);

const readQueueHealthSummary = async (response) => {
  if (typeof response.json !== 'function') return null;

  try {
    const body = await response.json();
    const statuses = QUEUE_HEALTH_CHECKS.map((key) => {
      const status = body?.checks?.[key]?.status;
      return QUEUE_HEALTH_STATUSES.has(status) ? `${key}=${status}` : null;
    });
    return statuses.every(Boolean) ? statuses.join(', ') : null;
  } catch {
    return null;
  }
};

const readReadySummary = async (response, responseKind) => {
  if (typeof response.json !== 'function') return null;
  const requiredChecks = responseKind === 'backend-ready'
    ? ['postgres', 'redis', 'rag']
    : ['postgres', 'milvus', 'elasticsearch', 'neo4j'];

  try {
    const rawBody = await response.json();
    const body = rawBody?.detail && typeof rawBody.detail === 'object' ? rawBody.detail : rawBody;
    const checks = requiredChecks.map((key) => {
      const status = body?.checks?.[key];
      return READY_STATUS_VALUES.has(status) ? `${key}=${status}` : null;
    });
    if (!checks.every(Boolean)) return null;

    if (responseKind === 'backend-ready') return checks.join(', ');

    const capabilityStatus = body?.capabilities?.status;
    const features = body?.capabilities?.features;
    const featureKeys = ['query_rewrite', 'reranker', 'graph_extraction', 'retrieval_cache', 'markdown_index'];
    if (!['ok', 'degraded'].includes(capabilityStatus) || !features || typeof features !== 'object') {
      return null;
    }
    const featureSummaries = featureKeys.map((key) => {
      const status = features?.[key]?.status;
      return CAPABILITY_STATUS_VALUES.has(status) ? `${key}=${status}` : null;
    });
    if (!featureSummaries.every(Boolean)) return null;
    const staleFiles = features.markdown_index?.stale_file_count;
    const staleSuffix = Number.isSafeInteger(staleFiles) ? `, stale_markdown_files=${staleFiles}` : '';
    return `${checks.join(', ')}; capabilities=${capabilityStatus}; ${featureSummaries.join(', ')}${staleSuffix}`;
  } catch {
    return null;
  }
};

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
    let ok = response.status >= 200 && response.status < 300;
    let detail = `HTTP ${response.status}`;
    if (target.responseKind === 'queue-health') {
      const summary = await readQueueHealthSummary(response);
      if (summary) {
        detail += `; ${summary}`;
      } else {
        ok = false;
        detail += '; invalid queue health response';
      }
    } else if (target.responseKind === 'backend-ready' || target.responseKind === 'rag-ready') {
      const summary = await readReadySummary(response, target.responseKind);
      if (summary) {
        detail += `; ${summary}`;
      } else {
        ok = false;
        detail += '; invalid readiness response';
      }
    }
    return {
      label: target.label,
      url: toSafeUrl(target.url),
      status: ok ? 'ok' : 'error',
      detail,
      durationMs,
    };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    return {
      label: target.label,
      url: toSafeUrl(target.url),
      status: 'error',
      detail: formatSafeError(error),
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
