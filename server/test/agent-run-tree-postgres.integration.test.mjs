import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquirePostgresIntegrationLock } from './postgres-integration-lock.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const integrationEnabled = process.env.AGENT_TREE_INTEGRATION === '1'
  && Boolean(process.env.TEST_DATABASE_URL);

/**
 * These four properties cannot be established by reading source.
 *
 * The run tree, the budget ledger and the memory store were designed around
 * guarantees the database is supposed to enforce: lineage columns that cannot
 * disagree, an allowance that cannot be overdrawn by concurrent writers, a
 * cancellation that reaches an entire subtree, and a partial unique index over
 * expressions. A unit test can only confirm that the SQL was written; whether
 * PostgreSQL accepts it and actually refuses the bad case is a different question,
 * and it is the one that decides whether a deploy succeeds.
 */
test('PostgreSQL enforces the Agent run tree, budget ledger and memory invariants', {
  skip: integrationEnabled ? false : 'set AGENT_TREE_INTEGRATION=1 and TEST_DATABASE_URL to run',
}, async (t) => {
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  const { randomUUID } = await import('node:crypto');
  const { pool, closeDatabasePool } = require(path.join(serverRoot, 'dist', 'lib', 'db.js'));
  const { runMigrations } = require(path.join(serverRoot, 'dist', 'lib', 'migrations.js'));
  const {
    createAgentRun,
    createSubagentRun,
    completeAgentRunForUser,
    cancelAgentRunForUser,
    createAgentApproval,
    decideAgentApprovalForUser,
    expireAgentApproval,
    findAgentRunForUser,
    markAgentRunWaitingForSubagents,
    resumeAgentRunFromSubagents,
    insertAgentStep,
    listAgentApprovalInboxForUser,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentRuns.js'));
  const {
    createAgentRunBudget,
    debitAgentRunBudget,
    findAgentRunBudget,
    markAgentRunBudgetDegraded,
    reserveAgentModelInvocation,
    settleAgentModelInvocation,
    settleExpiredAgentModelInvocations,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentRunBudgets.js'));
  const {
    claimQueuedSubagentRun,
    claimAbandonedSubagentRun,
    renewSubagentRunLease,
    markClaimedSubagentRunWaitingForSubagents,
    resumeClaimedSubagentRunFromSubagents,
    releaseSubagentRunLease,
    finalizeClaimedSubagentRun,
    failExpiredSubagentRunLeases,
    listSubagentOutcomesForToolCall,
    areSubagentOutcomesTerminal,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentSubagentQueue.js'));
  const {
    upsertAgentMemory,
    decideAgentMemory,
    listRecallableAgentMemories,
    supersedeAgentMemory,
    forgetAgentMemory,
    deleteExpiredAgentMemories,
    listAgentMemoriesForUser,
    listAgentMemoryScopeSettings,
    recordAgentMemoryRecallsWithClient,
    recordAgentMemoryRecalls,
    setAgentMemoryScopeEnabled,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentMemories.js'));
  const {
    claimAgentMemoryEmbeddingJobById,
    completeAgentMemoryEmbeddingJob,
    failAgentMemoryEmbeddingAttempt,
    reconcileInactiveAgentMemoryEmbeddingJobs,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentMemoryEmbeddings.js'));
  const {
    resolveAgentConversationContext,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentConversationSummaries.js'));
  const {
    beginAgentToolInvocation,
    ensureAgentSubagentDispatchInvocation,
    finishAgentToolInvocation,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentToolInvocations.js'));
  const {
    findAgentSubagentDispatch,
    getOrCreateAgentSubagentDispatch,
    materializeAgentSubagentDispatch,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentSubagentDispatches.js'));
  const {
    appendAgentRunEvent,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentRunEvents.js'));
  const {
    createAgentForUser,
    updateAgentForUser,
    publishAgentForUser,
    rollbackAgentVersionForUser,
    listAgentVersionsForUser,
    findExecutableAgentVersionForUser,
    setAgentDisabledForUser,
    deleteAgentForUser,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agents.js'));
  const {
    createAgentToolForUser,
    updateAgentToolForUser,
    deleteAgentToolForUser,
    listAgentToolVersionsForUser,
    findAgentToolVersionsWithSecretsForUserByIds,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentTools.js'));
  const {
    createAgentVersionDryRun,
    completeAgentVersionDryRun,
    findAgentVersionDryRunForUser,
    listAgentVersionDryRunsForUser,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentDryRuns.js'));
  const {
    createAgentEvalDatasetForUser,
    createAgentEvalCaseForUser,
    createAgentEvalRunForUser,
    claimAgentEvalRunJobById,
    completeAgentEvalRun,
    getAgentEvalRunForUser,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentEval.js'));
  const {
    restoreAgentRuntimeToolsForRecovery,
  } = require(path.join(
    serverRoot,
    'dist',
    'modules',
    'agents',
    'runtime',
    'agent-tool-recovery.js',
  ));
  const { memoryPolicyFromLegacyMode } = require(path.join(
    serverRoot,
    'dist',
    'lib',
    'agentMemoryPolicy.js',
  ));
  const {
    createAgentRuntimeCheckpoint,
  } = require(path.join(
    serverRoot,
    'dist',
    'modules',
    'agents',
    'runtime',
    'agent-checkpoint.js',
  ));
  const { createAgentApprovalIntent } = require(path.join(
    serverRoot,
    'dist',
    'modules',
    'agents',
    'runtime',
    'agent-approval-intent.js',
  ));
  const {
    findAgentRunCheckpointForUser,
    saveAgentRunCheckpoint,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentRunCheckpoints.js'));
  const {
    claimAgentWorkItemForRun,
    claimQueuedAgentWorkItemForRecovery,
    listQueuedAgentWorkItemIds,
    markClaimedAgentRunWaitingForSubagents,
    parkAgentWorkItem,
    renewAgentWorkItemClaim,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentWorkItems.js'));
  const { Queue } = require('bullmq');
  const {
    BULLMQ_PREFIX,
    getBullMqConnectionOptions,
  } = require(path.join(serverRoot, 'dist', 'lib', 'redis.js'));
  const {
    AGENT_RECOVERY_QUEUE_NAME,
    buildAgentRecoveryQueueJob,
    dispatchRecoverableAgentWorkItems,
  } = require(path.join(serverRoot, 'dist', 'services', 'agentRecoveryQueue.js'));

  const otherUserId = randomUUID();
  const projectSpaceId = randomUUID();
  const createdUserIds = [otherUserId];
  let githubId = BigInt(Date.now()) * 1000n;
  let releaseIntegrationLock = async () => undefined;

  const approvalIntentFor = ({
    toolKey = 'custom:writer',
    args = {},
    riskLevel = 'write',
    policyChain = ['writes'],
  } = {}) => createAgentApprovalIntent({
    tool: {
      key: toolKey,
      modelName: toolKey.replace(/[^a-z0-9_]/gi, '_'),
      riskLevel,
      retryMode: 'never',
      definition: {
        type: 'function',
        function: { name: toolKey, description: toolKey, parameters: { type: 'object' } },
      },
      execute: async () => ({}),
    },
    args,
    policyChain,
  });

  const insertUser = async (id, username) => {
    githubId += 1n;
    await pool.query(
      `insert into users (id, github_id, username, avatar_url, display_name)
       values ($1, $2, $3, '', $3)`,
      [id, githubId.toString(), username],
    );
  };

  // Configuration lives on agent_versions; agents only carries metadata.
  const insertAgent = async (id, name, ownerId) => {
    await pool.query(
      'insert into agents (id, user_id, name) values ($1, $2, $3)',
      [id, ownerId, name],
    );
  };

  /**
   * Each subtest gets its own user. Root runs stay active for the length of the
   * test, so sharing a user would let earlier subtests exhaust the active-run
   * quota and turn every later failure into a misleading AGENT_ACTIVE_RUN_LIMIT.
   */
  let scenarioSeq = 0;
  const defaultRunBudget = () => ({
    deadlineAt: new Date(Date.now() + 60_000),
    tokenTotal: 1_000_000,
    iterationTotal: 1_000,
    toolCallTotal: 1_000,
    subagentDispatchTotal: 1_000,
    finalAnswerReserveTokens: 1_000,
  });
  const createScenario = async (agentCount = 4) => {
    scenarioSeq += 1;
    const scenarioUserId = randomUUID();
    await insertUser(scenarioUserId, `agent-tree-${Date.now()}-${scenarioSeq}`);
    createdUserIds.push(scenarioUserId);
    const scenarioConversationId = randomUUID();
    await pool.query(
      'insert into conversations (id, user_id, title) values ($1, $2, $3)',
      [scenarioConversationId, scenarioUserId, `run tree ${scenarioSeq}`],
    );
    const agentIds = [];
    for (let index = 0; index < agentCount; index += 1) {
      const agentId = randomUUID();
      await insertAgent(agentId, `agent ${scenarioSeq}-${index}`, scenarioUserId);
      agentIds.push(agentId);
    }
    const startRun = (agentId = agentIds[0], budget = defaultRunBudget()) => createAgentRun({
      userId: scenarioUserId,
      agentId,
      agentVersionId: null,
      conversationId: scenarioConversationId,
      userMessageId: null,
      agentVersionSnapshot: {},
      budget,
    });
    return {
      userId: scenarioUserId,
      conversationId: scenarioConversationId,
      agentIds,
      startRun,
    };
  };

  const expectRejected = async (promise, constraintFragment) => {
    let raised;
    try {
      await promise;
    } catch (error) {
      raised = error;
    }
    assert.ok(raised, `expected a rejection mentioning ${constraintFragment}`);
    assert.match(String(raised.message), new RegExp(constraintFragment, 'i'));
  };

  try {
    releaseIntegrationLock = await acquirePostgresIntegrationLock(pool);
    await runMigrations();
    await insertUser(otherUserId, `agent-tree-other-${Date.now()}`);

    await t.test('a root run references itself with an empty ancestor chain', async () => {
      const scenario = await createScenario();
      const run = await scenario.startRun();
      assert.equal(run.root_run_id, run.id, 'a root run is its own tree root');
      assert.equal(run.parent_run_id, null);
      assert.equal(run.depth, 0);
      assert.deepEqual(run.ancestor_agent_ids, []);
    });

    await t.test('the lineage columns cannot contradict each other', async () => {
      const scenario = await createScenario();
      const orphan = randomUUID();
      // depth without a parent: the row claims to be both a root and a descendant.
      await expectRejected(
        pool.query(
          `insert into agent_runs (
             id, root_run_id, depth, ancestor_agent_ids, user_id, conversation_id, status
           ) values ($1, $1, 1, $2::uuid[], $3, $4, 'running')`,
          [orphan, [scenario.agentIds[0]], scenario.userId, scenario.conversationId],
        ),
        'agent_runs_lineage_check',
      );

      // An ancestor chain that does not match the depth would make cycle detection
      // read from the wrong set.
      const parent = await scenario.startRun();
      await expectRejected(
        pool.query(
          `insert into agent_runs (
             id, root_run_id, parent_run_id, depth, ancestor_agent_ids,
             user_id, conversation_id, status
           ) values ($1, $2, $2, 1, '{}'::uuid[], $3, $4, 'running')`,
          [randomUUID(), parent.id, scenario.userId, scenario.conversationId],
        ),
        'agent_runs_ancestor_cardinality_check',
      );

      // Nesting is bounded in the schema, not only in the runtime.
      await expectRejected(
        pool.query(
          `insert into agent_runs (
             id, root_run_id, parent_run_id, depth, ancestor_agent_ids,
             user_id, conversation_id, status
           ) values ($1, $2, $2, 4, $3::uuid[], $4, $5, 'running')`,
          [
            randomUUID(),
            parent.id,
            scenario.agentIds,
            scenario.userId,
            scenario.conversationId,
          ],
        ),
        'agent_runs_depth_check',
      );
    });

    await t.test('a dispatched run derives its lineage and refuses cycles', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();

      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: 'call-1',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      assert.equal(child.root_run_id, parent.id);
      assert.equal(child.parent_run_id, parent.id);
      assert.equal(child.depth, 1);
      // The chain includes the parent's own Agent, which is what makes the cycle
      // check exact rather than heuristic.
      assert.deepEqual(child.ancestor_agent_ids, [scenario.agentIds[0]]);

      // A grandchild that targets an Agent already running above it is refused.
      await expectRejected(
        createSubagentRun({
          userId: scenario.userId,
          agentId: scenario.agentIds[0],
          agentVersionId: null,
          parentRunId: child.id,
          parentToolCallId: 'call-2',
          agentVersionSnapshot: {},
          maxDepth: 3,
        }),
        'already running higher up',
      );

      // Depth is refused before the insert is attempted.
      const grandchild = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[2],
        agentVersionId: null,
        parentRunId: child.id,
        parentToolCallId: 'call-3',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      const childClaim = await claimQueuedSubagentRun({
        runId: child.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(childClaim);
      const childApprovalStep = await insertAgentStep({
        runId: child.id,
        sequence: 0,
        kind: 'approval',
        status: 'pending',
        toolCallId: 'call-write',
        toolKey: 'custom:writer',
        input: { value: 1 },
        output: { risk_level: 'write' },
      });
      const grandchildStep = await insertAgentStep({
        runId: grandchild.id,
        sequence: 0,
        kind: 'model',
        status: 'running',
      });
      const childApprovalIntent = approvalIntentFor({ args: { value: 1 } });
      const approval = await createAgentApproval({
        runId: parent.id,
        stepId: childApprovalStep.id,
        userId: scenario.userId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestedByRunId: child.id,
        intent: childApprovalIntent.intent,
        intentHash: childApprovalIntent.intentHash,
      });
      assert.equal(grandchild.depth, 2);
      await expectRejected(
        createSubagentRun({
          userId: scenario.userId,
          agentId: scenario.agentIds[3],
          agentVersionId: null,
          parentRunId: grandchild.id,
          parentToolCallId: 'call-4',
          agentVersionSnapshot: {},
          maxDepth: 2,
        }),
        'limited to 2 levels',
      );

      // A run belonging to another user is not reachable for dispatch.
      assert.equal(
        await createSubagentRun({
          userId: otherUserId,
          agentId: scenario.agentIds[1],
          agentVersionId: null,
          parentRunId: parent.id,
          parentToolCallId: 'call-5',
          agentVersionSnapshot: {},
          maxDepth: 3,
        }),
        null,
      );
    });

    await t.test('a step is attributed to its tree root, not to its own run', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: 'call-1',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });

      const dispatchStep = await insertAgentStep({
        runId: parent.id,
        sequence: 0,
        kind: 'subagent_dispatch',
        status: 'succeeded',
      });
      const childStep = await insertAgentStep({
        runId: child.id,
        sequence: 0,
        kind: 'model',
        status: 'succeeded',
        parentSpanId: dispatchStep.span_id,
      });

      // Both steps share the trace even though they belong to different runs: this
      // is what lets a subagent's work be read as part of one request.
      assert.equal(dispatchStep.trace_id, parent.id);
      assert.equal(childStep.trace_id, parent.id);
      assert.equal(childStep.parent_span_id, dispatchStep.span_id);
      assert.notEqual(childStep.span_id, dispatchStep.span_id);
    });

    await t.test('cancelling a run cancels the subtree it spawned', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: 'call-1',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      const grandchild = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[2],
        agentVersionId: null,
        parentRunId: child.id,
        parentToolCallId: 'call-2',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });

      // A parent parked on its children is still active, so cancellation has to
      // reach it too.
      assert.ok(await markAgentRunWaitingForSubagents(parent.id, scenario.userId));
      const cancelled = await cancelAgentRunForUser(parent.id, scenario.userId);
      assert.ok(cancelled, 'the requested run is returned, not an arbitrary descendant');
      assert.equal(cancelled.id, parent.id);

      const { rows } = await pool.query(
        `select id, status, lease_token, lease_expires_at
         from agent_runs where root_run_id = $1 order by depth`,
        [parent.id],
      );
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.status, 'cancelled', `run ${row.id} must be cancelled with the tree`);
        assert.equal(row.lease_token, null, `run ${row.id} must not retain a lease`);
        assert.equal(row.lease_expires_at, null, `run ${row.id} must not retain a lease deadline`);
      }
      assert.ok(rows.some((row) => row.id === grandchild.id));
      const closedSteps = await pool.query(
        'select id, status from agent_steps where id = any($1::uuid[]) order by id',
        [[childApprovalStep.id, grandchildStep.id]],
      );
      assert.equal(closedSteps.rows.length, 2);
      assert.ok(closedSteps.rows.every((step) => step.status === 'cancelled'));
      const closedApproval = await pool.query(
        'select status from agent_approvals where id = $1',
        [approval.id],
      );
      assert.equal(closedApproval.rows[0].status, 'expired');

      // A cancelled parent must not be pulled back into running by a dispatch that
      // was already in flight.
      assert.equal(await resumeAgentRunFromSubagents(parent.id, scenario.userId), null);
    });

    await t.test('root success fences leftover descendants and closes their approvals', async () => {
      const scenario = await createScenario();
      const root = await scenario.startRun();
      const rootWorkClaim = await claimAgentWorkItemForRun({
        runId: root.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(rootWorkClaim);
      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: root.id,
        parentToolCallId: 'call-success-cleanup',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      const childClaim = await claimQueuedSubagentRun({
        runId: child.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(childClaim);
      const grandchild = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[2],
        agentVersionId: null,
        parentRunId: child.id,
        parentToolCallId: 'call-grandchild-success-cleanup',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      const grandchildClaim = await claimQueuedSubagentRun({
        runId: grandchild.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(grandchildClaim);
      const approvalStep = await insertAgentStep({
        runId: grandchild.id,
        sequence: 0,
        kind: 'approval',
        status: 'pending',
        toolCallId: 'call-pending-on-success',
        toolKey: 'custom:writer',
        input: {},
        output: { risk_level: 'write' },
      });
      const pendingOnSuccessIntent = approvalIntentFor();
      const approval = await createAgentApproval({
        runId: root.id,
        stepId: approvalStep.id,
        userId: scenario.userId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestedByRunId: grandchild.id,
        intent: pendingOnSuccessIntent.intent,
        intentHash: pendingOnSuccessIntent.intentHash,
      });
      assert.ok(await markAgentRunWaitingForSubagents(root.id, scenario.userId));

      const completed = await completeAgentRunForUser({
        runId: root.id,
        userId: scenario.userId,
        content: 'root answer',
        sources: [],
        assistantStepSequence: 0,
        iterationCount: 1,
        toolCallCount: 1,
        tokenUsage: {},
        workItemLeaseToken: rootWorkClaim.lease_token,
        workItemFencingGeneration: rootWorkClaim.fencing_generation,
      });
      assert.equal(completed.run.status, 'succeeded');

      const { rows } = await pool.query(
        `select id, status, lease_token
         from agent_runs where root_run_id = $1 order by depth`,
        [root.id],
      );
      assert.deepEqual(rows.map((row) => row.status), ['succeeded', 'cancelled', 'cancelled']);
      assert.equal(rows[1].lease_token, null);
      assert.equal(rows[2].lease_token, null);
      assert.equal(
        (await pool.query('select status from agent_approvals where id = $1', [approval.id])).rows[0].status,
        'expired',
      );
      assert.equal(
        (await pool.query('select status from agent_steps where id = $1', [approvalStep.id])).rows[0].status,
        'failed',
      );
      assert.equal(await renewSubagentRunLease({
        runId: grandchild.id,
        leaseToken: grandchildClaim.lease_token,
        leaseDurationMs: 60_000,
      }), null);
    });

    await t.test('PostgreSQL rejects a terminal parent with an active child', async () => {
      const scenario = await createScenario();
      const root = await scenario.startRun();
      await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: root.id,
        parentToolCallId: 'call-invalid-terminal-parent',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });

      await expectRejected(
        pool.query(
          "update agent_runs set status = 'succeeded', completed_at = now() where id = $1",
          [root.id],
        ),
        'terminal Agent run cannot have an active descendant',
      );
    });

    await t.test('a bubbled approval projects child context and transitions its step atomically', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: 'call-approval',
        agentVersionSnapshot: { name: 'Approval worker' },
        maxDepth: 3,
      });
      const approvalStep = await insertAgentStep({
        runId: child.id,
        sequence: 0,
        kind: 'approval',
        status: 'pending',
        toolCallId: 'call-write',
        toolKey: 'custom:writer',
        input: { title: 'Draft' },
        output: { risk_level: 'write' },
      });
      const bubbledIntent = approvalIntentFor({ args: { title: 'Draft' } });
      const approval = await createAgentApproval({
        runId: parent.id,
        stepId: approvalStep.id,
        userId: scenario.userId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestedByRunId: child.id,
        intent: bubbledIntent.intent,
        intentHash: bubbledIntent.intentHash,
      });

      const detail = await findAgentRunForUser(parent.id, scenario.userId);
      const projected = detail.approvals.find((candidate) => candidate.id === approval.id);
      assert.ok(projected);
      assert.equal(projected.requested_by_run_id, child.id);
      assert.equal(projected.requested_by_agent_id, scenario.agentIds[1]);
      assert.equal(projected.requested_by_agent_name, 'Approval worker');
      assert.equal(projected.requested_by_depth, 1);
      assert.equal(projected.tool_key, 'custom:writer');
      assert.deepEqual(projected.input, { title: 'Draft' });
      assert.deepEqual(projected.intent, bubbledIntent.intent);
      assert.equal(projected.intent_hash, bubbledIntent.intentHash);

      const inbox = await listAgentApprovalInboxForUser({
        userId: scenario.userId,
        status: 'pending',
        limit: 10,
      });
      assert.equal(inbox.items.some((candidate) => candidate.id === approval.id), true);
      assert.equal(
        (await listAgentApprovalInboxForUser({ userId: otherUserId })).items.length,
        0,
        'another user cannot enumerate pending approvals',
      );
      await expectRejected(
        pool.query(
          `update agent_approvals
           set intent = jsonb_set(intent, '{method}', '"changed"'::jsonb)
           where id = $1`,
          [approval.id],
        ),
        'Agent approval intent is immutable',
      );
      await expectRejected(
        pool.query(
          `update agent_steps set input = '{"title":"Changed"}'::jsonb where id = $1`,
          [approvalStep.id],
        ),
        'cannot change tool or input',
      );

      assert.ok(await decideAgentApprovalForUser({
        approvalId: approval.id,
        runId: parent.id,
        userId: scenario.userId,
        decision: 'approved',
        reason: 'Reviewed',
      }));
      const decidedState = await pool.query(
        `select approval.status as approval_status, step.status as step_status, step.output
         from agent_approvals approval
         join agent_steps step on step.id = approval.step_id
         where approval.id = $1`,
        [approval.id],
      );
      assert.equal(decidedState.rows[0].approval_status, 'approved');
      assert.equal(decidedState.rows[0].step_status, 'succeeded');
      assert.equal(decidedState.rows[0].output.decision, 'approved');
      assert.equal(await decideAgentApprovalForUser({
        approvalId: approval.id,
        runId: parent.id,
        userId: scenario.userId,
        decision: 'rejected',
      }), null, 'a canonical approval can transition only once');

      const expiringStep = await insertAgentStep({
        runId: child.id,
        sequence: 1,
        kind: 'approval',
        status: 'pending',
        toolCallId: 'call-expire',
        toolKey: 'custom:writer',
        input: {},
        output: { risk_level: 'write' },
      });
      const expiringIntent = approvalIntentFor();
      const expiringApproval = await createAgentApproval({
        runId: parent.id,
        stepId: expiringStep.id,
        userId: scenario.userId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestedByRunId: child.id,
        intent: expiringIntent.intent,
        intentHash: expiringIntent.intentHash,
      });
      assert.ok(await expireAgentApproval(expiringApproval.id, parent.id));
      const expiredState = await pool.query(
        `select approval.status as approval_status, step.status as step_status, step.output
         from agent_approvals approval
         join agent_steps step on step.id = approval.step_id
         where approval.id = $1`,
        [expiringApproval.id],
      );
      assert.equal(expiredState.rows[0].approval_status, 'expired');
      assert.equal(expiredState.rows[0].step_status, 'failed');
      assert.equal(expiredState.rows[0].output.decision, 'expired');

      // PostgreSQL jsonb expands exponential numbers and sorts UTF-8 keys. The
      // application fingerprint must match that canonical form exactly.
      const numericArgs = {
        tiny: 1e-7,
        huge: 1e21,
        nested: { 2: 'second', 10: 'first' },
      };
      const numericStep = await insertAgentStep({
        runId: child.id,
        sequence: 2,
        kind: 'approval',
        status: 'pending',
        toolCallId: 'call-numeric-canonical',
        toolKey: 'custom:writer',
        input: numericArgs,
        output: { risk_level: 'write' },
      });
      const numericIntent = approvalIntentFor({ args: numericArgs });
      const numericApproval = await createAgentApproval({
        runId: parent.id,
        stepId: numericStep.id,
        userId: scenario.userId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestedByRunId: child.id,
        intent: numericIntent.intent,
        intentHash: numericIntent.intentHash,
      });
      assert.equal(numericApproval.intent_hash, numericIntent.intentHash);
      assert.ok(await decideAgentApprovalForUser({
        approvalId: numericApproval.id,
        runId: parent.id,
        userId: scenario.userId,
        decision: 'rejected',
        reason: 'Canonical hash verified',
      }));
    });

    await t.test('deleting a run removes the subtree instead of orphaning it', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: 'call-1',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      await pool.query('delete from agent_runs where id = $1', [parent.id]);
      assert.equal(
        (await pool.query('select 1 from agent_runs where id = $1', [child.id])).rowCount,
        0,
        'the child must not survive its parent',
      );
    });

    await t.test('root Run and tree budget are created or rolled back together', async () => {
      const scenario = await createScenario();
      const configured = {
        deadlineAt: new Date(Date.now() + 45_000),
        tokenTotal: 4_000,
        iterationTotal: 7,
        toolCallTotal: 9,
        subagentDispatchTotal: 5,
        finalAnswerReserveTokens: 500,
      };
      const root = await scenario.startRun(scenario.agentIds[0], configured);
      const persisted = await findAgentRunBudget(root.id);
      assert.ok(persisted, 'a visible root Run must always have its tree ledger');
      assert.equal(persisted.token_total, configured.tokenTotal);
      assert.equal(persisted.iteration_total, configured.iterationTotal);
      assert.equal(persisted.tool_call_total, configured.toolCallTotal);
      assert.equal(persisted.subagent_dispatch_total, configured.subagentDispatchTotal);
      assert.equal(persisted.final_answer_reserve_tokens, configured.finalAnswerReserveTokens);
      assert.ok(Math.abs(
        new Date(persisted.deadline_at).getTime() - configured.deadlineAt.getTime(),
      ) < 1_000);

      const rollbackScenario = await createScenario();
      await expectRejected(
        rollbackScenario.startRun(rollbackScenario.agentIds[0], {
          ...defaultRunBudget(),
          tokenTotal: 100,
          finalAnswerReserveTokens: 100,
        }),
        'agent_run_budgets_reserve_check',
      );
      assert.equal(
        (await pool.query('select count(*)::int as count from agent_runs where user_id = $1', [
          rollbackScenario.userId,
        ])).rows[0].count,
        0,
        'a rejected budget insert must roll the root Run back',
      );
      assert.equal(
        (await pool.query('select count(*)::int as count from messages where conversation_id = $1', [
          rollbackScenario.conversationId,
        ])).rows[0].count,
        0,
        'a rejected budget insert must not leave an assistant placeholder',
      );
    });

    await t.test('parallel model reservations cannot jointly overspend and settle once', async () => {
      const scenario = await createScenario();
      const root = await scenario.startRun(scenario.agentIds[0], {
        deadlineAt: new Date(Date.now() + 60_000),
        tokenTotal: 1_000,
        iterationTotal: 10,
        toolCallTotal: 10,
        subagentDispatchTotal: 3,
        finalAnswerReserveTokens: 200,
      });
      const attempts = await Promise.all(Array.from({ length: 8 }, () => (
        reserveAgentModelInvocation({
          runId: root.id,
          rootRunId: root.id,
          reservationTokens: 300,
        })
      )));
      const granted = attempts.filter((result) => result.granted);
      assert.equal(granted.length, 2, 'only 600 of the ordinary 800 tokens can fit whole requests');
      let budget = await findAgentRunBudget(root.id);
      assert.equal(budget.token_reserved, 600);
      assert.equal(budget.iteration_consumed, 2);

      const invocation = granted[0].invocation;
      const firstSettlement = await settleAgentModelInvocation({
        invocationId: invocation.id,
        runId: root.id,
        status: 'succeeded',
        actualTokens: 120,
        usageSource: 'provider_reported',
        resultPayload: { content: 'settled once', tool_calls: [], finish_reason: 'stop' },
      });
      assert.equal(firstSettlement.status, 'succeeded');
      const repeatedSettlement = await settleAgentModelInvocation({
        invocationId: invocation.id,
        runId: root.id,
        status: 'succeeded',
        actualTokens: 120,
        usageSource: 'provider_reported',
        resultPayload: { content: 'settled once', tool_calls: [], finish_reason: 'stop' },
      });
      assert.equal(repeatedSettlement.status, 'succeeded');
      budget = await findAgentRunBudget(root.id);
      assert.equal(budget.token_consumed, 120, 'repeated settlement must not double-charge');
      assert.equal(budget.token_reserved, 300, 'settlement releases the unused reservation');

      const replacement = await reserveAgentModelInvocation({
        runId: root.id,
        rootRunId: root.id,
        reservationTokens: 300,
      });
      assert.equal(replacement.granted, true, 'released headroom is immediately reusable');

      await pool.query(
        'update agent_run_budgets set deadline_at = now() - interval \'1 second\' where root_run_id = $1',
        [root.id],
      );
      const swept = await settleExpiredAgentModelInvocations();
      assert.equal(swept.length, 2, 'every still-reserved request is closed after the tree deadline');
      budget = await findAgentRunBudget(root.id);
      assert.equal(budget.token_reserved, 0);
      assert.equal(budget.token_consumed, 720, 'unknown provider outcomes consume the full exposure');
      const invocationRows = await pool.query(
        `select status, actual_tokens, reservation_tokens, usage_source
         from agent_model_invocations
         where id = any($1::uuid[])`,
        [swept],
      );
      assert.equal(invocationRows.rowCount, 2);
      for (const row of invocationRows.rows) {
        assert.equal(row.status, 'indeterminate');
        assert.equal(row.actual_tokens, row.reservation_tokens);
        assert.equal(row.usage_source, 'reservation_conservative');
      }
    });

    await t.test('only the root can spend the protected final model turn', async () => {
      const scenario = await createScenario();
      const root = await scenario.startRun(scenario.agentIds[0], {
        deadlineAt: new Date(Date.now() + 60_000),
        tokenTotal: 1_000,
        iterationTotal: 2,
        toolCallTotal: 10,
        subagentDispatchTotal: 3,
        finalAnswerReserveTokens: 200,
      });
      const ordinary = await reserveAgentModelInvocation({
        runId: root.id,
        rootRunId: root.id,
        reservationTokens: 100,
      });
      assert.equal(ordinary.granted, true);

      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: root.id,
        parentToolCallId: 'final-reserve-child',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      const childAttempt = await reserveAgentModelInvocation({
        runId: child.id,
        rootRunId: root.id,
        reservationTokens: 100,
        allowFinalAnswerReserve: true,
      });
      assert.equal(childAttempt.granted, false);
      assert.equal(childAttempt.reason, 'final_answer_reserve_forbidden');

      const normalRootAttempt = await reserveAgentModelInvocation({
        runId: root.id,
        rootRunId: root.id,
        reservationTokens: 100,
      });
      assert.equal(normalRootAttempt.granted, false);
      assert.equal(normalRootAttempt.reason, 'iteration_exhausted');
      assert.equal(normalRootAttempt.reserveWouldCover, true);
      const finalRootAttempt = await reserveAgentModelInvocation({
        runId: root.id,
        rootRunId: root.id,
        reservationTokens: 100,
        allowFinalAnswerReserve: true,
      });
      assert.equal(finalRootAttempt.granted, true);
      assert.equal((await findAgentRunBudget(root.id)).iteration_consumed, 2);
    });

    await t.test('parallel child creation is capped by the shared dispatch ledger', async () => {
      const scenario = await createScenario(12);
      const root = await scenario.startRun(scenario.agentIds[0], {
        ...defaultRunBudget(),
        subagentDispatchTotal: 3,
      });
      const outcomes = await Promise.allSettled(
        scenario.agentIds.slice(1, 11).map((agentId, index) => createSubagentRun({
          userId: scenario.userId,
          agentId,
          agentVersionId: null,
          parentRunId: root.id,
          parentToolCallId: `parallel-dispatch-${index}`,
          agentVersionSnapshot: {},
          maxDepth: 3,
        })),
      );
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 3);
      for (const outcome of outcomes.filter((item) => item.status === 'rejected')) {
        assert.equal(outcome.reason.code, 'subagent_budget_exhausted');
      }
      const budget = await findAgentRunBudget(root.id);
      assert.equal(budget.subagent_dispatch_consumed, 3);
      assert.equal(
        (await pool.query('select count(*)::int as count from agent_runs where parent_run_id = $1', [
          root.id,
        ])).rows[0].count,
        3,
      );
    });

    await t.test('an expired tree starts no new model, tool or subagent work', async () => {
      const scenario = await createScenario();
      const root = await scenario.startRun(scenario.agentIds[0], {
        ...defaultRunBudget(),
        deadlineAt: new Date(Date.now() - 1_000),
      });
      const model = await reserveAgentModelInvocation({
        runId: root.id,
        rootRunId: root.id,
        reservationTokens: 100,
      });
      assert.equal(model.granted, false);
      assert.equal(model.reason, 'deadline_exceeded');
      assert.equal((await debitAgentRunBudget({
        runId: root.id,
        rootRunId: root.id,
        dimension: 'tool_call',
        amount: 1,
      })).granted, false);
      await assert.rejects(() => createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: root.id,
        parentToolCallId: 'expired-dispatch',
        agentVersionSnapshot: {},
        maxDepth: 3,
      }), (error) => error?.code === 'subagent_deadline_exceeded');
    });

    await t.test('concurrent debits cannot overdraw the shared allowance', async () => {
      const scenario = await createScenario();
      const budget = {
        deadlineAt: new Date(Date.now() + 60_000),
        tokenTotal: 1_000,
        iterationTotal: 10,
        toolCallTotal: 10,
        subagentDispatchTotal: 3,
        finalAnswerReserveTokens: 200,
      };
      const root = await scenario.startRun(scenario.agentIds[0], budget);

      // Ten writers each asking for 100 tokens against an 800-token spendable
      // allowance. A read-then-write implementation lets more than eight through;
      // the conditional UPDATE is the whole reason this holds.
      const results = await Promise.all(Array.from({ length: 10 }, () => debitAgentRunBudget({
        runId: root.id,
        rootRunId: root.id,
        dimension: 'token',
        amount: 100,
      })));
      const granted = results.filter((result) => result.granted).length;
      assert.equal(granted, 8, `only the spendable allowance may be granted, got ${granted}`);

      const afterOrdinary = await findAgentRunBudget(root.id);
      assert.equal(afterOrdinary.token_consumed, 800);
      // The reserve is untouched by ordinary work.
      assert.equal(
        afterOrdinary.token_total - afterOrdinary.token_consumed,
        afterOrdinary.final_answer_reserve_tokens,
      );

      // The rejected callers are told the reserve would have covered them, which is
      // the signal the runtime uses to degrade instead of failing.
      assert.ok(results.some((result) => !result.granted && result.reserveWouldCover));

      // A generic debit can never spend the reserve. Only a root model
      // reservation with an identity check can do that.
      const reserveDebit = await debitAgentRunBudget({
        runId: root.id,
        rootRunId: root.id,
        dimension: 'token',
        amount: 200,
      });
      assert.equal(reserveDebit.granted, false);
      assert.equal(reserveDebit.reserveWouldCover, true);
      assert.equal(
        (await debitAgentRunBudget({
          runId: root.id,
          rootRunId: root.id,
          dimension: 'token',
          amount: 1,
        })).granted,
        false,
      );

      // Restarting must not reset an allowance that has already been spent.
      const reused = await createAgentRunBudget({
        rootRunId: root.id,
        userId: scenario.userId,
        deadlineAt: new Date(Date.now() + 60_000),
        tokenTotal: 1_000,
        iterationTotal: 10,
        toolCallTotal: 10,
        subagentDispatchTotal: 3,
        finalAnswerReserveTokens: 200,
      });
      assert.equal(reused.token_consumed, 800);

      // The first transition into degraded mode wins so concurrent runs in one tree
      // do not overwrite each other's reason.
      assert.ok(await markAgentRunBudgetDegraded(root.id, 'token_budget'));
      assert.equal(await markAgentRunBudgetDegraded(root.id, 'something_else'), null);
      assert.equal((await findAgentRunBudget(root.id)).degraded_reason, 'token_budget');
    });

    await t.test('the ledger refuses an overdraft even when asked directly', async () => {
      const scenario = await createScenario();
      const root = await scenario.startRun(scenario.agentIds[0], {
        deadlineAt: new Date(Date.now() + 60_000),
        tokenTotal: 100,
        iterationTotal: 2,
        toolCallTotal: 2,
        subagentDispatchTotal: 1,
        finalAnswerReserveTokens: 10,
      });
      // Bypassing the repository must not bypass the invariant.
      await expectRejected(
        pool.query(
          'update agent_run_budgets set token_consumed = token_total + 1 where root_run_id = $1',
          [root.id],
        ),
        'agent_run_budgets_token_accounting_check',
      );
      // A reserve that swallows the whole allowance is rejected as well.
      await expectRejected(
        pool.query(
          'update agent_run_budgets set final_answer_reserve_tokens = token_total where root_run_id = $1',
          [root.id],
        ),
        'agent_run_budgets_reserve_check',
      );
    });

    await t.test('0052 repairs legacy memory graphs in an isolated schema', async () => {
      const client = await pool.connect();
      const schema = `memory_0052_${randomUUID().replaceAll('-', '')}`;
      try {
        await client.query('begin');
        await client.query(`create schema "${schema}"`);
        await client.query(`set local search_path to "${schema}", pg_catalog`);
        const currentSchema = await client.query('select current_schema() as name');
        assert.equal(currentSchema.rows[0].name, schema);

        // This is the relevant 0051 shape: the old active-row indexes and a
        // permissive self-FK, without deleted_at or the lifecycle trigger.
        await client.query(`
          create table agent_memories (
            id uuid primary key,
            user_id uuid not null,
            scope text not null,
            scope_ref_id uuid,
            kind text not null,
            content text not null,
            provenance_run_id uuid,
            provenance_step_id uuid,
            source_trust text not null,
            superseded_by uuid,
            expires_at timestamptz,
            embedding real[],
            embedding_model text,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            constraint agent_memories_superseded_by_fkey
              foreign key (superseded_by) references agent_memories(id) on delete set null,
            constraint agent_memories_self_supersede_check
              check (superseded_by is null or superseded_by <> id)
          );
          create index agent_memories_scope_idx
            on agent_memories (user_id, scope, scope_ref_id, created_at desc)
            where superseded_by is null;
          create index agent_memories_expiry_idx
            on agent_memories (expires_at)
            where expires_at is not null and superseded_by is null;
          create unique index agent_memories_dedupe_idx
            on agent_memories (
              user_id,
              scope,
              coalesce(scope_ref_id, '00000000-0000-0000-0000-000000000000'::uuid),
              kind,
              md5(content)
            )
            where superseded_by is null;
        `);

        const legacyUserId = randomUUID();
        const otherLegacyUserId = randomUUID();
        const legacyProjectId = randomUUID();
        const replacementByScopeId = randomUUID();
        const replacementByUserId = randomUUID();
        const invalidSourceAId = randomUUID();
        const invalidSourceBId = randomUUID();
        const cycleLeftId = randomUUID();
        const cycleRightId = randomUUID();
        const insertLegacyMemory = (input) => client.query(
          `insert into agent_memories (
             id, user_id, scope, scope_ref_id, kind, content, source_trust, superseded_by
           ) values ($1, $2, $3, $4, 'decision', $5, 'agent_inferred', $6)`,
          [
            input.id,
            input.userId,
            input.scope,
            input.scopeRefId ?? null,
            input.content,
            input.supersededBy ?? null,
          ],
        );

        await insertLegacyMemory({
          id: replacementByScopeId,
          userId: legacyUserId,
          scope: 'user',
          content: 'Wrong-scope replacement.',
        });
        await insertLegacyMemory({
          id: replacementByUserId,
          userId: otherLegacyUserId,
          scope: 'project',
          scopeRefId: legacyProjectId,
          content: 'Wrong-user replacement.',
        });
        for (const memory of [
          {
            id: invalidSourceAId,
            content: 'Legacy invalid predecessor A.',
            supersededBy: replacementByScopeId,
          },
          {
            id: invalidSourceBId,
            content: 'Legacy invalid predecessor B.',
            supersededBy: replacementByUserId,
          },
          { id: cycleLeftId, content: 'Legacy cycle left.' },
          { id: cycleRightId, content: 'Legacy cycle right.' },
        ]) {
          await insertLegacyMemory({
            ...memory,
            userId: legacyUserId,
            scope: 'project',
            scopeRefId: legacyProjectId,
          });
        }
        await client.query(
          'update agent_memories set superseded_by = $2 where id = $1',
          [cycleLeftId, cycleRightId],
        );
        await client.query(
          'update agent_memories set superseded_by = $2 where id = $1',
          [cycleRightId, cycleLeftId],
        );
        await client.query(
          `update agent_memories
           set embedding = $2::real[], embedding_model = 'legacy-model',
               provenance_run_id = $3, provenance_step_id = $4,
               expires_at = now() + interval '1 day'
           where id = $1`,
          [invalidSourceAId, [1, 0], randomUUID(), randomUUID()],
        );

        // Execute the exact migration file. The four repaired rows converge on
        // one dedupe key; this is where the legacy unique index used to abort.
        const migrationSql = readFileSync(
          path.join(serverRoot, 'migrations', '0052_agent_memory_lifecycle.sql'),
          'utf8',
        );
        await client.query(migrationSql);
        const repairedIds = [invalidSourceAId, invalidSourceBId, cycleLeftId, cycleRightId];
        const repaired = await client.query(
          `select id, content, superseded_by, deleted_at, embedding, embedding_model,
                  provenance_run_id, provenance_step_id, expires_at, ctid::text as ctid
           from agent_memories
           where id = any($1::uuid[])
           order by id`,
          [repairedIds],
        );
        assert.equal(repaired.rowCount, repairedIds.length);
        for (const memory of repaired.rows) {
          assert.equal(memory.content, '[deleted]');
          assert.equal(memory.superseded_by, null);
          assert.ok(memory.deleted_at);
          assert.equal(memory.embedding, null);
          assert.equal(memory.embedding_model, null);
          assert.equal(memory.provenance_run_id, null);
          assert.equal(memory.provenance_step_id, null);
          assert.equal(memory.expires_at, null);
        }

        const replacements = await client.query(
          `select id, content, deleted_at
           from agent_memories
           where id = any($1::uuid[])
           order by id`,
          [[replacementByScopeId, replacementByUserId]],
        );
        assert.equal(replacements.rowCount, 2);
        assert.ok(replacements.rows.every((memory) => memory.deleted_at === null));
        assert.ok(replacements.rows.every((memory) => memory.content !== '[deleted]'));

        const predicate = await client.query(
          `select pg_get_expr(index_info.indpred, index_info.indrelid) as predicate
           from pg_index index_info
           join pg_class index_class on index_class.oid = index_info.indexrelid
           join pg_namespace namespace on namespace.oid = index_class.relnamespace
           where namespace.nspname = $1
             and index_class.relname = 'agent_memories_dedupe_idx'`,
          [schema],
        );
        assert.equal(predicate.rowCount, 1);
        assert.match(predicate.rows[0].predicate, /superseded_by IS NULL/i);
        assert.match(predicate.rows[0].predicate, /deleted_at IS NULL/i);

        const indexRows = await client.query(
          `select indexname, indexdef
           from pg_indexes
           where schemaname = $1 and tablename = 'agent_memories'`,
          [schema],
        );
        const indexDefinitions = new Map(
          indexRows.rows.map((row) => [row.indexname, row.indexdef.toLowerCase()]),
        );
        assert.match(indexDefinitions.get('agent_memories_user_idx') || '', /\(user_id\)/);
        assert.match(
          indexDefinitions.get('agent_memories_superseded_by_idx') || '',
          /\(superseded_by\).*superseded_by is not null/,
        );

        const functionNamespace = await client.query(
          `select namespace.nspname
           from pg_proc function_info
           join pg_namespace namespace on namespace.oid = function_info.pronamespace
           where namespace.nspname = $1
             and function_info.proname = 'enforce_agent_memory_supersession'
             and pg_get_function_identity_arguments(function_info.oid) = ''`,
          [schema],
        );
        assert.equal(functionNamespace.rowCount, 1);

        const fk = await client.query(
          `select constraint_info.confdeltype, constraint_info.condeferrable,
                  constraint_info.condeferred,
                  referenced_namespace.nspname as referenced_schema
           from pg_constraint constraint_info
           join pg_class source_table on source_table.oid = constraint_info.conrelid
           join pg_namespace source_namespace on source_namespace.oid = source_table.relnamespace
           join pg_class referenced_table on referenced_table.oid = constraint_info.confrelid
           join pg_namespace referenced_namespace
             on referenced_namespace.oid = referenced_table.relnamespace
           where source_namespace.nspname = $1
             and source_table.relname = 'agent_memories'
             and constraint_info.conname = 'agent_memories_superseded_by_fkey'`,
          [schema],
        );
        assert.equal(fk.rowCount, 1);
        assert.equal(fk.rows[0].confdeltype, 'a');
        assert.equal(fk.rows[0].condeferrable, true);
        assert.equal(fk.rows[0].condeferred, false);
        assert.equal(fk.rows[0].referenced_schema, schema);

        // A full replay models recovery after an operator is unsure whether the
        // migration completed. It must neither fail nor rewrite clean tombstones.
        await client.query(migrationSql);
        const replayed = await client.query(
          `select id, ctid::text as ctid
           from agent_memories
           where id = any($1::uuid[])
           order by id`,
          [repairedIds],
        );
        assert.deepEqual(
          replayed.rows.map((row) => [row.id, row.ctid]),
          repaired.rows.map((row) => [row.id, row.ctid]),
          'replaying 0052 must not rewrite normalized tombstones',
        );
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
      }
    });

    await t.test('memory deduplicates, expires and stays scoped', async () => {
      const scenario = await createScenario();
      const userId = scenario.userId;
      const parentAgentId = scenario.agentIds[0];
      const first = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'preference',
        content: 'Prefers metric units.',
        sourceTrust: 'agent_inferred',
      });
      // Re-remembering the same statement updates rather than accumulating, which
      // is what keeps a run that remembers every time from flooding recall.
      const again = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'preference',
        content: 'Prefers metric units.',
        sourceTrust: 'user_stated',
      });
      assert.equal(again.id, first.id, 'the partial unique index must collapse duplicates');
      assert.equal(again.source_trust, 'user_stated');

      const expired = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'fact',
        content: 'Temporarily on call.',
        sourceTrust: 'agent_inferred',
        expiresAt: new Date(Date.now() - 1_000),
      });
      const otherProject = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: randomUUID(),
        kind: 'fact',
        content: 'Belongs to another workspace.',
        sourceTrust: 'agent_inferred',
      });
      const userScoped = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'fact',
        content: 'Active across the user account.',
        sourceTrust: 'user_stated',
      });
      const agentScoped = await upsertAgentMemory({
        userId,
        scope: 'agent',
        scopeRefId: parentAgentId,
        kind: 'fact',
        content: 'Available only to the current Agent.',
        sourceTrust: 'agent_inferred',
      });
      const otherAgent = await upsertAgentMemory({
        userId,
        scope: 'agent',
        scopeRefId: randomUUID(),
        kind: 'fact',
        content: 'Belongs to another Agent.',
        sourceTrust: 'agent_inferred',
      });

      const recalled = await listRecallableAgentMemories({
        userId,
        projectSpaceId,
        agentId: parentAgentId,
        limit: 20,
      });
      const recalledIds = recalled.map((memory) => memory.id);
      assert.ok(recalledIds.includes(first.id));
      assert.ok(recalledIds.includes(userScoped.id));
      assert.ok(recalledIds.includes(agentScoped.id));
      // Excluded in SQL, so no code path can surface them by forgetting to check.
      assert.ok(!recalledIds.includes(expired.id), 'an expired memory must never be recalled');
      assert.ok(!recalledIds.includes(otherProject.id), 'a project memory must not leak');
      assert.ok(!recalledIds.includes(otherAgent.id), 'another Agent memory must not leak');

      const projectAndAgentIds = (await listRecallableAgentMemories({
        userId,
        projectSpaceId,
        agentId: parentAgentId,
        scopes: ['project', 'agent'],
        limit: 20,
      })).map((memory) => memory.id);
      assert.ok(projectAndAgentIds.includes(first.id));
      assert.ok(projectAndAgentIds.includes(agentScoped.id));
      assert.ok(!projectAndAgentIds.includes(userScoped.id));
      assert.ok(!projectAndAgentIds.includes(otherProject.id));
      assert.ok(!projectAndAgentIds.includes(otherAgent.id));

      const userAndAgentIds = (await listRecallableAgentMemories({
        userId,
        projectSpaceId,
        agentId: parentAgentId,
        scopes: ['user', 'agent'],
        limit: 20,
      })).map((memory) => memory.id);
      assert.ok(userAndAgentIds.includes(userScoped.id));
      assert.ok(userAndAgentIds.includes(agentScoped.id));
      assert.ok(!userAndAgentIds.includes(first.id));
      assert.deepEqual(await listRecallableAgentMemories({
        userId,
        projectSpaceId,
        agentId: parentAgentId,
        scopes: [],
        limit: 20,
      }), []);

      const replacement = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'preference',
        content: 'Prefers imperial units now.',
        sourceTrust: 'user_stated',
        embedding: { vector: [0.25, 0.75], model: 'integration-test' },
      });

      // Replacement is an atomic same-user, same-scope operation. A target from
      // another scope or user must not mutate the original row.
      await expectRejected(
        pool.query(
          'update agent_memories set superseded_by = $2 where id = $1',
          [first.id, userScoped.id],
        ),
        'same user and scope',
      );
      assert.equal(await supersedeAgentMemory({
        userId,
        memoryId: first.id,
        supersededById: userScoped.id,
      }), null);
      const otherUserReplacement = await upsertAgentMemory({
        userId: otherUserId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'preference',
        content: 'Another user replacement.',
        sourceTrust: 'user_stated',
      });
      assert.equal(await supersedeAgentMemory({
        userId,
        memoryId: first.id,
        supersededById: otherUserReplacement.id,
      }), null);

      const inactiveReplacement = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'preference',
        content: 'An intermediate preference.',
        sourceTrust: 'agent_inferred',
      });
      const inactiveReplacementSuccessor = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'preference',
        content: 'The intermediate preference changed.',
        sourceTrust: 'user_stated',
      });
      assert.ok(await supersedeAgentMemory({
        userId,
        memoryId: inactiveReplacement.id,
        supersededById: inactiveReplacementSuccessor.id,
      }));
      assert.equal(await supersedeAgentMemory({
        userId,
        memoryId: first.id,
        supersededById: inactiveReplacement.id,
      }), null, 'a superseded replacement must not be accepted');

      assert.ok(await supersedeAgentMemory({
        userId,
        memoryId: first.id,
        supersededById: replacement.id,
      }));
      const unchangedSupersession = await pool.query(
        `update agent_memories
         set superseded_by = $2, updated_at = now()
         where id = $1
         returning id`,
        [first.id, replacement.id],
      );
      assert.equal(unchangedSupersession.rowCount, 1,
        'writing the existing supersession value must remain a legal no-op');
      const afterSupersede = (await listRecallableAgentMemories({
        userId,
        projectSpaceId,
        agentId: parentAgentId,
        limit: 20,
      })).map((memory) => memory.id);
      assert.ok(!afterSupersede.includes(first.id), 'a superseded memory must drop out of recall');
      assert.ok(afterSupersede.includes(replacement.id));

      await expectRejected(
        pool.query(
          'update agent_memories set superseded_by = null where id = $1',
          [first.id],
        ),
        'supersession cannot be changed',
      );
      await expectRejected(
        pool.query(
          'update agent_memories set superseded_by = $2 where id = $1',
          [first.id, inactiveReplacementSuccessor.id],
        ),
        'supersession cannot be changed',
      );

      await expectRejected(
        pool.query(
          `update agent_memories
           set scope = 'user', scope_ref_id = null
           where id = $1`,
          [replacement.id],
        ),
        'user and scope are immutable',
      );

      // Direct SQL is guarded too. Pointing the active replacement back at its
      // predecessor would form a two-node cycle.
      await expectRejected(
        pool.query(
          'update agent_memories set superseded_by = $2 where id = $1',
          [replacement.id, first.id],
        ),
        'cannot form a cycle',
      );

      // A referenced replacement may not be physically removed: forget uses a
      // tombstone so the predecessor keeps its supersession link.
      await expectRejected(
        pool.query('delete from agent_memories where id = $1', [replacement.id]),
        'agent_memories_superseded_by_fkey',
      );
      assert.equal(await forgetAgentMemory(userId, replacement.id), replacement.id);
      assert.equal(await forgetAgentMemory(userId, replacement.id), null);
      const afterForget = (await listRecallableAgentMemories({
        userId,
        projectSpaceId,
        agentId: parentAgentId,
        limit: 20,
      })).map((memory) => memory.id);
      assert.ok(!afterForget.includes(first.id), 'forgetting B in A -> B must not revive A');
      assert.ok(!afterForget.includes(replacement.id), 'a forgotten replacement is not recallable');
      const managedIds = (await listAgentMemoriesForUser({
        userId,
        limit: 100,
        offset: 0,
      })).map((memory) => memory.id);
      assert.ok(!managedIds.includes(replacement.id), 'management must hide deletion tombstones');
      const lifecycleRows = await pool.query(
        `select id, content, superseded_by, deleted_at, embedding, embedding_model,
                provenance_run_id, provenance_step_id
         from agent_memories where id = any($1::uuid[])`,
        [[first.id, replacement.id]],
      );
      const persistedFirst = lifecycleRows.rows.find((row) => row.id === first.id);
      const persistedReplacement = lifecycleRows.rows.find((row) => row.id === replacement.id);
      assert.equal(persistedFirst.superseded_by, replacement.id);
      assert.ok(persistedReplacement.deleted_at, 'forget must retain a tombstone');
      assert.equal(persistedReplacement.content, '[deleted]');
      assert.equal(persistedReplacement.embedding, null);
      assert.equal(persistedReplacement.embedding_model, null);
      assert.equal(persistedReplacement.provenance_run_id, null);
      assert.equal(persistedReplacement.provenance_step_id, null);
      await expectRejected(
        pool.query(
          'update agent_memories set deleted_at = null where id = $1',
          [replacement.id],
        ),
        'cannot be restored',
      );
      await expectRejected(
        pool.query(
          "update agent_memories set content = 'restored payload' where id = $1",
          [replacement.id],
        ),
        'agent_memories_deleted_payload_check',
      );
      await expectRejected(
        pool.query(
          `update agent_memories
           set embedding = $2::real[], embedding_model = 'restored-model'
           where id = $1`,
          [replacement.id, [1, 0]],
        ),
        'agent_memories_deleted_payload_check',
      );
      const unchangedTombstone = await pool.query(
        `update agent_memories
         set deleted_at = deleted_at, updated_at = now()
         where id = $1
         returning id`,
        [replacement.id],
      );
      assert.equal(unchangedTombstone.rowCount, 1,
        'a tombstone may be touched without making it restorable');

      const rememberedAgain = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'preference',
        content: 'Prefers imperial units now.',
        sourceTrust: 'user_stated',
        embedding: { vector: [0.25, 0.75], model: 'integration-test' },
      });
      assert.notEqual(rememberedAgain.id, replacement.id,
        'a deleted row must not block remembering the same content again');

      assert.ok(await deleteExpiredAgentMemories() >= 1);
      const purgedExpiry = await pool.query(
        'select content, deleted_at, expires_at from agent_memories where id = $1',
        [expired.id],
      );
      assert.equal(purgedExpiry.rows[0].content, '[deleted]');
      assert.ok(purgedExpiry.rows[0].deleted_at);
      assert.equal(purgedExpiry.rows[0].expires_at, null);

      const cycleLeft = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'decision',
        content: 'Concurrent cycle candidate left.',
        sourceTrust: 'agent_inferred',
      });
      const cycleRight = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'decision',
        content: 'Concurrent cycle candidate right.',
        sourceTrust: 'agent_inferred',
      });
      const cycleOutcomes = await Promise.all([
        supersedeAgentMemory({
          userId,
          memoryId: cycleLeft.id,
          supersededById: cycleRight.id,
        }),
        supersedeAgentMemory({
          userId,
          memoryId: cycleRight.id,
          supersededById: cycleLeft.id,
        }),
      ]);
      assert.equal(cycleOutcomes.filter(Boolean).length, 1,
        'opposite concurrent replacements must have one winner');
      const cycleRows = await pool.query(
        'select id, superseded_by from agent_memories where id = any($1::uuid[])',
        [[cycleLeft.id, cycleRight.id]],
      );
      const cycleLinks = new Map(cycleRows.rows.map((row) => [row.id, row.superseded_by]));
      assert.equal([...cycleLinks.values()].filter(Boolean).length, 1);
      assert.ok(
        (cycleLinks.get(cycleLeft.id) === cycleRight.id
          && cycleLinks.get(cycleRight.id) === null)
        || (cycleLinks.get(cycleRight.id) === cycleLeft.id
          && cycleLinks.get(cycleLeft.id) === null),
        'the committed supersession graph must remain acyclic',
      );

      // The trigger must enforce the same property for callers that bypass the
      // repository. Two explicit backend transactions meet at a row-lock barrier:
      // one becomes the deadlock victim and the other commits, but both must never
      // establish an edge.
      const directCycleLeft = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'decision',
        content: 'Direct SQL cycle candidate left.',
        sourceTrust: 'agent_inferred',
      });
      const directCycleRight = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'decision',
        content: 'Direct SQL cycle candidate right.',
        sourceTrust: 'agent_inferred',
      });
      assert.ok((pool.options?.max ?? 0) >= 2,
        'direct SQL cycle integration requires two PostgreSQL backends');
      const [directLeftClient, directRightClient] = await Promise.all([
        pool.connect(),
        pool.connect(),
      ]);
      let directCycleOutcomes;
      try {
        const backendIds = await Promise.all([
          directLeftClient.query('select pg_backend_pid() as id'),
          directRightClient.query('select pg_backend_pid() as id'),
        ]);
        assert.notEqual(backendIds[0].rows[0].id, backendIds[1].rows[0].id);
        await Promise.all([
          directLeftClient.query('begin'),
          directRightClient.query('begin'),
        ]);
        // Establish a deterministic barrier with the same row-lock mode used by
        // an UPDATE that does not change a key. FOR KEY SHARE is compatible with
        // these locks and would let both edges commit; FOR UPDATE must deadlock
        // one transaction, whose complete rollback releases the winner.
        await Promise.all([
          directLeftClient.query(
            'select id from agent_memories where id = $1 for no key update',
            [directCycleLeft.id],
          ),
          directRightClient.query(
            'select id from agent_memories where id = $1 for no key update',
            [directCycleRight.id],
          ),
        ]);
        const establishEdge = async (client, sourceId, replacementId) => {
          try {
            const result = await client.query(
              'update agent_memories set superseded_by = $2 where id = $1 returning id',
              [sourceId, replacementId],
            );
            await client.query('commit');
            return { status: 'fulfilled', result };
          } catch (error) {
            await client.query('rollback');
            return { status: 'rejected', error };
          }
        };
        directCycleOutcomes = await Promise.all([
          establishEdge(directLeftClient, directCycleLeft.id, directCycleRight.id),
          establishEdge(directRightClient, directCycleRight.id, directCycleLeft.id),
        ]);
      } finally {
        await Promise.allSettled([
          directLeftClient.query('rollback'),
          directRightClient.query('rollback'),
        ]);
        directLeftClient.release();
        directRightClient.release();
      }
      assert.equal(
        directCycleOutcomes.filter((outcome) => outcome.status === 'fulfilled').length,
        1,
        'the database trigger must allow only one direct-SQL cycle edge',
      );
      const fulfilledDirectCycle = directCycleOutcomes.find(
        (outcome) => outcome.status === 'fulfilled',
      );
      assert.equal(fulfilledDirectCycle?.result?.rowCount, 1);
      const rejectedDirectCycle = directCycleOutcomes.find(
        (outcome) => outcome.status === 'rejected',
      );
      assert.equal(rejectedDirectCycle?.error?.code, '40P01',
        'the losing transaction must be the deadlock victim, not an unrelated failure');
      const persistedDirectCycle = await pool.query(
        'select id, superseded_by from agent_memories where id = any($1::uuid[])',
        [[directCycleLeft.id, directCycleRight.id]],
      );
      const directCycleLinks = new Map(
        persistedDirectCycle.rows.map((row) => [row.id, row.superseded_by]),
      );
      assert.equal([...directCycleLinks.values()].filter(Boolean).length, 1);
      const reverseEdge = directCycleLinks.get(directCycleLeft.id)
        ? [directCycleRight.id, directCycleLeft.id]
        : [directCycleLeft.id, directCycleRight.id];
      await expectRejected(
        pool.query(
          'update agent_memories set superseded_by = $2 where id = $1',
          reverseEdge,
        ),
        'cannot form a cycle',
      );

      const sharedSource = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'decision',
        content: 'Concurrent shared source.',
        sourceTrust: 'agent_inferred',
      });
      const possibleSuccessorA = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'decision',
        content: 'Concurrent successor A.',
        sourceTrust: 'agent_inferred',
      });
      const possibleSuccessorB = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'decision',
        content: 'Concurrent successor B.',
        sourceTrust: 'agent_inferred',
      });
      const sharedSourceOutcomes = await Promise.all([
        supersedeAgentMemory({
          userId,
          memoryId: sharedSource.id,
          supersededById: possibleSuccessorA.id,
        }),
        supersedeAgentMemory({
          userId,
          memoryId: sharedSource.id,
          supersededById: possibleSuccessorB.id,
        }),
      ]);
      assert.equal(sharedSourceOutcomes.filter(Boolean).length, 1,
        'one source cannot commit two concurrent replacements');
      const persistedSharedSource = await pool.query(
        'select superseded_by from agent_memories where id = $1',
        [sharedSource.id],
      );
      assert.ok(
        [possibleSuccessorA.id, possibleSuccessorB.id]
          .includes(persistedSharedSource.rows[0].superseded_by),
      );

      // A memory cannot supersede itself, and another user cannot touch it.
      assert.equal(await supersedeAgentMemory({
        userId,
        memoryId: replacement.id,
        supersededById: replacement.id,
      }), null);
      assert.equal(await supersedeAgentMemory({
        userId: otherUserId,
        memoryId: replacement.id,
        supersededById: replacement.id,
      }), null);

      // The self-reference uses NO ACTION rather than RESTRICT so a user-owned
      // cascade can remove the whole graph at statement end.
      const cascadeUserId = randomUUID();
      await insertUser(cascadeUserId, `agent-memory-cascade-${Date.now()}`);
      createdUserIds.push(cascadeUserId);
      const cascadeSource = await upsertAgentMemory({
        userId: cascadeUserId,
        scope: 'project',
        scopeRefId: randomUUID(),
        kind: 'decision',
        content: 'Cascade source.',
        sourceTrust: 'agent_inferred',
      });
      const cascadeReplacement = await upsertAgentMemory({
        userId: cascadeUserId,
        scope: 'project',
        scopeRefId: cascadeSource.scope_ref_id,
        kind: 'decision',
        content: 'Cascade replacement.',
        sourceTrust: 'agent_inferred',
      });
      const cascadeFinal = await upsertAgentMemory({
        userId: cascadeUserId,
        scope: 'project',
        scopeRefId: cascadeSource.scope_ref_id,
        kind: 'decision',
        content: 'Cascade final replacement.',
        sourceTrust: 'user_stated',
      });
      assert.ok(await supersedeAgentMemory({
        userId: cascadeUserId,
        memoryId: cascadeSource.id,
        supersededById: cascadeReplacement.id,
      }));
      assert.ok(await supersedeAgentMemory({
        userId: cascadeUserId,
        memoryId: cascadeReplacement.id,
        supersededById: cascadeFinal.id,
      }));
      assert.equal(
        await forgetAgentMemory(cascadeUserId, cascadeReplacement.id),
        cascadeReplacement.id,
      );
      await pool.query('delete from users where id = $1', [cascadeUserId]);
      const cascadeRows = await pool.query(
        'select count(*)::int as count from agent_memories where user_id = $1',
        [cascadeUserId],
      );
      assert.equal(cascadeRows.rows[0].count, 0,
        'deleting a user must cascade through a supersession graph');

      // Scope invariants are enforced by the schema, not just by the repository.
      await expectRejected(
        pool.query(
          `insert into agent_memories (user_id, scope, scope_ref_id, kind, content, source_trust)
           values ($1, 'project', null, 'fact', 'scoped but subjectless', 'agent_inferred')`,
          [userId],
        ),
        'agent_memories_scope_ref_check',
      );
      await expectRejected(
        pool.query(
          `insert into agent_memories (user_id, scope, kind, content, source_trust)
           values ($1, 'user', 'fact', '', 'agent_inferred')`,
          [userId],
        ),
        'agent_memories_content_check',
      );
    });

    await t.test('Memory governance quarantines untrusted writes and keeps lifecycle audit immutable', async () => {
      const scenario = await createScenario();
      const userId = scenario.userId;
      const sourceRun = await scenario.startRun();
      const candidate = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'fact',
        content: 'A proposed fact that needs review.',
        sourceTrust: 'agent_inferred',
        provenanceRunId: sourceRun.id,
        requireConfirmation: true,
      });
      assert.equal(candidate.status, 'candidate');
      assert.equal(candidate.verification_status, 'unverified');
      assert.equal(candidate.verified_at, null);
      assert.ok(!(await listRecallableAgentMemories({
        userId,
        agentId: scenario.agentIds[0],
        limit: 20,
      })).some((memory) => memory.id === candidate.id));

      // A direct caller cannot self-assert verification for content copied from
      // a tool. The BEFORE trigger rewrites every tool-derived INSERT, not only
      // inserts that happened to use the legacy defaults.
      const directTool = await pool.query(
        `insert into agent_memories (
           user_id, scope, kind, content, source_trust,
           status, verification_status, verified_at
         ) values (
           $1, 'user', 'fact', 'Untrusted direct SQL proposal.', 'tool_derived',
           'confirmed', 'user_confirmed', now()
         )
         returning id, status, verification_status, verified_at`,
        [userId],
      );
      assert.equal(directTool.rows[0].status, 'candidate');
      assert.equal(directTool.rows[0].verification_status, 'unverified');
      assert.equal(directTool.rows[0].verified_at, null);

      const confirmed = await decideAgentMemory({
        userId,
        memoryId: candidate.id,
        decision: 'confirmed',
      });
      assert.equal(confirmed.kind, 'updated');
      assert.equal(confirmed.memory.status, 'confirmed');
      assert.equal(confirmed.memory.verification_status, 'user_confirmed');
      assert.ok(confirmed.memory.verified_at);
      assert.equal((await decideAgentMemory({
        userId,
        memoryId: candidate.id,
        decision: 'confirmed',
      })).kind, 'unchanged', 'replaying the same decision must be idempotent');
      assert.equal((await decideAgentMemory({
        userId,
        memoryId: candidate.id,
        decision: 'rejected',
      })).kind, 'conflict', 'a confirmed Memory cannot be reversed');

      const rejectedCandidate = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'fact',
        content: 'A proposal the user rejects.',
        sourceTrust: 'agent_inferred',
        requireConfirmation: true,
      });
      const rejected = await decideAgentMemory({
        userId,
        memoryId: rejectedCandidate.id,
        decision: 'rejected',
      });
      assert.equal(rejected.kind, 'updated');
      assert.equal(rejected.memory.status, 'rejected');
      assert.equal(rejected.memory.embedding, null);
      assert.equal((await decideAgentMemory({
        userId,
        memoryId: rejectedCandidate.id,
        decision: 'confirmed',
      })).kind, 'conflict');
      await expectRejected(
        pool.query(
          `update agent_memories
           set status = 'confirmed', verification_status = 'user_confirmed'
           where id = $1`,
          [rejectedCandidate.id],
        ),
        'cannot change status',
      );

      const pendingReplacement = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'fact',
        content: 'A replacement that is still pending.',
        sourceTrust: 'agent_inferred',
        requireConfirmation: true,
      });
      assert.equal(await supersedeAgentMemory({
        userId,
        memoryId: candidate.id,
        supersededById: pendingReplacement.id,
      }), null, 'a candidate cannot replace confirmed Memory');
      await decideAgentMemory({
        userId,
        memoryId: pendingReplacement.id,
        decision: 'confirmed',
      });
      assert.ok(await supersedeAgentMemory({
        userId,
        memoryId: candidate.id,
        supersededById: pendingReplacement.id,
      }));

      const accounted = await recordAgentMemoryRecalls({
        userId,
        memoryIds: [pendingReplacement.id, directTool.rows[0].id],
      });
      assert.deepEqual(accounted, [pendingReplacement.id],
        'only active confirmed Memories are recall-accounted');
      const recallRows = await pool.query(
        `select id, recall_count, last_recalled_at
         from agent_memories where id = any($1::uuid[])`,
        [[pendingReplacement.id, directTool.rows[0].id]],
      );
      const recallById = new Map(recallRows.rows.map((row) => [row.id, row]));
      assert.equal(Number(recallById.get(pendingReplacement.id).recall_count), 1);
      assert.ok(recallById.get(pendingReplacement.id).last_recalled_at);
      assert.equal(Number(recallById.get(directTool.rows[0].id).recall_count), 0);
      assert.equal(recallById.get(directTool.rows[0].id).last_recalled_at, null);

      const trackedRun = await createAgentRun({
        userId,
        agentId: scenario.agentIds[0],
        agentVersionId: null,
        conversationId: scenario.conversationId,
        userMessageId: null,
        agentVersionSnapshot: {},
        recalledMemoryIds: [pendingReplacement.id],
        budget: defaultRunBudget(),
      });
      const trackedRecall = await pool.query(
        `select count(*)::int as count
         from agent_memory_events
         where memory_id = $1 and event_type = 'recalled' and source_run_id = $2`,
        [pendingReplacement.id, trackedRun.id],
      );
      assert.equal(trackedRecall.rows[0].count, 1,
        'Run creation and its exact recall event must commit together');

      const runCountBeforeStale = await pool.query(
        'select count(*)::int as count from agent_runs where user_id = $1',
        [userId],
      );
      await assert.rejects(
        () => createAgentRun({
          userId,
          agentId: scenario.agentIds[0],
          agentVersionId: null,
          conversationId: scenario.conversationId,
          userMessageId: null,
          agentVersionSnapshot: {},
          recalledMemoryIds: [directTool.rows[0].id],
          budget: defaultRunBudget(),
        }),
        (error) => error?.message === 'AGENT_MEMORY_RECALL_SNAPSHOT_STALE',
      );
      const runCountAfterStale = await pool.query(
        'select count(*)::int as count from agent_runs where user_id = $1',
        [userId],
      );
      assert.equal(runCountAfterStale.rows[0].count, runCountBeforeStale.rows[0].count,
        'a stale recall snapshot must roll back the whole Run');

      const otherScenario = await createScenario();
      const otherRun = await otherScenario.startRun();
      await expectRejected(
        upsertAgentMemory({
          userId,
          scope: 'user',
          kind: 'fact',
          content: 'Cross-user provenance must fail.',
          sourceTrust: 'agent_inferred',
          provenanceRunId: otherRun.id,
        }),
        'must belong to the Memory owner',
      );
      const sourceStep = await insertAgentStep({
        runId: sourceRun.id,
        sequence: 0,
        kind: 'memory_read',
        status: 'succeeded',
        output: {},
      });
      await expectRejected(
        upsertAgentMemory({
          userId,
          scope: 'user',
          kind: 'fact',
          content: 'Mismatched Step provenance must fail.',
          sourceTrust: 'agent_inferred',
          provenanceRunId: trackedRun.id,
          provenanceStepId: sourceStep.id,
        }),
        'Step must belong to its source Run',
      );

      const auditRows = await pool.query(
        `select
           (select id from agent_memory_events where memory_id = $1 order by id limit 1) as event_id,
           (select id from agent_memory_evidence where memory_id = $1 order by id limit 1) as evidence_id`,
        [candidate.id],
      );
      assert.ok(auditRows.rows[0].event_id);
      assert.ok(auditRows.rows[0].evidence_id);
      await expectRejected(
        pool.query('update agent_memory_events set details = details where id = $1', [
          auditRows.rows[0].event_id,
        ]),
        'append-only',
      );
      await expectRejected(
        pool.query('delete from agent_memory_evidence where id = $1', [
          auditRows.rows[0].evidence_id,
        ]),
        'append-only',
      );

      const cascadeMemory = await upsertAgentMemory({
        userId: otherScenario.userId,
        scope: 'user',
        kind: 'fact',
        content: 'Cascade removes the complete Memory audit graph.',
        sourceTrust: 'agent_inferred',
        provenanceRunId: otherRun.id,
      });
      await pool.query('delete from users where id = $1', [otherScenario.userId]);
      const cascadeAudit = await pool.query(
        `select
           (select count(*)::int from agent_memories where id = $1) as memories,
           (select count(*)::int from agent_memory_events where memory_id = $1) as events,
           (select count(*)::int from agent_memory_evidence where memory_id = $1) as evidence`,
        [cascadeMemory.id],
      );
      assert.deepEqual(cascadeAudit.rows[0], { memories: 0, events: 0, evidence: 0 },
        'a user cascade must be the one legal audit-row deletion path');
    });

    await t.test('Memory scope opt-out serializes recall and enforces hard quotas', async () => {
      const scenario = await createScenario();
      const userId = scenario.userId;
      const memory = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'preference',
        content: 'Use concise answers for scope-control integration tests.',
        sourceTrust: 'user_stated',
      });
      const snapshot = await listRecallableAgentMemories({
        userId,
        agentId: scenario.agentIds[0],
        limit: 20,
      });
      assert.ok(snapshot.some((row) => row.id === memory.id));

      // Hold the recall transaction open after it takes the shared scope lock.
      // The opt-out cannot acknowledge completion until this already-linearized
      // recall commits.
      const recallClient = await pool.connect();
      let recallTransactionOpen = false;
      let disablePromise;
      try {
        await recallClient.query('begin');
        recallTransactionOpen = true;
        assert.deepEqual(await recordAgentMemoryRecallsWithClient(recallClient, {
          userId,
          memoryIds: [memory.id],
        }), [memory.id]);

        let disableSettled = false;
        disablePromise = setAgentMemoryScopeEnabled({
          userId,
          scope: 'user',
          enabled: false,
        }).then((setting) => {
          disableSettled = true;
          return setting;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(disableSettled, false,
          'scope disable must wait for an in-flight recall holding the same lock');

        await recallClient.query('commit');
        recallTransactionOpen = false;
        const disabled = await disablePromise;
        assert.equal(disabled.enabled, false);
      } finally {
        if (recallTransactionOpen) await recallClient.query('rollback');
        recallClient.release();
      }

      const settings = await listAgentMemoryScopeSettings(userId);
      const userSetting = settings.find((setting) => setting.scope === 'user');
      assert.equal(userSetting.enabled, false);
      assert.equal(userSetting.active_memory_count, 1,
        'disabled Memory remains reviewable instead of being silently deleted');
      assert.ok(!(await listRecallableAgentMemories({
        userId,
        agentId: scenario.agentIds[0],
        limit: 20,
      })).some((row) => row.id === memory.id));

      const beforeDisabledRecall = await pool.query(
        'select recall_count from agent_memories where id = $1',
        [memory.id],
      );
      assert.deepEqual(await recordAgentMemoryRecalls({
        userId,
        memoryIds: [memory.id],
      }), [], 'explicit recall accounting must respect a disabled scope');
      const afterDisabledRecall = await pool.query(
        'select recall_count from agent_memories where id = $1',
        [memory.id],
      );
      assert.equal(
        Number(afterDisabledRecall.rows[0].recall_count),
        Number(beforeDisabledRecall.rows[0].recall_count),
      );

      const runCountBeforeStale = await pool.query(
        'select count(*)::int as count from agent_runs where user_id = $1',
        [userId],
      );
      await assert.rejects(
        () => createAgentRun({
          userId,
          agentId: scenario.agentIds[0],
          agentVersionId: null,
          conversationId: scenario.conversationId,
          userMessageId: null,
          agentVersionSnapshot: {},
          recalledMemoryIds: [memory.id],
          budget: defaultRunBudget(),
        }),
        (error) => error?.message === 'AGENT_MEMORY_RECALL_SNAPSHOT_STALE',
      );
      const runCountAfterStale = await pool.query(
        'select count(*)::int as count from agent_runs where user_id = $1',
        [userId],
      );
      assert.equal(runCountAfterStale.rows[0].count, runCountBeforeStale.rows[0].count,
        'a snapshot resolved before opt-out must roll back the complete Run');

      await assert.rejects(
        () => upsertAgentMemory({
          userId,
          scope: 'user',
          kind: 'fact',
          content: 'Repository writes are blocked while the scope is disabled.',
          sourceTrust: 'agent_inferred',
        }),
        (error) => error?.code === 'scope_disabled',
      );
      await expectRejected(
        pool.query(
          `insert into agent_memories (user_id, scope, kind, content, source_trust)
           values ($1, 'user', 'fact', 'Direct SQL is also blocked.', 'agent_inferred')`,
          [userId],
        ),
        'Agent Memory scope is disabled by the user',
      );

      await setAgentMemoryScopeEnabled({ userId, scope: 'user', enabled: true });
      assert.ok((await listRecallableAgentMemories({
        userId,
        agentId: scenario.agentIds[0],
        limit: 20,
      })).some((row) => row.id === memory.id));
      const restoredWrite = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'fact',
        content: 'Writes resume after the user explicitly enables the scope.',
        sourceTrust: 'agent_inferred',
      });
      assert.equal(restoredWrite.scope, 'user');

      const quotaUserId = randomUUID();
      await insertUser(quotaUserId, `agent-memory-quota-${Date.now()}`);
      createdUserIds.push(quotaUserId);
      await pool.query(
        `insert into agent_memory_scope_settings (
           user_id, scope, enabled, max_active_memories
         ) values ($1, 'user', true, 1)`,
        [quotaUserId],
      );
      const quotaAttempts = await Promise.allSettled([
        upsertAgentMemory({
          userId: quotaUserId,
          scope: 'user',
          kind: 'fact',
          content: 'Concurrent quota candidate A.',
          sourceTrust: 'agent_inferred',
        }),
        upsertAgentMemory({
          userId: quotaUserId,
          scope: 'user',
          kind: 'fact',
          content: 'Concurrent quota candidate B.',
          sourceTrust: 'agent_inferred',
        }),
      ]);
      const quotaWinners = quotaAttempts.filter((result) => result.status === 'fulfilled');
      const quotaLosers = quotaAttempts.filter((result) => result.status === 'rejected');
      assert.equal(quotaWinners.length, 1);
      assert.equal(quotaLosers.length, 1);
      assert.equal(quotaLosers[0].reason?.code, 'quota_exceeded');

      const winner = quotaWinners[0].value;
      const duplicate = await upsertAgentMemory({
        userId: quotaUserId,
        scope: 'user',
        kind: winner.kind,
        content: winner.content,
        sourceTrust: 'agent_inferred',
      });
      assert.equal(duplicate.id, winner.id,
        'an exact active duplicate remains an idempotent upsert at the quota');
      const quotaRows = await pool.query(
        `select count(*)::int as count
         from agent_memories
         where user_id = $1 and scope = 'user'
           and status in ('candidate', 'confirmed')
           and superseded_by is null and deleted_at is null`,
        [quotaUserId],
      );
      assert.equal(quotaRows.rows[0].count, 1,
        'concurrent admissions must never exceed the database quota');

      await pool.query('delete from users where id = $1', [quotaUserId]);
      const cascadedSettings = await pool.query(
        'select count(*)::int as count from agent_memory_scope_settings where user_id = $1',
        [quotaUserId],
      );
      assert.equal(cascadedSettings.rows[0].count, 0,
        'scope settings must follow the user ownership cascade');
    });

    await t.test('Memory embedding jobs are confirmation-gated, recoverable and lease fenced', async () => {
      const scenario = await createScenario();
      const userId = scenario.userId;
      const candidate = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'preference',
        content: 'Candidate content must not leave PostgreSQL before confirmation.',
        sourceTrust: 'agent_inferred',
        requireConfirmation: true,
      });
      assert.equal(candidate.status, 'candidate');
      assert.equal((await pool.query(
        'select count(*)::int as count from agent_memory_embedding_jobs where memory_id = $1',
        [candidate.id],
      )).rows[0].count, 0, 'candidate Memory must not create provider work');

      await decideAgentMemory({
        userId,
        memoryId: candidate.id,
        decision: 'confirmed',
      });
      assert.equal((await pool.query(
        'select status from agent_memory_embedding_jobs where memory_id = $1',
        [candidate.id],
      )).rows[0].status, 'queued');

      const privacyClaim = await claimAgentMemoryEmbeddingJobById({
        memoryId: candidate.id,
        workerId: 'privacy-worker',
        leaseDurationMs: 30_000,
        maxAttempts: 5,
      });
      assert.equal(privacyClaim.content, candidate.content,
        'content is loaded only after a PostgreSQL claim, never copied into BullMQ');
      await setAgentMemoryScopeEnabled({ userId, scope: 'user', enabled: false });
      assert.equal((await pool.query(
        'select status from agent_memory_embedding_jobs where memory_id = $1',
        [candidate.id],
      )).rows[0].status, 'cancelled');
      assert.equal(await completeAgentMemoryEmbeddingJob({
        memoryId: candidate.id,
        userId,
        workerId: privacyClaim.worker_id,
        leaseToken: privacyClaim.lease_token,
        embedding: { vector: [0.1, 0.9], model: 'privacy-stale-model' },
      }), false, 'scope opt-out must fence an already-running provider response');

      await setAgentMemoryScopeEnabled({ userId, scope: 'user', enabled: true });
      const firstOwner = await claimAgentMemoryEmbeddingJobById({
        memoryId: candidate.id,
        workerId: 'expired-worker',
        leaseDurationMs: 50,
        maxAttempts: 5,
      });
      assert.ok(firstOwner);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const secondOwner = await claimAgentMemoryEmbeddingJobById({
        memoryId: candidate.id,
        workerId: 'recovery-worker',
        leaseDurationMs: 30_000,
        maxAttempts: 5,
      });
      assert.ok(secondOwner);
      assert.notEqual(secondOwner.lease_token, firstOwner.lease_token);
      assert.equal(await completeAgentMemoryEmbeddingJob({
        memoryId: candidate.id,
        userId,
        workerId: firstOwner.worker_id,
        leaseToken: firstOwner.lease_token,
        embedding: { vector: [1, 0], model: 'stale-model' },
      }), false, 'an expired owner cannot overwrite its replacement');
      assert.equal(await completeAgentMemoryEmbeddingJob({
        memoryId: candidate.id,
        userId,
        workerId: secondOwner.worker_id,
        leaseToken: secondOwner.lease_token,
        embedding: { vector: [0, 1], model: 'current-model' },
      }), true);
      const completed = (await pool.query(
        `select memory.embedding, memory.embedding_model, job.status, job.completed_at
         from agent_memories memory
         join agent_memory_embedding_jobs job on job.memory_id = memory.id
         where memory.id = $1`,
        [candidate.id],
      )).rows[0];
      assert.deepEqual(completed.embedding, [0, 1]);
      assert.equal(completed.embedding_model, 'current-model');
      assert.equal(completed.status, 'completed');
      assert.ok(completed.completed_at);

      const source = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'fact',
        content: 'This fact will be replaced before its vector returns.',
        sourceTrust: 'user_stated',
      });
      const sourceClaim = await claimAgentMemoryEmbeddingJobById({
        memoryId: source.id,
        workerId: 'superseded-worker',
        leaseDurationMs: 30_000,
        maxAttempts: 5,
      });
      const replacement = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'fact',
        content: 'This is the current replacement fact.',
        sourceTrust: 'user_stated',
      });
      assert.ok(await supersedeAgentMemory({
        userId,
        memoryId: source.id,
        supersededById: replacement.id,
      }));
      assert.equal(await completeAgentMemoryEmbeddingJob({
        memoryId: source.id,
        userId,
        workerId: sourceClaim.worker_id,
        leaseToken: sourceClaim.lease_token,
        embedding: { vector: [1, 0], model: 'superseded-model' },
      }), false);
      assert.equal((await pool.query(
        'select status from agent_memory_embedding_jobs where memory_id = $1',
        [source.id],
      )).rows[0].status, 'cancelled');

      const forgotten = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'decision',
        content: 'This decision is forgotten while its embedding is running.',
        sourceTrust: 'user_stated',
      });
      const forgottenClaim = await claimAgentMemoryEmbeddingJobById({
        memoryId: forgotten.id,
        workerId: 'forgotten-worker',
        leaseDurationMs: 30_000,
        maxAttempts: 5,
      });
      assert.equal(await forgetAgentMemory(userId, forgotten.id), forgotten.id);
      assert.equal(await completeAgentMemoryEmbeddingJob({
        memoryId: forgotten.id,
        userId,
        workerId: forgottenClaim.worker_id,
        leaseToken: forgottenClaim.lease_token,
        embedding: { vector: [1, 0], model: 'forgotten-model' },
      }), false);

      const expiring = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'fact',
        content: 'Natural expiry is reconciled even after Redis loses its wake-up.',
        sourceTrust: 'user_stated',
        expiresAt: new Date(Date.now() + 100),
      });
      const expiringClaim = await claimAgentMemoryEmbeddingJobById({
        memoryId: expiring.id,
        workerId: 'expired-without-redis-worker',
        leaseDurationMs: 30_000,
        maxAttempts: 5,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.ok(await reconcileInactiveAgentMemoryEmbeddingJobs() >= 1);
      assert.equal((await pool.query(
        'select status from agent_memory_embedding_jobs where memory_id = $1',
        [expiring.id],
      )).rows[0].status, 'cancelled');
      assert.equal(await completeAgentMemoryEmbeddingJob({
        memoryId: expiring.id,
        userId,
        workerId: expiringClaim.worker_id,
        leaseToken: expiringClaim.lease_token,
        embedding: { vector: [1, 0], model: 'expired-model' },
      }), false);

      const exhausted = await upsertAgentMemory({
        userId,
        scope: 'user',
        kind: 'fact',
        content: 'A provider failure exhausts the configured retry budget.',
        sourceTrust: 'user_stated',
      });
      const exhaustedClaim = await claimAgentMemoryEmbeddingJobById({
        memoryId: exhausted.id,
        workerId: 'failing-worker',
        leaseDurationMs: 30_000,
        maxAttempts: 1,
      });
      const failed = await failAgentMemoryEmbeddingAttempt({
        memoryId: exhausted.id,
        userId,
        workerId: exhaustedClaim.worker_id,
        leaseToken: exhaustedClaim.lease_token,
        maxAttempts: 1,
        retryBaseDelayMs: 1_000,
        errorCode: 'embedding_provider_unavailable',
      });
      assert.equal(failed.status, 'failed');
      assert.ok(failed.completed_at);
    });

    await t.test('conversation summaries persist exact watermarks and serialize message erasure', async () => {
      const scenario = await createScenario();
      const inserted = await pool.query(
        `insert into messages (conversation_id, role, content, created_at)
         values
           ($1, 'user', 'oldest retained fact', now() - interval '5 seconds'),
           ($1, 'assistant', 'older response', now() - interval '4 seconds'),
           ($1, 'user', 'middle fact', now() - interval '3 seconds'),
           ($1, 'assistant', 'recent response', now() - interval '2 seconds'),
           ($1, 'user', 'latest question', now() - interval '1 second')
         returning id, content, created_at`,
        [scenario.conversationId],
      );
      const first = await resolveAgentConversationContext({
        conversationId: scenario.conversationId,
        userId: scenario.userId,
        recentLimit: 2,
        summaryMaxTokens: 128,
      });
      assert.equal(first.recentNewestFirst.length, 2);
      assert.ok(first.summary.content.includes('oldest retained fact'));
      assert.equal(first.summary.watermarkMessageId, inserted.rows[2].id);
      assert.equal(first.summary.candidateMessageCount, 3);
      assert.equal(first.summary.omittedMessageCount, 0);
      assert.equal(first.summary.revision, 1);

      const replay = await resolveAgentConversationContext({
        conversationId: scenario.conversationId,
        userId: scenario.userId,
        recentLimit: 2,
        summaryMaxTokens: 128,
      });
      assert.equal(replay.summary.revision, 1, 'same watermark and budget must reuse the snapshot');

      await pool.query(
        `insert into messages (conversation_id, role, content, created_at)
         values ($1, 'user', 'late imported older fact', now() - interval '6 seconds')`,
        [scenario.conversationId],
      );
      const imported = await resolveAgentConversationContext({
        conversationId: scenario.conversationId,
        userId: scenario.userId,
        recentLimit: 2,
        summaryMaxTokens: 128,
      });
      assert.equal(imported.summary.watermarkMessageId, inserted.rows[2].id);
      assert.equal(imported.summary.candidateMessageCount, 4);
      assert.equal(imported.summary.revision, 2, 'a changed candidate set must not reuse the watermark alone');

      const foreignScenario = await createScenario();
      const foreignMessage = await pool.query(
        `insert into messages (conversation_id, role, content)
         values ($1, 'user', 'foreign watermark') returning id`,
        [foreignScenario.conversationId],
      );
      await assert.rejects(
        pool.query(
          `update agent_conversation_summaries
           set watermark_message_id = $2
           where conversation_id = $1`,
          [scenario.conversationId, foreignMessage.rows[0].id],
        ),
        (error) => error?.constraint === 'agent_conversation_summaries_watermark_scope_check',
      );

      await pool.query('update messages set content = $2 where id = $1', [
        inserted.rows[0].id,
        'edited oldest fact',
      ]);
      const invalidated = await pool.query(
        `select summary, watermark_message_id, included_message_count,
                candidate_message_count, revision
         from agent_conversation_summaries where conversation_id = $1`,
        [scenario.conversationId],
      );
      assert.equal(invalidated.rows[0].summary, '');
      assert.equal(invalidated.rows[0].watermark_message_id, null);
      assert.equal(invalidated.rows[0].included_message_count, 0);
      assert.equal(invalidated.rows[0].candidate_message_count, 0);
      assert.equal(invalidated.rows[0].revision, 3);

      const rebuilt = await resolveAgentConversationContext({
        conversationId: scenario.conversationId,
        userId: scenario.userId,
        recentLimit: 2,
        summaryMaxTokens: 128,
      });
      assert.equal(rebuilt.summary.revision, 4);
      assert.match(rebuilt.summary.content, /edited oldest fact/);
      assert.doesNotMatch(rebuilt.summary.content, /oldest retained fact/);

      const lockClient = await pool.connect();
      let transactionOpen = false;
      try {
        await lockClient.query('begin');
        transactionOpen = true;
        await lockClient.query(
          `select pg_advisory_xact_lock(
             hashtextextended('agent-conversation-summary:' || $1::text, 0)
           )`,
          [scenario.conversationId],
        );
        let deletionSettled = false;
        const deletion = pool.query('delete from messages where id = $1', [
          inserted.rows[1].id,
        ]).then(() => { deletionSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(deletionSettled, false, 'covered-message deletion must take the summary lock');
        await lockClient.query('commit');
        transactionOpen = false;
        await deletion;
      } finally {
        if (transactionOpen) await lockClient.query('rollback');
        lockClient.release();
      }
      assert.equal((await pool.query(
        'select watermark_message_id from agent_conversation_summaries where conversation_id = $1',
        [scenario.conversationId],
      )).rows[0].watermark_message_id, null);
    });

    await t.test('a subagent fan-out does not exhaust the active-run quota', async () => {
      const quotaUserId = randomUUID();
      await insertUser(quotaUserId, `agent-quota-${Date.now()}`);
      const quotaConversationId = randomUUID();
      await pool.query(
        'insert into conversations (id, user_id, title) values ($1, $2, $3)',
        [quotaConversationId, quotaUserId, 'quota'],
      );
      const quotaAgentId = randomUUID();
      await insertAgent(quotaAgentId, 'quota agent', quotaUserId);

      // The ceiling comes from AGENT_MAX_ACTIVE_RUNS_PER_USER, so fill it exactly.
      const activeLimit = Number(process.env.AGENT_MAX_ACTIVE_RUNS_PER_USER || 3);
      const roots = [];
      for (let index = 0; index < activeLimit; index += 1) {
        roots.push(await createAgentRun({
          userId: quotaUserId,
          agentId: quotaAgentId,
          agentVersionId: null,
          conversationId: quotaConversationId,
          userMessageId: null,
          agentVersionSnapshot: {},
          budget: defaultRunBudget(),
        }));
      }
      const root = roots[0];

      // Children beyond the quota. Counting descendants against it would make a
      // fan-out impossible for every user.
      for (let index = 0; index < 3; index += 1) {
        const childAgentId = randomUUID();
        await insertAgent(childAgentId, `quota child ${index}`, quotaUserId);
        const child = await createSubagentRun({
          userId: quotaUserId,
          agentId: childAgentId,
          agentVersionId: null,
          parentRunId: root.id,
          parentToolCallId: `call-${index}`,
          agentVersionSnapshot: {},
          maxDepth: 3,
        });
        assert.equal(child.depth, 1);
      }

      // A second root run is still refused, because that is what the quota is for.
      await expectRejected(
        createAgentRun({
          userId: quotaUserId,
          agentId: quotaAgentId,
          agentVersionId: null,
          conversationId: quotaConversationId,
          userMessageId: null,
          agentVersionSnapshot: {},
          budget: defaultRunBudget(),
        }),
        'AGENT_ACTIVE_RUN_LIMIT',
      );

      await pool.query('delete from users where id = $1', [quotaUserId]);
    });
    await t.test('a dispatched run is queued and claimed exactly once', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: 'call-queue',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });

      // Written as durable work, not started in place.
      assert.equal(child.status, 'queued');
      assert.ok(child.queued_at, 'a queued child records when it was enqueued');

      // Two claimers race for the same row; exactly one may win.
      const [first, second] = await Promise.all([
        claimQueuedSubagentRun({ runId: child.id, leaseDurationMs: 60_000 }),
        claimQueuedSubagentRun({ runId: child.id, leaseDurationMs: 60_000 }),
      ]);
      const winners = [first, second].filter(Boolean);
      assert.equal(winners.length, 1, 'a queued run must be claimed exactly once');
      assert.equal(winners[0].status, 'running');
      assert.ok(winners[0].lease_token);
      assert.ok(winners[0].lease_expires_at);

      // Renewal is scoped to the holder's token.
      assert.ok(await renewSubagentRunLease({
        runId: child.id,
        leaseToken: winners[0].lease_token,
        leaseDurationMs: 60_000,
      }));
      assert.equal(await renewSubagentRunLease({
        runId: child.id,
        leaseToken: randomUUID(),
        leaseDurationMs: 60_000,
      }), null, 'a stale worker must not be able to extend the lease');

      assert.equal(
        await releaseSubagentRunLease({ runId: child.id, leaseToken: winners[0].lease_token }),
        false,
        'a live worker may not release its lease and leave a running orphan',
      );
      assert.equal(await finalizeClaimedSubagentRun({
        runId: child.id,
        leaseToken: randomUUID(),
        status: 'succeeded',
        iterationCount: 1,
        toolCallCount: 0,
      }), null, 'a stale fencing token cannot submit an outcome');
      const finalized = await finalizeClaimedSubagentRun({
        runId: child.id,
        leaseToken: winners[0].lease_token,
        status: 'succeeded',
        iterationCount: 1,
        toolCallCount: 0,
        assistant: { sequence: 0, content: 'durable answer' },
      });
      assert.ok(finalized);
      const released = await pool.query(
        'select status, lease_token, lease_expires_at from agent_runs where id = $1',
        [child.id],
      );
      assert.equal(released.rows[0].status, 'succeeded');
      assert.equal(released.rows[0].lease_token, null);
      assert.equal(released.rows[0].lease_expires_at, null);
      assert.equal(await renewSubagentRunLease({
        runId: child.id,
        leaseToken: winners[0].lease_token,
        leaseDurationMs: 60_000,
      }), null, 'a terminal run cannot be renewed');
    });

    await t.test('checkpoints reject stale generations, users and delegated leases', async () => {
      const scenario = await createScenario();
      const root = await scenario.startRun();
      const rootClaim = await claimAgentWorkItemForRun({
        runId: root.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(rootClaim);
      const first = await saveAgentRunCheckpoint({
        runId: root.id,
        userId: scenario.userId,
        expectedGeneration: 0,
        leaseToken: rootClaim.lease_token,
        boundary: 'model_ready',
        payload: { next_sequence: 1 },
      });
      assert.equal(first.generation, 1);
      assert.equal(
        await saveAgentRunCheckpoint({
          runId: root.id,
          userId: otherUserId,
          expectedGeneration: 1,
          leaseToken: rootClaim.lease_token,
          boundary: 'model_ready',
          payload: { forbidden: true },
        }),
        null,
      );

      const concurrent = await Promise.all([
        saveAgentRunCheckpoint({
          runId: root.id,
          userId: scenario.userId,
          expectedGeneration: 1,
          leaseToken: rootClaim.lease_token,
          boundary: 'tool_batch_ready',
          payload: { writer: 'left' },
        }),
        saveAgentRunCheckpoint({
          runId: root.id,
          userId: scenario.userId,
          expectedGeneration: 1,
          leaseToken: rootClaim.lease_token,
          boundary: 'tool_batch_ready',
          payload: { writer: 'right' },
        }),
      ]);
      assert.equal(concurrent.filter(Boolean).length, 1, 'exactly one CAS writer may advance');
      const persisted = await findAgentRunCheckpointForUser(root.id, scenario.userId);
      assert.equal(persisted.generation, 2);

      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: root.id,
        parentToolCallId: 'call-checkpoint',
        agentVersionSnapshot: {},
        workItem: {
          taskIndex: 0,
          payload: { task: 'checkpoint child', bounded_context: {} },
        },
        maxDepth: 3,
      });
      const claim = await claimAgentWorkItemForRun({ runId: child.id, leaseDurationMs: 60_000 });
      assert.ok(claim);
      assert.equal(await saveAgentRunCheckpoint({
        runId: child.id,
        userId: scenario.userId,
        expectedGeneration: 0,
        leaseToken: randomUUID(),
        boundary: 'model_ready',
        payload: {},
      }), null, 'a stale delegated worker cannot create a checkpoint');
      const childCheckpoint = await saveAgentRunCheckpoint({
        runId: child.id,
        userId: scenario.userId,
        expectedGeneration: 0,
        leaseToken: claim.lease_token,
        boundary: 'model_ready',
        payload: { next_sequence: 0 },
      });
      assert.equal(childCheckpoint.owner_lease_token, claim.lease_token);

      const oversizedRoot = await scenario.startRun(scenario.agentIds[2]);
      await expectRejected(
        pool.query(
          `insert into agent_run_checkpoints (
             run_id, root_run_id, generation, format_version, boundary, payload
           ) values ($1, $1, 1, 1, 'model_ready', jsonb_build_object('x', repeat('x', 262145)))`,
          [oversizedRoot.id],
        ),
        'agent_run_checkpoints_payload_size_check',
      );
    });

    await t.test('work item claim generation fences stale workers and rebuilds queued delivery', async () => {
      const scenario = await createScenario();
      const root = await scenario.startRun();
      const placeholder = await pool.query(
        `select run.assistant_message_id, message.content,
                (select count(*)::int from messages
                 where conversation_id = run.conversation_id and role = 'assistant') as assistant_count
         from agent_runs run
         join messages message on message.id = run.assistant_message_id
         where run.id = $1`,
        [root.id],
      );
      assert.equal(placeholder.rows[0].content, '');
      assert.equal(placeholder.rows[0].assistant_count, 1);
      const queuedIds = await listQueuedAgentWorkItemIds(1000);
      assert.ok(queuedIds.includes(
        (await pool.query('select id from agent_work_items where run_id = $1', [root.id])).rows[0].id,
      ), 'a lost queue message can be rebuilt from the PostgreSQL queued row');

      const [left, right] = await Promise.all([
        claimAgentWorkItemForRun({ runId: root.id, leaseDurationMs: 60_000 }),
        claimAgentWorkItemForRun({ runId: root.id, leaseDurationMs: 60_000 }),
      ]);
      const claims = [left, right].filter(Boolean);
      assert.equal(claims.length, 1, 'only one concurrent worker may claim a work item');
      const claim = claims[0];
      assert.equal(claim.attempt_count, 1);
      assert.equal(claim.fencing_generation, 1);
      assert.equal(await renewAgentWorkItemClaim({
        workItemId: claim.id,
        leaseToken: randomUUID(),
        fencingGeneration: claim.fencing_generation,
        leaseDurationMs: 60_000,
      }), null, 'a stale lease token cannot extend ownership');
      assert.equal(await renewAgentWorkItemClaim({
        workItemId: claim.id,
        leaseToken: claim.lease_token,
        fencingGeneration: claim.fencing_generation + 1,
        leaseDurationMs: 60_000,
      }), null, 'a stale generation cannot extend ownership');
      assert.ok(await renewAgentWorkItemClaim({
        workItemId: claim.id,
        leaseToken: claim.lease_token,
        fencingGeneration: claim.fencing_generation,
        leaseDurationMs: 60_000,
      }));
      const staleCompletion = await completeAgentRunForUser({
        runId: root.id,
        userId: scenario.userId,
        content: 'stale answer',
        sources: [],
        assistantStepSequence: 0,
        iterationCount: 1,
        toolCallCount: 0,
        tokenUsage: {},
        workItemLeaseToken: randomUUID(),
        workItemFencingGeneration: claim.fencing_generation,
      });
      assert.equal(staleCompletion, null, 'a stale worker cannot submit a final answer');
      assert.deepEqual((await pool.query(
        `select id, content from messages
         where conversation_id = $1 and role = 'assistant' order by id`,
        [scenario.conversationId],
      )).rows, [{
        id: placeholder.rows[0].assistant_message_id,
        content: '',
      }], 'a rejected stale finalization must not mutate or duplicate the placeholder');
      const completed = await completeAgentRunForUser({
        runId: root.id,
        userId: scenario.userId,
        content: 'owned answer',
        sources: [],
        assistantStepSequence: 0,
        iterationCount: 1,
        toolCallCount: 0,
        tokenUsage: {},
        workItemLeaseToken: claim.lease_token,
        workItemFencingGeneration: claim.fencing_generation,
      });
      assert.ok(completed);
      assert.equal(completed.assistantMessage.id, placeholder.rows[0].assistant_message_id);
      assert.equal(await completeAgentRunForUser({
        runId: root.id,
        userId: scenario.userId,
        content: 'duplicate answer',
        sources: [],
        assistantStepSequence: 1,
        iterationCount: 2,
        toolCallCount: 0,
        tokenUsage: {},
        workItemLeaseToken: claim.lease_token,
        workItemFencingGeneration: claim.fencing_generation,
      }), null, 'a completed Run cannot be finalized twice by the former owner');
      assert.deepEqual((await pool.query(
        `select id, content from messages
         where conversation_id = $1 and role = 'assistant' order by id`,
        [scenario.conversationId],
      )).rows, [{
        id: placeholder.rows[0].assistant_message_id,
        content: 'owned answer',
      }], 'terminal retries must keep exactly one assistant message');
      const finalized = await pool.query(
        'select status, lease_token from agent_work_items where id = $1',
        [claim.id],
      );
      assert.equal(finalized.rows[0].status, 'succeeded');
      assert.equal(finalized.rows[0].lease_token, null);
    });

    await t.test('a Redis-lost Agent delivery is rebuilt from the queued PostgreSQL Work Item', async () => {
      const scenario = await createScenario();
      const run = await createAgentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[0],
        agentVersionId: null,
        conversationId: scenario.conversationId,
        userMessageId: null,
        agentVersionSnapshot: {},
        workItemPayload: {
          initial_execution: {
            messages: [
              { role: 'system', content: 'durable queue rebuild' },
              { role: 'user', content: 'continue after Redis loss' },
            ],
            deadline_at: Date.now() + 60_000,
            optional_history_count: 0,
          },
        },
        budget: defaultRunBudget(),
      });
      const workItemId = (await pool.query(
        'select id from agent_work_items where run_id = $1',
        [run.id],
      )).rows[0].id;
      const queue = new Queue(AGENT_RECOVERY_QUEUE_NAME, {
        connection: getBullMqConnectionOptions(),
        prefix: BULLMQ_PREFIX,
      });
      const jobId = buildAgentRecoveryQueueJob(workItemId).opts.jobId;
      try {
        await queue.waitUntilReady();
        const firstScan = await dispatchRecoverableAgentWorkItems(queue, 1_000);
        assert.ok(firstScan.includes(workItemId));
        const firstJob = await queue.getJob(jobId);
        assert.ok(firstJob, 'the PostgreSQL row must produce a BullMQ delivery');

        // Removing only the transport record simulates Redis losing the job;
        // the Work Item deliberately remains queued and authoritative.
        await firstJob.remove();
        assert.equal(await queue.getJob(jobId), undefined);
        assert.equal((await pool.query(
          'select status from agent_work_items where id = $1',
          [workItemId],
        )).rows[0].status, 'queued');

        const rebuiltScan = await dispatchRecoverableAgentWorkItems(queue, 1_000);
        assert.ok(rebuiltScan.includes(workItemId));
        const rebuilt = await queue.getJob(jobId);
        assert.ok(rebuilt, 'the next PostgreSQL scan must recreate the lost Redis job');
        assert.deepEqual(rebuilt.data, { workItemId });
        await rebuilt.remove();
      } finally {
        await queue.close();
      }
    });

    await t.test('a claimed subagent keeps fenced ownership while waiting for descendants', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: 'call-waiting-lease',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      const claim = await claimQueuedSubagentRun({ runId: child.id, leaseDurationMs: 60_000 });
      assert.ok(claim);

      assert.equal(await markClaimedSubagentRunWaitingForSubagents({
        runId: child.id,
        leaseToken: randomUUID(),
      }), null, 'a stale token cannot park a claimed Run');
      const waiting = await markClaimedSubagentRunWaitingForSubagents({
        runId: child.id,
        leaseToken: claim.lease_token,
      });
      assert.equal(waiting.status, 'waiting_subagent');
      assert.equal(waiting.lease_token, claim.lease_token);
      assert.ok(waiting.lease_expires_at);

      assert.equal(await resumeClaimedSubagentRunFromSubagents({
        runId: child.id,
        leaseToken: randomUUID(),
      }), null, 'a stale token cannot resume a waiting Run');
      assert.equal(await renewSubagentRunLease({
        runId: child.id,
        leaseToken: randomUUID(),
        leaseDurationMs: 60_000,
      }), null, 'a stale token cannot renew a waiting Run');
      assert.ok(await renewSubagentRunLease({
        runId: child.id,
        leaseToken: claim.lease_token,
        leaseDurationMs: 60_000,
      }), 'the owner keeps renewing while descendants execute');

      const resumed = await resumeClaimedSubagentRunFromSubagents({
        runId: child.id,
        leaseToken: claim.lease_token,
      });
      assert.equal(resumed.status, 'running');
      const finalized = await finalizeClaimedSubagentRun({
        runId: child.id,
        leaseToken: claim.lease_token,
        status: 'succeeded',
        iterationCount: 1,
        toolCallCount: 1,
        assistant: { sequence: 0, content: 'nested work completed' },
      });
      assert.equal(finalized.status, 'succeeded');
      assert.equal(await resumeClaimedSubagentRunFromSubagents({
        runId: child.id,
        leaseToken: claim.lease_token,
      }), null, 'a terminal Run cannot be revived by its former owner');
    });

    await t.test('a lease whose holder died fails the subtask instead of replaying it', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: 'call-lease',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      const claim = await claimQueuedSubagentRun({ runId: child.id, leaseDurationMs: 60_000 });
      assert.ok(claim);
      const grandchild = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[2],
        agentVersionId: null,
        parentRunId: child.id,
        parentToolCallId: 'call-lease-descendant',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      const grandchildClaim = await claimQueuedSubagentRun({
        runId: grandchild.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(grandchildClaim);
      const activeStep = await insertAgentStep({
        runId: child.id,
        sequence: 0,
        kind: 'approval',
        status: 'pending',
        toolCallId: 'call-expiring-write',
        toolKey: 'custom:writer',
        input: {},
        output: { risk_level: 'write' },
      });
      const leaseApprovalIntent = approvalIntentFor();
      const pendingApproval = await createAgentApproval({
        runId: parent.id,
        stepId: activeStep.id,
        userId: scenario.userId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestedByRunId: child.id,
        intent: leaseApprovalIntent.intent,
        intentHash: leaseApprovalIntent.intentHash,
      });

      const waiting = await markClaimedSubagentRunWaitingForSubagents({
        runId: child.id,
        leaseToken: claim.lease_token,
      });
      assert.equal(waiting.status, 'waiting_subagent');

      // Simulate a worker that stopped renewing.
      await pool.query(
        "update agent_runs set lease_expires_at = now() - interval '1 second' where id = $1",
        [child.id],
      );
      const failed = await failExpiredSubagentRunLeases();
      assert.ok(failed.includes(child.id));
      assert.ok(failed.includes(grandchild.id));

      const { rows } = await pool.query(
        'select status, error_code, lease_token from agent_runs where id = $1',
        [child.id],
      );
      // Failed, not re-queued: replaying a child could repeat a side effect it
      // already performed.
      assert.equal(rows[0].status, 'failed');
      assert.equal(rows[0].error_code, 'subagent_lease_expired');
      assert.equal(rows[0].lease_token, null);
      const grandchildState = await pool.query(
        'select status, error_code, lease_token from agent_runs where id = $1',
        [grandchild.id],
      );
      assert.equal(grandchildState.rows[0].status, 'cancelled');
      assert.equal(grandchildState.rows[0].error_code, 'agent_run_parent_ended');
      assert.equal(grandchildState.rows[0].lease_token, null);
      assert.equal(
        (await pool.query('select status from agent_steps where id = $1', [activeStep.id])).rows[0].status,
        'failed',
      );
      assert.equal(
        (await pool.query('select status from agent_approvals where id = $1', [pendingApproval.id])).rows[0].status,
        'expired',
      );
    });

    await t.test('an abandoned queued run can be picked up by another worker', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const child = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: 'call-abandoned',
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      // Too recent to be considered abandoned.
      assert.equal(
        await claimAbandonedSubagentRun({ leaseDurationMs: 60_000, abandonedBeforeMs: 60_000 }),
        null,
      );
      // Backdate it as a process that died right after enqueueing would have left it.
      await pool.query(
        "update agent_runs set queued_at = now() - interval '10 minutes' where id = $1",
        [child.id],
      );
      const claimed = await claimAbandonedSubagentRun({
        leaseDurationMs: 60_000,
        abandonedBeforeMs: 60_000,
      });
      assert.ok(claimed, 'an abandoned queued run must be recoverable');
      assert.equal(claimed.id, child.id);
      assert.equal(claimed.status, 'running');
    });

    await t.test('outcomes are readable from the database by whoever asks', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const toolCallId = 'call-outcomes';

      const succeeded = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[1],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: toolCallId,
        agentVersionSnapshot: {},
        maxDepth: 3,
      });
      const failedChild = await createSubagentRun({
        userId: scenario.userId,
        agentId: scenario.agentIds[2],
        agentVersionId: null,
        parentRunId: parent.id,
        parentToolCallId: toolCallId,
        agentVersionSnapshot: {},
        maxDepth: 3,
      });

      // Still queued: the dispatch is not finished.
      assert.equal(
        areSubagentOutcomesTerminal(await listSubagentOutcomesForToolCall({
          parentRunId: parent.id,
          parentToolCallId: toolCallId,
          userId: scenario.userId,
        })),
        false,
      );

      const successClaim = await claimQueuedSubagentRun({
        runId: succeeded.id,
        leaseDurationMs: 60_000,
      });
      const durableEnvelope = {
        version: 1,
        answer: 'the subtask answer',
        status: 'supported',
        evidence_used: true,
        sources: [{
          file_id: 'file-evidence',
          chunk_id: 'chunk-evidence',
          filename: 'evidence.md',
          similarity: 0.9,
          content: 'the subtask answer is supported here',
        }],
        grounding: { status: 'supported', score: 0.9 },
        insufficient_evidence: false,
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        warnings: [],
      };
      assert.ok(await finalizeClaimedSubagentRun({
        runId: succeeded.id,
        leaseToken: successClaim.lease_token,
        status: 'succeeded',
        iterationCount: 1,
        toolCallCount: 0,
        tokenUsage: durableEnvelope.usage,
        grounding: durableEnvelope.grounding,
        assistant: {
          sequence: 0,
          content: 'the subtask answer',
          output: durableEnvelope,
        },
      }));
      const failureClaim = await claimQueuedSubagentRun({
        runId: failedChild.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(await finalizeClaimedSubagentRun({
        runId: failedChild.id,
        leaseToken: failureClaim.lease_token,
        status: 'failed',
        iterationCount: 1,
        toolCallCount: 0,
        errorCode: 'subagent_failed',
        errorMessage: 'no answer',
      }));

      const outcomes = await listSubagentOutcomesForToolCall({
        parentRunId: parent.id,
        parentToolCallId: toolCallId,
        userId: scenario.userId,
      });
      assert.equal(outcomes.length, 2);
      assert.equal(areSubagentOutcomesTerminal(outcomes), true);

      const answered = outcomes.find((outcome) => outcome.id === succeeded.id);
      // The answer comes from the child's assistant step, since a subagent writes
      // no conversation message.
      assert.equal(answered.answer, 'the subtask answer');
      assert.equal(answered.status, 'succeeded');
      assert.deepEqual(answered.result_envelope, durableEnvelope);
      assert.deepEqual(answered.token_usage, durableEnvelope.usage);
      assert.deepEqual(answered.grounding, durableEnvelope.grounding);

      const broken = outcomes.find((outcome) => outcome.id === failedChild.id);
      assert.equal(broken.status, 'failed');
      assert.equal(broken.error_code, 'subagent_failed');
      assert.equal(broken.answer, null);

      // Another user cannot read this dispatch.
      assert.deepEqual(await listSubagentOutcomesForToolCall({
        parentRunId: parent.id,
        parentToolCallId: toolCallId,
        userId: otherUserId,
      }), []);
    });

    await t.test('a dispatch manifest materializes one crash-stable child batch exactly once', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const claim = await claimAgentWorkItemForRun({
        runId: parent.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(claim);
      const childVersionId = randomUUID();
      await pool.query(
        `insert into agent_versions (
           id, agent_id, version, instructions, model, temperature,
           max_iterations, max_duration_ms, max_output_tokens,
           memory_mode, response_format, output_schema, approval_policy,
           tool_bindings, welcome_message, suggested_prompts
         ) values (
           $1, $2, 1, 'durable child', 'qwen-plus', 0,
           4, 60000, 256, 'none', 'markdown', '{}'::jsonb, 'never',
           '[]'::jsonb, '', '[]'::jsonb
         )`,
        [childVersionId, scenario.agentIds[1]],
      );
      const toolCallId = `dispatch-manifest-${randomUUID()}`;
      const childPayload = {
        task: 'Execute the pinned child task.',
        bounded_context: {},
        project_space_id: null,
        pinned_agent_version: {
          agent_id: scenario.agentIds[1],
          agent_version_id: childVersionId,
          model: 'qwen-plus',
          temperature: 0,
          max_iterations: 4,
          max_output_tokens: 256,
          response_format: 'markdown',
          output_schema: null,
          project_space_id: null,
          tool_bindings: [],
          tool_snapshots: [],
        },
        policy_snapshot: {
          chain: ['never'],
          max_risk_level: 'read',
          approval_scope: 'none',
        },
        delegation: {
          parent_run_id: parent.id,
          root_run_id: parent.root_run_id,
          parent_tool_call_id: toolCallId,
          task_index: 0,
        },
        initial_execution: {
          messages: [
            { role: 'system', content: 'durable child' },
            { role: 'user', content: 'Execute the pinned child task.' },
          ],
          deadline_at: Date.now() + 60_000,
          optional_history_count: 0,
        },
      };
      const plan = {
        formatVersion: 1,
        mode: 'parallel',
        tasks: [{
          kind: 'child',
          taskIndex: 0,
          agentId: scenario.agentIds[1],
          agentVersionId: childVersionId,
          agentVersionSnapshot: childPayload.pinned_agent_version,
          workItemPayload: childPayload,
        }],
      };
      const manifest = await getOrCreateAgentSubagentDispatch({
        workItemId: claim.id,
        workItemLeaseToken: claim.lease_token,
        workItemFencingGeneration: claim.fencing_generation,
        parentRunId: parent.id,
        rootRunId: parent.root_run_id,
        userId: scenario.userId,
        parentToolCallId: toolCallId,
        plan,
      });
      assert.equal(manifest.status, 'planned');
      const checkpoint = createAgentRuntimeCheckpoint({
        phase: 'subagents_wait',
        messages: [
          { role: 'system', content: 'parent' },
          { role: 'user', content: 'delegate' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: toolCallId,
              type: 'function',
              function: { name: 'dispatch_subagents', arguments: '{}' },
            }],
          },
        ],
        counters: { iteration: 1, toolCalls: 1, nextStepSequence: 0 },
        usage: {},
        budget: {
          rootRunId: parent.root_run_id,
          deadlineAt: Date.now() + 60_000,
          degraded: false,
        },
        evidence: {
          evidenceUsed: false,
          insufficientEvidence: false,
          sources: [],
          warnings: [],
        },
        pending: {
          kind: 'subagents',
          toolCallId,
          arguments: { dispatch_manifest_id: manifest.id, format_version: 1 },
        },
      });
      assert.ok(await saveAgentRunCheckpoint({
        runId: parent.id,
        userId: scenario.userId,
        expectedGeneration: 0,
        leaseToken: claim.lease_token,
        boundary: checkpoint.boundary,
        payload: checkpoint.payload,
        stateHash: checkpoint.stateHash,
      }));
      assert.ok(await ensureAgentSubagentDispatchInvocation({
        workItemId: claim.id,
        workItemLeaseToken: claim.lease_token,
        workItemFencingGeneration: claim.fencing_generation,
        runId: parent.id,
        toolCallId,
        toolKey: 'dispatch_subagents',
      }));

      const materialized = await materializeAgentSubagentDispatch({
        dispatchId: manifest.id,
        workItemId: claim.id,
        workItemLeaseToken: claim.lease_token,
        workItemFencingGeneration: claim.fencing_generation,
      });
      assert.equal(materialized.status, 'materialized');
      assert.equal(materialized.expected_child_count, 1);
      const firstCounts = await pool.query(
        `select
           (select count(*)::int from agent_runs
            where parent_run_id = $1 and parent_tool_call_id = $2) as child_count,
           (select count(*)::int from agent_work_items child_work
            join agent_runs child on child.id = child_work.run_id
            where child.parent_run_id = $1 and child.parent_tool_call_id = $2) as work_count,
           (select subagent_dispatch_consumed::int from agent_run_budgets
            where root_run_id = $1) as dispatch_consumed`,
        [parent.id, toolCallId],
      );
      assert.deepEqual(firstCounts.rows[0], {
        child_count: 1,
        work_count: 1,
        dispatch_consumed: 1,
      });

      const retried = await materializeAgentSubagentDispatch({
        dispatchId: manifest.id,
        workItemId: claim.id,
        workItemLeaseToken: claim.lease_token,
        workItemFencingGeneration: claim.fencing_generation,
      });
      assert.equal(retried.expected_child_count, 1);
      const secondCounts = await pool.query(
        `select count(*)::int as child_count
         from agent_runs where parent_run_id = $1 and parent_tool_call_id = $2`,
        [parent.id, toolCallId],
      );
      assert.equal(secondCounts.rows[0].child_count, 1);
      const restored = await findAgentSubagentDispatch({
        parentRunId: parent.id,
        parentToolCallId: toolCallId,
        userId: scenario.userId,
      });
      assert.equal(restored.plan.tasks[0].agentVersionId, childVersionId);
    });

    await t.test('sequential dispatch advances only after each durable child wakes a new parent claim', async () => {
      const scenario = await createScenario();
      const parent = await scenario.startRun();
      const parentClaim = await claimAgentWorkItemForRun({
        runId: parent.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(parentClaim);
      const childVersionIds = [randomUUID(), randomUUID()];
      for (const [index, childVersionId] of childVersionIds.entries()) {
        await pool.query(
          `insert into agent_versions (
             id, agent_id, version, instructions, model, temperature,
             max_iterations, max_duration_ms, max_output_tokens,
             memory_mode, response_format, output_schema, approval_policy,
             tool_bindings, welcome_message, suggested_prompts
           ) values (
             $1, $2, 1, $3, 'qwen-plus', 0,
             4, 60000, 256, 'none', 'markdown', '{}'::jsonb, 'never',
             '[]'::jsonb, '', '[]'::jsonb
           )`,
          [childVersionId, scenario.agentIds[index + 1], `sequential child ${index}`],
        );
      }
      const toolCallId = `dispatch-sequential-${randomUUID()}`;
      const plan = {
        formatVersion: 1,
        mode: 'sequential',
        tasks: childVersionIds.map((agentVersionId, taskIndex) => ({
          kind: 'child',
          taskIndex,
          agentId: scenario.agentIds[taskIndex + 1],
          agentVersionId,
          agentVersionSnapshot: {
            agent_id: scenario.agentIds[taskIndex + 1],
            agent_version_id: agentVersionId,
          },
          workItemPayload: {
            task: `sequential task ${taskIndex}`,
            delegation: {
              parent_run_id: parent.id,
              root_run_id: parent.root_run_id,
              parent_tool_call_id: toolCallId,
              task_index: taskIndex,
            },
          },
        })),
      };
      const manifest = await getOrCreateAgentSubagentDispatch({
        workItemId: parentClaim.id,
        workItemLeaseToken: parentClaim.lease_token,
        workItemFencingGeneration: parentClaim.fencing_generation,
        parentRunId: parent.id,
        rootRunId: parent.root_run_id,
        userId: scenario.userId,
        parentToolCallId: toolCallId,
        plan,
      });
      const checkpoint = createAgentRuntimeCheckpoint({
        phase: 'subagents_wait',
        messages: [
          { role: 'system', content: 'parent' },
          { role: 'user', content: 'run sequential children' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: toolCallId,
              type: 'function',
              function: { name: 'dispatch_subagents', arguments: '{}' },
            }],
          },
        ],
        counters: { iteration: 1, toolCalls: 1, nextStepSequence: 0 },
        usage: {},
        budget: {
          rootRunId: parent.root_run_id,
          deadlineAt: Date.now() + 60_000,
          degraded: false,
        },
        evidence: {
          evidenceUsed: false,
          insufficientEvidence: false,
          sources: [],
          warnings: [],
        },
        pending: {
          kind: 'subagents',
          toolCallId,
          arguments: { dispatch_manifest_id: manifest.id, format_version: 1 },
        },
      });
      assert.ok(await saveAgentRunCheckpoint({
        runId: parent.id,
        userId: scenario.userId,
        expectedGeneration: 0,
        leaseToken: parentClaim.lease_token,
        boundary: checkpoint.boundary,
        payload: checkpoint.payload,
        stateHash: checkpoint.stateHash,
      }));
      assert.ok(await ensureAgentSubagentDispatchInvocation({
        workItemId: parentClaim.id,
        workItemLeaseToken: parentClaim.lease_token,
        workItemFencingGeneration: parentClaim.fencing_generation,
        runId: parent.id,
        toolCallId,
        toolKey: 'dispatch_subagents',
      }));

      const first = await materializeAgentSubagentDispatch({
        dispatchId: manifest.id,
        workItemId: parentClaim.id,
        workItemLeaseToken: parentClaim.lease_token,
        workItemFencingGeneration: parentClaim.fencing_generation,
      });
      assert.equal(first.status, 'materializing');
      assert.equal(first.next_task_index, 1);
      assert.equal(first.created_child_count, 1);

      // Even an accidental duplicate wake/attempt cannot overlap sequential children.
      const premature = await materializeAgentSubagentDispatch({
        dispatchId: manifest.id,
        workItemId: parentClaim.id,
        workItemLeaseToken: parentClaim.lease_token,
        workItemFencingGeneration: parentClaim.fencing_generation,
      });
      assert.equal(premature.next_task_index, 1);
      assert.equal(premature.created_child_count, 1);
      assert.equal((await pool.query(
        'select subagent_dispatch_consumed::int as value from agent_run_budgets where root_run_id = $1',
        [parent.root_run_id],
      )).rows[0].value, 1);

      assert.ok(await markClaimedAgentRunWaitingForSubagents({
        workItemId: parentClaim.id,
        leaseToken: parentClaim.lease_token,
        fencingGeneration: parentClaim.fencing_generation,
        runId: parent.id,
      }));
      assert.ok(await parkAgentWorkItem({
        workItemId: parentClaim.id,
        leaseToken: parentClaim.lease_token,
        fencingGeneration: parentClaim.fencing_generation,
      }));
      const firstChild = (await pool.query(
        `select run.id
         from agent_runs run
         join agent_work_items work on work.run_id = run.id
         where run.parent_run_id = $1 and run.parent_tool_call_id = $2
         order by work.task_index`,
        [parent.id, toolCallId],
      )).rows[0];
      const firstChildClaim = await claimAgentWorkItemForRun({
        runId: firstChild.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(firstChildClaim);
      assert.ok(await finalizeClaimedSubagentRun({
        runId: firstChild.id,
        leaseToken: firstChildClaim.lease_token,
        status: 'failed',
        iterationCount: 1,
        toolCallCount: 0,
        errorCode: 'sequential_test_failure_0',
        errorMessage: 'first sequential test outcome',
      }));

      const secondParentClaim = await claimQueuedAgentWorkItemForRecovery({
        workItemId: parentClaim.id,
        leaseDurationMs: 60_000,
      });
      assert.ok(secondParentClaim);
      assert.ok(secondParentClaim.fencing_generation > parentClaim.fencing_generation);
      const second = await materializeAgentSubagentDispatch({
        dispatchId: manifest.id,
        workItemId: secondParentClaim.id,
        workItemLeaseToken: secondParentClaim.lease_token,
        workItemFencingGeneration: secondParentClaim.fencing_generation,
      });
      assert.equal(second.status, 'materialized');
      assert.equal(second.next_task_index, 2);
      assert.equal(second.created_child_count, 2);
      assert.equal(second.expected_child_count, 2);
      assert.ok(await markClaimedAgentRunWaitingForSubagents({
        workItemId: secondParentClaim.id,
        leaseToken: secondParentClaim.lease_token,
        fencingGeneration: secondParentClaim.fencing_generation,
        runId: parent.id,
      }));
      assert.ok(await parkAgentWorkItem({
        workItemId: secondParentClaim.id,
        leaseToken: secondParentClaim.lease_token,
        fencingGeneration: secondParentClaim.fencing_generation,
      }));
      const children = (await pool.query(
        `select run.id, work.task_index
         from agent_runs run
         join agent_work_items work on work.run_id = run.id
         where run.parent_run_id = $1 and run.parent_tool_call_id = $2
         order by work.task_index`,
        [parent.id, toolCallId],
      )).rows;
      assert.deepEqual(children.map((child) => child.task_index), [0, 1]);
      const secondChildClaim = await claimAgentWorkItemForRun({
        runId: children[1].id,
        leaseDurationMs: 60_000,
      });
      assert.ok(secondChildClaim);
      assert.ok(await finalizeClaimedSubagentRun({
        runId: children[1].id,
        leaseToken: secondChildClaim.lease_token,
        status: 'failed',
        iterationCount: 1,
        toolCallCount: 0,
        errorCode: 'sequential_test_failure_1',
        errorMessage: 'second sequential test outcome',
      }));

      const outcomes = await listSubagentOutcomesForToolCall({
        parentRunId: parent.id,
        parentToolCallId: toolCallId,
        userId: scenario.userId,
      });
      assert.deepEqual(outcomes.map((outcome) => outcome.task_index), [0, 1]);
      assert.deepEqual(outcomes.map((outcome) => outcome.error_code), [
        'sequential_test_failure_0',
        'sequential_test_failure_1',
      ]);
      assert.equal((await pool.query(
        'select subagent_dispatch_consumed::int as value from agent_run_budgets where root_run_id = $1',
        [parent.root_run_id],
      )).rows[0].value, 2);
      assert.ok(await claimQueuedAgentWorkItemForRecovery({
        workItemId: parentClaim.id,
        leaseDurationMs: 60_000,
      }), 'the last sequential child must wake the parent again');
    });

    await t.test('the terminal trigger writes a fallback event that richer outbox data replaces', async () => {
      const scenario = await createScenario();
      const run = await scenario.startRun();
      await pool.query(
        `update agent_runs
         set status = 'failed', completed_at = now(),
             error_code = 'integration_terminal', error_message = 'fallback terminal event'
         where id = $1`,
        [run.id],
      );
      const fallback = await pool.query(
        `select id::text, event_key, payload
         from agent_run_events where run_id = $1 and event_key = 'run.failed'`,
        [run.id],
      );
      assert.equal(fallback.rowCount, 1);
      assert.equal(fallback.rows[0].payload.terminalFallback, true);
      const eventId = fallback.rows[0].id;

      const richer = await appendAgentRunEvent({
        runId: run.id,
        userId: scenario.userId,
        eventKey: 'run.failed',
        payload: {
          agentRunId: run.id,
          agentEvent: {
            type: 'run.failed',
            runId: run.id,
            error: 'richer application event',
          },
        },
      });
      assert.equal(richer.id, eventId);
      assert.equal(richer.payload.terminalFallback, undefined);
      assert.equal(richer.payload.agentEvent.error, 'richer application event');
      const count = await pool.query(
        `select count(*)::int as count from agent_run_events
         where run_id = $1 and event_key = 'run.failed'`,
        [run.id],
      );
      assert.equal(count.rows[0].count, 1);
    });

    await t.test('Agent versions are immutable, hashed, published with evidence, and rolled back by copy', async () => {
      const userId = randomUUID();
      await insertUser(userId, `agent-governance-${Date.now()}`);
      createdUserIds.push(userId);
      const configuration = {
        instructions: 'Answer with verified evidence.',
        model: 'qwen-plus',
        temperature: 0.4,
        max_iterations: 6,
        max_duration_ms: 120000,
        max_output_tokens: 4096,
        memory_mode: 'conversation',
        memory_policy: memoryPolicyFromLegacyMode('conversation'),
        response_format: 'json',
        output_schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
        approval_policy: 'writes',
        tool_bindings: [],
        delegation_mode: 'explicit',
        delegation_bindings: [],
        welcome_message: 'How can I help?',
        suggested_prompts: ['Review this design'],
      };
      const created = await createAgentForUser({
        userId,
        name: 'Governed Agent',
        ...configuration,
      });
      assert.equal(created.version, 1);
      assert.equal(created.change_kind, 'created');
      assert.equal(created.derived_from_version_id, null);
      assert.match(created.configuration_hash, /^[0-9a-f]{64}$/);
      assert.deepEqual(created.memory_policy, memoryPolicyFromLegacyMode('conversation'));

      await assert.rejects(
        () => pool.query(
          'update agent_versions set instructions = $1 where id = $2',
          ['silently mutated', created.current_version_id],
        ),
        (error) => error?.code === '23514'
          && error?.constraint === 'agent_versions_immutable_check',
      );

      const edited = await updateAgentForUser({
        agentId: created.id,
        userId,
        metadata: {},
        version: { instructions: 'Answer with verified evidence and concise citations.' },
        maxVersionsPerAgent: 10,
      });
      assert.equal(edited.version, 2);
      assert.equal(edited.change_kind, 'edited');
      assert.equal(edited.derived_from_version_id, created.current_version_id);
      assert.notEqual(edited.configuration_hash, created.configuration_hash);

      const validationReport = {
        format_version: 1,
        valid: true,
        checks: [
          { key: 'model_capability', status: 'passed', message: 'supported' },
          { key: 'tool_scope', status: 'passed', message: 'in scope' },
        ],
      };
      const published = await publishAgentForUser({
        agentId: created.id,
        userId,
        expectedVersionId: edited.current_version_id,
        releaseNotes: 'Validated citation behavior.',
        validationReport,
      });
      assert.equal(published.published_version_id, edited.current_version_id);
      assert.equal(published.publication.release_notes, 'Validated citation behavior.');
      assert.deepEqual(published.publication.validation_report, validationReport);

      const editedAgain = await updateAgentForUser({
        agentId: created.id,
        userId,
        metadata: {},
        version: { temperature: 0.8 },
        maxVersionsPerAgent: 10,
      });
      assert.equal(editedAgain.version, 3);
      const rolledBack = await rollbackAgentVersionForUser({
        agentId: created.id,
        versionId: created.current_version_id,
        userId,
        maxVersionsPerAgent: 10,
      });
      assert.equal(rolledBack.version, 4);
      assert.equal(rolledBack.change_kind, 'rollback');
      assert.equal(rolledBack.derived_from_version_id, created.current_version_id);
      assert.equal(rolledBack.configuration_hash, created.configuration_hash);
      assert.equal(rolledBack.current_version_id === created.current_version_id, false);
      assert.equal(rolledBack.published_version_id, edited.current_version_id);
      assert.equal(rolledBack.has_unpublished_changes, true);

      const history = await listAgentVersionsForUser(created.id, userId);
      assert.deepEqual(history.map((version) => version.version), [4, 3, 2, 1]);
      assert.equal(history.find((version) => version.version === 2).release_notes, 'Validated citation behavior.');
      assert.equal(history.find((version) => version.version === 4).is_current, true);
      assert.equal(history.find((version) => version.version === 2).is_published, true);

      const customMemoryPolicy = structuredClone(memoryPolicyFromLegacyMode('conversation'));
      customMemoryPolicy.read.top_k = 7;
      const other = await createAgentForUser({
        userId,
        name: 'Other Governed Agent',
        ...configuration,
        memory_mode: 'custom',
        memory_policy: customMemoryPolicy,
      });
      assert.equal(other.memory_mode, 'custom');
      assert.notEqual(other.configuration_hash, created.configuration_hash);
      await assert.rejects(
        () => pool.query(
          `insert into agent_versions (
             agent_id, version, instructions, model, memory_mode, memory_policy
           ) values ($1, 2, 'invalid policy', 'qwen-plus', 'custom', $2::jsonb)`,
          [other.id, JSON.stringify({ format_version: 1 })],
        ),
        (error) => error?.code === '23514'
          && error?.constraint === 'agent_versions_memory_policy_check',
      );
      await assert.rejects(
        () => pool.query(
          `insert into agent_version_publications (
             agent_id, agent_version_id, published_by, validation_report
           ) values ($1, $2, $3, $4::jsonb)`,
          [created.id, other.current_version_id, userId, JSON.stringify(validationReport)],
        ),
        (error) => error?.code === '23503'
          && error?.constraint === 'agent_version_publications_version_agent_fkey',
      );
    });

    await t.test('Agent draft dry-runs pin versions and never attach to production conversations or Runs', async () => {
      const userId = randomUUID();
      await insertUser(userId, `agent-dry-run-${Date.now()}`);
      createdUserIds.push(userId);
      const agent = await createAgentForUser({
        userId,
        name: 'Dry-run Agent',
        instructions: 'Preview safely.',
        model: 'qwen-plus',
        temperature: 0.2,
        max_iterations: 4,
        max_duration_ms: 60000,
        max_output_tokens: 512,
        memory_mode: 'conversation',
        memory_policy: memoryPolicyFromLegacyMode('conversation'),
        response_format: 'markdown',
        output_schema: {},
        approval_policy: 'writes',
        tool_bindings: [],
        delegation_mode: 'explicit',
        delegation_bindings: [],
        welcome_message: '',
        suggested_prompts: [],
      });
      const before = await pool.query(
        `select
           (select count(*)::int from agent_runs where user_id = $1) as run_count,
           (select count(*)::int from messages message
              join conversations conversation on conversation.id = message.conversation_id
              where conversation.user_id = $1) as message_count`,
        [userId],
      );
      const validationReport = {
        format_version: 1,
        valid: true,
        checks: [{ key: 'model_capability', status: 'passed', message: 'supported' }],
      };
      const isolationReport = {
        mode: 'model_only',
        blocked_effects: ['tool_execution', 'conversation_write'],
        omitted_context: ['conversation_history', 'long_term_memory'],
      };
      const dryRun = await createAgentVersionDryRun({
        userId,
        agentId: agent.id,
        agentVersionId: agent.current_version_id,
        inputText: 'Test this immutable draft.',
        validationReport,
        isolationReport,
      });
      assert.equal(dryRun.status, 'running');
      assert.equal(await findAgentVersionDryRunForUser(dryRun.id, otherUserId), null);

      const completed = await completeAgentVersionDryRun({
        dryRunId: dryRun.id,
        userId,
        outputText: 'Preview result',
        plannedToolCalls: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
      assert.equal(completed.status, 'succeeded');
      assert.equal(completed.agent_version_id, agent.current_version_id);
      const listed = await listAgentVersionDryRunsForUser({
        userId,
        agentId: agent.id,
        agentVersionId: agent.current_version_id,
      });
      assert.deepEqual(listed.map((item) => item.id), [dryRun.id]);

      const after = await pool.query(
        `select
           (select count(*)::int from agent_runs where user_id = $1) as run_count,
           (select count(*)::int from messages message
              join conversations conversation on conversation.id = message.conversation_id
              where conversation.user_id = $1) as message_count`,
        [userId],
      );
      assert.deepEqual(after.rows[0], before.rows[0]);

      await assert.rejects(
        () => pool.query(
          `update agent_version_dry_runs
           set usage = '{"prompt_tokens":1.5,"completion_tokens":0,"total_tokens":2}'::jsonb
           where id = $1`,
          [dryRun.id],
        ),
        (error) => error?.code === '23514'
          && error?.constraint === 'agent_version_dry_runs_usage_check',
      );
    });

    await t.test('Agent Eval pins dataset and Agent versions without touching production ledgers', async () => {
      const userId = randomUUID();
      await insertUser(userId, `agent-eval-${Date.now()}`);
      createdUserIds.push(userId);
      const agent = await createAgentForUser({
        userId,
        name: 'Eval Agent',
        instructions: 'Evaluate releases safely.',
        model: 'qwen-plus',
        temperature: 0.2,
        max_iterations: 4,
        max_duration_ms: 60000,
        max_output_tokens: 512,
        memory_mode: 'none',
        memory_policy: memoryPolicyFromLegacyMode('none'),
        response_format: 'markdown',
        output_schema: {},
        approval_policy: 'writes',
        tool_bindings: [],
        delegation_mode: 'explicit',
        delegation_bindings: [],
        welcome_message: '',
        suggested_prompts: [],
      });
      const dataset = await createAgentEvalDatasetForUser({
        userId,
        name: 'Release regression',
        description: 'Pinned Agent release checks',
      });
      const testCase = await createAgentEvalCaseForUser({
        userId,
        datasetId: dataset.id,
        name: 'Safe answer',
        inputText: 'Is release v2 ready?',
        evaluationSpec: { expected_output_contains: ['ready'] },
      });
      const before = await pool.query(
        `select
           (select count(*)::int from agent_runs where user_id = $1) as run_count,
           (select count(*)::int from agent_tool_invocations invocation
             join agent_runs run on run.id = invocation.run_id
             where run.user_id = $1) as invocation_count,
           (select count(*)::int from messages message
             join conversations conversation on conversation.id = message.conversation_id
             where conversation.user_id = $1) as message_count`,
        [userId],
      );
      const evalRun = await createAgentEvalRunForUser({
        userId,
        datasetId: dataset.id,
        agentId: agent.id,
        candidateAgentVersionId: agent.current_version_id,
        candidateConfigurationHash: agent.configuration_hash,
        validationReport: { valid: true, candidate: { valid: true, checks: [] }, baseline: null },
        executionSnapshot: {
          evaluator_version: 'agent-eval-v1',
          tool_mode: 'deterministic_fixture_replay',
          real_tool_execution: false,
        },
      });
      assert.equal(evalRun.status, 'queued');
      assert.equal(evalRun.dataset_revision, 2);
      assert.equal(await getAgentEvalRunForUser(evalRun.id, otherUserId), null);
      const claim = await claimAgentEvalRunJobById({
        runId: evalRun.id,
        workerId: 'postgres-agent-eval-test',
        leaseDurationMs: 60000,
        runTimeoutMs: 120000,
      });
      assert.equal(claim.cases[0].case_id, testCase.id);
      const completed = await completeAgentEvalRun({
        runId: claim.id,
        userId,
        workerId: claim.worker_id,
        leaseToken: claim.lease_token,
        status: 'completed',
        aggregateMetrics: {
          candidate: { overall_score: 1 },
          isolation: { real_tool_execution: false },
        },
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        results: [{
          caseId: testCase.id,
          variant: 'candidate',
          agentId: agent.id,
          agentVersionId: agent.current_version_id,
          configurationHash: agent.configuration_hash,
          status: 'succeeded',
          outputText: 'Release v2 is ready.',
          plannedToolCalls: [],
          metrics: { task_success: 1, overall_score: 1 },
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          latencyMs: 25,
        }],
      });
      assert.equal(completed.status, 'completed');
      const after = await pool.query(
        `select
           (select count(*)::int from agent_runs where user_id = $1) as run_count,
           (select count(*)::int from agent_tool_invocations invocation
             join agent_runs run on run.id = invocation.run_id
             where run.user_id = $1) as invocation_count,
           (select count(*)::int from messages message
             join conversations conversation on conversation.id = message.conversation_id
             where conversation.user_id = $1) as message_count`,
        [userId],
      );
      assert.deepEqual(after.rows[0], before.rows[0]);
      await assert.rejects(
        () => pool.query(
          `update agent_eval_runs
           set candidate_configuration_hash = $2
           where id = $1`,
          [evalRun.id, 'b'.repeat(64)],
        ),
        /Agent eval execution snapshot is immutable/,
      );
      await assert.rejects(
        () => pool.query(
          `update agent_eval_results
           set usage = '{"prompt_tokens":1.5,"completion_tokens":0,"total_tokens":2}'::jsonb
           where run_id = $1`,
          [evalRun.id],
        ),
        (error) => error?.code === '23514'
          && error?.constraint === 'agent_eval_results_usage_check',
      );
    });

    await t.test('explicit delegation pins collaborator versions and protects the live graph lifecycle', async () => {
      const userId = randomUUID();
      await insertUser(userId, `agent-delegation-${Date.now()}`);
      createdUserIds.push(userId);
      const validationReport = {
        format_version: 1,
        valid: true,
        checks: [
          { key: 'delegation_graph', status: 'passed', message: 'validated' },
        ],
      };
      const baseConfiguration = {
        instructions: 'Complete only the assigned task.',
        model: 'qwen-plus',
        temperature: 0.2,
        max_iterations: 4,
        max_duration_ms: 120000,
        max_output_tokens: 2048,
        memory_mode: 'conversation',
        memory_policy: memoryPolicyFromLegacyMode('conversation'),
        response_format: 'markdown',
        output_schema: {},
        approval_policy: 'writes',
        tool_bindings: [],
        delegation_mode: 'explicit',
        delegation_bindings: [],
        welcome_message: '',
        suggested_prompts: [],
      };

      const collaboratorV1 = await createAgentForUser({
        userId,
        name: 'Pinned Collaborator',
        ...baseConfiguration,
      });
      await publishAgentForUser({
        agentId: collaboratorV1.id,
        userId,
        expectedVersionId: collaboratorV1.current_version_id,
        releaseNotes: 'Collaborator v1',
        validationReport,
      });

      const delegationBinding = {
        alias: 'technical_reviewer',
        agent_id: collaboratorV1.id,
        version_policy: 'pinned',
        agent_version_id: collaboratorV1.current_version_id,
        role: 'Review technical risks',
        max_parallelism: 1,
        allowed_context_keys: ['requirements', 'constraints'],
      };
      const parentV1 = await createAgentForUser({
        userId,
        name: 'Delegating Parent',
        ...baseConfiguration,
        instructions: 'Delegate technical review through the configured alias.',
        tool_bindings: [{ key: 'dispatch_subagents', enabled: true }],
        delegation_bindings: [delegationBinding],
      });
      await publishAgentForUser({
        agentId: parentV1.id,
        userId,
        expectedVersionId: parentV1.current_version_id,
        releaseNotes: 'Parent v1',
        validationReport,
      });

      const collaboratorV2 = await updateAgentForUser({
        agentId: collaboratorV1.id,
        userId,
        metadata: {},
        version: { instructions: 'Complete the task using the v2 review rubric.' },
      });
      await publishAgentForUser({
        agentId: collaboratorV1.id,
        userId,
        expectedVersionId: collaboratorV2.current_version_id,
        releaseNotes: 'Collaborator v2',
        validationReport,
      });
      const stillPinned = await findExecutableAgentVersionForUser(
        collaboratorV1.id,
        collaboratorV1.current_version_id,
        userId,
      );
      assert.equal(stillPinned.selected_version_id, collaboratorV1.current_version_id);
      assert.equal(stillPinned.instructions, 'Complete only the assigned task.');
      assert.equal(parentV1.delegation_bindings[0].agent_version_id, collaboratorV1.current_version_id);

      await assert.rejects(
        () => updateAgentForUser({
          agentId: collaboratorV1.id,
          userId,
          metadata: {},
          version: {
            tool_bindings: [{ key: 'dispatch_subagents', enabled: true }],
            delegation_mode: 'explicit',
            delegation_bindings: [{
              alias: 'parent',
              agent_id: parentV1.id,
              version_policy: 'pinned',
              agent_version_id: parentV1.current_version_id,
              role: 'Create a static cycle',
              max_parallelism: 1,
              allowed_context_keys: [],
            }],
          },
        }),
        (error) => error?.message === 'AGENT_DELEGATION_CYCLE',
      );
      await assert.rejects(
        () => setAgentDisabledForUser(collaboratorV1.id, userId, true),
        (error) => error?.message === 'AGENT_DELEGATION_STILL_BOUND',
      );
      await assert.rejects(
        () => deleteAgentForUser(collaboratorV1.id, userId),
        (error) => error?.message === 'AGENT_DELEGATION_STILL_BOUND',
      );
      await assert.rejects(
        () => updateAgentForUser({
          agentId: collaboratorV1.id,
          userId,
          metadata: { project_space_id: randomUUID() },
          version: {},
        }),
        (error) => error?.message === 'AGENT_DELEGATION_BINDING_SCOPE',
      );

      const parentWithoutBinding = await updateAgentForUser({
        agentId: parentV1.id,
        userId,
        metadata: {},
        version: {
          tool_bindings: [],
          delegation_mode: 'explicit',
          delegation_bindings: [],
        },
      });
      await assert.rejects(
        () => setAgentDisabledForUser(collaboratorV1.id, userId, true),
        (error) => error?.message === 'AGENT_DELEGATION_STILL_BOUND',
        'the still-published parent version must keep the collaborator protected',
      );
      await publishAgentForUser({
        agentId: parentV1.id,
        userId,
        expectedVersionId: parentWithoutBinding.current_version_id,
        releaseNotes: 'Remove collaborator',
        validationReport,
      });
      const disabled = await setAgentDisabledForUser(collaboratorV1.id, userId, true);
      assert.equal(disabled.status, 'disabled');
      const reenabled = await setAgentDisabledForUser(collaboratorV1.id, userId, false);
      assert.equal(reenabled.status, 'published');
      assert.equal(await deleteAgentForUser(collaboratorV1.id, userId), true);
      await assert.rejects(
        () => rollbackAgentVersionForUser({
          agentId: parentV1.id,
          versionId: parentV1.current_version_id,
          userId,
        }),
        (error) => error?.message === 'AGENT_DELEGATION_BINDING_UNAVAILABLE',
        'historical bindings do not block deletion but are revalidated before rollback',
      );
    });

    await t.test('custom tool versions pin definitions, credentials, Agent bindings, and Run recovery', async () => {
      const userId = randomUUID();
      await insertUser(userId, `agent-tool-version-${Date.now()}`);
      createdUserIds.push(userId);
      const conversationId = randomUUID();
      await pool.query(
        'insert into conversations (id, user_id, title) values ($1, $2, $3)',
        [conversationId, userId, 'versioned tool recovery'],
      );

      const toolConfiguration = (endpoint) => ({
        endpoint,
        method: 'GET',
        idempotency_mode: 'none',
        timeout_ms: 5000,
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          additionalProperties: false,
        },
        static_headers: {},
        response_path: 'data',
      });
      const firstTool = await createAgentToolForUser({
        userId,
        name: 'Versioned Search',
        description: 'Search the pinned v1 endpoint.',
        kind: 'http',
        riskLevel: 'read',
        maxInvocationsPerRun: 2,
        configuration: toolConfiguration('https://example.com/v1'),
      });
      assert.equal(firstTool.tool_version, 1);
      assert.equal(firstTool.secret_version, 1);
      assert.equal(firstTool.change_kind, 'created');
      assert.match(firstTool.configuration_hash, /^[0-9a-f]{64}$/);

      const agentConfiguration = {
        instructions: 'Use the pinned search tool and report evidence.',
        model: 'qwen-plus',
        temperature: 0.2,
        max_iterations: 4,
        max_duration_ms: 120000,
        max_output_tokens: 2048,
        memory_mode: 'conversation',
        memory_policy: memoryPolicyFromLegacyMode('conversation'),
        response_format: 'markdown',
        output_schema: {},
        approval_policy: 'writes',
        tool_bindings: [{
          key: `custom:${firstTool.id}`,
          enabled: true,
          tool_version_id: firstTool.tool_version_id,
        }],
        delegation_mode: 'explicit',
        delegation_bindings: [],
        welcome_message: '',
        suggested_prompts: [],
      };
      const agent = await createAgentForUser({
        userId,
        name: 'Pinned Tool Agent',
        ...agentConfiguration,
      });
      const originalAgentHash = agent.configuration_hash;

      const pinnedSnapshot = {
        agent_id: agent.id,
        agent_version_id: agent.current_version_id,
        project_space_id: null,
        memory_mode: agent.memory_mode,
        memory_policy: agent.memory_policy,
        tool_bindings: agent.tool_bindings,
        tool_snapshots: [{
          id: firstTool.id,
          name: firstTool.name,
          description: firstTool.description,
          kind: firstTool.kind,
          risk_level: firstTool.risk_level,
          max_invocations_per_run: firstTool.max_invocations_per_run ?? null,
          project_space_id: firstTool.project_space_id ?? null,
          configuration: firstTool.configuration,
          enabled: firstTool.enabled,
          has_secrets: firstTool.has_secrets,
          tool_version_id: firstTool.tool_version_id,
          tool_version: firstTool.tool_version,
          secret_version: firstTool.secret_version,
          configuration_hash: firstTool.configuration_hash,
          updated_at: firstTool.updated_at,
        }],
      };
      const run = await createAgentRun({
        userId,
        agentId: agent.id,
        agentVersionId: agent.current_version_id,
        conversationId,
        userMessageId: null,
        agentVersionSnapshot: pinnedSnapshot,
        budget: defaultRunBudget(),
      });

      const secondVersion = await updateAgentToolForUser(firstTool.id, userId, {
        description: 'Search the current v2 endpoint.',
        configuration: toolConfiguration('https://example.com/v2'),
      });
      assert.equal(secondVersion.tool_version, 2);
      assert.equal(secondVersion.secret_version, 1);
      assert.equal(secondVersion.derived_from_version_id, firstTool.tool_version_id);
      assert.equal(secondVersion.change_kind, 'edited');
      assert.notEqual(secondVersion.configuration_hash, firstTool.configuration_hash);

      const versionsAfterEdit = await listAgentToolVersionsForUser(firstTool.id, userId);
      assert.deepEqual(versionsAfterEdit.map((version) => version.version), [2, 1]);
      assert.equal(versionsAfterEdit[1].description, 'Search the pinned v1 endpoint.');
      assert.equal(versionsAfterEdit[1].configuration.endpoint, 'https://example.com/v1');
      assert.equal(versionsAfterEdit[0].configuration.endpoint, 'https://example.com/v2');
      await assert.rejects(
        () => pool.query(
          'update agent_tool_versions set description = $1 where id = $2',
          ['mutated in place', firstTool.tool_version_id],
        ),
        (error) => error?.code === '23514'
          && error?.constraint === 'agent_tool_versions_immutable_check',
      );

      const restored = await restoreAgentRuntimeToolsForRecovery({
        userId,
        payload: {
          pinned_agent_version: pinnedSnapshot,
          policy_snapshot: {
            chain: ['writes'],
            max_risk_level: 'high',
            approval_scope: 'non_read',
          },
          shared_memory_snapshot: {
            format_version: 1,
            items: [],
            character_count: 0,
          },
        },
      });
      assert.equal(restored.tools.length, 1);
      assert.equal(
        restored.tools[0].definition.function.description,
        'Search the pinned v1 endpoint.',
      );
      const persistedRun = await findAgentRunForUser(run.id, userId);
      assert.equal(
        persistedRun.agent_version_snapshot.tool_snapshots[0].tool_version_id,
        firstTool.tool_version_id,
      );

      const secretVersion = await updateAgentToolForUser(firstTool.id, userId, {
        encrypted_secrets: 'integration-ciphertext-v1',
      });
      assert.equal(secretVersion.tool_version, 3);
      assert.equal(secretVersion.secret_version, 2);
      assert.equal(secretVersion.change_kind, 'secret_rotated');
      assert.notEqual(secretVersion.configuration_hash, secondVersion.configuration_hash);
      const clearedSecretVersion = await updateAgentToolForUser(firstTool.id, userId, {
        encrypted_secrets: null,
      });
      assert.equal(clearedSecretVersion.tool_version, 4);
      assert.equal(clearedSecretVersion.secret_version, 3);
      assert.equal(clearedSecretVersion.has_secrets, false);
      const secretEvents = await pool.query(
        `select id, event_type, secret_version, metadata
         from agent_tool_secret_events
         where user_id = $1 and tool_id = $2
         order by created_at, id`,
        [userId, firstTool.id],
      );
      assert.deepEqual(
        secretEvents.rows.map((event) => [event.event_type, event.secret_version]),
        [['replaced', 2], ['cleared', 3]],
      );
      assert.deepEqual(secretEvents.rows.map((event) => event.metadata), [{}, {}]);
      await assert.rejects(
        () => pool.query(
          'update agent_tool_secret_events set metadata = $1::jsonb where id = $2',
          [JSON.stringify({ tampered: true }), secretEvents.rows[0].id],
        ),
        (error) => error?.code === '23514'
          && error?.constraint === 'agent_tool_secret_events_append_only_check',
      );
      await assert.rejects(
        () => pool.query('delete from agent_tool_secret_events where id = $1', [secretEvents.rows[0].id]),
        (error) => error?.code === '23514'
          && error?.constraint === 'agent_tool_secret_events_append_only_check',
      );

      const otherTool = await createAgentToolForUser({
        userId,
        name: 'Other Versioned Search',
        description: 'A distinct tool.',
        kind: 'http',
        riskLevel: 'read',
        configuration: toolConfiguration('https://example.org/v1'),
      });
      await assert.rejects(
        () => createAgentForUser({
          userId,
          name: 'Mismatched Tool Agent',
          ...agentConfiguration,
          tool_bindings: [{
            key: `custom:${firstTool.id}`,
            enabled: true,
            tool_version_id: otherTool.tool_version_id,
          }],
        }),
        (error) => error?.message === 'AGENT_TOOL_BINDING_UNAVAILABLE',
      );
      await assert.rejects(
        () => pool.query(
          `insert into agent_tool_versions (
             tool_id, version, description, kind, risk_level, configuration,
             derived_from_version_id, change_kind
           ) values ($1, 99, 'cross-tool ancestry', 'http', 'read', $2::jsonb, $3, 'edited')`,
          [
            firstTool.id,
            JSON.stringify(toolConfiguration('https://example.com/invalid')),
            otherTool.tool_version_id,
          ],
        ),
        (error) => error?.code === '23503'
          && error?.constraint === 'agent_tool_versions_derived_from_same_tool_fkey',
      );

      const rebound = await updateAgentForUser({
        agentId: agent.id,
        userId,
        metadata: {},
        version: {
          tool_bindings: [{
            key: `custom:${firstTool.id}`,
            enabled: true,
            tool_version_id: clearedSecretVersion.tool_version_id,
          }],
        },
      });
      assert.notEqual(rebound.configuration_hash, originalAgentHash);
      const history = await listAgentVersionsForUser(agent.id, userId);
      assert.equal(history.find((version) => version.version === 1).tool_bindings[0].tool_version_id, firstTool.tool_version_id);
      assert.equal(history.find((version) => version.version === 2).tool_bindings[0].tool_version_id, clearedSecretVersion.tool_version_id);

      await updateAgentForUser({
        agentId: agent.id,
        userId,
        metadata: {},
        version: { tool_bindings: [] },
      });
      assert.equal(await deleteAgentToolForUser(firstTool.id, userId), true);
      const retainedVersions = await pool.query(
        `select count(*)::int as count
         from agent_tool_versions where tool_id = $1`,
        [firstTool.id],
      );
      assert.equal(retainedVersions.rows[0].count, 4);
      const retainedPinned = await findAgentToolVersionsWithSecretsForUserByIds(
        [firstTool.tool_version_id],
        userId,
      );
      assert.equal(retainedPinned.length, 1);
      assert.equal(retainedPinned[0].deleted_at !== null, true);
      assert.equal(retainedPinned[0].enabled, false);
    });

    await t.test('tool invocation ledger persists retry contract and indeterminate outcomes', async () => {
      const scenario = await createScenario();
      const run = await scenario.startRun();
      const toolCallId = 'call-indeterminate-write';
      const executionToken = randomUUID();

      const first = await beginAgentToolInvocation({
        runId: run.id,
        toolCallId,
        toolKey: 'custom:test-write',
        retryMode: 'never',
        executionToken,
      });
      assert.equal(first.attempt_count, 1);
      assert.equal(first.retry_mode, 'never');
      assert.equal(first.status, 'in_flight');

      // The database, not TypeScript, requires an auditable reason for an
      // unknown outcome.
      await assert.rejects(
        () => finishAgentToolInvocation({
          runId: run.id,
          toolCallId,
          executionToken,
          status: 'indeterminate',
        }),
        (error) => error?.code === '23514',
      );

      const settled = await finishAgentToolInvocation({
        runId: run.id,
        toolCallId,
        executionToken,
        status: 'indeterminate',
        errorCode: 'tool_result_indeterminate',
      });
      assert.equal(settled.status, 'indeterminate');
      assert.equal(settled.error_code, 'tool_result_indeterminate');
      assert.ok(settled.completed_at);
      assert.equal(await beginAgentToolInvocation({
        runId: run.id,
        toolCallId,
        toolKey: 'custom:test-write',
        retryMode: 'never',
        executionToken: randomUUID(),
      }), undefined, 'an indeterminate invocation must never be reopened');

      const retryCallId = 'call-idempotent-write';
      const retryExecutionToken = randomUUID();
      await beginAgentToolInvocation({
        runId: run.id,
        toolCallId: retryCallId,
        toolKey: 'custom:test-idempotent-write',
        retryMode: 'idempotent_write',
        executionToken: retryExecutionToken,
      });
      assert.equal(await beginAgentToolInvocation({
        runId: run.id,
        toolCallId: retryCallId,
        toolKey: 'custom:test-idempotent-write',
        retryMode: 'idempotent_write',
        executionToken: randomUUID(),
      }), undefined, 'a concurrent runtime cannot take over an in-flight invocation');
      const secondAttempt = await beginAgentToolInvocation({
        runId: run.id,
        toolCallId: retryCallId,
        toolKey: 'custom:test-idempotent-write',
        retryMode: 'idempotent_write',
        executionToken: retryExecutionToken,
      });
      assert.equal(secondAttempt.attempt_count, 2);
      assert.equal(secondAttempt.retry_mode, 'idempotent_write');
      assert.equal(secondAttempt.completed_at, null);
      assert.equal(secondAttempt.error_code, null);
      assert.equal(await finishAgentToolInvocation({
        runId: run.id,
        toolCallId: retryCallId,
        executionToken: randomUUID(),
        status: 'succeeded',
        resultPayload: { modelContent: '{"ok":true}', evidencePayload: { ok: true } },
      }), null, 'a stale runtime cannot submit a terminal outcome');
      const succeeded = await finishAgentToolInvocation({
        runId: run.id,
        toolCallId: retryCallId,
        executionToken: retryExecutionToken,
        status: 'succeeded',
        resultPayload: { modelContent: '{"ok":true}', evidencePayload: { ok: true } },
      });
      assert.equal(succeeded.status, 'succeeded');
      assert.equal(succeeded.error_code, null);
      assert.equal(succeeded.result_format_version, 1);
      assert.deepEqual(succeeded.result_payload, {
        modelContent: '{"ok":true}',
        evidencePayload: { ok: true },
      });
      assert.match(succeeded.result_hash, /^[0-9a-f]{64}$/);
    });

  } finally {
    await pool.query('delete from users where id = any($1::uuid[])', [createdUserIds]);
    await releaseIntegrationLock();
    await closeDatabasePool();
  }
});
