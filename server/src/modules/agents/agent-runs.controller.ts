import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/http/request-context.decorator';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { mutationSchemas } from '../../lib/mutationSchemas';
import { User } from '../../types';
import { AgentRunsService } from './agent-runs.service';

@Controller('agent-runs')
@UseGuards(AuthGuard)
export class AgentRunsController {
  constructor(private readonly agentRunsService: AgentRunsService) {}

  @Get()
  list(@CurrentUser() user: User, @Query() query: Record<string, unknown>) {
    return this.agentRunsService.list(user.id, query);
  }

  @Get(':runId')
  get(@CurrentUser() user: User, @Param('runId') runId: string, @Query() query: Record<string, unknown>) {
    return this.agentRunsService.get(user.id, runId, query);
  }

  @Post(':runId/cancel')
  @ValidateMutation(mutationSchemas.agentRunCancel)
  cancel(@CurrentUser() user: User, @Param('runId') runId: string) {
    return this.agentRunsService.cancel(user.id, runId);
  }

  @Post('conversations/:conversationId/cancel')
  @ValidateMutation(mutationSchemas.agentRunConversationCancel)
  cancelConversation(@CurrentUser() user: User, @Param('conversationId') conversationId: string) {
    return this.agentRunsService.cancelConversation(user.id, conversationId);
  }

  // Declared before the single-approval route so ':approvalId' cannot swallow it.
  @Post(':runId/approvals')
  @ValidateMutation(mutationSchemas.agentRunApprovalBatchDecision)
  decideApprovalBatch(
    @CurrentUser() user: User,
    @Param('runId') runId: string,
    @Body() body: {
      decisions: { approval_id: string; decision: 'approved' | 'rejected'; reason?: string }[];
    },
  ) {
    return this.agentRunsService.decideApprovalBatch(user.id, runId, body);
  }

  @Post(':runId/approvals/:approvalId')
  @ValidateMutation(mutationSchemas.agentRunApprovalDecision)
  decideApproval(
    @CurrentUser() user: User,
    @Param('runId') runId: string,
    @Param('approvalId') approvalId: string,
    @Body() body: { decision: 'approved' | 'rejected'; reason?: string },
  ) {
    return this.agentRunsService.decideApproval(user.id, runId, approvalId, body);
  }
}
