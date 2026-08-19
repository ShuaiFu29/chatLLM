import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const { evaluateAgentExpression } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'runtime',
  'calculator.js',
));
const { validateAgentJsonSchemaInput } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'runtime',
  'json-schema-input.js',
));
const {
  validateAgentJsonSchemaDefinition,
  validateAgentJsonObjectSchemaDefinition,
  validateAgentJsonSchemaValue,
  parseAndValidateAgentJsonOutput,
  buildAgentJsonInsufficientEvidenceOutput,
} = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'runtime',
  'json-schema-input.js',
));
const {
  decryptAgentToolSecrets,
  encryptAgentToolSecrets,
} = require(path.join(serverRoot, 'dist', 'lib', 'agentToolSecrets.js'));
const {
  getChatModelCapabilities,
  assertCompatibleModelStreamComplete,
} = require(path.join(serverRoot, 'dist', 'lib', 'llmProviders.js'));
const { createCustomMcpRuntimeTool } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'runtime',
  'custom-mcp-tool.js',
));
const { createCustomHttpRuntimeTool } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'runtime',
  'custom-http-tool.js',
));
const { AgentToolsService } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'agent-tools.service.js',
));
const { isAgentToolInProjectScope } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'runtime',
  'tool-scope.js',
));
const {
  AgentRunService,
  decideAgentToolPolicy,
  getAgentModelResponseFormat,
  mergeStreamingAgentToolCall,
  assertAgentStreamComplete,
  mergeAgenticRagQuality,
  collectAgentSources,
  estimateAgentRequestTokens,
  serializeToolResult,
  getMinimumToolResultBytes,
} = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'agent-run.service.js',
));
const db = require(path.join(serverRoot, 'dist', 'lib', 'db.js'));
const { serverEnv } = require(path.join(serverRoot, 'dist', 'lib', 'env.js'));
const {
  createAgentRun,
  completeAgentRunForUser,
  cancelAgentRunForUser,
  cancelActiveAgentRunsForConversationForUser,
} = require(path.join(serverRoot, 'dist', 'repositories', 'agentRuns.js'));

test('Agent calculator evaluates arithmetic without code execution', () => {
  assert.equal(evaluateAgentExpression('2 + 3 * (4 - 1)'), 11);
  assert.equal(evaluateAgentExpression('2^3^2'), 512);
  assert.equal(evaluateAgentExpression('1e3 / 4'), 250);
  assert.throws(() => evaluateAgentExpression('process.exit()'), /unsupported characters/);
  assert.throws(() => evaluateAgentExpression('1 / 0'), /not finite/);
});

test('custom tool secrets use authenticated encryption and detect tampering', () => {
  const key = 'ab'.repeat(32);
  const encrypted = encryptAgentToolSecrets({ bearer_token: 'secret', 'header:X-Key': 'value' }, key);
  assert.doesNotMatch(encrypted, /secret|value/);
  assert.deepEqual(decryptAgentToolSecrets(encrypted, key), {
    bearer_token: 'secret',
    'header:X-Key': 'value',
  });
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => decryptAgentToolSecrets(tampered, key));
});

test('custom Agent JSON schema validation rejects missing, extra, and wrongly typed inputs', () => {
  const schema = {
    type: 'object',
    properties: {
      city: { type: 'string', minLength: 1, maxLength: 80 },
      days: { type: 'integer', minimum: 1, maximum: 14 },
    },
    required: ['city'],
    additionalProperties: false,
  };
  assert.deepEqual(validateAgentJsonSchemaInput({ city: 'Shanghai', days: 3 }, schema), {
    city: 'Shanghai',
    days: 3,
  });
  assert.throws(() => validateAgentJsonSchemaInput({ days: 3 }, schema), /Missing required/);
  assert.throws(() => validateAgentJsonSchemaInput({ city: 'Shanghai', debug: true }, schema), /Unexpected/);
  assert.throws(() => validateAgentJsonSchemaInput({ city: 'Shanghai', days: 1.5 }, schema), /Invalid type/);
});

test('Agent approval policy is fail-closed for write tools', () => {
  assert.equal(decideAgentToolPolicy('never', 'read'), 'execute');
  assert.equal(decideAgentToolPolicy('never', 'write'), 'reject');
  assert.equal(decideAgentToolPolicy('never', 'high'), 'reject');
  assert.equal(decideAgentToolPolicy('writes', 'read'), 'execute');
  assert.equal(decideAgentToolPolicy('writes', 'write'), 'approve');
  assert.equal(decideAgentToolPolicy('writes', 'high'), 'approve');
  assert.equal(decideAgentToolPolicy('always', 'read'), 'approve');
  assert.equal(decideAgentToolPolicy('always', 'write'), 'approve');
  assert.equal(decideAgentToolPolicy('always', 'high'), 'approve');
});

test('custom Agent tools are limited to global or matching project scope', () => {
  assert.equal(isAgentToolInProjectScope(null, null), true);
  assert.equal(isAgentToolInProjectScope(null, 'project-a'), true);
  assert.equal(isAgentToolInProjectScope('project-a', 'project-a'), true);
  assert.equal(isAgentToolInProjectScope('project-a', 'project-b'), false);
  assert.equal(isAgentToolInProjectScope('project-a', null), false);
});

test('Agent JSON output parsing accepts valid output and rejects invalid JSON/schema output', () => {
  const schema = {
    type: 'object',
    properties: {
      answer: { type: 'string', minLength: 1 },
      citations: { type: 'array', items: { type: 'string' } },
    },
    required: ['answer'],
    additionalProperties: false,
  };
  validateAgentJsonSchemaDefinition(schema);
  assert.deepEqual(parseAndValidateAgentJsonOutput('{"answer":"ok","citations":[]}', schema), {
    answer: 'ok',
    citations: [],
  });
  assert.throws(() => parseAndValidateAgentJsonOutput('{"answer":', schema), /not valid JSON/);
  assert.throws(() => parseAndValidateAgentJsonOutput('{"citations":[]}', schema), /does not match/);
  assert.throws(() => parseAndValidateAgentJsonOutput('{"answer":"ok","extra":true}', schema), /does not match/);
  assert.throws(() => validateAgentJsonSchemaDefinition({
    type: 'object',
    required: ['missing'],
    properties: {},
  }), /unknown property/);
  assert.throws(() => validateAgentJsonObjectSchemaDefinition({ type: 'array', items: { type: 'string' } }), /allow an object/);
  assert.throws(() => validateAgentJsonSchemaDefinition({ type: 'string', pattern: '.*' }), /unsupported keyword/);
  assert.throws(() => validateAgentJsonSchemaDefinition({
    type: 'object',
    description: 'x'.repeat(70_000),
  }), /maximum size/);
  assert.deepEqual(validateAgentJsonSchemaValue({ any: true }, {}, 'output'), { any: true });
});

test('JSON Agent grounding refusals preserve the configured output schema', () => {
  const schema = {
    type: 'object',
    properties: {
      answer: { type: 'string', minLength: 1 },
      citations: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['answer', 'citations', 'confidence'],
    additionalProperties: false,
  };
  const refusal = buildAgentJsonInsufficientEvidenceOutput(
    schema,
    'Insufficient evidence to answer reliably.',
  );
  assert.match(refusal.answer, /Insufficient evidence/);
  assert.deepEqual(refusal.citations, []);
  assert.equal(refusal.confidence, 0);
  assert.deepEqual(parseAndValidateAgentJsonOutput(JSON.stringify(refusal), schema), refusal);
});

test('JSON Agent grounding refusals keep an empty object schema valid', () => {
  const refusal = buildAgentJsonInsufficientEvidenceOutput(
    {},
    'Insufficient evidence to answer reliably.',
  );
  assert.deepEqual(refusal, { answer: 'Insufficient evidence to answer reliably.' });
  assert.deepEqual(parseAndValidateAgentJsonOutput(JSON.stringify(refusal), {}), refusal);
});

test('Agent model capability contract excludes unsupported reasoning models', () => {
  assert.equal(getChatModelCapabilities('deepseek-chat').tool_calling, true);
  assert.equal(getChatModelCapabilities('deepseek-reasoner').tool_calling, false);
  assert.equal(getChatModelCapabilities('qwen-plus').tool_calling, true);
  assert.equal(getChatModelCapabilities('moonshot-v1-8k').context_window_tokens, 8192);
  assert.ok(getChatModelCapabilities('qwen-plus').context_window_tokens > 8192);
});

test('Agent JSON mode only requests provider structured output when supported', () => {
  assert.deepEqual(getAgentModelResponseFormat('json', true), { type: 'json_object' });
  assert.equal(getAgentModelResponseFormat('json', false), undefined);
  assert.equal(getAgentModelResponseFormat('markdown', true), undefined);
});

test('streaming Agent tool-call deltas merge indexed, id-only, and cumulative provider chunks', () => {
  const calls = new Map();
  mergeStreamingAgentToolCall(calls, {
    index: '0',
    id: 'call-1',
    function: { name: 'weather', arguments: '{"city"' },
  }, 0);
  mergeStreamingAgentToolCall(calls, {
    id: 'call-1',
    function: { arguments: ':"Shanghai"}' },
  }, 0);
  mergeStreamingAgentToolCall(calls, {
    index: 0,
    function: { arguments: '{"city":"Shanghai"}' },
  }, 0);
  assert.deepEqual([...calls.values()], [{
    id: 'call-1',
    type: 'function',
    function: { name: 'weather', arguments: '{"city":"Shanghai"}' },
  }]);
});

test('streaming Agent tool-call deltas keep parallel id-only calls separate', () => {
  const calls = new Map();
  mergeStreamingAgentToolCall(calls, {
    id: 'call-1',
    function: { name: 'first', arguments: '{}' },
  }, 0);
  mergeStreamingAgentToolCall(calls, {
    id: 'call-2',
    function: { name: 'second', arguments: '{}' },
  }, 1);
  assert.deepEqual([...calls.values()].map((call) => call.id), ['call-1', 'call-2']);
  assert.deepEqual([...calls.values()].map((call) => call.function.name), ['first', 'second']);
});

test('Agent rejects a model stream that closes without a finish reason', () => {
  assert.equal(assertAgentStreamComplete('stop'), 'stop');
  assert.equal(assertAgentStreamComplete('tool_calls'), 'tool_calls');
  assert.throws(
    () => assertAgentStreamComplete(null),
    /ended without a finish reason/,
  );
  assert.throws(
    () => assertAgentStreamComplete(''),
    /ended without a finish reason/,
  );
});

test('compatible model SSE streams must include the [DONE] sentinel', () => {
  assert.doesNotThrow(() => assertCompatibleModelStreamComplete(true));
  assert.throws(
    () => assertCompatibleModelStreamComplete(false),
    /ended without \[DONE\]/,
  );
});

test('multiple Agentic RAG calls keep the weakest grounding quality', () => {
  assert.deepEqual(mergeAgenticRagQuality({
    evidence_label: 'strong',
    support_label: 'supported',
    overall_score: 0.9,
  }, {
    evidence_label: 'weak',
    support_label: 'unsupported',
    overall_score: 0.4,
    risk_factors: ['missing citation'],
  }), {
    evidence_label: 'weak',
    support_label: 'unsupported',
    overall_score: 0.4,
    risk_factors: ['missing citation'],
    missing_markers: [],
    matched_markers: [],
  });
});

test('Agent request estimates include tool definitions and use a conservative UTF-8 budget', () => {
  const messages = [
    { role: 'system', content: '系统指令' },
    { role: 'user', content: '请查询项目资料' },
  ];
  const withoutTools = estimateAgentRequestTokens(messages, []);
  const withTools = estimateAgentRequestTokens(messages, [{
    definition: {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Lookup a long external record',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    },
  }]);
  assert.ok(withoutTools > 0);
  assert.ok(withTools > withoutTools);
});

test('Agent tool result envelopes stay within the exact UTF-8 budget', () => {
  const maximum = getMinimumToolResultBytes() + 32;
  const serialized = serializeToolResult({ text: '你好'.repeat(1000) }, maximum);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= maximum);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.truncated, true);
  assert.throws(
    () => serializeToolResult({ text: 'x'.repeat(1000) }, getMinimumToolResultBytes() - 1),
    /no room for a tool result/,
  );
});

test('Agent source collection grounds document inventory and commits limit checks atomically', () => {
  const sources = [];
  collectAgentSources('list_documents', [{
    id: 'file-1',
    filename: 'policy.md',
    status: 'completed',
    document_kind: 'markdown',
    size: 123,
  }], sources);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].filename, 'policy.md');
  assert.match(sources[0].content, /Status: completed/);

  const originalMaximum = serverEnv.AGENT_MAX_SOURCES;
  serverEnv.AGENT_MAX_SOURCES = 1;
  try {
    assert.throws(() => collectAgentSources('list_documents', [{
      id: 'file-2',
      filename: 'second.md',
      status: 'completed',
    }], sources), /source limit/);
    assert.equal(sources.length, 1, 'failed collection left a partial source behind');
  } finally {
    serverEnv.AGENT_MAX_SOURCES = originalMaximum;
  }
});

test('remote MCP runtime initializes a session, calls the configured tool, and closes it', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = body ? JSON.parse(body) : null;
      requests.push({ method: request.method, payload, session: request.headers['mcp-session-id'] });
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      if (payload?.method === 'initialize') {
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', 'test-session');
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'test-mcp', version: '1.0.0' },
          },
        }));
        return;
      }
      if (payload?.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      response.setHeader('content-type', 'text/event-stream');
      response.end(`event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { content: [{ type: 'text', text: `Hello ${payload.params.arguments.name}` }] },
      })}\n\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const runtimeTool = createCustomMcpRuntimeTool({
    id: '11111111-1111-4111-8111-111111111111',
    user_id: 'user-1',
    project_space_id: null,
    name: 'Greeting',
    description: 'Greets a person',
    kind: 'mcp',
    risk_level: 'read',
    configuration: {
      endpoint: `http://127.0.0.1:${address.port}/mcp`,
      tool_name: 'greet',
      timeout_ms: 5000,
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
    enabled: true,
    has_secrets: false,
    encrypted_secrets: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const result = await runtimeTool.execute(
    { name: 'Codex' },
    {
      userId: 'user-1',
      projectSpaceId: null,
      conversationId: 'conversation-1',
      signal: new AbortController().signal,
    },
  );

  assert.deepEqual(result, { content: [{ type: 'text', text: 'Hello Codex' }] });
  assert.equal(requests[2].payload.method, 'tools/call');
  assert.equal(requests[2].session, 'test-session');
  assert.equal(requests.at(-1).method, 'DELETE');
});

test('remote MCP SSE runtime returns as soon as the matching event arrives even when the connection stays open', async (t) => {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = body ? JSON.parse(body) : null;
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      if (payload?.method === 'initialize') {
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', 'long-lived-session');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: {} }));
        return;
      }
      if (payload?.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      response.setHeader('content-type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { ok: true } })}\n\n`);
      // Deliberately leave the response open. The runtime must cancel its
      // reader after receiving the matching JSON-RPC response.
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const runtimeTool = createCustomMcpRuntimeTool({
    id: '44444444-4444-4444-8444-444444444444',
    user_id: 'user-1',
    project_space_id: null,
    name: 'Long lived MCP',
    description: '',
    kind: 'mcp',
    risk_level: 'read',
    configuration: {
      endpoint: `http://127.0.0.1:${address.port}/mcp`,
      tool_name: 'long_lived',
      timeout_ms: 1000,
      input_schema: { type: 'object', properties: {} },
    },
    enabled: true,
    has_secrets: false,
    encrypted_secrets: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const startedAt = Date.now();
  const result = await runtimeTool.execute({}, {
    userId: 'user-1',
    projectSpaceId: null,
    conversationId: 'conversation-1',
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(Date.now() - startedAt < 900, 'MCP call waited for the remote SSE connection to close');
});

test('remote MCP runtime denies hosts outside the deployment allowlist', async () => {
  const runtimeTool = createCustomMcpRuntimeTool({
    id: '22222222-2222-4222-8222-222222222222',
    user_id: 'user-1',
    name: 'Blocked',
    description: '',
    kind: 'mcp',
    risk_level: 'read',
    configuration: {
      endpoint: 'https://not-allowed.example/mcp',
      tool_name: 'blocked',
      timeout_ms: 1000,
    },
    enabled: true,
    has_secrets: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await assert.rejects(() => runtimeTool.execute({}, {
    userId: 'user-1',
    conversationId: 'conversation-1',
    signal: new AbortController().signal,
  }), /not allowlisted/);
});

test('remote MCP tool-level errors are not recorded as successful results', async (t) => {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'DELETE') {
        response.writeHead(204).end();
        return;
      }
      const payload = body ? JSON.parse(body) : {};
      if (payload.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.setHeader('mcp-session-id', 'error-session');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: payload.method === 'tools/call'
          ? { isError: true, content: [{ type: 'text', text: 'remote failure' }] }
          : {},
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const runtimeTool = createCustomMcpRuntimeTool({
    id: '55555555-5555-4555-8555-555555555555',
    user_id: 'user-1',
    project_space_id: null,
    name: 'Failing MCP',
    description: '',
    kind: 'mcp',
    risk_level: 'write',
    configuration: {
      endpoint: `http://127.0.0.1:${address.port}/mcp`,
      tool_name: 'fail',
      timeout_ms: 5000,
      input_schema: { type: 'object', properties: {} },
    },
    enabled: true,
    has_secrets: false,
    encrypted_secrets: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await assert.rejects(() => runtimeTool.execute({}, {
    userId: 'user-1',
    conversationId: 'conversation-1',
    signal: new AbortController().signal,
  }), /execution error/);
});

test('custom tool configuration rejects credential-like URL query parameters and fragments', () => {
  const service = new AgentToolsService();
  assert.throws(() => service.validateConfiguration('http', {
    endpoint: 'https://api.example.com/weather?api_key=hidden',
    method: 'GET',
  }), (error) => error?.response?.error === 'Credential query parameters must be stored in the secrets section');
  assert.throws(() => service.validateConfiguration('mcp', {
    endpoint: 'https://mcp.example.com/server#token=hidden',
    tool_name: 'search',
  }), (error) => error?.response?.error === 'Endpoint fragments are not allowed; store credentials in the secrets section');
  assert.deepEqual(service.validateConfiguration('http', {
    endpoint: 'https://api.example.com/weather?tenant=public',
    method: 'GET',
  }).endpoint, 'https://api.example.com/weather?tenant=public');
});

test('custom HTTP runtime validates inputs, applies encrypted credentials, and selects response data', async (t) => {
  let receivedRequest;
  const server = createServer((request, response) => {
    receivedRequest = {
      url: request.url,
      authorization: request.headers.authorization,
      apiKey: request.headers['x-api-key'],
    };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ payload: { temperature: 23 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const runtimeTool = createCustomHttpRuntimeTool({
    id: '33333333-3333-4333-8333-333333333333',
    user_id: 'user-1',
    name: 'Weather',
    description: 'Reads weather',
    kind: 'http',
    risk_level: 'read',
    configuration: {
      endpoint: `http://127.0.0.1:${address.port}/weather/{city}?scope=configured-scope`,
      method: 'GET',
      timeout_ms: 5000,
      input_schema: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          units: { type: 'string' },
          tenant: { type: 'string' },
          scope: { type: 'string' },
        },
        required: ['city'],
        additionalProperties: false,
      },
      static_headers: {},
      response_path: 'payload',
    },
    encrypted_secrets: encryptAgentToolSecrets({
      bearer_token: 'runtime-test-token',
      'header:X-Api-Key': 'runtime-test-key',
      'query:tenant': 'tenant-a',
    }),
    enabled: true,
    has_secrets: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const result = await runtimeTool.execute({
    city: 'Shanghai',
    units: 'metric',
    tenant: 'model-controlled-tenant',
    scope: 'model-controlled-scope',
  }, {
    userId: 'user-1',
    conversationId: 'conversation-1',
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, { status: 200, data: { temperature: 23 } });
  assert.match(receivedRequest.url, /^\/weather\/Shanghai\?/);
  assert.match(receivedRequest.url, /units=metric/);
  assert.match(receivedRequest.url, /tenant=tenant-a/);
  assert.doesNotMatch(receivedRequest.url, /model-controlled-tenant/);
  assert.match(receivedRequest.url, /scope=configured-scope/);
  assert.doesNotMatch(receivedRequest.url, /model-controlled-scope/);
  assert.equal(receivedRequest.authorization, 'Bearer runtime-test-token');
  assert.equal(receivedRequest.apiKey, 'runtime-test-key');
});

test('custom HTTP runtime fails when a configured response path is absent', async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ payload: {} }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const runtimeTool = createCustomHttpRuntimeTool({
    id: '66666666-6666-4666-8666-666666666666',
    user_id: 'user-1',
    name: 'Missing response path',
    description: '',
    kind: 'http',
    risk_level: 'read',
    configuration: {
      endpoint: `http://127.0.0.1:${address.port}/data`,
      method: 'GET',
      timeout_ms: 5000,
      input_schema: { type: 'object', properties: {} },
      static_headers: {},
      response_path: 'payload.items',
    },
    encrypted_secrets: null,
    enabled: true,
    has_secrets: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await assert.rejects(() => runtimeTool.execute({}, {
    userId: 'user-1',
    conversationId: 'conversation-1',
    signal: new AbortController().signal,
  }), /response path was not found/);
});

test('Agent approval wait resumes exactly once for the owning user and run', async () => {
  const service = new AgentRunService({});
  const controller = new AbortController();
  const pending = service.waitForApproval({
    approvalId: 'approval-1',
    runId: 'run-1',
    userId: 'user-1',
    signal: controller.signal,
  });
  assert.equal(service.hasPendingApproval('approval-1', 'run-1', 'user-1'), true);
  assert.equal(service.resolveApproval('approval-1', 'run-1', 'other-user', {
    decision: 'approved',
    reason: '',
  }), false);
  assert.equal(service.resolveApproval('approval-1', 'run-1', 'user-1', {
    decision: 'approved',
    reason: 'confirmed',
  }), true);
  assert.deepEqual(await pending, { decision: 'approved', reason: 'confirmed' });
  assert.equal(service.hasPendingApproval('approval-1', 'run-1', 'user-1'), false);
  assert.equal(service.resolveApproval('approval-1', 'run-1', 'user-1', {
    decision: 'approved',
    reason: '',
  }), false);
});

test('Agent run creation consumes a pre-run cancellation intent before quota insertion', async () => {
  const originalWithTransaction = db.withTransaction;
  const calls = [];
  db.withTransaction = async (callback) => callback({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/delete from agent_run_cancel_intents/i.test(sql)) {
        return { rows: [{ user_message_id: 'message-1' }] };
      }
      return { rows: [] };
    },
  });
  try {
    await assert.rejects(() => createAgentRun({
      userId: 'user-1',
      agentId: 'agent-1',
      agentVersionId: 'version-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      agentVersionSnapshot: {},
    }), /AGENT_RUN_CANCELLED_BEFORE_START/);
    assert.equal(calls.some((call) => /insert into agent_runs/i.test(call.sql)), false);
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});

test('Agent run creation persists an assistant placeholder for reload recovery', async () => {
  const originalWithTransaction = db.withTransaction;
  const calls = [];
  db.withTransaction = async (callback) => callback({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/delete from agent_run_cancel_intents/i.test(sql)) return { rows: [] };
      if (/select count\(\*\)/i.test(sql)) return { rows: [{ count: '0' }] };
      if (/insert into agent_runs/i.test(sql)) {
        return { rows: [{ id: 'run-1', conversation_id: 'conversation-1', status: 'running' }] };
      }
      if (/insert into messages/i.test(sql)) return { rows: [{ id: 'assistant-1' }] };
      if (/update agent_runs/i.test(sql)) {
        return { rows: [{
          id: 'run-1',
          conversation_id: 'conversation-1',
          assistant_message_id: 'assistant-1',
          status: 'running',
        }] };
      }
      return { rows: [] };
    },
  });
  try {
    const run = await createAgentRun({
      userId: 'user-1',
      agentId: 'agent-1',
      agentVersionId: 'version-1',
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      agentVersionSnapshot: {},
    });
    assert.equal(run.assistant_message_id, 'assistant-1');
    assert.ok(calls.some((call) => /values \(\$1, 'assistant', '', '\[\]'::jsonb\)/i.test(call.sql)));
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});

test('Agent completion fills the persisted assistant placeholder instead of duplicating it', async () => {
  const originalWithTransaction = db.withTransaction;
  const calls = [];
  db.withTransaction = async (callback) => callback({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/select[\s\S]+from agent_runs/i.test(sql)) {
        return { rows: [{
          id: 'run-1',
          user_id: 'user-1',
          conversation_id: 'conversation-1',
          assistant_message_id: 'assistant-1',
          status: 'running',
        }] };
      }
      if (/update messages/i.test(sql)) {
        return { rows: [{
          id: 'assistant-1',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: 'done',
          sources: [],
          created_at: new Date().toISOString(),
        }] };
      }
      if (/update agent_runs/i.test(sql)) {
        return { rows: [{ id: 'run-1', status: 'succeeded', assistant_message_id: 'assistant-1' }] };
      }
      return { rows: [] };
    },
  });
  try {
    const completed = await completeAgentRunForUser({
      runId: 'run-1',
      userId: 'user-1',
      content: 'done',
      sources: [],
      assistantStepSequence: 0,
      iterationCount: 1,
      toolCallCount: 0,
      tokenUsage: {},
    });
    assert.equal(completed.assistantMessage.id, 'assistant-1');
    assert.ok(calls.some((call) => /update messages/i.test(call.sql)));
    assert.equal(calls.some((call) => /insert into messages/i.test(call.sql)), false);
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});

test('cancelling an Agent run atomically expires approvals and cancels active steps', async () => {
  const originalWithTransaction = db.withTransaction;
  const calls = [];
  db.withTransaction = async (callback) => callback({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/update agent_runs/i.test(sql)) {
        return {
          rows: [{
            id: 'run-1',
            status: 'cancelled',
            agent_version_snapshot: {},
          }],
        };
      }
      return { rows: [] };
    },
  });
  try {
    const run = await cancelAgentRunForUser('run-1', 'user-1');
    assert.equal(run.status, 'cancelled');
    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /status = 'cancelled'/i);
    assert.match(calls[1].sql, /status = 'expired'/i);
    assert.match(calls[2].sql, /status in \('pending', 'running'\)/i);
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});

test('conversation cancellation closes the pre-SSE Agent stop race atomically', async () => {
  const originalWithTransaction = db.withTransaction;
  const calls = [];
  db.withTransaction = async (callback) => callback({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/select message\.id/i.test(sql)) {
        return { rows: [{ id: 'message-1' }] };
      }
      if (/update agent_runs/i.test(sql)) {
        return {
          rows: [{
            id: 'run-1',
            conversation_id: 'conversation-1',
            assistant_message_id: 'assistant-1',
            status: 'cancelled',
            agent_version_snapshot: {},
          }],
        };
      }
      return { rows: [] };
    },
  });
  try {
    const runs = await cancelActiveAgentRunsForConversationForUser('conversation-1', 'user-1');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'cancelled');
    assert.match(calls.find((call) => /update agent_runs/i.test(call.sql)).sql, /conversation_id = \$1/i);
    assert.ok(calls.some((call) => /agent_run_cancel_intents/i.test(call.sql)));
    assert.ok(calls.some((call) => /status = 'expired'/i.test(call.sql)));
    assert.ok(calls.some((call) => /status in \('pending', 'running'\)/i.test(call.sql)));
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});
