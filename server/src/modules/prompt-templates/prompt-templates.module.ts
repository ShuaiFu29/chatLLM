import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PromptTemplatesController } from './prompt-templates.controller';

@Module({
  controllers: [PromptTemplatesController],
  providers: [AuthGuard],
})
export class PromptTemplatesModule {}
