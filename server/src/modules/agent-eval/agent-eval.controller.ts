import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import { CurrentUser, RequestId } from '../../common/http/request-context.decorator';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { serverEnv } from '../../lib/env';
import { mutationSchemas } from '../../lib/mutationSchemas';
import type { User } from '../../types';
import {
  type AgentEvalCaseBody,
  type AgentEvalDatasetBody,
  type AgentEvalRunBody,
  AgentEvalService,
} from './agent-eval.service';

@Controller('agent-eval')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'agent-eval',
  max: serverEnv.RAG_EVAL_RATE_LIMIT_MAX,
  message: 'Too many Agent evaluation requests',
})
export class AgentEvalController {
  constructor(private readonly agentEvalService: AgentEvalService) {}

  @Get('datasets')
  listDatasets(@CurrentUser() user: User, @RequestId() requestId?: string) {
    return this.agentEvalService.listDatasets(user.id, requestId);
  }

  @Post('datasets')
  @HttpCode(HttpStatus.CREATED)
  @ValidateMutation(mutationSchemas.agentEvalDatasetCreate)
  createDataset(
    @CurrentUser() user: User,
    @Body() body: AgentEvalDatasetBody,
    @RequestId() requestId?: string,
  ) {
    return this.agentEvalService.createDataset(user.id, body, requestId);
  }

  @Delete('datasets/:datasetId')
  @ValidateMutation(mutationSchemas.agentEvalDatasetDelete)
  deleteDataset(
    @CurrentUser() user: User,
    @Param('datasetId') datasetId: string,
    @RequestId() requestId?: string,
  ) {
    return this.agentEvalService.deleteDataset(user.id, datasetId, requestId);
  }

  @Post('datasets/:datasetId/cases')
  @HttpCode(HttpStatus.CREATED)
  @ValidateMutation(mutationSchemas.agentEvalCaseCreate)
  createCase(
    @CurrentUser() user: User,
    @Param('datasetId') datasetId: string,
    @Body() body: AgentEvalCaseBody,
    @RequestId() requestId?: string,
  ) {
    return this.agentEvalService.createCase(user.id, datasetId, body, requestId);
  }

  @Delete('cases/:caseId')
  @ValidateMutation(mutationSchemas.agentEvalCaseDelete)
  deleteCase(
    @CurrentUser() user: User,
    @Param('caseId') caseId: string,
    @RequestId() requestId?: string,
  ) {
    return this.agentEvalService.deleteCase(user.id, caseId, requestId);
  }

  @Post('datasets/:datasetId/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @ValidateMutation(mutationSchemas.agentEvalRunCreate)
  runDataset(
    @CurrentUser() user: User,
    @Param('datasetId') datasetId: string,
    @Body() body: AgentEvalRunBody,
    @RequestId() requestId?: string,
  ) {
    return this.agentEvalService.runDataset(user.id, datasetId, body, requestId);
  }

  @Get('runs/:runId')
  getRun(
    @CurrentUser() user: User,
    @Param('runId') runId: string,
    @RequestId() requestId?: string,
  ) {
    return this.agentEvalService.getRun(user.id, runId, requestId);
  }

  @Post('runs/:runId/cancel')
  @ValidateMutation(mutationSchemas.agentEvalRunCancel)
  cancelRun(
    @CurrentUser() user: User,
    @Param('runId') runId: string,
    @RequestId() requestId?: string,
  ) {
    return this.agentEvalService.cancelRun(user.id, runId, requestId);
  }
}
