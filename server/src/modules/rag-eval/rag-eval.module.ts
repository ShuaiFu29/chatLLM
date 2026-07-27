import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RagEvalController } from './rag-eval.controller';

@Module({
  controllers: [RagEvalController],
  providers: [AuthGuard],
})
export class RagEvalModule {}
