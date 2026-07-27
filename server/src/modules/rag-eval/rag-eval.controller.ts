import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import { CurrentUser, RequestId } from '../../common/http/request-context.decorator';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { serverEnv } from '../../lib/env';
import { mutationSchemas } from '../../lib/mutationSchemas';
import { User } from '../../types';
import {
  RagEvalCaseBody,
  RagEvalDatasetBody,
  RagEvalService,
} from './rag-eval.service';

@Controller('rag-eval')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'rag-eval',
  max: serverEnv.RAG_EVAL_RATE_LIMIT_MAX,
  message: 'Too many RAG evaluation requests',
})
export class RagEvalController {
  constructor(private readonly ragEvalService: RagEvalService) {}

  @Get('history')
  history(
    @CurrentUser() user: User,
    @Query('limit') limit: unknown,
    @RequestId() requestId?: string,
  ) {
    return this.ragEvalService.history(user.id, limit, requestId);
  }

  @Get('datasets')
  listDatasets(@CurrentUser() user: User, @RequestId() requestId?: string) {
    return this.ragEvalService.listDatasets(user.id, requestId);
  }

  @Post('datasets')
  @ValidateMutation(mutationSchemas.ragEvalDatasetCreate)
  createDataset(
    @CurrentUser() user: User,
    @Body() body: RagEvalDatasetBody,
    @RequestId() requestId?: string,
  ) {
    return this.ragEvalService.createDataset(user.id, body, requestId);
  }

  @Patch('datasets/:datasetId')
  @ValidateMutation(mutationSchemas.ragEvalDatasetUpdate)
  updateDataset(
    @CurrentUser() user: User,
    @Param('datasetId') datasetId: string,
    @Body() body: RagEvalDatasetBody,
    @RequestId() requestId?: string,
  ) {
    return this.ragEvalService.updateDataset(user.id, datasetId, body, requestId);
  }

  @Delete('datasets/:datasetId')
  @ValidateMutation(mutationSchemas.ragEvalDatasetDelete)
  deleteDataset(
    @CurrentUser() user: User,
    @Param('datasetId') datasetId: string,
    @RequestId() requestId?: string,
  ) {
    return this.ragEvalService.deleteDataset(user.id, datasetId, requestId);
  }

  @Get('datasets/:datasetId/quality')
  qualitySummary(
    @CurrentUser() user: User,
    @Param('datasetId') datasetId: string,
    @RequestId() requestId?: string,
  ) {
    return this.ragEvalService.qualitySummary(user.id, datasetId, requestId);
  }

  @Post('datasets/:datasetId/cases')
  @ValidateMutation(mutationSchemas.ragEvalCaseCreate)
  createCase(
    @CurrentUser() user: User,
    @Param('datasetId') datasetId: string,
    @Body() body: RagEvalCaseBody,
    @RequestId() requestId?: string,
  ) {
    return this.ragEvalService.createCase(user.id, datasetId, body, requestId);
  }

  @Post('datasets/:datasetId/runs')
  @HttpCode(202)
  @ValidateMutation(mutationSchemas.ragEvalDatasetRun)
  runDataset(
    @CurrentUser() user: User,
    @Param('datasetId') datasetId: string,
    @RequestId() requestId?: string,
  ) {
    return this.ragEvalService.runDataset(user.id, datasetId, requestId);
  }

  @Get('runs/:runId')
  getRun(
    @CurrentUser() user: User,
    @Param('runId') runId: string,
    @RequestId() requestId?: string,
  ) {
    return this.ragEvalService.getRun(user.id, runId, requestId);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.ragEvalRunCancel)
  cancelRun(
    @CurrentUser() user: User,
    @Param('runId') runId: string,
    @RequestId() requestId?: string,
  ) {
    return this.ragEvalService.cancelRun(user.id, runId, requestId);
  }

  @Delete('cases/:caseId')
  @ValidateMutation(mutationSchemas.ragEvalCaseDelete)
  deleteCase(
    @CurrentUser() user: User,
    @Param('caseId') caseId: string,
    @RequestId() requestId?: string,
  ) {
    return this.ragEvalService.deleteCase(user.id, caseId, requestId);
  }
}
