import assert from 'node:assert/strict';
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
    cancelAgentRunForUser,
    markAgentRunWaitingForSubagents,
    resumeAgentRunFromSubagents,
    insertAgentStep,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentRuns.js'));
  const {
    createAgentRunBudget,
    debitAgentRunBudget,
    findAgentRunBudget,
    markAgentRunBudgetDegraded,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentRunBudgets.js'));
  const {
    claimQueuedSubagentRun,
    claimAbandonedSubagentRun,
    renewSubagentRunLease,
    releaseSubagentRunLease,
    failExpiredSubagentRunLeases,
    listSubagentOutcomesForToolCall,
    areSubagentOutcomesTerminal,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentSubagentQueue.js'));
  const {
    upsertAgentMemory,
    listRecallableAgentMemories,
    supersedeAgentMemory,
  } = require(path.join(serverRoot, 'dist', 'repositories', 'agentMemories.js'));

  const otherUserId = randomUUID();
  const projectSpaceId = randomUUID();
  const createdUserIds = [otherUserId];
  let githubId = BigInt(Date.now()) * 1000n;
  let releaseIntegrationLock = async () => undefined;

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
    const startRun = (agentId = agentIds[0]) => createAgentRun({
      userId: scenarioUserId,
      agentId,
      agentVersionId: null,
      conversationId: scenarioConversationId,
      userMessageId: null,
      agentVersionSnapshot: {},
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
        'select id, status from agent_runs where root_run_id = $1 order by depth',
        [parent.id],
      );
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.status, 'cancelled', `run ${row.id} must be cancelled with the tree`);
      }
      assert.ok(rows.some((row) => row.id === grandchild.id));

      // A cancelled parent must not be pulled back into running by a dispatch that
      // was already in flight.
      assert.equal(await resumeAgentRunFromSubagents(parent.id, scenario.userId), null);
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

    await t.test('concurrent debits cannot overdraw the shared allowance', async () => {
      const scenario = await createScenario();
      const root = await scenario.startRun();
      await createAgentRunBudget({
        rootRunId: root.id,
        userId: scenario.userId,
        deadlineAt: new Date(Date.now() + 60_000),
        tokenTotal: 1_000,
        iterationTotal: 10,
        toolCallTotal: 10,
        subagentDispatchTotal: 3,
        finalAnswerReserveTokens: 200,
      });

      // Ten writers each asking for 100 tokens against an 800-token spendable
      // allowance. A read-then-write implementation lets more than eight through;
      // the conditional UPDATE is the whole reason this holds.
      const results = await Promise.all(Array.from({ length: 10 }, () => debitAgentRunBudget({
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

      // Only the final, tool-free turn may spend the reserve.
      const reserveDebit = await debitAgentRunBudget({
        rootRunId: root.id,
        dimension: 'token',
        amount: 200,
        allowReserve: true,
      });
      assert.equal(reserveDebit.granted, true);
      assert.equal(reserveDebit.budget.token_consumed, 1_000);
      // And nothing beyond it.
      assert.equal(
        (await debitAgentRunBudget({
          rootRunId: root.id,
          dimension: 'token',
          amount: 1,
          allowReserve: true,
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
      assert.equal(reused.token_consumed, 1_000);

      // The first transition into degraded mode wins so concurrent runs in one tree
      // do not overwrite each other's reason.
      assert.ok(await markAgentRunBudgetDegraded(root.id, 'token_budget'));
      assert.equal(await markAgentRunBudgetDegraded(root.id, 'something_else'), null);
      assert.equal((await findAgentRunBudget(root.id)).degraded_reason, 'token_budget');
    });

    await t.test('the ledger refuses an overdraft even when asked directly', async () => {
      const scenario = await createScenario();
      const root = await scenario.startRun();
      await createAgentRunBudget({
        rootRunId: root.id,
        userId: scenario.userId,
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
        'agent_run_budgets_token_consumed_check',
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

      const recalled = await listRecallableAgentMemories({
        userId,
        projectSpaceId,
        agentId: parentAgentId,
        limit: 20,
      });
      const recalledIds = recalled.map((memory) => memory.id);
      assert.ok(recalledIds.includes(first.id));
      // Excluded in SQL, so no code path can surface them by forgetting to check.
      assert.ok(!recalledIds.includes(expired.id), 'an expired memory must never be recalled');
      assert.ok(!recalledIds.includes(otherProject.id), 'a project memory must not leak');

      const replacement = await upsertAgentMemory({
        userId,
        scope: 'project',
        scopeRefId: projectSpaceId,
        kind: 'preference',
        content: 'Prefers imperial units now.',
        sourceTrust: 'user_stated',
      });
      assert.ok(await supersedeAgentMemory({
        userId,
        memoryId: first.id,
        supersededById: replacement.id,
      }));
      const afterSupersede = (await listRecallableAgentMemories({
        userId,
        projectSpaceId,
        agentId: parentAgentId,
        limit: 20,
      })).map((memory) => memory.id);
      assert.ok(!afterSupersede.includes(first.id), 'a superseded memory must drop out of recall');
      assert.ok(afterSupersede.includes(replacement.id));

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

      await releaseSubagentRunLease({ runId: child.id, leaseToken: winners[0].lease_token });
      const released = await pool.query(
        'select lease_token, lease_expires_at from agent_runs where id = $1',
        [child.id],
      );
      assert.equal(released.rows[0].lease_token, null);
      assert.equal(released.rows[0].lease_expires_at, null);
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

      // Simulate a worker that stopped renewing.
      await pool.query(
        "update agent_runs set lease_expires_at = now() - interval '1 second' where id = $1",
        [child.id],
      );
      const failed = await failExpiredSubagentRunLeases();
      assert.ok(failed.includes(child.id));

      const { rows } = await pool.query(
        'select status, error_code, lease_token from agent_runs where id = $1',
        [child.id],
      );
      // Failed, not re-queued: replaying a child could repeat a side effect it
      // already performed.
      assert.equal(rows[0].status, 'failed');
      assert.equal(rows[0].error_code, 'subagent_lease_expired');
      assert.equal(rows[0].lease_token, null);
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

      await claimQueuedSubagentRun({ runId: succeeded.id, leaseDurationMs: 60_000 });
      await insertAgentStep({
        runId: succeeded.id,
        sequence: 0,
        kind: 'assistant',
        status: 'succeeded',
        content: 'the subtask answer',
      });
      await pool.query(
        "update agent_runs set status = 'succeeded', completed_at = now() where id = $1",
        [succeeded.id],
      );
      await pool.query(
        `update agent_runs
         set status = 'failed', error_code = 'subagent_failed',
             error_message = 'no answer', completed_at = now()
         where id = $1`,
        [failedChild.id],
      );

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

  } finally {
    await pool.query('delete from users where id = any($1::uuid[])', [createdUserIds]);
    await releaseIntegrationLock();
    await closeDatabasePool();
  }
});
