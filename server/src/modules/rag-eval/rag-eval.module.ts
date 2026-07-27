import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RagEvalController } from './rag-eval.controller';
import { RagEvalService } from './rag-eval.service';

@Module({
  controllers: [RagEvalController],
  providers: [AuthGuard, RagEvalService],
})
export class RagEvalModule {}
