import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import {
  CurrentUser,
  RequestId,
} from '../../common/http/request-context.decorator';
import { User } from '../../types';
import { UsageService } from './usage.service';

type UsageQuery = Record<string, unknown>;

@Controller('usage')
@UseGuards(AuthGuard)
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  @Get()
  overview(
    @CurrentUser() user: User,
    @Query() query: UsageQuery,
    @RequestId() requestId?: string,
  ) {
    return this.usageService.getOverview(user.id, query.limit, requestId);
  }

  @Get('provider-health')
  providerHealth() {
    return this.usageService.getProviderHealth();
  }

  @Get('file-queue')
  fileQueue(
    @CurrentUser() user: User,
    @Query() query: UsageQuery,
    @RequestId() requestId?: string,
  ) {
    return this.usageService.getFileQueue(user.id, query.limit, requestId);
  }

  @Get('conversations/:conversationId')
  conversation(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
    @Query() query: UsageQuery,
    @RequestId() requestId?: string,
  ) {
    return this.usageService.getConversation(
      user.id,
      conversationId,
      query.messageLimit,
      query.ragRunLimit,
      requestId,
    );
  }
}
