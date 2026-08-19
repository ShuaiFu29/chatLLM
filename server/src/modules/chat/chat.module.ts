import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ChatController } from './chat.controller';
import { ChatStreamService } from './chat-stream.service';
import { ChatService } from './chat.service';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [AgentsModule],
  controllers: [ChatController],
  providers: [AuthGuard, ChatService, ChatStreamService],
})
export class ChatModule {}
