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
import type { IncomingMessage } from 'node:http';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import {
  CurrentUser,
  RequestConnection,
  RequestId,
} from '../../common/http/request-context.decorator';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { serverEnv } from '../../lib/env';
import { mutationSchemas } from '../../lib/mutationSchemas';
import { User } from '../../types';
import { ChatStreamService } from './chat-stream.service';
import { ChatService } from './chat.service';

@Controller('chat')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'chat',
  max: serverEnv.CHAT_RATE_LIMIT_MAX,
  message: 'Too many chat requests',
})
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatStreamService: ChatStreamService,
  ) {}

  @Get('search')
  search(
    @CurrentUser() user: User,
    @Query() query: Record<string, any>,
  ) {
    return this.chatService.searchMessages(user, query);
  }

  @Get('conversations')
  listConversations(
    @CurrentUser() user: User,
    @Query() query: Record<string, any>,
  ) {
    return this.chatService.listConversations(user, query);
  }

  @Post('conversations')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.chatCreateConversation)
  createConversation(
    @CurrentUser() user: User,
    @Body() body: Record<string, any>,
  ) {
    return this.chatService.createConversation(user, body);
  }

  @Post('conversations/:conversationId/branches')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.chatBranchConversation)
  branchConversation(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
    @Body() body: Record<string, any>,
  ) {
    return this.chatService.branchConversation(user, conversationId, body);
  }

  @Get('conversations/:conversationId/compare/:otherConversationId')
  compareConversations(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
    @Param('otherConversationId') otherConversationId: string,
  ) {
    return this.chatService.compareConversations(
      user,
      conversationId,
      otherConversationId,
    );
  }

  @Patch('conversations/:conversationId')
  @ValidateMutation(mutationSchemas.chatUpdateConversation)
  updateConversation(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
    @Body() body: Record<string, any>,
  ) {
    return this.chatService.updateConversation(user, conversationId, body);
  }

  @Delete('conversations/:conversationId')
  @ValidateMutation(mutationSchemas.chatDeleteConversation)
  deleteConversation(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
  ) {
    return this.chatService.deleteConversation(user, conversationId);
  }

  @Delete('messages/:messageId')
  @ValidateMutation(mutationSchemas.chatDeleteMessage)
  deleteMessage(
    @CurrentUser() user: User,
    @Param('messageId') messageId: string,
  ) {
    return this.chatService.deleteMessage(user, messageId);
  }

  @Delete('conversations/:conversationId/messages/:messageId/truncate')
  @ValidateMutation(mutationSchemas.chatTruncateConversation)
  truncateConversation(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.chatService.truncateConversation(user, conversationId, messageId);
  }

  @Get('conversations/:conversationId/messages')
  getMessages(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
    @Query() query: Record<string, any>,
  ) {
    return this.chatService.getMessages(user, conversationId, query);
  }

  @Post('conversations/:conversationId/messages')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.chatSendMessage)
  sendMessage(
    @CurrentUser() user: User,
    @Param('conversationId') conversationId: string,
    @Body() body: Record<string, unknown>,
    @RequestConnection() connection: IncomingMessage,
    @RequestId() requestId?: string,
  ) {
    return this.chatStreamService.sendMessage({
      user,
      conversationId,
      content: body.content,
      continueGeneration: body.continue === true,
      connection,
      requestId,
    });
  }
}
