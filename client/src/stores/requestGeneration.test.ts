/// <reference types="node" />

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createCompletionPoller,
  isRequestAbortError,
  RequestGenerationGuard,
} from './requestGeneration';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('RequestGenerationGuard', () => {
  test('a newer request aborts and fences the older generation for the same key', () => {
    const guard = new RequestGenerationGuard();
    const first = guard.begin('files');
    const second = guard.begin('files');

    expect(first.controller.signal.aborted).toBe(true);
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    expect(guard.finish(first)).toBe(false);
    expect(guard.finish(second)).toBe(true);
  });

  test('abort detection covers browser and Axios cancellation without treating other errors as aborts', () => {
    expect(isRequestAbortError({ name: 'AbortError' })).toBe(true);
    expect(isRequestAbortError({ name: 'CanceledError' })).toBe(true);
    expect(isRequestAbortError({ code: 'ERR_CANCELED' })).toBe(true);
    expect(isRequestAbortError(new Error('network failed'))).toBe(false);
  });
});

test('completion poller schedules the next request only after the current request settles', async () => {
  vi.useFakeTimers();
  const firstRun = deferred<void>();
  let calls = 0;
  const poller = createCompletionPoller(async () => {
    calls += 1;
    if (calls === 1) await firstRun.promise;
  }, 3_000);

  poller.start();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(calls).toBe(1);

  await vi.advanceTimersByTimeAsync(30_000);
  expect(calls).toBe(1);

  firstRun.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(2_999);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toBe(2);

  poller.stop();
});

test('completion poller remains non-overlapping when restarted during an active task', async () => {
  vi.useFakeTimers();
  const activeRun = deferred<void>();
  let calls = 0;
  const poller = createCompletionPoller(async () => {
    calls += 1;
    if (calls === 1) await activeRun.promise;
  }, 3_000);

  poller.start();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(calls).toBe(1);

  poller.stop();
  poller.start();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(calls).toBe(1);

  activeRun.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(calls).toBe(2);
  poller.stop();
});

test('completion poller can run immediately and delays its next run until that task settles', async () => {
  vi.useFakeTimers();
  const firstRun = deferred<void>();
  let calls = 0;
  const poller = createCompletionPoller(async () => {
    calls += 1;
    if (calls === 1) await firstRun.promise;
  }, 3_000);

  poller.startNow();
  await Promise.resolve();
  expect(calls).toBe(1);

  await vi.advanceTimersByTimeAsync(30_000);
  expect(calls).toBe(1);

  firstRun.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(2_999);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toBe(2);
  poller.stop();
});

test('startNow requested during an active task runs immediately after that task settles', async () => {
  vi.useFakeTimers();
  const activeRun = deferred<void>();
  let calls = 0;
  const poller = createCompletionPoller(async () => {
    calls += 1;
    if (calls === 1) await activeRun.promise;
  }, 3_000);

  poller.startNow();
  await Promise.resolve();
  expect(calls).toBe(1);

  poller.stop();
  poller.startNow();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(calls).toBe(1);

  activeRun.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toBe(2);
  poller.stop();
});

test('knowledge and evaluation polling never use overlapping setInterval loops', () => {
  const knowledgeSource = readFileSync(new URL('../pages/KnowledgeBase.tsx', import.meta.url), 'utf8');
  const evaluationSource = readFileSync(new URL('../pages/RagEvaluation.tsx', import.meta.url), 'utf8');

  expect(knowledgeSource).not.toMatch(/setInterval\s*\(/);
  expect(evaluationSource).not.toMatch(/setInterval\s*\(/);
  expect(knowledgeSource).toMatch(/createCompletionPoller/);
  expect(knowledgeSource).toMatch(/pollerRef\.current\?\.startNow\(\)/);
  expect(knowledgeSource).not.toMatch(/\bfetchFiles\(\);/);
  expect(evaluationSource).toMatch(/createCompletionPoller/);
});

test('RAG background refresh and cancellation share one request generation boundary', () => {
  const evaluationSource = readFileSync(new URL('../pages/RagEvaluation.tsx', import.meta.url), 'utf8');
  const cancelBody = evaluationSource
    .split('const handleCancelRun', 2)[1]
    ?.split('const handleViewRunDetails', 1)[0] || '';

  expect(evaluationSource).toMatch(/if \(requestGuard\.finish\(ticket\)\) setIsLoading\(false\)/);
  expect(cancelBody).toMatch(/requestGuard\.abort\('selected-run'\)/);
  expect(cancelBody).toMatch(/requestGuard\.begin\('cancel-run'\)/);
  expect(cancelBody).toMatch(/signal: ticket\.controller\.signal/);
  expect(cancelBody).toMatch(/requestGuard\.isCurrent\(ticket\)/);
});

test('RAG mutations and modal closure invalidate stale dataset and run-detail requests', () => {
  const evaluationSource = readFileSync(new URL('../pages/RagEvaluation.tsx', import.meta.url), 'utf8');
  const handlerPairs = [
    ['handleSaveDataset', 'handleCreateCase'],
    ['handleCreateCase', 'handleDeleteCase'],
    ['handleDeleteCase', 'handleDeleteDataset'],
    ['handleDeleteDataset', 'handleRunEval'],
    ['handleRunEval', 'handleCancelRun'],
    ['handleCancelRun', 'handleViewRunDetails'],
  ];

  for (const [handler, nextHandler] of handlerPairs) {
    const body = evaluationSource.split(`const ${handler}`, 2)[1]?.split(`const ${nextHandler}`, 1)[0] || '';
    expect(body, handler).toMatch(/invalidateDatasetRequests\(\)/);
  }

  expect(evaluationSource).toMatch(
    /const closeRunDetails[\s\S]*?requestGuard\.abort\('selected-run'\)[\s\S]*?setIsRunModalOpen\(false\)/,
  );
  expect(evaluationSource).toMatch(
    /if \(!selectedQualityDatasetId\) \{[\s\S]*?setIsQualityLoading\(false\)/,
  );
  expect(evaluationSource).toMatch(
    /const invalidateDatasetRequests[\s\S]*?requestGuard\.abort\('datasets'\)[\s\S]*?setIsLoading\(false\)/,
  );
});

test('knowledge deletion invalidates an older file-list request before its optimistic update', () => {
  const knowledgeSource = readFileSync(new URL('../pages/KnowledgeBase.tsx', import.meta.url), 'utf8');
  const deleteBody = knowledgeSource
    .split('const confirmDeleteFile', 2)[1]
    ?.split('const [isDragging', 1)[0] || '';

  expect(deleteBody).toMatch(/requestGuard\.abort\('files'\)/);
  expect(deleteBody).toMatch(/setIsLoading\(false\)/);
  expect(deleteBody.indexOf("requestGuard.abort('files')")).toBeLessThan(deleteBody.indexOf('setFiles('));
});

test('knowledge retry invalidates an older file-list request before applying queued state', () => {
  const knowledgeSource = readFileSync(new URL('../pages/KnowledgeBase.tsx', import.meta.url), 'utf8');
  const retryBody = knowledgeSource
    .split('const handleRetryFile', 2)[1]
    ?.split('const handleFileUpload', 1)[0] || '';

  expect(retryBody).toMatch(/requestGuard\.abort\('files'\)/);
  expect(retryBody).toMatch(/setIsLoading\(false\)/);
  expect(retryBody.indexOf("requestGuard.abort('files')")).toBeLessThan(retryBody.indexOf('setFiles('));
});
