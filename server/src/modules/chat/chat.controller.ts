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
import { AuthGuard } from '../../common/guards/auth.guard';
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import type { AppReply, AppRequest } from '../../common/http/app-request';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import {
  branchConversation,
  compareConversations,
  createConversation,
  deleteConversation,
  deleteMessage,
  getConversations,
  getMessages,
  searchMessages,
  sendMessage,
  truncateConversation,
  updateConversation,
} from '../../controllers/chat';
import { serverEnv } from '../../lib/env';
import { mutationSchemas } from '../../lib/mutationSchemas';

@Controller('chat')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'chat',
  max: serverEnv.CHAT_RATE_LIMIT_MAX,
  message: 'Too many chat requests',
})
export class ChatController {
  @Get('search')
  search(@Req() request: AppRequest, @Res() reply: AppReply) {
    return searchMessages(request, reply);
  }

  @Get('conversations')
  listConversations(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getConversations(request, reply);
  }

  @Post('conversations')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.chatCreateConversation)
  createConversation(@Req() request: AppRequest, @Res() reply: AppReply) {
    return createConversation(request, reply);
  }

  @Post('conversations/:conversationId/branches')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.chatBranchConversation)
  branchConversation(@Req() request: AppRequest, @Res() reply: AppReply) {
    return branchConversation(request, reply);
  }

  @Get('conversations/:conversationId/compare/:otherConversationId')
  compareConversations(@Req() request: AppRequest, @Res() reply: AppReply) {
    return compareConversations(request, reply);
  }

  @Patch('conversations/:conversationId')
  @ValidateMutation(mutationSchemas.chatUpdateConversation)
  updateConversation(@Req() request: AppRequest, @Res() reply: AppReply) {
    return updateConversation(request, reply);
  }

  @Delete('conversations/:conversationId')
  @ValidateMutation(mutationSchemas.chatDeleteConversation)
  deleteConversation(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deleteConversation(request, reply);
  }

  @Delete('messages/:messageId')
  @ValidateMutation(mutationSchemas.chatDeleteMessage)
  deleteMessage(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deleteMessage(request, reply);
  }

  @Delete('conversations/:conversationId/messages/:messageId/truncate')
  @ValidateMutation(mutationSchemas.chatTruncateConversation)
  truncateConversation(@Req() request: AppRequest, @Res() reply: AppReply) {
    return truncateConversation(request, reply);
  }

  @Get('conversations/:conversationId/messages')
  getMessages(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getMessages(request, reply);
  }

  @Post('conversations/:conversationId/messages')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.chatSendMessage)
  sendMessage(@Req() request: AppRequest, @Res() reply: AppReply) {
    return sendMessage(request, reply);
  }
}
