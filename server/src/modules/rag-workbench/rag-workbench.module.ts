import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RagWorkbenchController } from './rag-workbench.controller';

@Module({
  controllers: [RagWorkbenchController],
  providers: [AuthGuard],
})
export class RagWorkbenchModule {}
