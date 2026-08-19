import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  cancelAgentRunForUser,
  cancelActiveAgentRunsForConversationForUser,
  decideAgentApprovalForUser,
  expireAgentApproval,
  findAgentApprovalForUser,
  findAgentRunForUser,
  isAgentRunActiveForUser,
  listAgentRunsForUser,
} from '../../repositories/agentRuns';
import { AgentRunService } from './agent-run.service';
import { abortAgentRunsForConversationInProcess } from './agent-run-control';

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
