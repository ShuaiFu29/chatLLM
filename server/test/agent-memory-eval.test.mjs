import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { AGENT_MEMORY_ZH_CN_GOLD_V1 } = require(path.join(
  serverRoot,
  'dist/evals/agent-memory-zh-cn-v1.js',
));
const {
  evaluateAgentMemoryDataset,
} = require(path.join(
  serverRoot,
  'dist/modules/agents/runtime/agent-memory-evaluation.js',
));

test('Chinese Agent Memory gold set has exhaustive stable judgements', () => {
  assert.equal(AGENT_MEMORY_ZH_CN_GOLD_V1.formatVersion, 1);
  assert.equal(
    AGENT_MEMORY_ZH_CN_GOLD_V1.annotationPolicy,
    'exhaustive_against_complete_pool',
  );
  assert.ok(AGENT_MEMORY_ZH_CN_GOLD_V1.memories.length >= 30);
  assert.ok(AGENT_MEMORY_ZH_CN_GOLD_V1.cases.length >= 30);
  assert.ok(AGENT_MEMORY_ZH_CN_GOLD_V1.cases.some((item) => item.relevantMemoryIds.length === 0));
  assert.equal(
    new Set(AGENT_MEMORY_ZH_CN_GOLD_V1.memories.map((item) => item.id)).size,
    AGENT_MEMORY_ZH_CN_GOLD_V1.memories.length,
  );
});

test('Memory retrieval meets versioned Chinese quality and latency gates', () => {
  const report = evaluateAgentMemoryDataset(AGENT_MEMORY_ZH_CN_GOLD_V1, {
    latencySamplesPerCase: 5,
  });

  assert.equal(report.candidateJudgementCount, 1_020);
  assert.equal(report.positiveCaseCount, 30);
  assert.equal(report.noRelevantCaseCount, 4);
  assert.equal(report.latencyScope, 'in_process_ranker_only');
  assert.equal(report.passed, true, JSON.stringify({
    failures: report.failures,
    recallAtK: report.recallAtK,
    meanReciprocalRank: report.meanReciprocalRank,
    irrelevantInjectionRate: report.irrelevantInjectionRate,
    noRelevantSafeRate: report.noRelevantSafeRate,
    p95RankLatencyMs: report.p95RankLatencyMs,
    failedCases: report.cases.filter((item) => (
      item.recallAtK === 0 || item.irrelevantRetrievedCount > 0
    )),
  }));
});

test('Memory evaluator rejects duplicate ids and unknown relevance labels', () => {
  const duplicate = structuredClone(AGENT_MEMORY_ZH_CN_GOLD_V1);
  duplicate.memories[1].id = duplicate.memories[0].id;
  assert.throws(() => evaluateAgentMemoryDataset(duplicate), /ids must be unique/);

  const unknown = structuredClone(AGENT_MEMORY_ZH_CN_GOLD_V1);
  unknown.cases[0].relevantMemoryIds = ['missing-memory'];
  assert.throws(() => evaluateAgentMemoryDataset(unknown), /unknown memory/);
});

