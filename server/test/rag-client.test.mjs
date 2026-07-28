import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const axiosModule = require(path.join(serverRoot, 'node_modules', 'axios'));
const axios = axiosModule.default || axiosModule;
const ragClientModule = require(path.join(serverRoot, 'dist', 'lib', 'ragClient.js'));

const retrieveInput = {
  query: 'what is indexed?',
  user_id: 'user-1',
  limit: 5,
  threshold: 0.1,
};

const ok = (data = {}) => ({ status: 200, data });

const axiosStatusError = (status) => new axios.AxiosError(
  `request failed with status ${status}`,
  'ERR_BAD_RESPONSE',
  {},
  null,
  {
    status,
    statusText: 'Error',
    headers: {},
    config: {},
    data: {},
  },
);

const axiosTimeoutError = () => new axios.AxiosError(
  'request timed out',
  'ECONNABORTED',
  {},
);

const createTransport = (handler) => {
  const calls = [];

  return {
    calls,
    async get(url, config) {
      const call = { method: 'get', url, config };
      calls.push(call);
      return handler(call);
    },
    async post(url, data, config) {
      const call = { method: 'post', url, data, config };
      calls.push(call);
      return handler(call);
    },
  };
};

const createMetrics = () => {
  const events = [];
  return {
    events,
    recordRagRetrieve(status, durationMs) {
      events.push({ type: 'request', status, durationMs });
    },
    recordRagCircuitOpen() {
      events.push({ type: 'circuit-open' });
    },
  };
};

const createClient = ({
  transport,
  metrics = createMetrics(),
  now = () => 0,
  failureThreshold = 2,
  resetMs = 1000,
  retrieveMaxAttempts = 1,
  retrieveTotalTimeoutMs = 100,
  retrieveRetryDelayMs = 0,
} = {}) => {
  assert.equal(
    typeof ragClientModule.createRagClient,
    'function',
    'ragClient must expose an injectable createRagClient factory',
  );

  return ragClientModule.createRagClient({
    transport,
    metrics,
    now,
    serviceUrl: 'http://rag.test',
    serviceToken: 'internal-rag-token',
    retrieveTimeoutMs: 100,
    ingestTimeoutMs: 300,
    cleanupTimeoutMs: 200,
    healthTimeoutMs: 50,
    retrieveMaxAttempts,
    retrieveTotalTimeoutMs,
    retrieveRetryDelayMs,
    failureThreshold,
    resetMs,
  });
};

test('transient retrieval failure retries once inside the total deadline', async () => {
  const outcomes = [axiosTimeoutError(), ok({ results: [{ id: 'recovered' }] })];
  const transport = createTransport(() => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const client = createClient({ transport, retrieveMaxAttempts: 2 });

  const results = await client.retrieveRagDocuments(retrieveInput);

  assert.deepEqual(results, [{ id: 'recovered' }]);
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(transport.calls.map((call) => call.config.timeout), [100, 100]);
});

test('retrieval transport preserves JSON multi-format chunk provenance', async () => {
  const responseFixture = JSON.parse(JSON.stringify({
    results: [{
      id: 'chunk-pdf-1',
      content: 'Transported PDF evidence.',
      metadata: {
        filename: 'transport.pdf',
        file_id: 'file-pdf-1',
        chunk_index: 6,
        document_kind: 'pdf',
        conversion_generation_id: 'generation-hit-1',
        source_unit_ids: ['u_11111111111111111111111111111111'],
        source_locator: {
          type: 'pdf',
          page_start: 12,
          page_end: 12,
          locators: [{ type: 'pdf', kind: 'page_text', page: 12, block: 3 }],
        },
      },
      similarity: 0.88,
    }],
  }));
  const transport = createTransport(() => ok(responseFixture));
  const client = createClient({ transport });

  const [document] = await client.retrieveRagDocuments(retrieveInput);

  assert.equal(transport.calls[0].url, 'http://rag.test/retrieve');
  assert.deepEqual(document.metadata, responseFixture.results[0].metadata);
  assert.equal(document.metadata.conversion_generation_id, 'generation-hit-1');
  assert.equal(document.metadata.source_locator.page_start, 12);
});

test('retrieval retry never repeats caller-caused 4xx responses', async () => {
  const transport = createTransport(() => { throw axiosStatusError(400); });
  const client = createClient({ transport, retrieveMaxAttempts: 2 });

  await assert.rejects(client.retrieveRagDocuments(retrieveInput), (error) => error.response?.status === 400);

  assert.equal(transport.calls.length, 1);
});

test('retry attempt timeout is capped by the remaining total budget', async () => {
  let currentTime = 0;
  let calls = 0;
  const transport = createTransport(() => {
    calls += 1;
    if (calls === 1) {
      currentTime = 80;
      throw axiosTimeoutError();
    }
    return ok({ results: [] });
  });
  const client = createClient({
    transport,
    now: () => currentTime,
    retrieveMaxAttempts: 2,
    retrieveTotalTimeoutMs: 100,
  });

  await client.retrieveRagDocuments(retrieveInput);

  assert.deepEqual(transport.calls.map((call) => call.config.timeout), [100, 20]);
});

test('caller-caused 400 responses never open the retrieve circuit', async () => {
  const outcomes = [axiosStatusError(400), axiosStatusError(400), ok({ results: [] })];
  const transport = createTransport(() => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const metrics = createMetrics();
  const client = createClient({ transport, metrics, failureThreshold: 2 });

  await assert.rejects(client.retrieveRagDocuments(retrieveInput), (error) => error.response?.status === 400);
  await assert.rejects(client.retrieveRagDocuments(retrieveInput), (error) => error.response?.status === 400);
  assert.deepEqual(await client.retrieveRagDocuments(retrieveInput), []);

  assert.equal(transport.calls.length, 3);
  assert.equal(metrics.events.filter((event) => event.type === 'circuit-open').length, 0);
});

test('a caller-caused 4xx does not erase an earlier service failure', async () => {
  const outcomes = [axiosStatusError(500), axiosStatusError(400), axiosStatusError(500)];
  const transport = createTransport(() => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const client = createClient({ transport, failureThreshold: 2 });

  await assert.rejects(client.retrieveRagDocuments(retrieveInput), (error) => error.response?.status === 500);
  await assert.rejects(client.retrieveRagDocuments(retrieveInput), (error) => error.response?.status === 400);
  await assert.rejects(client.retrieveRagDocuments(retrieveInput), (error) => error.response?.status === 500);
  await assert.rejects(
    client.retrieveRagDocuments(retrieveInput),
    (error) => error.code === 'RAG_CIRCUIT_OPEN',
  );

  assert.equal(transport.calls.length, 3);
});

for (const [name, makeFailure] of [
  ['HTTP 429', () => axiosStatusError(429)],
  ['HTTP 500', () => axiosStatusError(500)],
  ['transport timeout', () => axiosTimeoutError()],
  ['non-Axios transport failure', () => new Error('socket failed')],
]) {
  test(`${name} counts as a downstream service failure`, async () => {
    const transport = createTransport(() => { throw makeFailure(); });
    const client = createClient({ transport, failureThreshold: 1 });

    await assert.rejects(client.retrieveRagDocuments(retrieveInput));
    await assert.rejects(
      client.retrieveRagDocuments(retrieveInput),
      (error) => error.code === 'RAG_CIRCUIT_OPEN',
    );

    assert.equal(transport.calls.length, 1);
  });
}

test('an open retrieve circuit leaves agentic, graph, eval, and cleanup operations available', async () => {
  let retrieveFailures = 0;
  const transport = createTransport((call) => {
    if (call.url.endsWith('/retrieve')) {
      retrieveFailures += 1;
      throw axiosStatusError(500);
    }
    if (call.url.endsWith('/graph/search')) return ok({ results: [] });
    if (call.url.endsWith('/agentic-retrieve')) return ok({ results: [] });
    return ok({});
  });
  const client = createClient({ transport, failureThreshold: 1 });

  await assert.rejects(client.retrieveRagDocuments(retrieveInput));
  assert.deepEqual((await client.retrieveAgenticRagDocuments(retrieveInput)).results, []);
  assert.deepEqual(await client.searchRagGraphDocuments(retrieveInput), []);
  await client.runRagEvaluation({ user_id: 'user-1', cases: [] });
  await client.cleanupRagFileVectors('file-1');
  await assert.rejects(
    client.retrieveRagDocuments(retrieveInput),
    (error) => error.code === 'RAG_CIRCUIT_OPEN',
  );

  assert.equal(retrieveFailures, 1);
  assert.deepEqual(
    transport.calls.map((call) => new URL(call.url).pathname),
    ['/retrieve', '/agentic-retrieve', '/graph/search', '/eval/run', '/cleanup-file'],
  );
});

test('success resets only the circuit for its own operation', async () => {
  let retrieveCalls = 0;
  const transport = createTransport((call) => {
    if (call.url.endsWith('/retrieve')) {
      retrieveCalls += 1;
      throw axiosStatusError(500);
    }
    return ok({ results: [] });
  });
  const client = createClient({ transport, failureThreshold: 1 });

  await assert.rejects(client.retrieveRagDocuments(retrieveInput));
  assert.deepEqual(await client.searchRagGraphDocuments(retrieveInput), []);
  await assert.rejects(
    client.retrieveRagDocuments(retrieveInput),
    (error) => error.code === 'RAG_CIRCUIT_OPEN',
  );

  assert.equal(retrieveCalls, 1);
});

test('only one reset-time probe is allowed for the affected operation', async () => {
  let currentTime = 0;
  let retrieveCalls = 0;
  let releaseProbe;
  const transport = createTransport((call) => {
    if (!call.url.endsWith('/retrieve')) return ok({});
    retrieveCalls += 1;
    if (retrieveCalls === 1) throw axiosStatusError(500);
    if (retrieveCalls === 2) {
      return new Promise((resolve) => {
        releaseProbe = () => resolve(ok({ results: [] }));
      });
    }
    return ok({ results: [] });
  });
  const client = createClient({
    transport,
    failureThreshold: 1,
    resetMs: 1000,
    now: () => currentTime,
  });

  await assert.rejects(client.retrieveRagDocuments(retrieveInput));
  currentTime = 999;
  await assert.rejects(
    client.retrieveRagDocuments(retrieveInput),
    (error) => error.code === 'RAG_CIRCUIT_OPEN',
  );

  currentTime = 1000;
  const probe = client.retrieveRagDocuments(retrieveInput);
  assert.equal(typeof releaseProbe, 'function');
  await assert.rejects(
    client.retrieveRagDocuments(retrieveInput),
    (error) => error.code === 'RAG_CIRCUIT_OPEN',
  );
  releaseProbe();
  assert.deepEqual(await probe, []);
  assert.deepEqual(await client.retrieveRagDocuments(retrieveInput), []);

  assert.equal(retrieveCalls, 3);
});

test('cleanup requests use their own cleanup circuit', async () => {
  let cleanupCalls = 0;
  const transport = createTransport((call) => {
    if (call.url.endsWith('/cleanup-file')) {
      cleanupCalls += 1;
      throw axiosStatusError(500);
    }
    return ok({ results: [] });
  });
  const client = createClient({ transport, failureThreshold: 1 });

  await assert.rejects(client.cleanupRagFileVectors('file-1'));
  await assert.rejects(
    client.cleanupRagFileVectors('file-2'),
    (error) => error.code === 'RAG_CIRCUIT_OPEN',
  );
  assert.deepEqual(await client.retrieveRagDocuments(retrieveInput), []);

  assert.equal(cleanupCalls, 1);
});

test('readiness uses the authenticated RAG ready endpoint and health timeout', async () => {
  const transport = createTransport(() => ok({ status: 'ready' }));
  const client = createClient({ transport });

  await client.checkRagServiceReady();

  assert.deepEqual(transport.calls, [{
    method: 'get',
    url: 'http://rag.test/health/ready',
    config: {
      timeout: 50,
      headers: { 'X-ChatLLM-RAG-Token': 'internal-rag-token' },
    },
  }]);
});

test('health failures open only the health circuit', async () => {
  let healthCalls = 0;
  const transport = createTransport((call) => {
    if (call.url.endsWith('/health/ready')) {
      healthCalls += 1;
      throw axiosStatusError(503);
    }
    return ok({ results: [] });
  });
  const client = createClient({ transport, failureThreshold: 1 });

  await assert.rejects(client.checkRagServiceReady());
  assert.deepEqual(await client.retrieveRagDocuments(retrieveInput), []);
  await assert.rejects(
    client.checkRagServiceReady(),
    (error) => error.code === 'RAG_CIRCUIT_OPEN',
  );

  assert.equal(healthCalls, 1);
});

test('ingestion forwards the durable attempt lease and cancellation signal', async () => {
  const transport = createTransport(() => ok({ status: 'completed' }));
  const client = createClient({ transport });
  const controller = new AbortController();

  await client.ingestRagFile({
    fileId: 'file-1',
    attemptId: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
  }, controller.signal);

  assert.deepEqual(transport.calls, [{
    method: 'post',
    url: 'http://rag.test/ingest-sync',
    data: {
      file_id: 'file-1',
      attempt_id: '11111111-1111-4111-8111-111111111111',
      lease_token: '22222222-2222-4222-8222-222222222222',
    },
    config: {
      timeout: 300,
      headers: { 'X-ChatLLM-RAG-Token': 'internal-rag-token' },
      signal: controller.signal,
    },
  }]);
});

test('an open ingestion circuit does not block retrieval', async () => {
  let ingestCalls = 0;
  const transport = createTransport((call) => {
    if (call.url.endsWith('/ingest-sync')) {
      ingestCalls += 1;
      throw axiosStatusError(500);
    }
    return ok({ results: [] });
  });
  const client = createClient({ transport, failureThreshold: 1 });
  const input = {
    fileId: 'file-1',
    attemptId: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
  };

  await assert.rejects(client.ingestRagFile(input));
  assert.deepEqual(await client.retrieveRagDocuments(retrieveInput), []);
  await assert.rejects(
    client.ingestRagFile(input),
    (error) => error.code === 'RAG_CIRCUIT_OPEN',
  );

  assert.equal(ingestCalls, 1);
});

test('local ingestion cancellation after lease loss does not open the ingest circuit', async () => {
  const outcomes = [new axios.CanceledError('lease lost'), ok({ status: 'completed' })];
  const transport = createTransport(() => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const client = createClient({ transport, failureThreshold: 1 });
  const input = {
    fileId: 'file-1',
    attemptId: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
  };

  await assert.rejects(client.ingestRagFile(input), (error) => axios.isCancel(error));
  await client.ingestRagFile(input);

  assert.equal(transport.calls.length, 2);
});

test('evaluation forwards its durable lease, deadlines, timeout, and cancellation signal', async () => {
  const transport = createTransport(() => ok({ case_count: 1, failed_count: 0, results: [] }));
  const client = createClient({ transport });
  const controller = new AbortController();

  await client.runRagEvaluation({
    run_id: '11111111-1111-4111-8111-111111111111',
    lease_token: '22222222-2222-4222-8222-222222222222',
    deadline_at: '2099-01-01T00:00:00.000Z',
    case_timeout_ms: 60000,
    user_id: 'user-1',
    project_space_id: 'space-1',
    cases: [{ id: 'case-1', question: 'What is durable?' }],
    limit: 10,
    threshold: 0.1,
  }, controller.signal, 120000);

  assert.deepEqual(transport.calls, [{
    method: 'post',
    url: 'http://rag.test/eval/run',
    data: {
      run_id: '11111111-1111-4111-8111-111111111111',
      lease_token: '22222222-2222-4222-8222-222222222222',
      deadline_at: '2099-01-01T00:00:00.000Z',
      case_timeout_ms: 60000,
      user_id: 'user-1',
      project_space_id: 'space-1',
      cases: [{ id: 'case-1', question: 'What is durable?' }],
      limit: 10,
      threshold: 0.1,
    },
    config: {
      timeout: 120000,
      headers: { 'X-ChatLLM-RAG-Token': 'internal-rag-token' },
      signal: controller.signal,
    },
  }]);
});
