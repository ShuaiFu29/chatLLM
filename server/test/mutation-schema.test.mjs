import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const UUID = '11111111-1111-4111-8111-111111111111';
const SHA256 = 'a'.repeat(64);

const expectedRouteSchemas = {
  'modules/auth/auth.controller.ts': [
    'authRegister',
    'authLogin',
    'authRefresh',
    'authUpdateProfile',
    'authDeleteAccount',
    'authLogout',
  ],
  'modules/chat/chat.controller.ts': [
    'chatCreateConversation',
    'chatBranchConversation',
    'chatUpdateConversation',
    'chatDeleteConversation',
    'chatDeleteMessage',
    'chatTruncateConversation',
    'chatSendMessage',
  ],
  'modules/persona/persona.controller.ts': [
    'personaAnalyze',
    'personaUpdateProfile',
    'personaDeleteProfile',
    'personaUpdateInterest',
    'personaDeleteInterest',
    'personaUpdateObservation',
    'personaDeleteObservation',
    'personaUpdateSuggestion',
    'personaDeleteSuggestion',
    'personaReset',
  ],
  'modules/project-spaces/project-spaces.controller.ts': [
    'projectSpaceCreate',
    'projectSpaceUpdate',
    'projectSpaceDelete',
  ],
  'modules/prompt-templates/prompt-templates.controller.ts': [
    'promptTemplateCreate',
    'promptTemplateUpdate',
    'promptTemplateDelete',
  ],
  'modules/agents/agents.controller.ts': [
    'agentCreate',
    'agentUpdate',
    'agentPublish',
    'agentVersionDryRun',
    'agentVersionRollback',
    'agentDuplicate',
    'agentStatus',
    'agentDelete',
  ],
  'modules/agents/agent-tools.controller.ts': [
    'agentToolCreate',
    'agentToolUpdate',
    'agentToolDiagnostic',
    'agentToolOpenApiImport',
    'agentToolRotateSecrets',
    'agentToolDelete',
  ],
  'modules/agents/agent-memories.controller.ts': [
    'agentMemorySupersede',
    'agentMemoryDecision',
    'agentMemoryScopeSetting',
    'agentMemoryDelete',
  ],
  'modules/agents/agent-runs.controller.ts': [
    'agentRunCancel',
    'agentRunConversationCancel',
    'agentRunApprovalDecision',
    'agentRunApprovalBatchDecision',
  ],
  'modules/agent-eval/agent-eval.controller.ts': [
    'agentEvalDatasetCreate',
    'agentEvalDatasetDelete',
    'agentEvalCaseCreate',
    'agentEvalCaseDelete',
    'agentEvalRunCreate',
    'agentEvalRunCancel',
  ],
  'modules/rag-eval/rag-eval.controller.ts': [
    'ragEvalDatasetCreate',
    'ragEvalDatasetUpdate',
    'ragEvalDatasetDelete',
    'ragEvalCaseCreate',
    'ragEvalDatasetRun',
    'ragEvalRunCancel',
    'ragEvalCaseDelete',
  ],
  'modules/rag-workbench/rag-workbench.controller.ts': [
    'ragWorkbenchInspect',
    'ragWorkbenchGraphList',
    'ragWorkbenchGraphSearch',
  ],
  'modules/upload/upload.controller.ts': [
    'uploadCheck',
    'uploadInit',
    'uploadMultipartInit',
    'uploadMultipartParts',
    'uploadMultipartComplete',
    'uploadMultipartAbort',
    'uploadChunk',
    'uploadMerge',
    'uploadAvatar',
    'uploadRetryFile',
    'uploadDeleteFile',
  ],
};

const validBodies = {
  authRegister: {
    email: 'ada@example.com',
    password: 'correct horse battery staple',
    displayName: 'Ada',
    rememberMe: true,
  },
  authLogin: {
    email: 'ada@example.com',
    password: 'correct horse battery staple',
    rememberMe: false,
  },
  authRefresh: {},
  authUpdateProfile: { display_name: 'Ada' },
  authDeleteAccount: {},
  authLogout: {},
  chatCreateConversation: {},
  chatBranchConversation: {},
  chatUpdateConversation: { is_pinned: false },
  chatDeleteConversation: {},
  chatDeleteMessage: {},
  chatTruncateConversation: {},
  chatSendMessage: { content: 'hello' },
  personaAnalyze: {},
  personaUpdateProfile: { summary: 'Backend engineer' },
  personaDeleteProfile: {},
  personaUpdateInterest: { status: 'active' },
  personaDeleteInterest: {},
  personaUpdateObservation: { status: 'hidden' },
  personaDeleteObservation: {},
  personaUpdateSuggestion: { status: 'used' },
  personaDeleteSuggestion: {},
  personaReset: {},
  projectSpaceCreate: { name: 'Project' },
  projectSpaceUpdate: { description: 'Description' },
  projectSpaceDelete: {},
  promptTemplateCreate: { name: 'Template', content: 'Prompt' },
  promptTemplateUpdate: { description: 'Description' },
  promptTemplateDelete: {},
  agentCreate: { name: 'Research Agent', instructions: 'Research carefully.' },
  agentUpdate: { description: 'Updated Agent' },
  agentPublish: {},
  agentVersionDryRun: { input: 'Summarize the architecture without changing anything.' },
  agentVersionRollback: {},
  agentDuplicate: {},
  agentStatus: { disabled: false },
  agentDelete: {},
  agentToolCreate: {
    name: 'Weather API',
    kind: 'http',
    configuration: { endpoint: 'https://api.example.com/weather' },
  },
  agentToolUpdate: { enabled: false },
  agentToolDiagnostic: { operation: 'preflight' },
  agentToolOpenApiImport: {
    document: { openapi: '3.1.0', info: { title: 'Fixture', version: '1' }, paths: {} },
  },
  agentToolRotateSecrets: {},
  agentToolDelete: {},
  agentRunCancel: {},
  agentRunConversationCancel: {},
  agentRunApprovalDecision: { decision: 'approved', reason: 'User confirmed the operation' },
  agentMemorySupersede: { superseded_by: UUID },
  agentMemoryDecision: { decision: 'confirmed' },
  agentMemoryScopeSetting: { scope: 'project', enabled: false },
  agentMemoryDelete: {},
  agentRunApprovalBatchDecision: {
    decisions: [{
      approval_id: UUID,
      decision: 'approved',
      reason: 'User confirmed both operations',
    }],
  },
  agentEvalDatasetCreate: { name: 'Agent regression suite' },
  agentEvalDatasetDelete: {},
  agentEvalCaseCreate: {
    input: 'Summarize the release risk.',
    evaluation_spec: { expected_output_contains: ['risk'] },
  },
  agentEvalCaseDelete: {},
  agentEvalRunCreate: {
    agent_id: UUID,
    candidate_version_id: '22222222-2222-4222-8222-222222222222',
  },
  agentEvalRunCancel: {},
  ragEvalDatasetCreate: { name: 'Dataset' },
  ragEvalDatasetUpdate: { name: 'Dataset' },
  ragEvalDatasetDelete: {},
  ragEvalCaseCreate: { question: 'What is retrieval?' },
  ragEvalDatasetRun: {},
  ragEvalRunCancel: {},
  ragEvalCaseDelete: {},
  ragWorkbenchInspect: { query: 'hybrid retrieval' },
  ragWorkbenchGraphList: {},
  ragWorkbenchGraphSearch: { query: 'knowledge graph' },
  uploadCheck: { hash: SHA256, filename: 'notes.md' },
  uploadInit: { filename: 'notes.md', hash: SHA256, size: 1024 },
  uploadMultipartInit: { filename: 'notes.md', hash: SHA256, size: 1024 },
  uploadMultipartParts: { uploadId: UUID, partNumbers: [1] },
  uploadMultipartComplete: { uploadId: UUID },
  uploadMultipartAbort: { uploadId: UUID },
  uploadChunk: { uploadId: UUID, chunkIndex: '0', hash: SHA256 },
  uploadMerge: { uploadId: UUID, filename: 'notes.md', totalChunks: 1, hash: SHA256 },
  uploadAvatar: {},
  uploadRetryFile: {},
  uploadDeleteFile: {},
};

const validParams = {
  chatBranchConversation: { conversationId: UUID },
  chatUpdateConversation: { conversationId: UUID },
  chatDeleteConversation: { conversationId: UUID },
  chatDeleteMessage: { messageId: UUID },
  chatTruncateConversation: { conversationId: UUID, messageId: UUID },
  chatSendMessage: { conversationId: UUID },
  personaUpdateInterest: { interestId: UUID },
  personaDeleteInterest: { interestId: UUID },
  personaUpdateObservation: { observationId: UUID },
  personaDeleteObservation: { observationId: UUID },
  personaUpdateSuggestion: { suggestionId: UUID },
  personaDeleteSuggestion: { suggestionId: UUID },
  projectSpaceUpdate: { projectSpaceId: UUID },
  projectSpaceDelete: { projectSpaceId: UUID },
  promptTemplateUpdate: { templateId: UUID },
  promptTemplateDelete: { templateId: UUID },
  agentUpdate: { agentId: UUID },
  agentPublish: { agentId: UUID },
  agentVersionDryRun: { agentId: UUID, versionId: UUID },
  agentVersionRollback: { agentId: UUID, versionId: UUID },
  agentDuplicate: { agentId: UUID },
  agentStatus: { agentId: UUID },
  agentDelete: { agentId: UUID },
  agentToolUpdate: { toolId: UUID },
  agentToolDiagnostic: { toolId: UUID },
  agentToolRotateSecrets: { toolId: UUID },
  agentToolDelete: { toolId: UUID },
  agentRunCancel: { runId: UUID },
  agentRunConversationCancel: { conversationId: UUID },
  agentRunApprovalDecision: { runId: UUID, approvalId: UUID },
  agentRunApprovalBatchDecision: { runId: UUID },
  agentMemorySupersede: { memoryId: UUID },
  agentMemoryDecision: { memoryId: UUID },
  agentMemoryDelete: { memoryId: UUID },
  agentEvalCaseCreate: { datasetId: UUID },
  agentEvalDatasetDelete: { datasetId: UUID },
  agentEvalCaseDelete: { caseId: UUID },
  agentEvalRunCreate: { datasetId: UUID },
  agentEvalRunCancel: { runId: UUID },
  ragEvalDatasetUpdate: { datasetId: UUID },
  ragEvalDatasetDelete: { datasetId: UUID },
  ragEvalCaseCreate: { datasetId: UUID },
  ragEvalDatasetRun: { datasetId: UUID },
  ragEvalRunCancel: { runId: UUID },
  ragEvalCaseDelete: { caseId: UUID },
  uploadRetryFile: { id: UUID },
  uploadDeleteFile: { id: UUID },
};

const emptyBodySchemas = [
  'authRefresh',
  'authDeleteAccount',
  'authLogout',
  'chatDeleteConversation',
  'chatDeleteMessage',
  'chatTruncateConversation',
  'personaAnalyze',
  'personaDeleteProfile',
  'personaDeleteInterest',
  'personaDeleteObservation',
  'personaDeleteSuggestion',
  'personaReset',
  'projectSpaceDelete',
  'promptTemplateDelete',
  'agentVersionRollback',
  'agentDelete',
  'agentToolDelete',
  'agentRunCancel',
  'agentRunConversationCancel',
  'agentEvalCaseDelete',
  'agentEvalDatasetDelete',
  'agentEvalRunCancel',
  'ragEvalDatasetDelete',
  'ragEvalDatasetRun',
  'ragEvalRunCancel',
  'ragEvalCaseDelete',
  'uploadAvatar',
  'uploadRetryFile',
  'uploadDeleteFile',
];

const loadValidation = () => require(path.join(serverRoot, 'dist', 'lib', 'validation.js'));
const loadSchemas = () => require(path.join(serverRoot, 'dist', 'lib', 'mutationSchemas.js'));
const loadValidationInterceptor = () => require(path.join(
  serverRoot,
  'dist',
  'common',
  'interceptors',
  'mutation-validation.interceptor.js',
));
const loadHttpExceptionFilter = () => require(path.join(
  serverRoot,
  'dist',
  'common',
  'filters',
  'http-exception.filter.js',
));

test('every Nest mutation controller method declares the shared validation boundary', () => {
  for (const [filename, schemaNames] of Object.entries(expectedRouteSchemas)) {
    const source = readFileSync(path.join(serverRoot, 'src', filename), 'utf8');
    const mutationLines = source.match(/@(Post|Put|Patch|Delete)\(/g) || [];

    assert.equal(mutationLines.length, schemaNames.length, `${filename} mutation count changed`);
    for (const schemaName of schemaNames) {
      assert.match(source, new RegExp(`@ValidateMutation\\(mutationSchemas\\.${schemaName}\\)`));
    }
    assert.equal(
      (source.match(/@ValidateMutation\(mutationSchemas\.[A-Za-z]+\)/g) || []).length,
      mutationLines.length,
      `${filename} has a mutation without validation metadata`,
    );
  }
});

test('the schema registry has one executable strict contract per mutation route', () => {
  const { parseBody, parseParams } = loadValidation();
  const { mutationSchemas } = loadSchemas();
  const expectedNames = Object.values(expectedRouteSchemas).flat().sort();

  assert.deepEqual(Object.keys(mutationSchemas).sort(), expectedNames);
  assert.deepEqual(Object.keys(validBodies).sort(), expectedNames);

  for (const name of expectedNames) {
    const boundary = mutationSchemas[name];
    assert.ok(boundary?.body, `${name} has no body schema`);
    assert.doesNotThrow(() => parseBody(boundary.body, validBodies[name]), `${name} valid body`);
    assert.throws(
      () => parseBody(boundary.body, { ...validBodies[name], audit_probe: 'must be rejected' }),
      `${name} accepted an unknown body field`,
    );

    if (validParams[name]) {
      assert.ok(boundary.params, `${name} has no params schema`);
      assert.doesNotThrow(() => parseParams(boundary.params, validParams[name]), `${name} valid params`);
    } else {
      assert.equal(boundary.params, undefined, `${name} unexpectedly declares params`);
    }
  }
});

test('wrong scalar and collection types are rejected instead of coerced or filtered', () => {
  const { parseBody } = loadValidation();
  const { mutationSchemas } = loadSchemas();
  const rejected = [
    ['authLogin', { email: 'ada@example.com', password: 'password123', rememberMe: 'true' }],
    ['authRegister', {
      email: 'ada@example.com',
      password: 'password123',
      displayName: 42,
      rememberMe: false,
    }],
    ['authUpdateProfile', { display_name: 42 }],
    ['chatSendMessage', { content: ['hello'] }],
    ['chatUpdateConversation', { tags: ['valid', 42] }],
    ['personaUpdateInterest', { status: true }],
    ['projectSpaceCreate', { name: { value: 'Project' } }],
    ['ragEvalCaseCreate', { question: 'Q', expected_keywords: ['valid', 42] }],
    ['ragWorkbenchInspect', { query: 'Q', limit: '10' }],
    ['uploadInit', { filename: 'notes.md', hash: SHA256, size: '1024' }],
    ['uploadMultipartParts', { uploadId: UUID, partNumbers: ['1'] }],
    ['uploadMerge', { uploadId: UUID, filename: 'notes.md', totalChunks: '1' }],
  ];

  for (const [name, body] of rejected) {
    assert.throws(() => parseBody(mutationSchemas[name].body, body), `${name} coerced a wrong type`);
  }
});

test('local auth schemas normalize email and enforce credential boundaries', () => {
  const { parseBody } = loadValidation();
  const { mutationSchemas } = loadSchemas();

  assert.deepEqual(
    parseBody(mutationSchemas.authLogin.body, {
      email: '  ADA@Example.COM  ',
      password: 'password123',
    }),
    {
      email: 'ada@example.com',
      password: 'password123',
      rememberMe: false,
    },
  );

  for (const body of [
    { email: 'not-an-email', password: 'password123' },
    { email: 'ada@example.com', password: 'short' },
    { email: 'ada@example.com', password: 'x'.repeat(129) },
  ]) {
    assert.throws(() => parseBody(mutationSchemas.authLogin.body, body));
  }

  assert.throws(() => parseBody(mutationSchemas.authRegister.body, {
    email: 'ada@example.com',
    password: 'password123',
    displayName: 'Ada',
    rememberMe: false,
    role: 'admin',
  }));
});

test('string booleans are rejected and literal false is preserved', () => {
  const { parseBody } = loadValidation();
  const { mutationSchemas } = loadSchemas();

  for (const [name, body] of [
    ['chatUpdateConversation', { is_pinned: 'false' }],
    ['promptTemplateCreate', { name: 'T', content: 'C', is_default: 'false' }],
    ['personaUpdateProfile', { memory_enabled: 'false' }],
  ]) {
    assert.throws(() => parseBody(mutationSchemas[name].body, body), `${name} accepted a string boolean`);
  }

  assert.equal(
    parseBody(mutationSchemas.chatUpdateConversation.body, { is_pinned: false }).is_pinned,
    false,
  );
});

test('oversized strings and arrays fail rather than being silently truncated', () => {
  const { parseBody } = loadValidation();
  const { mutationSchemas } = loadSchemas();
  const rejected = [
    ['authUpdateProfile', { display_name: 'x'.repeat(121) }],
    ['chatCreateConversation', { title: 'x'.repeat(201) }],
    ['chatUpdateConversation', { note: 'x'.repeat(2001) }],
    ['chatUpdateConversation', { tags: Array.from({ length: 13 }, (_, index) => `tag-${index}`) }],
    ['personaUpdateProfile', { summary: 'x'.repeat(1201) }],
    ['personaUpdateProfile', { goals: Array.from({ length: 13 }, (_, index) => `goal-${index}`) }],
    ['projectSpaceCreate', { name: 'x'.repeat(81) }],
    ['promptTemplateCreate', { name: 'T', content: 'x'.repeat(8001) }],
    ['ragEvalCaseCreate', { question: 'x'.repeat(4097) }],
    ['ragEvalCaseCreate', { question: 'Q', expected_keywords: Array(21).fill('keyword') }],
    ['uploadInit', { filename: `${'x'.repeat(253)}.md`, hash: SHA256, size: 1 }],
  ];

  for (const [name, body] of rejected) {
    assert.throws(() => parseBody(mutationSchemas[name].body, body), `${name} truncated an over-limit value`);
  }
});

test('malformed UUIDs are rejected in every mutation path and UUID body field', () => {
  const { parseBody, parseParams } = loadValidation();
  const { mutationSchemas } = loadSchemas();

  for (const [name, params] of Object.entries(validParams)) {
    const invalidParams = Object.fromEntries(Object.keys(params).map((key) => [key, 'not-a-uuid']));
    assert.throws(
      () => parseParams(mutationSchemas[name].params, invalidParams),
      `${name} accepted malformed path params`,
    );
  }

  for (const [name, body] of [
    ['chatCreateConversation', { project_space_id: 'not-a-uuid' }],
    ['chatBranchConversation', { messageId: 'not-a-uuid' }],
    ['ragWorkbenchGraphList', { project_space_id: 'not-a-uuid' }],
    ['uploadMultipartComplete', { uploadId: 'not-a-uuid' }],
  ]) {
    assert.throws(() => parseBody(mutationSchemas[name].body, body), `${name} accepted a malformed UUID`);
  }
});

test('empty-body mutations accept an omitted body but reject supplied fields', () => {
  const { parseBody } = loadValidation();
  const { mutationSchemas } = loadSchemas();

  for (const name of emptyBodySchemas) {
    assert.deepEqual(parseBody(mutationSchemas[name].body, undefined), {}, `${name} rejected no body`);
    assert.throws(
      () => parseBody(mutationSchemas[name].body, { force: true }),
      `${name} accepted an undeclared body`,
    );
  }
});

test('legacy aliases remain explicit but ambiguous duplicate aliases are rejected', () => {
  const { parseBody } = loadValidation();
  const { mutationSchemas } = loadSchemas();

  assert.doesNotThrow(() => parseBody(mutationSchemas.chatCreateConversation.body, { projectSpaceId: UUID }));
  assert.doesNotThrow(() => parseBody(mutationSchemas.promptTemplateCreate.body, {
    name: 'T',
    content: 'C',
    isDefault: false,
  }));
  assert.doesNotThrow(() => parseBody(mutationSchemas.ragEvalCaseCreate.body, {
    question: 'Q',
    expectedKeywords: ['retrieval'],
  }));
  assert.doesNotThrow(() => parseBody(mutationSchemas.uploadMultipartParts.body, {
    uploadId: UUID,
    part_numbers: [1],
  }));

  assert.throws(() => parseBody(mutationSchemas.chatCreateConversation.body, {
    project_space_id: UUID,
    projectSpaceId: UUID,
  }));
  assert.throws(() => parseBody(mutationSchemas.promptTemplateCreate.body, {
    name: 'T',
    content: 'C',
    is_default: false,
    isDefault: false,
  }));
});

test('Agent mutation schemas accept only internally consistent structured Memory Policy', () => {
  const { parseBody } = loadValidation();
  const { mutationSchemas } = loadSchemas();
  const policy = {
    format_version: 1,
    conversation: {
      enabled: true,
      message_limit: 20,
      rolling_summary: { enabled: false, max_tokens: 0 },
    },
    persona: { enabled: false },
    project_context: { enabled: false },
    read: {
      allowed_scopes: ['user', 'project', 'agent'],
      auto_recall: true,
      auto_scopes: ['user', 'agent'],
      top_k: 10,
      token_budget: 512,
      min_trust: 'agent_inferred',
    },
    write: {
      enabled: true,
      allowed_scopes: ['user', 'agent'],
      default_ttl_days: 30,
      require_confirmation: true,
    },
    subagent: {
      share_recalled_memory: true,
      max_items: 5,
      token_budget: 128,
    },
  };
  assert.doesNotThrow(() => parseBody(mutationSchemas.agentUpdate.body, {
    memory_mode: 'custom',
    memory_policy: policy,
  }));
  assert.throws(() => parseBody(mutationSchemas.agentUpdate.body, {
    memory_policy: {
      ...policy,
      read: { ...policy.read, allowed_scopes: ['user'], auto_scopes: ['agent'] },
    },
  }));
  assert.throws(() => parseBody(mutationSchemas.agentUpdate.body, {
    memory_policy: {
      ...policy,
      subagent: { share_recalled_memory: true, max_items: 0, token_budget: 0 },
    },
  }));
  assert.throws(() => parseBody(mutationSchemas.agentUpdate.body, {
    memory_policy: { ...policy, unexpected: true },
  }));
});

test('Agent mutation schemas bound explicit collaborator aliases and context allowlists', () => {
  const { parseBody } = loadValidation();
  const { mutationSchemas } = loadSchemas();
  const binding = {
    alias: 'technical_reviewer',
    agent_id: UUID,
    version_policy: 'pinned',
    agent_version_id: '22222222-2222-4222-8222-222222222222',
    role: 'Review technical risks',
    max_parallelism: 2,
    allowed_context_keys: ['requirements', 'constraints'],
  };

  assert.deepEqual(parseBody(mutationSchemas.agentUpdate.body, {
    delegation_bindings: [binding],
  }).delegation_bindings, [binding]);
  assert.throws(() => parseBody(mutationSchemas.agentUpdate.body, {
    delegation_bindings: [binding, { ...binding }],
  }));
  assert.throws(() => parseBody(mutationSchemas.agentUpdate.body, {
    delegation_bindings: [{
      ...binding,
      allowed_context_keys: ['requirements', 'requirements'],
    }],
  }));
  assert.throws(() => parseBody(mutationSchemas.agentUpdate.body, {
    delegation_bindings: [{ ...binding, alias: 'Raw Agent UUID' }],
  }));
  assert.throws(() => parseBody(mutationSchemas.agentUpdate.body, {
    delegation_bindings: [{ ...binding, version_policy: 'latest' }],
  }));
  assert.throws(() => parseBody(mutationSchemas.agentUpdate.body, {
    delegation_bindings: [{ ...binding, max_parallelism: 17 }],
  }));
});

test('Agent tool diagnostics accept input only for an explicit safe test operation', () => {
  const { parseBody } = loadValidation();
  const { mutationSchemas } = loadSchemas();
  assert.deepEqual(parseBody(mutationSchemas.agentToolDiagnostic.body, {
    operation: 'safe_test',
    input: { city: 'Shanghai' },
  }), {
    operation: 'safe_test',
    input: { city: 'Shanghai' },
  });
  assert.throws(() => parseBody(mutationSchemas.agentToolDiagnostic.body, {
    operation: 'preflight',
    input: {},
  }));
  assert.throws(() => parseBody(mutationSchemas.agentToolDiagnostic.body, {
    operation: 'call',
  }));
});

test('RAG eval case schema accepts bounded advanced Gold labels and rejects invalid calibration data', () => {
  const { parseBody } = loadValidation();
  const { mutationSchemas } = loadSchemas();

  assert.doesNotThrow(() => parseBody(mutationSchemas.ragEvalCaseCreate.body, {
    question: 'What happens when the worker fails?',
    evaluation_spec: {
      tags: ['queue', 'reliability'],
      category: 'operations',
      difficulty: 'medium',
      expected_chunk_ids: ['chunk-1'],
      expected_evidence: ['The worker retries the job.'],
      expected_answerable: true,
      expected_graph_relations: [{
        source: 'Worker',
        relation: 'USES',
        target: 'Queue',
        polarity: 'negative',
        modality: 'planned_or_obligatory',
      }],
      human_scores: { correctness: 0.9, completeness: 0.8, faithfulness: 1 },
    },
  }));

  assert.throws(() => parseBody(mutationSchemas.ragEvalCaseCreate.body, {
    question: 'Q',
    evaluation_spec: { human_scores: { correctness: 1.1 } },
  }));
  assert.throws(() => parseBody(mutationSchemas.ragEvalCaseCreate.body, {
    question: 'Q',
    evaluation_spec: { expected_graph_relations: [{ source: 'Worker', relation: 'USES' }] },
  }));
  assert.throws(() => parseBody(mutationSchemas.ragEvalCaseCreate.body, {
    question: 'Q',
    evaluation_spec: {
      expected_graph_relations: [{
        source: 'Worker', relation: 'USES', target: 'Queue', polarity: 'unknown',
      }],
    },
  }));
  assert.throws(() => parseBody(mutationSchemas.ragEvalCaseCreate.body, {
    question: 'Q',
    evaluation_spec: { difficulty: 'expert' },
  }));
  assert.throws(() => parseBody(mutationSchemas.ragEvalCaseCreate.body, {
    question: 'Q',
    evaluation_spec: { tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) },
  }));
  assert.throws(() => parseBody(mutationSchemas.ragEvalCaseCreate.body, {
    question: 'Q',
    evaluation_spec: { category: 'x'.repeat(81) },
  }));
});

test('MutationValidationInterceptor throws a non-reflective validation error and forwards parsed values', () => {
  const { HttpValidationError } = loadValidation();
  const { MutationValidationInterceptor } = loadValidationInterceptor();
  const { mutationSchemas } = loadSchemas();
  const secretProbe = 'query-token-that-must-not-be-reflected';
  const invalidRequest = {
    body: { is_pinned: 'false', secret: secretProbe },
    params: { conversationId: UUID },
  };
  const reflector = {
    getAllAndOverride() {
      return mutationSchemas.chatUpdateConversation;
    },
  };
  const interceptor = new MutationValidationInterceptor(reflector);
  const createExecutionContext = (request) => ({
    getHandler: () => function updateConversation() {},
    getClass: () => class ChatController {},
    switchToHttp: () => ({ getRequest: () => request }),
  });
  const nextResult = { subscribe() {} };
  let nextCalls = 0;
  const next = {
    handle() {
      nextCalls += 1;
      return nextResult;
    },
  };

  let validationError;
  try {
    interceptor.intercept(createExecutionContext(invalidRequest), next);
  } catch (error) {
    validationError = error;
  }

  assert.ok(validationError instanceof HttpValidationError);
  assert.doesNotMatch(validationError.message, new RegExp(secretProbe));
  assert.equal(nextCalls, 0);

  const reply = {
    sent: false,
    raw: { headersSent: false },
    statusCode: undefined,
    body: undefined,
    code(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    send(body) {
      this.body = body;
      this.sent = true;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => invalidRequest,
      getResponse: () => reply,
    }),
  };
  const { HttpExceptionFilter } = loadHttpExceptionFilter();
  new HttpExceptionFilter().catch(validationError, host);

  assert.equal(reply.statusCode, 400);
  assert.deepEqual(reply.body, { error: 'Invalid request', code: 'validation_error' });
  assert.doesNotMatch(JSON.stringify(reply.body), new RegExp(secretProbe));

  const validRequest = {
    body: { title: '  Renamed  ', is_pinned: false },
    params: { conversationId: UUID },
  };
  const result = interceptor.intercept(createExecutionContext(validRequest), next);

  assert.equal(result, nextResult);
  assert.equal(nextCalls, 1);
  assert.deepEqual(validRequest.body, { title: 'Renamed', is_pinned: false });
  assert.deepEqual(validRequest.params, { conversationId: UUID });
});

test('controllers consume validated values without secondary coercion or truncation', () => {
  const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');
  const chatSource = readSource('src/modules/chat/chat.service.ts');
  const projectSpaceSource = readSource('src/modules/project-spaces/project-spaces.service.ts');
  const promptTemplateSource = readSource('src/modules/prompt-templates/prompt-templates.service.ts');
  const ragEvalSource = readSource('src/modules/rag-eval/rag-eval.service.ts');
  const ragWorkbenchSource = readSource('src/modules/rag-workbench/rag-workbench.service.ts');
  const personaRepositorySource = readSource('src/repositories/persona.ts');

  assert.doesNotMatch(chatSource, /Boolean\(is_(?:pinned|favorite)\)/);
  assert.doesNotMatch(chatSource, /\.slice\(0,\s*12\)/);
  assert.doesNotMatch(chatSource, /note\.slice\(0,\s*2000\)/);
  assert.doesNotMatch(projectSpaceSource, /\.slice\(0,\s*(?:80|500)\)/);
  assert.doesNotMatch(promptTemplateSource, /Boolean\(req\.body/);
  assert.doesNotMatch(promptTemplateSource, /\.slice\(0,\s*maxLength\)/);
  assert.doesNotMatch(ragEvalSource, /trim\(\)\.slice\(0,\s*maxLength\)/);
  assert.doesNotMatch(ragEvalSource, /\.slice\(0,\s*maxItems\)/);
  assert.doesNotMatch(ragWorkbenchSource, /Number\.parseInt\(raw/);
  assert.doesNotMatch(personaRepositorySource, /trimText(?:Array)?\(input\./);
});
