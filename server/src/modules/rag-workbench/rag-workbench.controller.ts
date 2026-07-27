import {
  Body,
  Controller,
  HttpCode,
  Post,
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
  RagWorkbenchBody,
  RagWorkbenchService,
} from './rag-workbench.service';

@Controller('rag-workbench')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'rag-workbench',
  max: serverEnv.RAG_EVAL_RATE_LIMIT_MAX,
  message: 'Too many RAG workbench requests',
})
export class RagWorkbenchController {
  constructor(private readonly ragWorkbenchService: RagWorkbenchService) {}

  @Post('inspect')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.ragWorkbenchInspect)
  inspect(
    @CurrentUser() user: User,
    @Body() body: RagWorkbenchBody,
    @RequestId() requestId?: string,
  ) {
    return this.ragWorkbenchService.inspect(user.id, body, requestId);
  }

  @Post('graph/list')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.ragWorkbenchGraphList)
  listGraph(
    @CurrentUser() user: User,
    @Body() body: RagWorkbenchBody,
    @RequestId() requestId?: string,
  ) {
    return this.ragWorkbenchService.listGraph(user.id, body, requestId);
  }

  @Post('graph/search')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.ragWorkbenchGraphSearch)
  searchGraph(
    @CurrentUser() user: User,
    @Body() body: RagWorkbenchBody,
    @RequestId() requestId?: string,
  ) {
    return this.ragWorkbenchService.searchGraph(user.id, body, requestId);
  }
}
