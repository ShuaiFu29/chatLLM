import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildLoadOptions,
  percentile,
  runLoadScenario,
  shouldFailSummary,
} from './load-smoke.mjs';

test('buildLoadOptions defaults to a bounded health scenario', () => {
  const options = buildLoadOptions({
    LOAD_TARGET_URL: 'http://localhost:3000',
    LOAD_REQUESTS: '25',
    LOAD_CONCURRENCY: '5',
  });

  assert.equal(options.targetUrl, 'http://localhost:3000');
  assert.equal(options.totalRequests, 25);
  assert.equal(options.concurrency, 5);
  assert.equal(options.requestTimeoutMs, 5000);
  assert.equal(options.maxFailureRate, 0);
  assert.deepEqual(options.steps, [{
    label: 'health-live',
    method: 'GET',
    path: '/health/live',
    headers: {},
    body: undefined,
  }]);
});

test('buildLoadOptions supports mixed scenarios, auth headers, and thresholds', () => {
  const options = buildLoadOptions({
    LOAD_TARGET_URL: 'http://localhost:3000',
    LOAD_SCENARIO: 'mixed',
    LOAD_HEADERS: '{"x-test":"yes"}',
    LOAD_AUTH_COOKIE: 'token=abc',
    LOAD_MAX_FAILURE_RATE: '0.2',
    LOAD_P95_MS: '250',
    LOAD_OUTPUT_JSON: 'load-summary.json',
  });

  assert.deepEqual(options.steps.map((step) => step.path), ['/health/live', '/health/ready']);
  assert.equal(options.steps[0].headers['x-test'], 'yes');
  assert.equal(options.steps[0].headers.Cookie, 'token=abc');
  assert.equal(options.maxFailureRate, 0.2);
  assert.equal(options.p95ThresholdMs, 250);
  assert.equal(options.outputJson, 'load-summary.json');
});

test('runLoadScenario reports latency, status families, RPS, and threshold failures', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      status: calls.length === 2 ? 503 : 200,
      text: async () => '',
    };
  };

  const summary = await runLoadScenario(buildLoadOptions({
    LOAD_TARGET_URL: 'http://example.test',
    LOAD_SCENARIO: 'mixed',
    LOAD_REQUESTS: '3',
    LOAD_CONCURRENCY: '2',
    LOAD_MAX_FAILURE_RATE: '0.5',
    LOAD_P95_MS: '10000',
  }), fakeFetch);

  assert.equal(summary.totalRequests, 3);
  assert.equal(summary.concurrency, 2);
  assert.equal(summary.failures, 1);
  assert.equal(summary.statusFamilies['2xx'], 2);
  assert.equal(summary.statusFamilies['5xx'], 1);
  assert.equal(summary.thresholdFailures.length, 0);
  assert.equal(shouldFailSummary(summary), false);
  assert.match(calls[0].url, /\/health\/live$/);
  assert.match(calls[1].url, /\/health\/ready$/);
});

test('runLoadScenario flags threshold failures without hiding server responses', async () => {
  const fakeFetch = async () => ({ status: 503, text: async () => '' });

  const summary = await runLoadScenario(buildLoadOptions({
    LOAD_TARGET_URL: 'http://example.test',
    LOAD_REQUESTS: '4',
    LOAD_CONCURRENCY: '2',
    LOAD_MAX_FAILURE_RATE: '0.25',
  }), fakeFetch);

  assert.equal(summary.failures, 4);
  assert.equal(summary.failureRate, 1);
  assert.deepEqual(summary.thresholdFailures, [
    'failure rate 100.00% exceeded LOAD_MAX_FAILURE_RATE 25.00%',
  ]);
  assert.equal(shouldFailSummary(summary), true);
});

test('percentile handles empty and sorted values predictably', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([10, 1, 20, 5], 50), 5);
  assert.equal(percentile([10, 1, 20, 5], 95), 20);
});
