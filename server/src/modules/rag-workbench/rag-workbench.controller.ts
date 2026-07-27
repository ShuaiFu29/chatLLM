import {
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  inspectRagRetrieval,
  listRagGraph,
  searchRagGraph,
} from '../../controllers/ragWorkbench';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import { AppReply, AppRequest } from '../../common/http/app-request';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { serverEnv } from '../../lib/env';
import { mutationSchemas } from '../../lib/mutationSchemas';

@Controller('rag-workbench')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'rag-workbench',
  max: serverEnv.RAG_EVAL_RATE_LIMIT_MAX,
  message: 'Too many RAG workbench requests',
})
export class RagWorkbenchController {
  @Post('inspect')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.ragWorkbenchInspect)
  inspect(@Req() request: AppRequest, @Res() reply: AppReply) {
    return inspectRagRetrieval(request, reply);
  }

  @Post('graph/list')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.ragWorkbenchGraphList)
  listGraph(@Req() request: AppRequest, @Res() reply: AppReply) {
    return listRagGraph(request, reply);
  }

  @Post('graph/search')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.ragWorkbenchGraphSearch)
  searchGraph(@Req() request: AppRequest, @Res() reply: AppReply) {
    return searchRagGraph(request, reply);
  }
}
