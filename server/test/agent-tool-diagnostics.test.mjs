import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const { runAgentToolDiagnostic } = require(path.join(
  serverRoot, 'dist', 'modules', 'agents', 'runtime', 'agent-tool-diagnostics.js',
));
const { encryptAgentToolSecrets } = require(path.join(
  serverRoot, 'dist', 'lib', 'agentToolSecrets.js',
));
const {
  decodeAgentToolDiagnosticCursor,
  encodeAgentToolDiagnosticCursor,
} = require(path.join(
  serverRoot, 'dist', 'lib', 'agentToolDiagnosticCursor.js',
));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HTTP_TOOL_ID = '22222222-2222-4222-8222-222222222222';
const MCP_TOOL_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';

const toolRow = (overrides = {}) => ({
  id: HTTP_TOOL_ID,
  user_id: USER_ID,
  project_space_id: null,
  name: 'Diagnostic tool',
  description: 'Used by diagnostic tests',
  kind: 'http',
  risk_level: 'read',
  max_invocations_per_run: null,
  configuration: {
    endpoint: 'https://not-allowlisted.example/api',
    method: 'GET',
    idempotency_mode: 'none',
    timeout_ms: 5000,
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    static_headers: {},
    response_path: '',
  },
  enabled: true,
  has_secrets: false,
  encrypted_secrets: null,
  current_version_id: VERSION_ID,
  latest_version: 1,
  tool_version_id: VERSION_ID,
  tool_version: 1,
  secret_version: 1,
  configuration_hash: 'a'.repeat(64),
  derived_from_version_id: null,
  change_kind: 'created',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  tool_version_created_at: new Date().toISOString(),
  ...overrides,
});

const listen = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
};

test('Agent tool diagnostic history cursor round-trips only its stable boundary', () => {
  const boundary = {
    checkedAt: '2026-08-29T08:09:10.123Z',
    id: '55555555-5555-4555-8555-555555555555',
  };
  const cursor = encodeAgentToolDiagnosticCursor(boundary);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeAgentToolDiagnosticCursor(cursor), boundary);
  assert.equal(decodeAgentToolDiagnosticCursor(undefined), null);
});

test('Agent tool diagnostic history cursor rejects forged or non-canonical boundaries', () => {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  for (const invalid of [
    'not-json',
    `${encode({ checked_at: '2026-08-29T08:09:10.123Z', id: VERSION_ID })}x`,
    encode({ checked_at: 'not-a-date', id: VERSION_ID }),
    encode({ checked_at: '2026-08-29T08:09:10.123Z', id: 'not-a-uuid' }),
    encode({ checked_at: '2026-08-29T08:09:10.123Z', id: VERSION_ID, direction: 'asc' }),
    'x'.repeat(513),
  ]) {
    assert.throws(
      () => decodeAgentToolDiagnosticCursor(invalid),
      /Invalid Agent tool diagnostic cursor/,
    );
  }
});

test('preflight reports an unallowlisted endpoint without sending a live request', async () => {
  const result = await runAgentToolDiagnostic({ tool: toolRow(), operation: 'preflight' });
  assert.equal(result.status, 'failed');
  assert.equal(result.live_request_attempted, false);
  assert.equal(result.error.code, 'tool_endpoint_not_allowlisted');
  assert.ok(result.checks.some((entry) => entry.key === 'allowlist' && entry.status === 'failed'));
});

test('live diagnostics refuse every HTTP write even when its endpoint is reachable', async () => {
  const audits = [];
  const tool = toolRow({
    risk_level: 'write',
    configuration: {
      ...toolRow().configuration,
      endpoint: 'http://127.0.0.1:65534/write',
      method: 'POST',
    },
  });
  const result = await runAgentToolDiagnostic({
    tool,
    operation: 'safe_test',
    arguments: { value: 'must-not-send' },
    recordDiagnosticEvent: async (event) => audits.push(event),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.live_request_attempted, false);
  assert.equal(result.error.code, 'diagnostic_operation_unsafe');
  assert.equal(audits.length, 0);
});

test('safe HTTP test reuses the runtime boundary, audits before send, and bounds its preview', async (t) => {
  let requests = 0;
  let received;
  const { server, endpoint } = await listen((request, response) => {
    requests += 1;
    received = { url: request.url, authorization: request.headers.authorization };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      payload: {
        echoed_authorization: request.headers.authorization,
        text: 'x'.repeat(40 * 1024),
      },
    }));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const encryptedSecrets = encryptAgentToolSecrets(
    { bearer_token: 'private-token' },
    { userId: USER_ID, toolId: HTTP_TOOL_ID, secretVersion: 1 },
  );
  const tool = toolRow({
    has_secrets: true,
    encrypted_secrets: encryptedSecrets,
    configuration: {
      ...toolRow().configuration,
      endpoint: `${endpoint}/weather/{city}`,
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' }, ignored: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
      response_path: 'payload',
    },
  });
  const audits = [];
  const secretEvents = [];
  const result = await runAgentToolDiagnostic({
    tool,
    operation: 'safe_test',
    arguments: { city: 'shanghai', ignored: 'declared' },
    recordDiagnosticEvent: async (event) => audits.push(event),
    recordSecretEvent: async (event) => secretEvents.push(event),
  });

  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.live_request_attempted, true);
  assert.equal(requests, 1);
  assert.equal(received.url, '/weather/shanghai?ignored=declared');
  assert.equal(received.authorization, 'Bearer private-token');
  assert.equal(result.response.status, 200);
  assert.equal(result.response.preview.truncated, true);
  assert.equal(result.response.preview.encoding, 'json-prefix');
  assert.match(String(result.response.preview.data), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result.response.preview), /private-token/);
  assert.equal(audits[0].phase, 'started');
  assert.equal(audits[0].liveRequestAttempted, false);
  assert.equal(audits[1].phase, 'completed');
  assert.equal(audits[1].status, 'passed');
  assert.equal(secretEvents.length, 1);
  assert.equal(secretEvents[0].eventType, 'used');
  assert.equal(secretEvents[0].runId, null);
  assert.equal(secretEvents[0].agentId, null);
  assert.doesNotMatch(JSON.stringify(audits), /private-token|shanghai|declared/);
});

test('an unavailable diagnostic audit fails closed before the HTTP request', async (t) => {
  let requests = 0;
  const { server, endpoint } = await listen((_request, response) => {
    requests += 1;
    response.end('{}');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await runAgentToolDiagnostic({
    tool: toolRow({ configuration: { ...toolRow().configuration, endpoint: `${endpoint}/safe` } }),
    operation: 'safe_test',
    arguments: {},
    recordDiagnosticEvent: async () => { throw new Error('audit unavailable'); },
  });
  assert.equal(result.error.code, 'diagnostic_audit_failed');
  assert.equal(result.live_request_attempted, false);
  assert.equal(requests, 0);
});

test('an unavailable Secret audit fails closed and reports that no HTTP request was sent', async (t) => {
  let requests = 0;
  const { server, endpoint } = await listen((_request, response) => {
    requests += 1;
    response.end('{}');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const encryptedSecrets = encryptAgentToolSecrets(
    { bearer_token: 'private-token' },
    { userId: USER_ID, toolId: HTTP_TOOL_ID, secretVersion: 1 },
  );
  const result = await runAgentToolDiagnostic({
    tool: toolRow({
      has_secrets: true,
      encrypted_secrets: encryptedSecrets,
      configuration: { ...toolRow().configuration, endpoint: `${endpoint}/safe` },
    }),
    operation: 'safe_test',
    arguments: {},
    recordDiagnosticEvent: async () => undefined,
    recordSecretEvent: async () => { throw new Error('secret audit unavailable'); },
  });
  assert.equal(result.error.code, 'tool_secret_audit_failed');
  assert.equal(result.live_request_attempted, false);
  assert.equal(requests, 0);
});

test('safe HTTP test rejects a response that violates the pinned Output Schema', async (t) => {
  const { server, endpoint } = await listen((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ payload: { temperature: 'hot' } }));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await runAgentToolDiagnostic({
    tool: toolRow({
      configuration: {
        ...toolRow().configuration,
        endpoint: `${endpoint}/weather`,
        response_path: 'payload',
        output_schema: {
          type: 'object',
          properties: { temperature: { type: 'number' } },
          required: ['temperature'],
          additionalProperties: false,
        },
      },
    }),
    operation: 'safe_test',
    arguments: {},
    recordDiagnosticEvent: async () => undefined,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.live_request_attempted, true);
  assert.equal(result.error.code, 'tool_output_invalid');
});

test('MCP discovery initializes, paginates tools/list, and never invokes tools/call', async (t) => {
  const methods = [];
  let deletes = 0;
  const { server, endpoint } = await listen((request, response) => {
    if (request.method === 'DELETE') {
      deletes += 1;
      response.end('');
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body);
      methods.push(message.method);
      response.setHeader('content-type', 'application/json');
      response.setHeader('mcp-session-id', 'diagnostic-session');
      if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end('');
      } else if (message.method === 'initialize') {
        response.end(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: `fixture-${request.headers.authorization}`, version: '1.2.3' },
          },
        }));
      } else if (message.method === 'tools/list' && !message.params.cursor) {
        response.end(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: {
            tools: [{
              name: 'search', description: 'Search safely',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
              outputSchema: {
                type: 'object',
                properties: { hits: { type: 'array', items: { type: 'string' } } },
                required: ['hits'],
              },
            }],
            nextCursor: 'page-2',
          },
        }));
      } else {
        response.end(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: {
            tools: [{
              name: 'lookup',
              inputSchema: { type: 'array', items: { type: 'string' } },
              outputSchema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            }],
          },
        }));
      }
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const mcpSecrets = encryptAgentToolSecrets(
    { bearer_token: 'mcp-private-token' },
    { userId: USER_ID, toolId: MCP_TOOL_ID, secretVersion: 1 },
  );
  const result = await runAgentToolDiagnostic({
    tool: toolRow({
      id: MCP_TOOL_ID,
      kind: 'mcp',
      risk_level: 'write',
      has_secrets: true,
      encrypted_secrets: mcpSecrets,
      configuration: {
        endpoint: `${endpoint}/mcp`, tool_name: 'search', timeout_ms: 5000,
        input_schema: { type: 'object', properties: {} },
      },
    }),
    operation: 'discover',
    recordDiagnosticEvent: async () => undefined,
    recordSecretEvent: async () => undefined,
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.discovery.selected_tool_found, true);
  assert.deepEqual(result.discovery.tools.map((entry) => entry.name), ['search', 'lookup']);
  assert.equal(result.discovery.tools[0].output_schema.properties.hits.type, 'array');
  assert.deepEqual(result.discovery.tools[1].input_schema, { type: 'object', properties: {} });
  assert.equal('output_schema' in result.discovery.tools[1], false);
  assert.ok(result.discovery.warnings.some((warning) => warning.includes('Invalid Input Schema')));
  assert.ok(result.discovery.warnings.some((warning) => warning.includes('Invalid Output Schema')));
  assert.equal(result.discovery.server_info.name, 'fixture-Bearer [REDACTED]');
  assert.doesNotMatch(JSON.stringify(result.discovery), /mcp-private-token/);
  assert.equal(methods.filter((method) => method === 'tools/list').length, 2);
  assert.equal(methods.includes('tools/call'), false);
  assert.equal(deletes, 1);
});
