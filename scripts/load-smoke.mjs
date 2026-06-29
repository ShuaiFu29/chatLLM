const targetUrl = process.env.LOAD_TARGET_URL || 'http://localhost:3000';
const path = process.env.LOAD_PATH || '/health/live';
const totalRequests = Number.parseInt(process.env.LOAD_REQUESTS || '100', 10);
const concurrency = Number.parseInt(process.env.LOAD_CONCURRENCY || '10', 10);

if (!Number.isInteger(totalRequests) || totalRequests <= 0) {
  throw new Error('LOAD_REQUESTS must be a positive integer');
}

if (!Number.isInteger(concurrency) || concurrency <= 0) {
  throw new Error('LOAD_CONCURRENCY must be a positive integer');
}

const url = new URL(path, targetUrl).toString();
const durations = [];
const statuses = new Map();

let nextRequest = 0;
let failures = 0;

const percentile = (values, percent) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(Math.ceil((percent / 100) * sorted.length) - 1, sorted.length - 1);
  return sorted[Math.max(index, 0)];
};

const runOne = async () => {
  const startedAt = performance.now();

  try {
    const response = await fetch(url);
    const durationMs = performance.now() - startedAt;
    durations.push(durationMs);
    statuses.set(response.status, (statuses.get(response.status) || 0) + 1);

    if (response.status < 200 || response.status >= 500) {
      failures += 1;
    }
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    durations.push(durationMs);
    failures += 1;
    statuses.set('network_error', (statuses.get('network_error') || 0) + 1);
    console.error('[load-smoke] request failed:', error instanceof Error ? error.message : error);
  }
};

const worker = async () => {
  while (nextRequest < totalRequests) {
    nextRequest += 1;
    await runOne();
  }
};

await Promise.all(
  Array.from({ length: Math.min(concurrency, totalRequests) }, () => worker())
);

const summary = {
  url,
  totalRequests,
  concurrency,
  failures,
  statuses: Object.fromEntries(statuses.entries()),
  latencyMs: {
    min: Math.min(...durations),
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    max: Math.max(...durations),
  },
};

console.log(JSON.stringify(summary, null, 2));

if (failures > 0) {
  process.exitCode = 1;
}
