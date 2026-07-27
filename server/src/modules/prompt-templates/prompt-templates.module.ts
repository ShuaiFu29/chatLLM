import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PromptTemplatesController } from './prompt-templates.controller';
import { PromptTemplatesService } from './prompt-templates.service';

@Module({
  controllers: [PromptTemplatesController],
  providers: [AuthGuard, PromptTemplatesService],
})
export class PromptTemplatesModule {}
