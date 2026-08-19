import { createServer } from 'node:http';

const PORT = 3100;
const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_FILE_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '88888888-8888-4888-8888-888888888888';
const RUN_STEP_ID = '99999999-9999-4999-8999-999999999999';
const now = '2026-08-01T12:00:00.000Z';

const user = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'e2e-user',
  display_name: 'E2E User',
  avatar_url: '',
};
const projectSpace = {
  id: SPACE_ID,
  user_id: user.id,
  name: 'E2E Workspace',
  description: 'Browser test workspace',
  is_default: true,
  created_at: now,
  updated_at: now,
};
const conversation = {
  id: CONVERSATION_ID,
  project_space_id: SPACE_ID,
  title: 'E2E Conversation',
  is_pinned: false,
  is_favorite: false,
  tags: [],
  note: '',
  archived_at: null,
  enable_rag: true,
  created_at: now,
  updated_at: now,
};
const source = {
  chunk_id: 'source-chunk-1',
  file_id: SOURCE_FILE_ID,
  filename: 'E2E Source.md',
  chunk_index: 0,
  similarity: 0.98,
  content: 'The integration source proves citation preview behavior.',
  document_kind: 'markdown',
};
const agent = {
  id: AGENT_ID,
  user_id: user.id,
  project_space_id: SPACE_ID,
  name: 'E2E Research Agent',
  description: 'Uses explicitly selected tools for browser QA.',
  avatar: '🧭',
  visibility: 'project',
  status: 'published',
  current_version_id: '77777777-7777-4777-8777-777777777777',
  published_version_id: '77777777-7777-4777-8777-777777777777',
  latest_version: 1,
  version: 1,
  published_version: 1,
  has_unpublished_changes: false,
  instructions: 'Answer with evidence when the RAG tool is used.',
  model: 'deepseek-chat',
  temperature: 0.2,
  max_iterations: 6,
  max_duration_ms: 120000,
  max_output_tokens: 2048,
  memory_mode: 'conversation',
  response_format: 'markdown',
  output_schema: {},
  approval_policy: 'writes',
  tool_bindings: [{ key: 'agentic_rag', enabled: true }],
  welcome_message: 'What would you like to research?',
  suggested_prompts: ['Summarize the workspace evidence'],
  created_at: now,
  updated_at: now,
};

let agentRun = {
  id: RUN_ID,
  user_id: user.id,
  agent_id: AGENT_ID,
  agent_version_id: agent.published_version_id,
  agent_version_snapshot: { version: 1, model: agent.model },
  conversation_id: CONVERSATION_ID,
  status: 'waiting_approval',
  iteration_count: 1,
  tool_call_count: 1,
  token_usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
  error_code: null,
  error_message: null,
  started_at: now,
  completed_at: null,
  created_at: now,
};

const agentRunDetail = () => ({
  ...agentRun,
  steps: [{
    id: RUN_STEP_ID,
    run_id: RUN_ID,
    sequence: 0,
    kind: 'approval',
    status: agentRun.status === 'cancelled' ? 'cancelled' : 'pending',
    tool_call_id: 'e2e-tool-call',
    tool_key: 'agentic_rag',
    input: { query: 'workspace evidence' },
    output: { risk_level: 'read' },
    created_at: now,
  }],
  approvals: [{
    id: 'approval-e2e-1',
    run_id: RUN_ID,
    step_id: RUN_STEP_ID,
    status: agentRun.status === 'cancelled' ? 'expired' : 'pending',
    reason: agentRun.status === 'cancelled' ? 'Agent run cancelled' : '',
    expires_at: '2030-01-01T00:00:00.000Z',
    created_at: now,
  }],
  steps_has_more: false,
  approvals_has_more: false,
});

let uploadedFilename = '';

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString('utf8');
  return value ? JSON.parse(value) : {};
};

const json = (response, payload, status = 200, headers = {}) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(payload));
};

const files = () => [
  {
    id: SOURCE_FILE_ID,
    filename: 'E2E Source.md',
    status: 'completed',
    progress: 100,
    project_space_id: SPACE_ID,
    document_kind: 'markdown',
    conversion_warning_count: 1,
    created_at: now,
  },
  ...(uploadedFilename ? [{
    id: '55555555-5555-4555-8555-555555555555',
    filename: uploadedFilename,
    status: 'completed',
    progress: 100,
    project_space_id: SPACE_ID,
    document_kind: 'markdown',
    created_at: now,
  }] : []),
];

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  if (pathname === '/health') return json(response, { status: 'ok' });
  if (request.method === 'GET' && pathname === '/api/auth/me') return json(response, { user });
  if (request.method === 'POST' && pathname === '/api/auth/login') return json(response, { user });
  if (request.method === 'POST' && pathname === '/api/auth/logout') return json(response, { ok: true });
  if (request.method === 'GET' && pathname === '/api/project-spaces') return json(response, [projectSpace]);
  if (request.method === 'GET' && pathname === '/api/chat/conversations') return json(response, [conversation]);
  if (request.method === 'GET' && pathname === '/api/agents') return json(response, [agent]);
  if (request.method === 'GET' && pathname === '/api/agents/tools/catalog') {
    return json(response, [{
      key: 'agentic_rag',
      name: 'Agentic RAG',
      description: 'Searches workspace evidence with the existing Agentic RAG pipeline.',
      category: 'knowledge',
      risk_level: 'read',
      requires_project: true,
    }]);
  }
  if (request.method === 'GET' && pathname === '/api/agent-runs') {
    const agentFilter = url.searchParams.get('agentId');
    return json(response, agentFilter && agentFilter !== AGENT_ID ? [] : [agentRun]);
  }
  if (request.method === 'GET' && pathname === `/api/agent-runs/${RUN_ID}`) {
    return json(response, agentRunDetail());
  }
  if (request.method === 'POST' && pathname === `/api/agent-runs/${RUN_ID}/cancel`) {
    agentRun = {
      ...agentRun,
      status: 'cancelled',
      completed_at: now,
      error_code: 'agent_run_cancelled',
      error_message: 'Agent run cancelled',
    };
    return json(response, agentRun);
  }
  if (request.method === 'GET' && pathname === '/api/agent-tools') return json(response, []);
  if (request.method === 'GET' && pathname === '/api/prompt-templates') return json(response, []);
  if (request.method === 'GET' && pathname === '/api/usage/provider-health') {
    return json(response, {
      default_provider: 'deepseek',
      default_model: 'deepseek-chat',
      providers: [{
        id: 'deepseek',
        name: 'DeepSeek',
        base_url: 'https://api.deepseek.com',
        default_model: 'deepseek-chat',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        has_api_key: true,
        quota_status: 'unknown',
        capabilities: { tool_calling: true },
      }],
    });
  }
  if (request.method === 'GET' && pathname === `/api/chat/conversations/${CONVERSATION_ID}/messages`) {
    return json(response, [{
      id: 'initial-assistant-message',
      conversation_id: CONVERSATION_ID,
      role: 'assistant',
      content: 'Existing answer with a verified source.',
      sources: [source],
      created_at: now,
    }], 200, {
      'x-chatllm-has-more': 'false',
      'x-chatllm-page-limit': '50',
    });
  }
  if (request.method === 'POST' && pathname === `/api/chat/conversations/${CONVERSATION_ID}/messages`) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    response.write(`data: ${JSON.stringify({ userMessageId: 'stream-user-message' })}\n\n`);
    response.write(`data: ${JSON.stringify({
      assistantMessageId: 'stream-assistant-message',
      content: 'The streamed E2E answer is complete.',
      sources: [source],
    })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  if (request.method === 'GET' && pathname === '/api/upload/files') return json(response, files());
  if (request.method === 'POST' && pathname === '/api/upload/check') {
    const body = await readBody(request);
    uploadedFilename = typeof body.filename === 'string' ? body.filename : 'uploaded-e2e.md';
    return json(response, { exists: true });
  }
  if (request.method === 'GET' && pathname === `/api/upload/files/${SOURCE_FILE_ID}/content`) {
    response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    response.end('# E2E source document\n\nThe citation preview loaded converted Markdown.');
    return;
  }
  if (request.method === 'POST' && (pathname === '/api/rag-workbench/graph/list' || pathname === '/api/rag-workbench/graph/search')) {
    return json(response, {
      results: [{
        id: 'graph-chunk-1',
        content: '订单服务不依赖 Redis，但计划连接到 Kafka。',
        metadata: {
          filename: 'E2E Source.md',
          file_id: SOURCE_FILE_ID,
          chunk_index: 0,
          document_kind: 'markdown',
          source_locator: { type: 'markdown', line_start: 3, line_end: 3 },
          graph_entities: ['订单服务', 'Redis'],
          graph_entity_details: [
            {
              entity_id: 'entity-order-service',
              name: '订单服务',
              normalized_name: '订单服务',
              entity_type: 'System',
              entity_type_label: '业务服务',
              aliases: ['Order Service'],
            },
            {
              entity_id: 'entity-redis',
              name: 'Redis',
              normalized_name: 'redis',
              entity_type: 'Technology',
              entity_type_label: '缓存数据库',
              aliases: [],
            },
          ],
          graph_extraction: {
            status: 'partial_llm_with_rule_fallback',
            attempted: 2,
            succeeded: 1,
            fallbacks: 1,
            extractor_version: 'llm-json-v2',
            ontology_version: 'core-v2',
          },
          graph_relations: [
            {
              fact_id: 'kgfact_e2e_depends',
              type: 'DEPENDS_ON',
              label: '依赖',
              from: '订单服务',
              to: 'Redis',
              from_entity_id: 'entity-order-service',
              to_entity_id: 'entity-redis',
              from_entity_type: 'System',
              to_entity_type: 'Technology',
              evidence: '订单服务不依赖 Redis。',
              polarity: 'negative',
              modality: 'asserted',
              validation_status: 'evidence_supported',
              extraction_lane: 'primary',
              extraction_method: 'llm_json',
              evidence_refs: [{ chunk_id: 'graph-chunk-1', span: '订单服务不依赖 Redis。' }],
            },
          ],
        },
      }, {
        id: 'graph-chunk-2',
        content: '订单服务计划连接到 Kafka。',
        metadata: {
          filename: 'E2E Source.md',
          file_id: SOURCE_FILE_ID,
          chunk_index: 1,
          document_kind: 'markdown',
          source_locator: { type: 'markdown', line_start: 7, line_end: 7 },
          graph_entities: ['订单服务', 'Kafka'],
          graph_entity_details: [
            {
              entity_id: 'entity-order-service',
              name: '订单服务',
              normalized_name: '订单服务',
              entity_type: 'System',
              entity_type_label: '业务服务',
              aliases: ['Order Service'],
            },
            {
              entity_id: 'entity-kafka',
              name: 'Kafka',
              normalized_name: 'kafka',
              entity_type: 'Technology',
              entity_type_label: '消息队列',
              aliases: [],
            },
          ],
          graph_extraction: {
            status: 'partial_llm_with_rule_fallback',
            attempted: 2,
            succeeded: 1,
            fallbacks: 1,
            extractor_version: 'llm-json-v2',
            ontology_version: 'core-v2',
          },
          graph_relations: [
            {
              fact_id: 'kgfact_e2e_connects',
              type: 'CONNECTS_TO',
              label: '计划连接',
              from: '订单服务',
              to: 'Kafka',
              from_entity_id: 'entity-order-service',
              to_entity_id: 'entity-kafka',
              from_entity_type: 'System',
              to_entity_type: 'Technology',
              evidence: '订单服务计划连接到 Kafka。',
              polarity: 'affirmative',
              modality: 'planned_or_obligatory',
              validation_status: 'rule_supported',
              extraction_lane: 'fallback',
              extraction_method: 'regex_rule',
              evidence_refs: [{ chunk_id: 'graph-chunk-2', span: '订单服务计划连接到 Kafka。' }],
            },
          ],
        },
      }],
    });
  }
  if (request.method === 'GET' && pathname === '/api/persona') {
    return json(response, { profile: null, interests: [], observations: [], suggestions: [] });
  }

  return json(response, { error: 'not_found', path: pathname }, 404);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`E2E mock API listening on http://127.0.0.1:${PORT}`);
});

const close = () => server.close(() => process.exit(0));
process.once('SIGINT', close);
process.once('SIGTERM', close);
