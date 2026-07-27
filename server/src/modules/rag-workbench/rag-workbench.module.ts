import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RagWorkbenchController } from './rag-workbench.controller';
import { RagWorkbenchService } from './rag-workbench.service';

@Module({
  controllers: [RagWorkbenchController],
  providers: [AuthGuard, RagWorkbenchService],
})
export class RagWorkbenchModule {}
