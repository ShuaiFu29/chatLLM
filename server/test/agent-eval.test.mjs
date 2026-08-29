import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const readSource = (relativePath) => readFileSync(path.join(serverRoot, relativePath), 'utf8');
const runtime = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agent-eval',
  'agent-eval-runtime.js',
));
const { executeAgentDryRunModel } = require(path.join(
  serverRoot,
  'dist',
  'modules',
  'agents',
  'runtime',
  'agent-dry-run.js',
));

test('Agent Eval fixture replay returns deterministic data without executing tools', async () => {
  let executions = 0;
  const requests = [];
  const responses = [{
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: 'lookup-1',
          type: 'function',
          function: { name: 'lookup_release', arguments: '{"release":"v2"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }, {
    choices: [{
      message: { content: 'Release v2 is ready [release-note].' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 15, completion_tokens: 6, total_tokens: 21 },
  }];
  const result = await executeAgentDryRunModel({
    model: 'test-model',
    systemPrompt: 'Evaluate safely.',
    question: 'Is v2 ready?',
    temperature: 0,
    maxOutputTokens: 256,
    responseFormat: 'markdown',
    outputSchema: {},
    supportsStructuredOutput: false,
    supportsToolCalling: true,
    approvalPolicy: 'writes',
    runtimeTools: [{
      key: 'lookup_release',
      modelName: 'lookup_release',
      riskLevel: 'read',
      retryMode: 'never',
      definition: {
        type: 'function',
        function: {
          name: 'lookup_release',
          description: 'Look up a release',
          parameters: {
            type: 'object',
            properties: { release: { type: 'string' } },
            required: ['release'],
            additionalProperties: false,
          },
        },
      },
      execute: async () => {
        executions += 1;
        throw new Error('must never execute');
      },
    }],
    signal: new AbortController().signal,
    simulation: {
      mode: 'evaluation',
      resolveToolResult: () => ({
        matched: true,
        result: { ready: true, source: 'release-note' },
      }),
    },
    invoke: async (request) => {
      requests.push(request);
      return responses.shift();
    },
  });

  assert.equal(executions, 0);
  assert.equal(result.planned_tool_calls[0].status, 'simulated');
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /"evaluation_fixture":true/);
  assert.match(toolMessage.content, /"ready":true/);
  assert.equal(requests[1].tools, undefined);
});

test('Agent Eval scores tool selection, arguments, safety and evidence deterministically', () => {
  const metrics = runtime.evaluateAgentSimulation({
    output: 'Release v2 is ready according to [release-note].',
    plannedToolCalls: [{
      tool_call_id: 'call-1',
      tool_key: 'lookup_release',
      model_name: 'lookup_release',
      risk_level: 'read',
      policy_decision: 'execute',
      status: 'simulated',
      arguments: { release: 'v2' },
    }],
    evaluationSpec: {
      expected_output_contains: ['ready'],
      forbidden_output_contains: ['deleted'],
      expected_tool_calls: [{
        tool_key: 'lookup_release',
        arguments: { release: 'v2' },
        fixture: { ready: true },
      }],
      forbidden_tool_keys: ['delete_release'],
      grounding_evidence: ['Release v2 is ready according to the release note.'],
      expected_citations: ['[release-note]'],
    },
  });

  assert.equal(metrics.task_success, 1);
  assert.equal(metrics.tool_selection_score, 1);
  assert.equal(metrics.tool_argument_validity, 1);
  assert.equal(metrics.tool_argument_correctness, 1);
  assert.equal(metrics.safety_score, 1);
  assert.equal(metrics.citation_quality_score, 1);
  assert.equal(metrics.metric_applicability.cost, false);
  assert.equal(metrics.evaluator.cost, 'not_available_without_versioned_provider_pricing');
});

test('Agent Eval paired aggregation preserves candidate-baseline deltas', () => {
  const base = {
    agentId: '11111111-1111-4111-8111-111111111111',
    configurationHash: 'a'.repeat(64),
    status: 'succeeded',
    outputText: 'ok',
    plannedToolCalls: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    latencyMs: 10,
  };
  const aggregate = runtime.aggregateAgentEvalResults({
    caseCount: 1,
    hasBaseline: true,
    results: [{
      ...base,
      caseId: 'case-1',
      variant: 'candidate',
      agentVersionId: '22222222-2222-4222-8222-222222222222',
      metrics: { overall_score: 0.9, task_success: 1 },
    }, {
      ...base,
      caseId: 'case-1',
      variant: 'baseline',
      agentVersionId: '33333333-3333-4333-8333-333333333333',
      metrics: { overall_score: 0.6, task_success: 0 },
    }],
  });

  assert.equal(aggregate.delta.overall_score, 0.3);
  assert.deepEqual(aggregate.paired, { wins: 1, ties: 0, losses: 0 });
  assert.equal(aggregate.isolation.real_tool_execution, false);
});

test('Agent Eval schema and wiring pin immutable versions and exclude production executors', () => {
  const migration = readSource('migrations/0075_agent_version_evaluations.sql');
  const queue = readSource('src/services/agentEvalQueue.ts');
  const runtimeSource = readSource('src/modules/agent-eval/agent-eval-runtime.ts');
  const repository = readSource('src/repositories/agentEval.ts');

  assert.match(migration, /candidate_agent_version_id uuid not null/i);
  assert.match(migration, /candidate_configuration_hash text not null/i);
  assert.match(migration, /dataset_revision bigint not null/i);
  assert.match(migration, /agent_eval_run_cases/i);
  assert.match(migration, /agent_eval_runs_version_guard/i);
  assert.match(repository, /worker_id = \$3[\s\S]*lease_token = \$4/);
  assert.match(queue, /completeAgentEvalRun/);
  assert.match(queue, /renewAgentEvalRunLease/);
  assert.doesNotMatch(runtimeSource, /WithSecrets|encrypted_secrets|decryptAgentToolSecrets/);
  assert.doesNotMatch(queue, /agent_runs|agent_tool_invocations|agent_approvals|messages/);
});

test('Agent Eval reuses the active immutable run before enforcing user quotas', () => {
  const repository = readSource('src/repositories/agentEval.ts');
  const createStart = repository.indexOf('export const createAgentEvalRunForUser');
  const createEnd = repository.indexOf('export const getAgentEvalRunForUser', createStart);
  const createSource = repository.slice(createStart, createEnd);
  const reuseIndex = createSource.indexOf('if (existing[0]) return');
  const quotaIndex = createSource.indexOf("throw new Error('AGENT_EVAL_ACTIVE_RUN_LIMIT')");

  assert.ok(reuseIndex >= 0, 'expected an active-run reuse branch');
  assert.ok(quotaIndex >= 0, 'expected an active-run quota branch');
  assert.ok(reuseIndex < quotaIndex, 'idempotent retries must be reused before quota rejection');
});

test('Agent Eval dataset deletion fences active workers and failed cases do not invent safety credit', () => {
  const repository = readSource('src/repositories/agentEval.ts');
  const service = readSource('src/modules/agent-eval/agent-eval.service.ts');
  const queue = readSource('src/services/agentEvalQueue.ts');

  assert.match(repository, /status in \('queued', 'running'\)[\s\S]*for update/);
  assert.match(repository, /activeRunIds: activeRuns\.map/);
  assert.match(service, /deletion\.activeRunIds[\s\S]*agentEvalQueue\.abortRun/);
  assert.match(queue, /safety_score: null/);
  assert.match(queue, /safety: false/);
});

test('Agent Eval mutation contract requires a bounded scoring oracle', () => {
  const { mutationSchemas } = require(path.join(serverRoot, 'dist', 'lib', 'mutationSchemas.js'));
  const { parseBody } = require(path.join(serverRoot, 'dist', 'lib', 'validation.js'));
  assert.throws(() => parseBody(mutationSchemas.agentEvalCaseCreate.body, {
    input: 'Unscored prompt',
    evaluation_spec: {},
  }));
  assert.doesNotThrow(() => parseBody(mutationSchemas.agentEvalCaseCreate.body, {
    input: 'Check the release',
    evaluation_spec: {
      expected_tool_calls: [{
        tool_key: 'lookup_release',
        arguments: { release: 'v2' },
        fixture: { ready: true },
      }],
    },
  }));
});
