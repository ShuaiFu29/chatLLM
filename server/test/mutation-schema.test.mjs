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
  'auth.ts': [
    'authRefresh',
    'authUpdateProfile',
    'authDeleteAccount',
    'authLogout',
  ],
  'chat.ts': [
    'chatCreateConversation',
    'chatBranchConversation',
    'chatUpdateConversation',
    'chatDeleteConversation',
    'chatDeleteMessage',
    'chatSendMessage',
  ],
  'persona.ts': [
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
  'projectSpaces.ts': [
    'projectSpaceCreate',
    'projectSpaceUpdate',
    'projectSpaceDelete',
  ],
  'promptTemplates.ts': [
    'promptTemplateCreate',
    'promptTemplateUpdate',
    'promptTemplateDelete',
  ],
  'ragEval.ts': [
    'ragEvalDatasetCreate',
    'ragEvalDatasetUpdate',
    'ragEvalDatasetDelete',
    'ragEvalCaseCreate',
    'ragEvalDatasetRun',
    'ragEvalRunCancel',
    'ragEvalCaseDelete',
  ],
  'ragWorkbench.ts': [
    'ragWorkbenchInspect',
    'ragWorkbenchGraphList',
    'ragWorkbenchGraphSearch',
  ],
  'upload.ts': [
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
  authRefresh: {},
  authUpdateProfile: { display_name: 'Ada' },
  authDeleteAccount: {},
  authLogout: {},
  chatCreateConversation: {},
  chatBranchConversation: {},
  chatUpdateConversation: { is_pinned: false },
  chatDeleteConversation: {},
  chatDeleteMessage: {},
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
  'personaAnalyze',
  'personaDeleteProfile',
  'personaDeleteInterest',
  'personaDeleteObservation',
  'personaDeleteSuggestion',
  'personaReset',
  'projectSpaceDelete',
  'promptTemplateDelete',
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

test('every Express mutation route mounts the shared validation boundary', () => {
  for (const [filename, schemaNames] of Object.entries(expectedRouteSchemas)) {
    const source = readFileSync(path.join(serverRoot, 'src', 'routes', filename), 'utf8');
    const mutationLines = source
      .split(/\r?\n/)
      .filter((line) => /router\.(?:post|put|patch|delete)\(/.test(line));

    assert.equal(mutationLines.length, schemaNames.length, `${filename} mutation count changed`);
    for (const line of mutationLines) {
      assert.match(line, /validateMutation\(mutationSchemas\.[A-Za-z]+\)/, `${filename}: ${line.trim()}`);
    }
    for (const schemaName of schemaNames) {
      assert.match(source, new RegExp(`validateMutation\\(mutationSchemas\\.${schemaName}\\)`));
    }
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

test('validation middleware returns a stable non-reflective 400 and forwards parsed values', () => {
  const { validateMutation } = loadValidation();
  const { mutationSchemas } = loadSchemas();
  const secretProbe = 'query-token-that-must-not-be-reflected';
  const invalidRequest = {
    body: { is_pinned: 'false', secret: secretProbe },
    params: { conversationId: UUID },
  };
  const response = {
    statusCode: undefined,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextCalls = 0;

  validateMutation(mutationSchemas.chatUpdateConversation)(invalidRequest, response, () => {
    nextCalls += 1;
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'Invalid request', code: 'validation_error' });
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(secretProbe));
  assert.equal(nextCalls, 0);

  const validRequest = {
    body: { title: '  Renamed  ', is_pinned: false },
    params: { conversationId: UUID },
  };
  validateMutation(mutationSchemas.chatUpdateConversation)(validRequest, response, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.deepEqual(validRequest.body, { title: 'Renamed', is_pinned: false });
  assert.deepEqual(validRequest.params, { conversationId: UUID });
});

test('controllers consume validated values without secondary coercion or truncation', () => {
  const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');
  const chatSource = readSource('src/controllers/chat.ts');
  const projectSpaceSource = readSource('src/controllers/projectSpaces.ts');
  const promptTemplateSource = readSource('src/controllers/promptTemplates.ts');
  const ragEvalSource = readSource('src/controllers/ragEval.ts');
  const ragWorkbenchSource = readSource('src/controllers/ragWorkbench.ts');
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
