import {
  HttpException,
  HttpStatus,
  Injectable,
  type MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  cancelAgentRunForUser,
  cancelActiveAgentRunsForConversationForUser,
  decideAgentApprovalForUser,
  expireAgentApproval,
  findAgentApprovalForUser,
  findAgentRunForUser,
  isAgentRunActiveForUser,
  listAgentRunsForUser,
  listAgentApprovalInboxForUser,
} from '../../repositories/agentRuns';
import { AgentRunService } from './agent-run.service';
import { abortAgentRunsForConversationInProcess } from './agent-run-control';
import {
  AgentRunEventError,
  listAgentRunEventsForUser,
} from '../../repositories/agentRunEvents';
import {
  AgentApprovalCursorError,
  decodeAgentApprovalCursor,
} from '../../lib/agentApprovalCursor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicError = (statusCode: number, error: string) => new HttpException({ error }, statusCode);

@Injectable()
export class AgentRunsService {
  constructor(private readonly agentRunService: AgentRunService) {}

  list(userId: string, query: Record<string, unknown>) {
    const agentId = typeof query.agentId === 'string' ? query.agentId.trim() : undefined;
    const conversationId = typeof query.conversationId === 'string' ? query.conversationId.trim() : undefined;
    if (agentId && !UUID.test(agentId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid agent id');
    if (conversationId && !UUID.test(conversationId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid conversation id');
    const rawLimit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : undefined;
    return listAgentRunsForUser({
      userId,
      agentId,
      conversationId,
      limit: Number.isInteger(rawLimit) ? rawLimit : undefined,
    });
  }

  async get(userId: string, runId: string, query: Record<string, unknown> = {}) {
    if (!UUID.test(runId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent run id');
    const parseLimit = (value: unknown, fallback: number, maximum: number) => {
      const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
      return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
    };
    const run = await findAgentRunForUser(runId, userId, {
      stepLimit: parseLimit(query.stepLimit ?? query.step_limit, 200, 500),
      approvalLimit: parseLimit(query.approvalLimit ?? query.approval_limit, 100, 200),
    });
    if (!run) throw publicError(HttpStatus.NOT_FOUND, 'Agent run not found');
    return run;
  }

  approvalInbox(userId: string, query: Record<string, unknown>) {
    const status = typeof query.status === 'string' ? query.status : 'pending';
    if (!['pending', 'approved', 'rejected', 'expired'].includes(status)) {
      throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent approval status');
    }
    const rawLimit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : undefined;
    try {
      return listAgentApprovalInboxForUser({
        userId,
        status: status as 'pending' | 'approved' | 'rejected' | 'expired',
        limit: Number.isInteger(rawLimit) ? rawLimit : undefined,
        cursor: decodeAgentApprovalCursor(query.cursor),
      });
    } catch (error) {
      if (error instanceof AgentApprovalCursorError) {
        throw publicError(HttpStatus.BAD_REQUEST, error.message);
      }
      throw error;
    }
  }

  async events(userId: string, runId: string, query: Record<string, unknown> = {}) {
    if (!UUID.test(runId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent run id');
    const afterId = typeof query.after === 'string'
      ? query.after
      : typeof query.after_id === 'string'
        ? query.after_id
        : undefined;
    const rawLimit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : undefined;
    try {
      const events = await listAgentRunEventsForUser({
        runId,
        userId,
        afterId,
        limit: Number.isInteger(rawLimit) ? rawLimit : undefined,
      });
      if (events.length === 0 && !await findAgentRunForUser(runId, userId, {
        stepLimit: 1,
        approvalLimit: 1,
      })) {
        throw publicError(HttpStatus.NOT_FOUND, 'Agent run not found');
      }
      return {
        events,
        next_after: events.at(-1)?.id || afterId || '0',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof AgentRunEventError && error.code === 'invalid') {
        throw publicError(HttpStatus.BAD_REQUEST, error.message);
      }
      throw error;
    }
  }

  streamEvents(userId: string, runId: string, query: Record<string, unknown> = {}) {
    if (!UUID.test(runId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent run id');
    const initialAfter = typeof query.after === 'string'
      ? query.after
      : typeof query.after_id === 'string'
        ? query.after_id
        : '0';
    const rawLimit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : NaN;
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 100;

    return new Observable<MessageEvent>((subscriber) => {
      let afterId = initialAfter;
      let timer: NodeJS.Timeout | null = null;
      let stopped = false;
      let polling = false;
      let terminalObservedAt = 0;
      const schedule = (delay = 500) => {
        if (stopped) return;
        timer = setTimeout(() => void poll(), delay);
        timer.unref();
      };
      const poll = async () => {
        if (stopped || polling) return;
        polling = true;
        try {
          const events = await listAgentRunEventsForUser({
            runId,
            userId,
            afterId,
            limit,
          });
          let terminalEventSeen = false;
          for (const event of events) {
            afterId = event.id;
            const type = event.payload.agentEvent
              && typeof event.payload.agentEvent === 'object'
              && !Array.isArray(event.payload.agentEvent)
              ? String((event.payload.agentEvent as Record<string, unknown>).type || '')
              : '';
            if (['run.completed', 'run.failed', 'run.cancelled'].includes(type)) {
              terminalEventSeen = true;
            }
            subscriber.next({ id: event.id, type: 'agent.run', data: event.payload });
          }
          if (terminalEventSeen) {
            subscriber.complete();
            return;
          }
          if (events.length >= limit) {
            schedule(0);
            return;
          }
          const run = await findAgentRunForUser(runId, userId, {
            stepLimit: 1,
            approvalLimit: 1,
          });
          if (!run) throw publicError(HttpStatus.NOT_FOUND, 'Agent run not found');
          const terminal = ['succeeded', 'failed', 'cancelled'].includes(run.status);
          if (!terminal) {
            terminalObservedAt = 0;
            schedule();
            return;
          }
          if (terminalObservedAt === 0) {
            terminalObservedAt = Date.now();
            schedule(250);
            return;
          }
          // Terminal state and event append are not yet one transaction. Keep a
          // short grace period, then perform one final cursor drain before EOF.
          if (Date.now() - terminalObservedAt < 1_000) {
            schedule(250);
            return;
          }
          subscriber.complete();
        } catch (error) {
          if (error instanceof AgentRunEventError && error.code === 'invalid') {
            subscriber.error(publicError(HttpStatus.BAD_REQUEST, error.message));
          } else {
            subscriber.error(error);
          }
        } finally {
          polling = false;
        }
      };
      void poll();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    });
  }

  async cancel(userId: string, runId: string) {
    if (!UUID.test(runId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent run id');
    // Abort the in-process execution before the database transition so a
    // concurrent completion cannot continue doing work after cancellation.
    this.agentRunService.abort(runId, userId);
    const run = await cancelAgentRunForUser(runId, userId);
    if (!run) {
      const existing = await findAgentRunForUser(runId, userId);
      if (!existing) throw publicError(HttpStatus.NOT_FOUND, 'Agent run not found');
      throw publicError(HttpStatus.CONFLICT, 'Agent run is no longer active');
    }
    return run;
  }

  async cancelConversation(userId: string, conversationId: string) {
    if (!UUID.test(conversationId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid conversation id');
    // This endpoint closes the race where the browser stops a stream before
    // the first SSE event has delivered its Agent run id.
    abortAgentRunsForConversationInProcess(conversationId, userId);
    return cancelActiveAgentRunsForConversationForUser(conversationId, userId);
  }

  /**
   * Decide several approvals for one run in a single request.
   *
   * This exists because a fan-out under an `always` policy can produce several
   * pending approvals at once, and forcing one round trip each is needlessly
   * painful. It changes only the number of requests, never the guarantee: each
   * decision still names the approval it applies to, so a human decides exactly
   * what they were shown.
   *
   * There is intentionally no blanket or remembered approval. "Approve this tool
   * for the rest of the run" would quietly turn an `always` policy into an
   * autonomous one, which is the opposite of what the operator configured.
   *
   * Outcomes are reported per entry rather than aborting the batch. If one
   * approval expired while the user was deciding, failing everything would throw
   * away their decisions on the others and the expired one would not come back.
   */
  async decideApprovalBatch(
    userId: string,
    runId: string,
    body: { decisions: { approval_id: string; decision: 'approved' | 'rejected'; reason?: string }[] },
  ) {
    if (!UUID.test(runId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent run id');
    // Checked once for the whole batch: the run either accepts decisions or it
    // does not, and re-checking per entry would only add races.
    if (!await isAgentRunActiveForUser(runId, userId)) {
      throw publicError(HttpStatus.CONFLICT, 'Agent run is no longer active');
    }

    const results: {
      approval_id: string;
      status: 'decided' | 'not_found' | 'already_decided' | 'expired';
      decision?: 'approved' | 'rejected';
    }[] = [];

    for (const entry of body.decisions) {
      const approval = await findAgentApprovalForUser(entry.approval_id, runId, userId);
      if (!approval) {
        results.push({ approval_id: entry.approval_id, status: 'not_found' });
        continue;
      }
      if (approval.status !== 'pending') {
        results.push({ approval_id: entry.approval_id, status: 'already_decided' });
        continue;
      }
      if (new Date(approval.expires_at).getTime() <= Date.now()) {
        await expireAgentApproval(entry.approval_id, runId);
        results.push({ approval_id: entry.approval_id, status: 'expired' });
        continue;
      }
      const decided = await decideAgentApprovalForUser({
        approvalId: entry.approval_id,
        runId,
        userId,
        decision: entry.decision,
        reason: entry.reason?.trim(),
      });
      if (!decided) {
        // Lost a race with the expiry sweep or another client.
        results.push({ approval_id: entry.approval_id, status: 'already_decided' });
        continue;
      }
      results.push({
        approval_id: entry.approval_id,
        status: 'decided',
        decision: entry.decision,
      });
    }

    return {
      decided: results.filter((result) => result.status === 'decided').length,
      total: results.length,
      results,
    };
  }

  async decideApproval(
    userId: string,
    runId: string,
    approvalId: string,
    body: { decision: 'approved' | 'rejected'; reason?: string },
  ) {
    if (!UUID.test(runId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent run id');
    if (!UUID.test(approvalId)) throw publicError(HttpStatus.BAD_REQUEST, 'Invalid Agent approval id');
    const approval = await findAgentApprovalForUser(approvalId, runId, userId);
    if (!approval) throw publicError(HttpStatus.NOT_FOUND, 'Agent approval not found');
    if (approval.status !== 'pending') {
      throw publicError(HttpStatus.CONFLICT, 'Agent approval has already been decided');
    }
    if (new Date(approval.expires_at).getTime() <= Date.now()) {
      await expireAgentApproval(approvalId, runId);
      throw publicError(HttpStatus.CONFLICT, 'Agent approval has expired');
    }
    // The execution process may differ from the API process. The database
    // approval row is authoritative; the execution worker polls it and will
    // resume even when this request lands on another instance.
    if (!await isAgentRunActiveForUser(runId, userId)) {
      throw publicError(HttpStatus.CONFLICT, 'Agent run is no longer active');
    }
    const decided = await decideAgentApprovalForUser({
      approvalId,
      runId,
      userId,
      decision: body.decision,
      reason: body.reason?.trim(),
    });
    if (!decided) throw publicError(HttpStatus.CONFLICT, 'Agent approval is no longer pending');
    this.agentRunService.resolveApproval(approvalId, runId, userId, {
      decision: body.decision,
      reason: body.reason?.trim() || '',
    });
    return decided;
  }
}
