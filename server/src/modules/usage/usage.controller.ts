import {
  Controller,
  Get,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  getProviderHealth,
  getUsageConversation,
  getUsageFileQueue,
  getUsageOverview,
} from '../../controllers/usage';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AppReply, AppRequest } from '../../common/http/app-request';

@Controller('usage')
@UseGuards(AuthGuard)
export class UsageController {
  @Get()
  overview(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getUsageOverview(request, reply);
  }

  @Get('provider-health')
  providerHealth(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getProviderHealth(request, reply);
  }

  @Get('file-queue')
  fileQueue(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getUsageFileQueue(request, reply);
  }

  @Get('conversations/:conversationId')
  conversation(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getUsageConversation(request, reply);
  }
}
