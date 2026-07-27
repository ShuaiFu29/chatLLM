import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ChatController } from './chat.controller';

@Module({
  controllers: [ChatController],
  providers: [AuthGuard],
})
export class ChatModule {}
