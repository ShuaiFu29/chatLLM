import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(currentDir, '..');
const require = createRequire(import.meta.url);

const retrieval = require(path.join(
  serverRoot,
  'dist/modules/agents/runtime/agent-memory-retrieval.js',
));
const memoryTools = require(path.join(
  serverRoot,
  'dist/modules/agents/runtime/memory-tool.js',
));
const memoryRepository = require(path.join(
  serverRoot,
  'dist/repositories/agentMemories.js',
));
const ragClient = require(path.join(serverRoot, 'dist/lib/ragClient.js'));
const memoryPolicy = require(path.join(serverRoot, 'dist/lib/agentMemoryPolicy.js'));

const makeMemory = (id, content, overrides = {}) => ({
  id,
  user_id: '11111111-1111-4111-8111-111111111111',
  scope: 'user',
  scope_ref_id: null,
  kind: 'fact',
  content,
  provenance_run_id: null,
  provenance_step_id: null,
  source_trust: 'agent_inferred',
  status: 'confirmed',
  verification_status: 'policy_confirmed',
  verified_at: '2026-08-01T00:00:00.000Z',
  confidence: 0.6,
  sensitivity: 'personal',
  last_recalled_at: null,
  recall_count: 0,
  superseded_by: null,
  deleted_at: null,
  expires_at: null,
  embedding: null,
  embedding_model: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

test('Chinese lexical recall filters unrelated memories when embeddings are unavailable', () => {
  const relevant = makeMemory(
    '11111111-1111-4111-8111-111111111101',
    '用户偏好使用公制单位和摄氏度。',
  );
  const unrelated = makeMemory(
    '11111111-1111-4111-8111-111111111102',
    '生产环境的数据库备份保留三十天。',
  );
  const result = retrieval.retrieveAgentMemories([unrelated, relevant], {
    query: '用户使用公制单位吗？',
    queryEmbedding: null,
    nowMs: Date.parse('2026-08-29T00:00:00.000Z'),
  });

  assert.equal(result.mode, 'lexical');
  assert.deepEqual(result.memories.map((memory) => memory.id), [relevant.id]);
  assert.deepEqual(result.filteredMemoryIds, [unrelated.id]);
  assert.equal(result.semanticComparableCount, 0);
});

test('hybrid relevance gate excludes orthogonal memories and keeps diverse evidence ahead of duplicates', () => {
  const exact = makeMemory(
    '11111111-1111-4111-8111-111111111201',
    'Database backup schedule is daily.',
    { embedding: [1, 0], embedding_model: 'memory-v1' },
  );
  const duplicate = makeMemory(
    '11111111-1111-4111-8111-111111111202',
    'Database backups run daily.',
    { embedding: [0.8, 0.2], embedding_model: 'memory-v1' },
  );
  const diverse = makeMemory(
    '11111111-1111-4111-8111-111111111203',
    'Backup retention is thirty days.',
    { embedding: [0.98, 0.2], embedding_model: 'memory-v1' },
  );
  const unrelated = makeMemory(
    '11111111-1111-4111-8111-111111111204',
    'The preferred interface language is Chinese.',
    { embedding: [0, 1], embedding_model: 'memory-v1' },
  );
  const result = retrieval.retrieveAgentMemories([exact, duplicate, diverse, unrelated], {
    query: 'What is the database backup schedule and retention?',
    queryEmbedding: { vector: [1, 0], model: 'memory-v1' },
    nowMs: Date.parse('2026-08-29T00:00:00.000Z'),
  });

  assert.equal(result.mode, 'hybrid');
  assert.equal(result.memories[0].id, exact.id);
  assert.ok(
    result.memories.findIndex((memory) => memory.id === diverse.id)
      < result.memories.findIndex((memory) => memory.id === duplicate.id),
    'MMR should prefer complementary retention evidence before a near-duplicate schedule',
  );
  assert.deepEqual(result.filteredMemoryIds, [unrelated.id]);
  assert.equal(result.semanticComparableCount, 4);
});

test('newer contradictory memory is preferred and the older fact is conflict-demoted', () => {
  const oldPositive = makeMemory(
    '11111111-1111-4111-8111-111111111301',
    'Dark mode is enabled.',
    {
      source_trust: 'user_stated',
      verification_status: 'user_confirmed',
      confidence: 1,
      embedding: [1, 0],
      embedding_model: 'memory-v1',
      created_at: '2024-01-01T00:00:00.000Z',
    },
  );
  const newNegative = makeMemory(
    '11111111-1111-4111-8111-111111111302',
    'Dark mode is not enabled.',
    {
      source_trust: 'user_stated',
      verification_status: 'user_confirmed',
      confidence: 1,
      embedding: [1, 0],
      embedding_model: 'memory-v1',
      created_at: '2026-08-28T00:00:00.000Z',
    },
  );
  const result = retrieval.retrieveAgentMemories([oldPositive, newNegative], {
    query: 'Is dark mode enabled?',
    queryEmbedding: { vector: [1, 0], model: 'memory-v1' },
    nowMs: Date.parse('2026-08-29T00:00:00.000Z'),
  });

  assert.equal(result.memories[0].id, newNegative.id);
  assert.equal(result.conflictDemotionCount, 1);
});

test('missing lexical and comparable vector signals fail closed instead of injecting noise', () => {
  const memories = [
    makeMemory('11111111-1111-4111-8111-111111111401', 'Prefers concise answers.'),
    makeMemory('11111111-1111-4111-8111-111111111402', 'Works on billing services.'),
  ];
  const result = retrieval.retrieveAgentMemories(memories, {
    query: 'quantum chromodynamics',
    queryEmbedding: { vector: [1, 0], model: 'new-model' },
  });

  assert.equal(result.mode, 'no_relevant_match');
  assert.deepEqual(result.memories, []);
  assert.deepEqual(result.filteredMemoryIds, memories.map((memory) => memory.id));
});

test('explicit recall accepts query/scopes, records only injected ids, and rejects scope escalation', async () => {
  const originalList = memoryRepository.listRecallableAgentMemories;
  const originalRecord = memoryRepository.recordAgentMemoryRecalls;
  const originalEmbed = ragClient.embedTexts;
  const listInputs = [];
  const recorded = [];
  memoryRepository.listRecallableAgentMemories = async (input) => {
    listInputs.push(input);
    return [
      makeMemory(
        '11111111-1111-4111-8111-111111111501',
        'Billing currency is CNY.',
        { embedding: [1, 0], embedding_model: 'memory-v1' },
      ),
      makeMemory(
        '11111111-1111-4111-8111-111111111502',
        'Preferred editor theme is dark.',
        { embedding: [0, 1], embedding_model: 'memory-v1' },
      ),
    ];
  };
  memoryRepository.recordAgentMemoryRecalls = async (input) => {
    recorded.push(input);
    return [...input.memoryIds];
  };
  ragClient.embedTexts = async () => ({ embeddings: [[1, 0]], model: 'memory-v1' });

  const policy = structuredClone(memoryPolicy.memoryPolicyFromLegacyMode('user'));
  policy.read.allowed_scopes = ['user'];
  policy.read.auto_scopes = ['user'];
  const context = {
    depth: 0,
    memoryPolicy: policy,
    signal: new AbortController().signal,
    userId: '11111111-1111-4111-8111-111111111111',
    projectSpaceId: null,
    agentId: '22222222-2222-4222-8222-222222222222',
    runId: '33333333-3333-4333-8333-333333333333',
  };
  const tool = memoryTools.createRecallRuntimeTool();

  try {
    const result = await tool.execute({
      query: 'What is the billing currency?',
      scopes: ['user'],
      limit: 5,
    }, context);
    assert.equal(result.count, 1);
    assert.equal(result.ranking_mode, 'hybrid');
    assert.equal(result.filtered_irrelevant_count, 1);
    assert.deepEqual(result.memories.map((memory) => memory.content), ['Billing currency is CNY.']);
    assert.deepEqual(listInputs[0].scopes, ['user']);
    assert.equal(listInputs[0].perScopeLimit, 50);
    assert.equal(listInputs[0].limit, 150);
    assert.deepEqual(recorded[0].memoryIds, ['11111111-1111-4111-8111-111111111501']);

    await assert.rejects(
      () => tool.execute({ query: 'project', scopes: ['project'] }, context),
      (error) => error?.code === 'memory_policy_violation',
    );
  } finally {
    memoryRepository.listRecallableAgentMemories = originalList;
    memoryRepository.recordAgentMemoryRecalls = originalRecord;
    ragClient.embedTexts = originalEmbed;
  }
});

test('recall repository uses a bounded candidate quota per scope before the global limit', () => {
  const source = readFileSync(
    path.join(serverRoot, 'src/repositories/agentMemories.ts'),
    'utf8',
  );
  const recall = source.slice(
    source.indexOf('export const listRecallableAgentMemories'),
    source.indexOf('export const listAgentMemoriesForUser'),
  );
  assert.match(recall, /row_number\(\) over \(\s*partition by scope/i);
  assert.match(recall, /where scope_rank <= \$6/i);
  assert.match(recall, /const perScopeLimit = Math\.min\(Math\.max/i);
});
