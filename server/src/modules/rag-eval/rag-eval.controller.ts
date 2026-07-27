import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  cancelRagEvalRun,
  createRagEvalCase,
  createRagEvalDataset,
  deleteRagEvalCase,
  deleteRagEvalDataset,
  getRagEvalQualitySummary,
  getRagEvalRun,
  listRagEvalDatasets,
  listRagEvalHistory,
  runRagEvalDataset,
  updateRagEvalDataset,
} from '../../controllers/ragEval';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import { AppReply, AppRequest } from '../../common/http/app-request';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { serverEnv } from '../../lib/env';
import { mutationSchemas } from '../../lib/mutationSchemas';

@Controller('rag-eval')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'rag-eval',
  max: serverEnv.RAG_EVAL_RATE_LIMIT_MAX,
  message: 'Too many RAG evaluation requests',
})
export class RagEvalController {
  @Get('history')
  history(@Req() request: AppRequest, @Res() reply: AppReply) {
    return listRagEvalHistory(request, reply);
  }

  @Get('datasets')
  listDatasets(@Req() request: AppRequest, @Res() reply: AppReply) {
    return listRagEvalDatasets(request, reply);
  }

  @Post('datasets')
  @ValidateMutation(mutationSchemas.ragEvalDatasetCreate)
  createDataset(@Req() request: AppRequest, @Res() reply: AppReply) {
    return createRagEvalDataset(request, reply);
  }

  @Patch('datasets/:datasetId')
  @ValidateMutation(mutationSchemas.ragEvalDatasetUpdate)
  updateDataset(@Req() request: AppRequest, @Res() reply: AppReply) {
    return updateRagEvalDataset(request, reply);
  }

  @Delete('datasets/:datasetId')
  @ValidateMutation(mutationSchemas.ragEvalDatasetDelete)
  deleteDataset(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deleteRagEvalDataset(request, reply);
  }

  @Get('datasets/:datasetId/quality')
  qualitySummary(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getRagEvalQualitySummary(request, reply);
  }

  @Post('datasets/:datasetId/cases')
  @ValidateMutation(mutationSchemas.ragEvalCaseCreate)
  createCase(@Req() request: AppRequest, @Res() reply: AppReply) {
    return createRagEvalCase(request, reply);
  }

  @Post('datasets/:datasetId/runs')
  @ValidateMutation(mutationSchemas.ragEvalDatasetRun)
  runDataset(@Req() request: AppRequest, @Res() reply: AppReply) {
    return runRagEvalDataset(request, reply);
  }

  @Get('runs/:runId')
  getRun(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getRagEvalRun(request, reply);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.ragEvalRunCancel)
  cancelRun(@Req() request: AppRequest, @Res() reply: AppReply) {
    return cancelRagEvalRun(request, reply);
  }

  @Delete('cases/:caseId')
  @ValidateMutation(mutationSchemas.ragEvalCaseDelete)
  deleteCase(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deleteRagEvalCase(request, reply);
  }
}
