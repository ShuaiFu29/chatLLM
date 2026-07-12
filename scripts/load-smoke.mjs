import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatSafeError, toSafeUrl } from './safe-error.mjs';

const DEFAULT_TARGET_URL = 'http://localhost:3000';
const DEFAULT_REQUESTS = 100;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const STATUS_FAMILIES = ['1xx', '2xx', '3xx', '4xx', '5xx', 'other'];

const parsePositiveInteger = (value, fallback, key) => {
  const raw = value === undefined || value === null || value === '' ? String(fallback) : String(value);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
};

const parseFailureRate = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('LOAD_MAX_FAILURE_RATE must be a number between 0 and 1');
  }
  return parsed;
};

const parseOptionalPositiveNumber = (value, key) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return parsed;
};

const parseJsonObject = (value, key) => {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object`);
  }
  return parsed;
};

const normalizeBody = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

const withSharedHeaders = (steps, sharedHeaders, authCookie) => (
  steps.map((step) => {
    const headers = {
      ...sharedHeaders,
      ...(step.headers || {}),
    };
    if (authCookie && !headers.Cookie) headers.Cookie = authCookie;
    if (step.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }

    return {
      label: step.label || `${step.method || 'GET'} ${step.path}`,
      method: (step.method || 'GET').toUpperCase(),
      path: step.path || '/',
      headers,
      body: normalizeBody(step.body),
    };
  })
);

const readBodyFromEnv = (env) => {
  if (env.LOAD_BODY_FILE) {
    return fs.readFileSync(path.resolve(env.LOAD_BODY_FILE), 'utf8');
  }
  return env.LOAD_BODY;
};

const buildScenarioSteps = (env, scenario) => {
  if (env.LOAD_STEPS_JSON) {
    const parsed = JSON.parse(env.LOAD_STEPS_JSON);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('LOAD_STEPS_JSON must be a non-empty JSON array');
    }
    return parsed;
  }

  if (scenario === 'mixed') {
    return [
      { label: 'health-live', method: 'GET', path: '/health/live' },
      { label: 'health-ready', method: 'GET', path: '/health/ready' },
    ];
  }

  if (scenario === 'rag-workbench') {
    return [{
      label: 'rag-workbench-inspect',
      method: 'POST',
      path: env.LOAD_PATH || '/api/rag-workbench/inspect',
      body: readBodyFromEnv(env) || JSON.stringify({ query: 'health check', limit: 3 }),
    }];
  }

  if (scenario === 'custom') {
    return [{
      label: 'custom',
      method: env.LOAD_METHOD || 'GET',
      path: env.LOAD_PATH || '/',
      body: readBodyFromEnv(env),
    }];
  }

  if (scenario !== 'health') {
    throw new Error('LOAD_SCENARIO must be one of: health, mixed, rag-workbench, custom');
  }

  return [{
    label: 'health-live',
    method: env.LOAD_METHOD || 'GET',
    path: env.LOAD_PATH || '/health/live',
    body: readBodyFromEnv(env),
  }];
};

export const percentile = (values, percent) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(Math.ceil((percent / 100) * sorted.length) - 1, sorted.length - 1);
  return sorted[Math.max(index, 0)];
};

export function buildLoadOptions(env = process.env) {
  const scenario = (env.LOAD_SCENARIO || 'health').trim().toLowerCase();
  const sharedHeaders = parseJsonObject(env.LOAD_HEADERS, 'LOAD_HEADERS');
  const steps = withSharedHeaders(
    buildScenarioSteps(env, scenario),
    sharedHeaders,
    env.LOAD_AUTH_COOKIE
  );

  return {
    targetUrl: env.LOAD_TARGET_URL || DEFAULT_TARGET_URL,
    scenario,
    totalRequests: parsePositiveInteger(env.LOAD_REQUESTS, DEFAULT_REQUESTS, 'LOAD_REQUESTS'),
    concurrency: parsePositiveInteger(env.LOAD_CONCURRENCY, DEFAULT_CONCURRENCY, 'LOAD_CONCURRENCY'),
    requestTimeoutMs: parsePositiveInteger(
      env.LOAD_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      'LOAD_REQUEST_TIMEOUT_MS'
    ),
    maxFailureRate: parseFailureRate(env.LOAD_MAX_FAILURE_RATE),
    p95ThresholdMs: parseOptionalPositiveNumber(env.LOAD_P95_MS, 'LOAD_P95_MS'),
    outputJson: env.LOAD_OUTPUT_JSON,
    steps,
  };
}

const getStatusFamily = (status) => {
  if (Number.isInteger(status) && status >= 100 && status < 600) {
    return `${Math.floor(status / 100)}xx`;
  }
  return 'other';
};

const executeStep = async (options, step, fetchImpl) => {
  const url = new URL(step.path, options.targetUrl).toString();
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  timer.unref?.();

  try {
    const response = await fetchImpl(url, {
      method: step.method,
      headers: step.headers,
      body: ['GET', 'HEAD'].includes(step.method) ? undefined : step.body,
      signal: controller.signal,
    });
    const durationMs = performance.now() - startedAt;
    const status = Number(response.status);
    return {
      label: step.label,
      url: toSafeUrl(url),
      status,
      statusFamily: getStatusFamily(status),
      durationMs,
      failed: status < 200 || status >= 500,
    };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    return {
      label: step.label,
      url: toSafeUrl(url),
      status: 'network_error',
      statusFamily: 'other',
      durationMs,
      failed: true,
      error: formatSafeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
};

const buildThresholdFailures = (summary, options) => {
  const failures = [];
  if (summary.failureRate > options.maxFailureRate) {
    failures.push(
      `failure rate ${(summary.failureRate * 100).toFixed(2)}% exceeded LOAD_MAX_FAILURE_RATE ${(options.maxFailureRate * 100).toFixed(2)}%`
    );
  }
  if (options.p95ThresholdMs !== undefined && summary.latencyMs.p95 > options.p95ThresholdMs) {
    failures.push(
      `p95 latency ${summary.latencyMs.p95.toFixed(2)}ms exceeded LOAD_P95_MS ${options.p95ThresholdMs.toFixed(2)}ms`
    );
  }
  return failures;
};

export async function runLoadScenario(options, fetchImpl = fetch) {
  const totalRequests = options.totalRequests;
  const concurrency = Math.min(options.concurrency, totalRequests);
  const results = [];
  let nextRequest = 0;
  const startedAt = performance.now();

  const worker = async () => {
    while (nextRequest < totalRequests) {
      const requestIndex = nextRequest;
      nextRequest += 1;
      const step = options.steps[requestIndex % options.steps.length];
      results.push(await executeStep(options, step, fetchImpl));
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const elapsedMs = Math.max(performance.now() - startedAt, 1);
  const durations = results.map((result) => result.durationMs);
  const statuses = new Map();
  const statusFamilies = Object.fromEntries(STATUS_FAMILIES.map((family) => [family, 0]));
  let failures = 0;

  for (const result of results) {
    statuses.set(result.status, (statuses.get(result.status) || 0) + 1);
    statusFamilies[result.statusFamily] = (statusFamilies[result.statusFamily] || 0) + 1;
    if (result.failed) failures += 1;
  }

  const summary = {
    targetUrl: options.targetUrl,
    scenario: options.scenario,
    totalRequests,
    concurrency,
    failures,
    failureRate: failures / totalRequests,
    requestsPerSecond: Number((totalRequests / (elapsedMs / 1000)).toFixed(2)),
    statuses: Object.fromEntries(statuses.entries()),
    statusFamilies,
    latencyMs: {
      min: Math.min(...durations),
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      p99: percentile(durations, 99),
      max: Math.max(...durations),
    },
    thresholds: {
      maxFailureRate: options.maxFailureRate,
      p95Ms: options.p95ThresholdMs,
    },
    thresholdFailures: [],
  };

  summary.thresholdFailures = buildThresholdFailures(summary, options);
  return summary;
}

export const shouldFailSummary = (summary) => summary.thresholdFailures.length > 0;

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).pathname : '';

if (pathToFileURL(currentFile).pathname === invokedFile) {
  const options = buildLoadOptions(process.env);
  const summary = await runLoadScenario(options);
  const rendered = JSON.stringify(summary, null, 2);
  console.log(rendered);

  if (options.outputJson) {
    fs.writeFileSync(path.resolve(options.outputJson), `${rendered}\n`, 'utf8');
  }

  if (shouldFailSummary(summary)) {
    process.exitCode = 1;
  }
}
